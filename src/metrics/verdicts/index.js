/**
 * In-session-Claude verdict pipeline (NO external API). The probabilistic
 * per-person metrics aggregate structured verdicts stored in `ai_verdicts`.
 * Those verdicts are produced by the Claude session that is ALREADY running
 * (Claude Code / the MCP host), not by a programmatic model call:
 *
 *   1. `listPendingVerdicts(metric, person)` → the artifacts (PR title/body/files,
 *      review-comment bodies, review bodies) that still need a verdict, with the
 *      text the session reasons over. Nothing leaves the machine.
 *   2. the session reads each artifact and decides the structured verdict,
 *   3. `recordVerdict(...)` persists it to ai_verdicts (idempotent per subject).
 *
 * The metric modules then read these verdicts (computeVerdictMetric). This keeps
 * the LLM judgement local and human-auditable (every verdict carries evidence).
 */

import { safeJsonParse } from '../../core/json.js'

const PROMPT_VERSION = 'session-claude-v1'
const MODEL_ID = 'in-session-claude'

/** ai_verdicts.subject_type for each probabilistic person metric. */
export function verdictSubjectType(metricId) {
  if (metricId === 'person.review_depth_mentorship') return 'review'
  if (metricId === 'pr.feedback_severity_mix_received') return 'review_comment'
  return 'pull_request'
}

/** The verdict-field shape the session must return, per metric (for the tool doc). */
export const VERDICT_SHAPE = {
  'person.design_bearing_ratio': '{ designBearing: boolean, difficulty: 1-5 }',
  'person.pr_review_difficulty': '{ band: 1-5 }',
  'person.pr_atomicity': '{ prior: 0..1 (1=atomic), sprawling: boolean }',
  'person.pr_description_quality': "{ rating: 'absent'|'thin'|'adequate'|'strong' }",
  'person.convention_adherence': "{ adherence: 'follows'|'minor_divergence'|'violates' }",
  'pr.feedback_severity_mix_received':
    "{ severity: 'nit'|'clarification'|'logic'|'architectural'|'security' }",
  'person.review_depth_mentorship':
    "{ category: 'substantive_logic'|'design_arch'|'security'|'test_coverage'|'cosmetic_nit'|'rubber_stamp', complexityWeight: number }",
}

export const VERDICT_METRICS = Object.keys(VERDICT_SHAPE)

/** Best-effort text extraction from a stored raw API payload. */
function extractText(raw) {
  const j = safeJsonParse(raw, null)
  if (j === null) return { title: null, body: '' }
  const node = j.node ?? j
  return {
    title: node.title ?? null,
    body: String(node.body ?? node.bodyText ?? j.body ?? '').slice(0, 4000),
  }
}

async function personIdentityIds(store, personId) {
  return new Set((await store.getIdentitiesByPerson(personId)).map((i) => i.id))
}

/** Per-file diff cap so a fat PR's artifact stays a bounded payload for the judge. */
const MAX_PATCH_CHARS = 4000

/** Truncate a synthesised unified diff to a bounded size, flagging elision. */
function truncatePatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return null
  if (patch.length <= MAX_PATCH_CHARS) return patch
  return `${patch.slice(0, MAX_PATCH_CHARS)}\n… [diff truncated: ${patch.length - MAX_PATCH_CHARS} more chars]`
}

/**
 * List artifacts that still need a verdict for `metric`, scoped to `personId`.
 * Returns { metric, subjectType, verdictShape, pending: [{ subjectId, context }] }.
 */
