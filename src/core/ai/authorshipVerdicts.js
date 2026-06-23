/**
 * In-session-Claude AI-authorship verdict pipeline (NO external API).
 *
 * The deterministic stylometry scorer (aiAuthorship.js) gives every commit/PR
 * an ai_score (0..1). Confident scores stand on their own; the AMBIGUOUS BAND
 * (typically 0.35–0.65) is exactly what the in-session Claude is uniquely good
 * at adjudicating — it reads the actual writing style and structure and decides
 * AI-assisted vs human. The pattern mirrors src/metrics/verdicts/index.js:
 *
 *   1. `listPendingAuthorshipVerdicts(store, opts)` → ambiguous-band entities
 *      that still need a verdict, with the TEXT the session judges (commit
 *      message for commits; title+body for PRs). Nothing leaves the machine.
 *   2. the session reads each artifact and decides ai-assisted (bool) +
 *      confidence + 1-sentence reasoning,
 *   3. `recordAuthorshipVerdict(...)` writes the four llm_* columns on the
 *      ai_authorship row. Stylometry re-scores never clobber these.
 *
 * Consumers (the AI-blend rework-coupling path in personDerive.js / aiScores
 * collapse in compute/index.js) PREFER llmVerdict over thresholded ai_score when
 * a verdict is present, falling back to the deterministic score when not. So an
 * entity that has not been judged keeps its existing behaviour — preserving all
 * current test outputs.
 */

/**
 * Calibrated guidance for the session judge — the same rubric the rejected API
 * tier used, kept here verbatim so the session reads style/structure, not a
 * single phrase. Em-dashes alone over-fire on diligent humans; the dominant AI
 * tells are markdown templates (## Summary / ## Test plan), checkbox test plans,
 * complete grammatically-perfect explanatory prose, and conventional-commit
 * titles paired with structured bodies. Human writing skews terse, lowercase,
 * abbreviation-heavy, and structurally plain.
 */
import { safeJsonParse } from '../json.js'

export const AUTHORSHIP_JUDGE_NOTE =
  'Judge whether the text was written with help from an AI coding assistant ' +
  '(Claude/Codex/Gemini/Copilot/Cursor — any of them). Decide from WRITING ' +
  'STYLE and STRUCTURE, never from a single phrase: em dashes, polished ' +
  'multi-section markdown (## Summary / ## Test plan), exhaustive bullet ' +
  'lists, checkbox test plans, complete and grammatically perfect explanatory ' +
  'prose, precise enumeration ("updated 10 references across 5 files"). ' +
  'Human-written messages skew terse, lowercase, abbreviation-heavy, and ' +
  'structurally plain. Be calibrated — return a genuine confidence, not always ' +
  'high. The deterministic stylometry score is already considered; you are ' +
  'adjudicating the AMBIGUOUS band where the score alone is inconclusive.'

/** Cap the judged text so a fat PR body can't blow the artifact payload. */
const MAX_TEXT_CHARS = 6000

const DEFAULT_LO_BAND = 0.35
const DEFAULT_HI_BAND = 0.65
const DEFAULT_LIMIT = 25

function parseRaw(raw) {
  return safeJsonParse(raw, {})
}

/** Commit-message extraction matching the stylometry scorer's commitMessage(). */
function commitText(raw) {
  const p = parseRaw(raw)
  return String(p.commit?.message ?? p.message ?? '')
}

/** PR text = "title\nbody" — matches the stylometry scorer's prText(). */
function prText(raw) {
  const p = parseRaw(raw)
  return `${p.title ?? ''}\n${p.body ?? ''}`
}

function truncate(text) {
  if (typeof text !== 'string') return ''
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n… [text truncated: ${text.length - MAX_TEXT_CHARS} more chars]`
}

/**
 * List ambiguous-band ai_authorship entities still needing a session verdict.
 * Returns { loBand, hiBand, pendingCount, pending: [{ entityType, entityId,
 * text, aiScore }], note }. The session judges each `text` and calls
 * recordAuthorshipVerdict per entity.
 */
export async function listPendingAuthorshipVerdicts(store, opts = {}) {
  const loBand = typeof opts.loBand === 'number' ? opts.loBand : DEFAULT_LO_BAND
  const hiBand = typeof opts.hiBand === 'number' ? opts.hiBand : DEFAULT_HI_BAND
  const limit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT
  // Optional recency floor: only surface entities authored on/after `sinceIso`, so
  // the (expensive) session judgments stay bounded to recent work. Null = no floor
  // (preserves prior behaviour for callers/tests that don't pass it).
  const sinceIso = typeof opts.sinceIso === 'string' ? opts.sinceIso : null
  if (loBand > hiBand) throw new Error('loBand must be <= hiBand')

  const pendingRows = await store.getPendingAiAuthorship({ loBand, hiBand, limit, sinceIso })

  // Targeted text lookups: ONE batched query per kind, not a full-table scan.
  const commitEntityIds = []
  const prIds = []
  for (const r of pendingRows) {
    if (r.entityType === 'commit') commitEntityIds.push(r.entityId)
    else if (r.entityType === 'pull_request') prIds.push(r.entityId)
  }
  const [commitRawByEntity, prRawById] = await Promise.all([
    commitEntityIds.length > 0
      ? store.getCommitRawByEntityIds(commitEntityIds)
      : Promise.resolve(new Map()),
    prIds.length > 0 ? store.getPullRequestRawByIds(prIds) : Promise.resolve(new Map()),
  ])

  const pending = []
  for (const r of pendingRows) {
    let text = ''
    if (r.entityType === 'commit') {
      const raw = commitRawByEntity.get(r.entityId)
      if (raw !== undefined) text = commitText(raw)
    } else if (r.entityType === 'pull_request') {
      const raw = prRawById.get(r.entityId)
      if (raw !== undefined) text = prText(raw)
    }
    pending.push({
      entityType: r.entityType,
      entityId: r.entityId,
      aiScore: r.aiScore,
      text: truncate(text),
    })
  }

  return {
    loBand,
    hiBand,
    pendingCount: pending.length,
    pending,
    note: AUTHORSHIP_JUDGE_NOTE,
  }
}

/**
 * Persist a session-produced AI-authorship verdict (idempotent per entity).
 * `aiAssisted` is boolean (true = AI-assisted); `confidence` is 0..1;
 * `reasoning` is a short justification (1–2 sentences). `now` is injected.
 */
export async function recordAuthorshipVerdict(
  store,
  { entityType, entityId, aiAssisted, confidence, reasoning },
  { now },
) {
  if (entityType !== 'commit' && entityType !== 'pull_request') {
    throw new Error(`Unknown entityType: ${entityType}`)
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new Error('entityId is required')
  }
  if (typeof aiAssisted !== 'boolean') throw new Error('aiAssisted must be a boolean')
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be a number in [0, 1]')
  }
  const changes = await store.setAiAuthorshipVerdict({
    entityType,
    entityId,
    llmVerdict: aiAssisted,
    llmConfidence: confidence,
    llmReasoning: typeof reasoning === 'string' ? reasoning : '',
    verdictAt: now,
  })
  return { recorded: changes > 0, entityType, entityId, aiAssisted, confidence }
}
