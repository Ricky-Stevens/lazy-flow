/**
 * Verdict harness — runVerdict + correctVerdict (SPEC §9.3, WP-AI-HARNESS)
 *
 * Responsibilities:
 *  - Builds the LlmParseRequest from insight params
 *  - Checks the verdict cache (subject + content_hash + prompt_version + model_id)
 *  - Calls the LlmClient
 *  - Validates that the structured output is non-null (handles refusal/cutoff)
 *  - Persists a full ai_verdicts audit row
 *  - Triggers the ensemble gate when the deterministic low-confidence proxy fires
 *  - Returns the verdict row
 */

import { randomUUID } from 'node:crypto'
import type { AiVerdict, Store } from '@lazy-flow/core'
import type { LlmClient } from './client/LlmClient.js'
import { DEFAULT_MODEL, ENSEMBLE_MODEL } from './constants.js'
import type { RequestShapeOptions } from './requestShape.js'
import { requestShape as buildRequestShape } from './requestShape.js'
import type { VerdictCache } from './verdictCache.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunVerdictOptions<T> {
  /** Subject being judged, e.g. 'pull_request' */
  subjectType: string
  /** Subject PK, e.g. PR node_id */
  subjectId: string
  /** Insight name, e.g. 'alignment', 'prquality' */
  metric: string
  /** Prompt version string, e.g. '1.0.0' */
  promptVersion: string
  /** Model id to use (defaults to DEFAULT_MODEL) */
  modelId?: string
  /** max_tokens for the request */
  maxTokens?: number
  /**
   * SHA-256 (or any stable hash) of the serialised feature vector.
   * The cache is keyed on this — changes trigger a re-run.
   */
  contentHash: string
  /** The feature vector passed to the model (stored in ai_verdicts). */
  featureVector: Record<string, unknown>
  /**
   * Privileged system instructions (the judge's rules), sent in the model's
   * `system` channel rather than concatenated into the untrusted user turn.
   */
  systemPrompt?: string
  /** The user message to send to the model. */
  userMessage: string
  /**
   * The zodOutputFormat(...) format object from @anthropic-ai/sdk/helpers/zod.
   * Typed as unknown here so the harness doesn't pull in zod as a hard dependency
   * at the interface boundary — callers supply the concrete format.
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque AutoParseableOutputFormat — Anthropic SDK provides no better public type
  outputConfigFormat: any // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * Deterministic low-confidence proxy predicate (SPEC §9.1.6, §9.3).
   * Receives the primary verdict value (or null) and returns true when the
   * ensemble escalation should run.  Injected per-insight.
   */
  shouldEscalate?: (value: T | null) => boolean
  /**
   * Ensemble (escalation) model id. Defaults to ENSEMBLE_MODEL. Wire from
   * config.claudeEnsembleModel so LAZYFLOW_CLAUDE_ENSEMBLE_MODEL takes effect.
   */
  ensembleModelId?: string
  /**
   * Confidence below which the default escalation proxy fires. Defaults to
   * DEFAULT_ESCALATION_CONFIDENCE. Wire from config.ensembleConfidenceThreshold
   * so LAZYFLOW_ENSEMBLE_THRESHOLD takes effect. Ignored when a custom
   * shouldEscalate is supplied.
   */
  escalationThreshold?: number
  /** Sampling options (will be shaped by requestShape adapter). */
  samplingOpts?: RequestShapeOptions
}

export interface RunVerdictResult<T> {
  verdict: AiVerdict
  /** The parsed structured value, or null on refusal/cutoff. */
  value: T | null
  /** True when the result came from the verdict cache (no LLM call). */
  fromCache: boolean
}

/** Confidence below which the ensemble gate fires by default. */
const DEFAULT_ESCALATION_CONFIDENCE = 0.5

