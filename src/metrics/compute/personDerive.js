/**
 * Input builders for the per-person metrics. Each takes already-loaded scope
 * data (+ the person's identity-id set + assembled extras) and returns the EXACT
 * input shape the corresponding pure module expects. Kept out of compute/index.js
 * so the dispatcher stays readable. Pure (no store / no I/O).
 */

import { percentile } from '../../core/index.js'
import { classifyWorkType, isProdCode, isTestFile, skillDomain } from '../person/classify.js'

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'stale',
])

/**
 * Composite-key separator. Must be a character that cannot appear in a repo id,
 * SHA, or file path. The SAME separator is used by loadPersonExtras when it
 * BUILDS these maps (compute/index.js) — keep them in lockstep.
 */
export const KEY_SEP = ' '
export const fcKey = (repoId, sha, path) => `${repoId}${KEY_SEP}${sha}${KEY_SEP}${path}`
export const repoShaKey = (repoId, sha) => `${repoId}${KEY_SEP}${sha}`
export const repoPathKey = (repoId, path) => `${repoId}${KEY_SEP}${path}`

/**
 * Filter generated/vendored files out of a pr_files list. Tolerant of older
 * rows that predate the `is_generated` column (those come back as `undefined`
 * which is treated as authored). The SAME filter is applied in compute/index.js
 * `toPrInput` and `totalWindowHaloc`, so per-PR and per-person volumes agree.
 */
const isAuthored = (f) => !f?.isGenerated

const prHaloc = (files) => {
  let h = 0
  let add = 0
  let del = 0
  let has = false
  for (const f of files ?? []) {
    if (!isAuthored(f)) continue
    h += f.haloc
    add += f.additions
    del += f.deletions
    has = true
  }
  return { haloc: has ? h : add + del, lines: add + del }
}

const nonAuthorHumanReviews = (revs, identityIds, bots) =>
  (revs ?? []).filter(
    (r) => !identityIds.has(r.reviewerIdentityId) && !bots.has(r.reviewerIdentityId),
  )

// --- Q5 / Q6 deterministic over loaded data --------------------------------

export function buildCiGreenInputs(authoredPrs, refByPr, checkRunsByRepoSha) {
  const prs = authoredPrs.map((pr) => {
    const ref = refByPr.get(pr.id)
    const checks = ref?.headSha
      ? (checkRunsByRepoSha.get(repoShaKey(pr.repoId, ref.headSha)) ?? [])
      : []
    const hadChecks = checks.length > 0
    const completed = checks.filter((c) => c.status === 'completed')
    const anyFailed = completed.some((c) => FAILED_CONCLUSIONS.has(String(c.conclusion)))
    const mergedMs = pr.mergedAt ? Date.parse(pr.mergedAt) : null
    const checksCompletedAfterMerge =
      mergedMs !== null &&
      completed.some((c) => c.completedAt && Date.parse(c.completedAt) > mergedMs)
    return {
      id: pr.id,
      hadChecks,
      greenAtMerge: hadChecks && completed.length > 0 && !anyFailed,
      checksCompletedAfterMerge,
    }
  })
  return { prs }
}

export function buildTicketLinkageInputs(authoredPrs, linkCountByPr) {
  return {
    prs: authoredPrs.map((pr) => {
      const linkCount = linkCountByPr.get(pr.id) ?? 0
      return { id: pr.id, linkCount, maxLinkConfidence: linkCount > 0 ? 1 : 0 }
    }),
  }
}

export function buildTestInclusionInputs(authoredPrs, prFilesByPr) {
  return {
    prs: authoredPrs.map((pr) => {
      const files = prFilesByPr.get(pr.id) ?? []
      return {
        id: pr.id,
        touchedProd: files.some((f) => isProdCode(f.path)),
        touchedTest: files.some((f) => isTestFile(f.path)),
      }
    }),
  }
}