export async function listPendingVerdicts(store, metric, personId, limit = 25) {
  if (!VERDICT_METRICS.includes(metric)) {
    throw new Error(`Unknown verdict metric: ${metric}`)
  }
  const subjectType = verdictSubjectType(metric)
  const ids = await personIdentityIds(store, personId)
  const done = new Set(
    (await store.getAiVerdictsByMetric(subjectType, metric)).map((v) => v.subjectId),
  )
  const prs = await store.getAllPullRequests()
  const pending = []

  if (subjectType === 'pull_request') {
    // Select the (≤limit) pending authored-merged PRs FIRST, then fetch ONLY those
    // PRs' files via a targeted query — never the whole pr_files table (millions of
    // rows at scale) to serve a 25-item request.
    const selected = []
    for (const pr of prs) {
      if (!(pr.authorIdentityId && ids.has(pr.authorIdentityId) && pr.state === 'merged')) continue
      if (done.has(pr.id)) continue
      selected.push(pr)
      if (selected.length >= limit) break
    }
    const filesByPr = await store.getPrFilesByPrIds(selected.map((p) => p.id))
    for (const pr of selected) {
      const t = extractText(pr.raw)
      const fs = filesByPr.get(pr.id) ?? []
      pending.push({
        subjectId: pr.id,
        context: {
          number: pr.number,
          title: t.title,
          body: t.body,
          files: fs.slice(0, 60).map((f) => ({
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            patch: truncatePatch(f.patch),
          })),
          fileCount: fs.length,
          note: fs.some((f) => typeof f.patch === 'string' && f.patch.length > 0)
            ? 'Synthesised diffs are included per file where available (truncated to a budget). Judge from title/body/diffs.'
            : 'No diffs backfilled yet — judge from title/body/file list; run backfill_pr_patches first for diff-level confidence.',
        },
      })
    }
  } else if (subjectType === 'review_comment') {
    const authoredPrIds = new Set(
      prs.filter((p) => p.authorIdentityId && ids.has(p.authorIdentityId)).map((p) => p.id),
    )
    for (const c of await store.getAllReviewComments()) {
      if (!authoredPrIds.has(c.prId) || done.has(c.nodeId)) continue
      if (ids.has(c.authorIdentityId)) continue // skip the author's own comments
      const t = extractText(c.raw)
      pending.push({
        subjectId: c.nodeId,
        context: { prId: c.prId, path: c.path, body: t.body },
      })
      if (pending.length >= limit) break
    }
  } else {
    // review — reviews the person GAVE. The PR lookup is only needed here.
    const prById = new Map(prs.map((p) => [p.id, p]))
    for (const r of await store.getAllReviews()) {
      if (!ids.has(r.reviewerIdentityId) || done.has(r.nodeId)) continue
      const t = extractText(r.raw)
      const pr = prById.get(r.prId)
      pending.push({
        subjectId: r.nodeId,
        context: {
          prId: r.prId,
          prTitle: pr ? extractText(pr.raw).title : null,
          state: r.state,
          body: t.body,
        },
      })
      if (pending.length >= limit) break
    }
  }

  return {
    metric,
    subjectType,
    verdictShape: VERDICT_SHAPE[metric],
    pendingCount: pending.length,
    pending,
  }
}

/**
 * Persist a session-produced verdict (idempotent per subject+metric). `verdict`
 * is the structured object whose shape matches VERDICT_SHAPE[metric]. `evidence`
 * is a free-form array/object the session cites (file:line, quote) — stored for
 * human audit. `now` and `id` are injected (no Date.now in pure paths).
 */
export async function recordVerdict(
  store,
  { metric, subjectId, verdict, confidence, evidence },
  ids,
) {
  if (!VERDICT_METRICS.includes(metric)) throw new Error(`Unknown verdict metric: ${metric}`)
  const subjectType = verdictSubjectType(metric)
  await store.deleteAiVerdictsForSubject(subjectType, subjectId, metric)
  await store.insertAiVerdict({
    id: ids.id,
    subjectType,
    subjectId,
    metric,
    promptVersion: PROMPT_VERSION,
    modelId: MODEL_ID,
    modelSnapshot: ids.modelSnapshot ?? MODEL_ID,
    requestShape: 'session',
    featureVectorJson: '{}',
    structuredVerdictJson: JSON.stringify(verdict ?? {}),
    evidenceJson: JSON.stringify(evidence ?? []),
    confidence: typeof confidence === 'number' ? confidence : 0.7,
    createdAt: ids.now,
  })
  return { recorded: true, subjectType, subjectId, metric }
}