/**
 * Default low-confidence proxy: escalate to the ensemble model when the primary
 * returned a borderline ANSWER (confidence below the threshold). A null verdict
 * (refusal/cutoff) is NOT auto-escalated — the pipeline's deterministic fallback
 * (e.g. blame-fallback, ordinal 0) is the designed behaviour there, and a second
 * opus call would most likely refuse too. Pipelines can override shouldEscalate
 * with a domain-specific predicate (e.g. to also escalate on null).
 */
function defaultShouldEscalate(
  value: unknown,
  threshold: number = DEFAULT_ESCALATION_CONFIDENCE,
): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'object' && 'confidence' in value) {
    const c = (value as Record<string, unknown>).confidence
    if (typeof c === 'number') return c < threshold
  }
  return false
}

// ─── Ensemble ─────────────────────────────────────────────────────────────────

/**
 * Run a second pass with the ensemble model and reconcile with the primary.
 *
 * Escalation only happens because the primary was low-confidence, so the
 * ensemble (Opus) result must be allowed to WIN — otherwise the second call is
 * pure wasted cost. Reconciliation:
 *   - ensemble null → keep primary
 *   - primary null  → use ensemble
 *   - both present + both expose numeric `confidence` → take the higher-
 *     confidence verdict (ties → primary, since the ensemble was the tie-breaker
 *     for an already-acceptable primary)
 *   - otherwise (no comparable confidence) → keep primary, the conservative default
 */
interface EnsembleOutcome<T> {
  /** The reconciled value served to the caller. */
  value: T | null
  /** True when the ensemble (Opus) verdict won and is the served value. */
  won: boolean
  /** The ensemble model id actually called. */
  modelId: string
  /** The ensemble call's returned model snapshot. */
  modelSnapshot: string
  /** The ensemble call's request shape (Opus rejects sampling params). */
  requestShape: unknown
}

async function runEnsemble<T>(
  primary: T | null,
  options: RunVerdictOptions<T>,
  client: LlmClient,
  ensembleModelId: string,
): Promise<EnsembleOutcome<T>> {
  const shape = buildRequestShape(ensembleModelId, {}) // opus gets no sampling params
  const result = await client.parse<T>({
    model: ensembleModelId,
    max_tokens: options.maxTokens ?? 1024,
    system: options.systemPrompt,
    messages: [{ role: 'user', content: options.userMessage }],
    requestShape: shape,
    outputConfigFormat: options.outputConfigFormat,
  })

  const base = {
    modelId: ensembleModelId,
    modelSnapshot: result.modelSnapshot,
    requestShape: result.requestShape,
  }

  // ensemble refused → keep primary; primary refused → use ensemble.
  if (result.value === null) return { value: primary, won: false, ...base }
  if (primary === null) return { value: result.value, won: true, ...base }

  // Prefer the higher-confidence verdict when both expose a numeric confidence.
  const primaryConf = numericConfidence(primary)
  const ensembleConf = numericConfidence(result.value)
  if (primaryConf !== null && ensembleConf !== null && ensembleConf > primaryConf) {
    return { value: result.value, won: true, ...base }
  }
  // Ties / no comparable signal → keep primary (conservative).
  return { value: primary, won: false, ...base }
}

/** Extract a top-level numeric `confidence`, or null if absent/non-numeric. */
function numericConfidence(value: unknown): number | null {
  if (value !== null && typeof value === 'object' && 'confidence' in value) {
    const c = (value as Record<string, unknown>).confidence
    if (typeof c === 'number') return c
  }
  return null
}

// ─── Main runVerdict ──────────────────────────────────────────────────────────