export function buildSmallPrInputs(authoredMergedPrs, allMergedPrs, prFilesByPr, wipNow) {
  const allHalocs = allMergedPrs.map((pr) => prHaloc(prFilesByPr.get(pr.id)).haloc)
  // Team-relative threshold: the median merged-PR HALOC across the whole scope.
  const smallThreshold = allHalocs.length > 0 ? percentile(allHalocs, 0.5) : 50
  const halocs = authoredMergedPrs.map((pr) => prHaloc(prFilesByPr.get(pr.id)).haloc)
  return { halocs, smallThreshold, wipNow: wipNow ?? null }
}

export function buildChangesRequestedInputs(authoredMergedPrs, reviewsByPr, identityIds, bots) {
  return {
    prs: authoredMergedPrs.map((pr) => {
      const revs = nonAuthorHumanReviews(reviewsByPr.get(pr.id), identityIds, bots)
      return { id: pr.id, hadChangesRequested: revs.some((r) => r.state === 'changes_requested') }
    }),
  }
}

export function buildReviewBypassInputs(authoredMergedPrs, reviewsByPr, identityIds, bots) {
  return {
    prs: authoredMergedPrs.map((pr) => {
      const revs = nonAuthorHumanReviews(reviewsByPr.get(pr.id), identityIds, bots)
      return {
        id: pr.id,
        hadExternalReview: revs.length > 0,
        selfMerged: pr.mergedByIdentityId !== null && identityIds.has(pr.mergedByIdentityId),
      }
    }),
  }
}

// Review round-trip cadence proxy (see feedbackResponseLatency LATENCY_DOC).
// We measure changes_requested → the next review event. This is gated by when
// the REVIEWER returns, so it is NOT a clean author-response time — the metric
// is surfaced as descriptive (polarity 0), never as a lower-is-better author
// score. Anchoring on the author's next push would need commit→PR linkage that
// the GraphQL ingest does not populate.
export function buildFeedbackLatencyInputs(authoredMergedPrs, reviewsByPr, identityIds, bots) {
  const samples = []
  for (const pr of authoredMergedPrs) {
    const revs = [...(reviewsByPr.get(pr.id) ?? [])]
      .filter((r) => !identityIds.has(r.reviewerIdentityId) && !bots.has(r.reviewerIdentityId))
      .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))
    for (let i = 0; i < revs.length - 1; i++) {
      if (revs[i].state === 'changes_requested') {
        const dt = (Date.parse(revs[i + 1].submittedAt) - Date.parse(revs[i].submittedAt)) / 1000
        if (Number.isFinite(dt) && dt >= 0) samples.push(dt)
      }
    }
  }
  return { samples }
}

// --- Q1 complexity (file-level cyclomatic deltas via pr_refs + file_complexity)

const fcGet = (fcByKey, repoId, sha, path) =>
  sha ? (fcByKey.get(fcKey(repoId, sha, path)) ?? null) : null

export function buildComplexityDeltaInputs(authoredMergedPrs, prFilesByPr, refByPr, fcByKey) {
  const prPositiveDeltas = []
  for (const pr of authoredMergedPrs) {
    const ref = refByPr.get(pr.id)
    if (!ref) continue
    const files = prFilesByPr.get(pr.id) ?? []
    let positive = 0
    let covered = false
    for (const f of files) {
      // Generated files (lockfiles, .min.js, .pb.*) carry no authored complexity
      // signal — tree-sitter may still parse them but their cyclomatic delta is
      // noise from the generator, not the author.
      if (!isAuthored(f)) continue
      const head = fcGet(fcByKey, pr.repoId, ref.headSha, f.path)
      const base = fcGet(fcByKey, pr.repoId, ref.baseSha, f.path)
      if (head === null && base === null) continue
      covered = true
      const delta = (head?.totalCyclomatic ?? 0) - (base?.totalCyclomatic ?? 0)
      if (delta > 0) positive += delta
    }
    if (covered) prPositiveDeltas.push(positive)
  }
  return { prPositiveDeltas }
}

