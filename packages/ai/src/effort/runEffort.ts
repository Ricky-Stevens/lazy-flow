/**
 * runEffort — Effort Proportionality harness entry point (SPEC §9.2.2)
 *
 * Orchestrates:
 *   1. Baseline-readiness gate (n < EFFORT_MIN_HISTORY_N → insufficient_history)
 *   2. Spike/research exemption check
 *   3. Deterministic log-ratio + cycle-time z-score
 *   4. Call runVerdict with the effort prompt
 *   5. Cross-check LLM band vs deterministic z-score; lower confidence on disagreement
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import { buildEffortUserMessage, EFFORT_PROMPT_VERSION, EFFORT_SYSTEM_PROMPT } from './prompt.js'
import {
  adjustConfidenceForDisagreement,
  computeCycleTimeZScore,
  computeLogRatio,
} from './stats.js'
import type { EffortDistribution, EffortResult, EffortVector } from './types.js'
import {
  EFFORT_MIN_HISTORY_N,
  EffortLlmOutput,
  EXEMPT_ISSUE_TYPES,
  INSUFFICIENT_HISTORY,
} from './types.js'

export interface RunEffortOptions {
  /** Effort vector for the PR/issue. */
  vector: EffortVector
  /** Team historical distribution. */
  distribution: EffortDistribution
  /** Jira issue type (e.g. "Story", "Bug", "Spike"). */
  issueType: string
  /** Jira issue summary for context. */
  issueSummary: string
  /** Story points (optional context signal). */
  storyPoints: number | null
  /** PR or issue id (used as subjectId in the audit row). */
  subjectId: string
  /** Subject type for the audit row. */
  subjectType?: string
  /** Override model id. */
  modelId?: string
}

/**
 * Runs the effort proportionality verdict.
 * Returns EffortResult — always safe to present to the caller.
 */
export async function runEffort(
  opts: RunEffortOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<EffortResult> {
  // 1. Baseline-readiness gate (§9.2.2)
  if (opts.distribution.n < EFFORT_MIN_HISTORY_N) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio: null,
      cycleTimeZScore: null,
      confidence: 0,
      exempt: false,
    }
  }

  // 2. Spike/research exemption
  if (EXEMPT_ISSUE_TYPES.has(opts.issueType)) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio: null,
      cycleTimeZScore: null,
      confidence: 0,
      exempt: true,
    }
  }

  // 3. Deterministic signals
  const logRatio = computeLogRatio(opts.vector, opts.distribution)
  const cycleTimeZScore = computeCycleTimeZScore(opts.vector, opts.distribution)

  // If std is degenerate, we can't score
  if (logRatio === null || cycleTimeZScore === null) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio,
      cycleTimeZScore,
      confidence: 0,
      exempt: false,
    }
  }

  // 4. Build user message
  const userMessage = buildEffortUserMessage({
    vector: opts.vector,
    logRatio,
    cycleTimeZScore,
    issueSummary: opts.issueSummary,
    issueType: opts.issueType,
    storyPoints: opts.storyPoints,
  })

  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({ vector: opts.vector, dist: opts.distribution, issueType: opts.issueType }),
    )
    .digest('hex')

  // 5. Call runVerdict
  const { value } = await runVerdict<EffortLlmOutput>(
    {
      subjectType: opts.subjectType ?? 'pull_request',
      subjectId: opts.subjectId,
      metric: 'effort',
      promptVersion: EFFORT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 512,
      contentHash,
      featureVector: {
        ...opts.vector,
        logRatio,
        cycleTimeZScore,
        issueType: opts.issueType,
        n: opts.distribution.n,
      },
      systemPrompt: EFFORT_SYSTEM_PROMPT,
      userMessage,
      outputConfigFormat: zodOutputFormat(EffortLlmOutput),
    },
    client,
    store,
    cache,
  )

  // 6. Handle refusal / cutoff
  if (value === null) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio,
      cycleTimeZScore,
      confidence: 0,
      exempt: false,
    }
  }

  // 7. Cross-check and adjust confidence
  const adjustedConfidence = adjustConfidenceForDisagreement(
    value.confidence,
    value.band,
    cycleTimeZScore,
  )

  return {
    band: value.band,
    logRatio,
    cycleTimeZScore,
    confidence: adjustedConfidence,
    exempt: false,
  }
}