export async function runVerdict<T>(
  options: RunVerdictOptions<T>,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<RunVerdictResult<T>> {
  const modelId = options.modelId ?? DEFAULT_MODEL
  const promptVersion = options.promptVersion

  // 1. Cache check
  const cacheKey = {
    subjectType: options.subjectType,
    subjectId: options.subjectId,
    contentHash: options.contentHash,
    promptVersion,
    modelId,
  }
  const cached = cache.get(cacheKey)
  if (cached) {
    return {
      verdict: cached,
      value: JSON.parse(cached.structuredVerdictJson) as T | null,
      fromCache: true,
    }
  }

  // 2. Build request
  const shape = buildRequestShape(modelId, options.samplingOpts ?? {})
  const result = await client.parse<T>({
    model: modelId,
    max_tokens: options.maxTokens ?? 1024,
    system: options.systemPrompt,
    messages: [{ role: 'user', content: options.userMessage }],
    requestShape: shape,
    outputConfigFormat: options.outputConfigFormat,
  })

  // 3. Ensemble gate — deterministic low-confidence proxy (SPEC §9.1.6).
  // Defaults to escalating on a refusal/null or sub-threshold confidence so the
  // ensemble model is actually consulted in production (previously every
  // pipeline left shouldEscalate undefined, making the gate dead code).
  const escalate =
    options.shouldEscalate ??
    ((v: T | null) => defaultShouldEscalate(v, options.escalationThreshold))
  let finalValue = result.value
  // Provenance of the SERVED verdict — defaults to the primary, overwritten by
  // the ensemble model when its verdict actually wins. Persisting the primary's
  // id/snapshot/shape on an Opus-served verdict (the previous behaviour)
  // misattributes the decision and miscalibrates per-model analysis.
  let servedModelId = modelId
  let servedSnapshot = result.modelSnapshot
  let servedRequestShape: unknown = result.requestShape
  if (escalate(result.value)) {
    const ensembleModelId = options.ensembleModelId ?? ENSEMBLE_MODEL
    const outcome = await runEnsemble(result.value, options, client, ensembleModelId)
    finalValue = outcome.value
    if (outcome.won) {
      servedModelId = outcome.modelId
      servedSnapshot = outcome.modelSnapshot
      servedRequestShape = outcome.requestShape
    }
  }

  // 4. Build and persist audit row
  const now = new Date().toISOString()
  const verdict: AiVerdict = {
    id: randomUUID(),
    subjectType: options.subjectType,
    subjectId: options.subjectId,
    metric: options.metric,
    promptVersion,
    modelId: servedModelId,
    modelSnapshot: servedSnapshot,
    requestShape: JSON.stringify(servedRequestShape),
    featureVectorJson: JSON.stringify(options.featureVector),
    structuredVerdictJson: JSON.stringify(finalValue),
    evidenceJson: JSON.stringify(extractEvidence(finalValue)),
    confidence: extractConfidence(finalValue),
    createdAt: now,
    correctedBy: null,
    correctionJson: null,
  }

  await store.insertAiVerdict(verdict)

  // 5. Populate cache
  cache.set(cacheKey, verdict)

  return { verdict, value: finalValue, fromCache: false }
}

// ─── correctVerdict ───────────────────────────────────────────────────────────

/**
 * Append-only write of corrected_by / correction_json to an existing ai_verdicts row.
 * This is the write surface AC7 depends on (SPEC §9.3 contestability, WP-AI-CALIBRATION).
 */
export async function correctVerdict(
  id: string,
  correctedBy: string,
  correctionJson: string,
  store: Store,
): Promise<void> {
  await store.correctAiVerdict(id, correctedBy, correctionJson)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Attempts to extract an `evidence` field from the structured output.
 * Falls back to the whole value if it's not an object with an `evidence` key.
 */
function extractEvidence(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'evidence' in value) {
    return (value as Record<string, unknown>).evidence
  }
  return null
}

/**
 * Attempts to extract a `confidence` number from the structured output.
 * Falls back to 0 if not present or non-numeric.
 */
function extractConfidence(value: unknown): number {
  if (value !== null && typeof value === 'object' && 'confidence' in value) {
    const c = (value as Record<string, unknown>).confidence
    if (typeof c === 'number') return c
  }
  return 0
}