export function buildHighComplexityShareInputs(
  authoredMergedPrs,
  prFilesByPr,
  refByPr,
  fcByKey,
  thresholdByRepo,
) {
  let highLineWeight = 0
  let coveredLineWeight = 0
  let totalLineWeight = 0
  let highFilePrCount = 0
  let coveredPrCount = 0
  for (const pr of authoredMergedPrs) {
    const ref = refByPr.get(pr.id)
    const files = prFilesByPr.get(pr.id) ?? []
    const threshold = thresholdByRepo.get(pr.repoId) ?? Number.POSITIVE_INFINITY
    let prHasHigh = false
    let prHasCoverage = false
    for (const f of files) {
      // Skip generated/vendored files: a 100k-line minified bundle would
      // dwarf the authored line-weight and read as "always reviewing high-
      // complexity files" even when the author only touched a config map.
      if (!isAuthored(f)) continue
      const lw = f.additions + f.deletions
      totalLineWeight += lw
      const head = fcGet(fcByKey, pr.repoId, ref?.headSha, f.path)
      if (head === null) continue
      coveredLineWeight += lw
      prHasCoverage = true
      if (head.totalCyclomatic >= threshold) {
        highLineWeight += lw
        prHasHigh = true
      }
    }
    if (prHasCoverage) coveredPrCount++
    if (prHasHigh) highFilePrCount++
  }
  return { highLineWeight, coveredLineWeight, totalLineWeight, highFilePrCount, coveredPrCount }
}

export function buildConceptualSurfaceInputs(authoredMergedPrs, prFilesByPr, refByPr, fcByKey) {
  const prSurfaces = []
  for (const pr of authoredMergedPrs) {
    const ref = refByPr.get(pr.id)
    const files = prFilesByPr.get(pr.id) ?? []
    let surface = 0
    let covered = false
    const dirs = new Set()
    for (const f of files) {
      // Generated files do not contribute conceptual surface — their volume
      // belongs to the bundler/codegen, not to the human reviewer.
      if (!isAuthored(f)) continue
      const head = fcGet(fcByKey, pr.repoId, ref?.headSha, f.path)
      if (head === null) continue
      covered = true
      const changed = f.additions + f.deletions
      const density = Math.min(1, changed / Math.max(1, head.loc))
      surface += head.totalCyclomatic * density
      dirs.add(f.path.split('/').slice(0, -1).join('/'))
    }
    if (covered) {
      // Light directory-spread weighting: spreading concern across dirs is harder.
      prSurfaces.push(surface * (1 + 0.1 * Math.max(0, dirs.size - 1)))
    }
  }
  return { prSurfaces }
}

// --- Q2 work-type + bug-fix share ------------------------------------------

export function buildWorktypeUnits(
  authoredMergedPrs,
  prFilesByPr,
  issueIdsByPr,
  issuesById,
  assignedResolvedIssues,
) {
  const buckets = []
  const verified = []
  const linkedIssueIds = new Set()
  for (const pr of authoredMergedPrs) {
    const issueIds = issueIdsByPr.get(pr.id) ?? []
    const linkedTypes = issueIds.map((id) => issuesById.get(id)?.type).filter(Boolean)
    for (const id of issueIds) linkedIssueIds.add(id)
    const paths = (prFilesByPr.get(pr.id) ?? []).map((f) => f.path)
    buckets.push(classifyWorkType(linkedTypes[0] ?? null, paths))
    verified.push(linkedTypes.length > 0)
  }
  for (const issue of assignedResolvedIssues) {
    if (linkedIssueIds.has(issue.id)) continue
    buckets.push(classifyWorkType(issue.type, []))
    verified.push(true)
  }
  const bugUnits = buckets.filter((b) => b === 'bug').length
  return {
    buckets,
    bugfix: {
      bugUnits,
      totalUnits: buckets.length,
      verifiedUnits: verified.filter(Boolean).length,
    },
  }
}

export function buildSkillDomainInputs(authoredPrs, prFilesByPr) {
  const byDomain = new Map()
  for (const pr of authoredPrs) {
    for (const f of prFilesByPr.get(pr.id) ?? []) {
      // Lockfile churn is not a "skill domain" — filter it before bucketing.
      if (!isAuthored(f)) continue
      const d = skillDomain(f.path)
      byDomain.set(d, (byDomain.get(d) ?? 0) + f.additions + f.deletions)
    }
  }
  const domains = [...byDomain].map(([domain, weight]) => ({ domain, weight }))
  return { domains, floor: 0 }
}

// --- Knowledge ownership (across the whole scope, attributed to the person) --

export function buildKnowledgeOwnershipInputs(allPrs, prFilesByPr, identityIds, latestCycloByPath) {
  const agg = new Map() // path -> { personLines, totalLines, authors:Set, repoId }
  for (const pr of allPrs) {
    const mine = pr.authorIdentityId !== null && identityIds.has(pr.authorIdentityId)
    for (const f of prFilesByPr.get(pr.id) ?? []) {
      // Don't credit anyone with "owning" yarn.lock just because they bumped
      // a dep. Knowledge-ownership reads authored source only.
      if (!isAuthored(f)) continue
      const lines = f.additions + f.deletions
      let a = agg.get(f.path)
      if (!a) {
        a = { personLines: 0, totalLines: 0, authors: new Set(), repoId: pr.repoId }
        agg.set(f.path, a)
      }
      a.totalLines += lines
      if (mine) a.personLines += lines
      if (pr.authorIdentityId !== null) a.authors.add(pr.authorIdentityId)
    }
  }
  const paths = []
  for (const [path, a] of agg) {
    paths.push({
      path,
      personLines: a.personLines,
      totalLines: a.totalLines,
      contributorCount: a.authors.size,
      cyclomatic: latestCycloByPath.get(repoPathKey(a.repoId, path)) ?? 0,
    })
  }
  return { paths, lineFloor: 30 }
}

// --- AI-blend vs rework coupling -------------------------------------------

/**
 * AI/human classification for a single PR. The in-session Claude verdict
 * (llmVerdict, written via record_ai_authorship_verdict) is the authoritative
 * call when present — it adjudicates the ambiguous band by reading the change
 * text. Without a verdict, we fall back to thresholding the deterministic
 * ai_score at 0.5 (the legacy behaviour). Returns `null` when neither signal
 * is available (no ai_authorship row at all).
 */
function isAiAssisted(authorship) {
  if (!authorship) return null
  if (authorship.llmVerdict === true) return true
  if (authorship.llmVerdict === false) return false
  if (typeof authorship.aiScore !== 'number') return null
  return authorship.aiScore >= 0.5
}

export function buildAiBlendInputs(
  authoredMergedPrs,
  aiByEntity,
  aiScoresForPerson,
  reviewsByPr,
  commentsByPr,
  identityIds,
  bots,
) {
  const aiHeavyRework = []
  const humanRework = []
  for (const pr of authoredMergedPrs) {
    const authorship = aiByEntity.get(pr.id)
    const aiAssisted = isAiAssisted(authorship)
    if (aiAssisted === null) continue
    const crRounds = nonAuthorHumanReviews(reviewsByPr.get(pr.id), identityIds, bots).filter(
      (r) => r.state === 'changes_requested',
    ).length
    const comments = (commentsByPr.get(pr.id) ?? []).filter(
      (c) => !identityIds.has(c.authorIdentityId) && !bots.has(c.authorIdentityId),
    ).length
    const rework = crRounds + comments
    if (aiAssisted) aiHeavyRework.push(rework)
    else humanRework.push(rework)
  }
  return { aiScores: aiScoresForPerson, aiHeavyRework, humanRework, aiHeavyThreshold: 0.5 }
}
