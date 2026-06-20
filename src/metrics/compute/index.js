import { ENGINE_VERSION, isProductionEnv, percentile } from '../../core/index.js'

import { estimationAccuracy, sayDo, sprintPredictability, sprintVelocity } from '../agile/index.js'
import {
  detectDeployInflation,
  detectStatusJuggling,
  detectTrivialPrSplitting,
  goodhartWarning,
} from '../antigaming/index.js'

import {
  codeChangeImpact,
  complexityDelta,
  halocAggregate,
  maintainabilityIndex,
  nagappanBall,
} from '../code/index.js'

import {
  changeFailureRate,
  deploymentFrequency,
  deploymentReworkRate,
  incidentReopenRate,
  leadTime,
  recoveryTime,
  reliabilityProxy,
} from '../dora/index.js'

import {
  agingWip,
  cfd,
  cycleTime,
  flowDistribution,
  flowEfficiency,
  monteCarlo,
  throughput,
  timeInStatus,
  wipLoad,
} from '../flow/index.js'

import {
  aiBlendCoupling,
  bugfixShare,
  changesRequestedReceived,
  ciGreenBeforeMerge,
  complexityAuthoredDelta,
  conventionAdherence,
  designBearingRatio,
  feedbackResponseLatency,
  feedbackSeverityMix,
  highComplexityFileShare,
  knowledgeOwnership,
  momentumVsTeam,
  prAtomicity,
  prConceptualSurface,
  prDescriptionQuality,
  prReviewDifficulty,
  reviewBypassReceived,
  reviewDepthMentorship,
  reviewReciprocity,
  selfBaselineDrift,
  skillDomainFootprint,
  smallPrDiscipline,
  testInclusionRate,
  ticketLinkageRate,
  worktypeMix,
} from '../person/index.js'
import {
  ciHealth,
  commentsPerPr,
  mergeWithoutReviewRate,
  prCycleTime,
  prSize,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
  reviewLatency,
  stalePr,
  timeToFirstReview,
  timeToMerge,
} from '../pr/index.js'
import { computePersonReport } from '../report/personReport.js'
import {
  buildAiBlendInputs,
  buildChangesRequestedInputs,
  buildCiGreenInputs,
  buildComplexityDeltaInputs,
  buildConceptualSurfaceInputs,
  buildFeedbackLatencyInputs,
  buildHighComplexityShareInputs,
  buildKnowledgeOwnershipInputs,
  buildReviewBypassInputs,
  buildSkillDomainInputs,
  buildSmallPrInputs,
  buildTestInclusionInputs,
  buildTicketLinkageInputs,
  buildWorktypeUnits,
  fcKey,
  repoPathKey,
  repoShaKey,
} from './personDerive.js'

// ---------------------------------------------------------------------------
// Wired metric ids
// ---------------------------------------------------------------------------

/** Every metric id this module knows how to compute against the store. */
export const COMPUTE_METRIC_IDS = [
  // DORA
  'dora.deployment_frequency',
  'dora.lead_time',
  'dora.change_failure_rate',
  'dora.recovery_time',
  'dora.deployment_rework_rate',
  'dora.reliability_proxy',
  'dora.incident_reopen_rate',
  // Flow
  'flow.cycle_time',
  'flow.throughput',
  'flow.flow_efficiency',
  'flow.wip_load',
  'flow.aging_wip',
  'flow.flow_distribution',
  'flow.cfd',
  'flow.time_in_status',
  'flow.monte_carlo_forecast',
  // PR
  'pr.cycle_time',
  'pr.review_latency',
  'pr.time_to_first_review',
  'pr.time_to_merge',
  'pr.size',
  'pr.ci_health',
  'pr.stale',
  'pr.reviewer_load_gini',
  'pr.merge_without_review_rate',
  'pr.review_coverage',
  'pr.reviewers_per_pr',
  'pr.comments_per_pr',
  'pr.review_iterations',
  // Agile
  'agile.say_do',
  'agile.sprint_velocity',
  'agile.sprint_predictability',
  'agile.estimation_accuracy',
  // Code (Group D). haloc_aggregate / nagappan_ball / change_impact compute from
  // ingested pr_files diffs. complexity_delta + maintainability_index compute from
  // per-PR whole-file ASTs (file_complexity, ingested via tree-sitter). rework_churn
  // still needs per-line git blame (not ingested) — it returns a SPECIFIC no_data
  // reason naming the missing input rather than a blanket short-circuit.
  'code.haloc_aggregate',
  'code.nagappan_ball',
  'code.change_impact',
  'code.complexity_delta',
  'code.maintainability_index',
  'code.rework_churn',
  // Person-only (computed at person/self scope; team scope returns no_data)
  'person.review_reciprocity',
  'person.knowledge_ownership_index',
  'person.ai_blend_rework_coupling',
  'person.ci_green_before_merge_rate',
  'person.ticket_linkage_rate',
  'person.test_inclusion_rate',
  'person.wip_small_pr_discipline',
  'pr.changes_requested_rate_received',
  'pr.review_bypass_rate_received',
  'pr.feedback_response_latency',
  'person.complexity_authored_delta',
  'person.high_complexity_file_share',
  'person.pr_conceptual_surface',
  'person.worktype_mix',
  'person.bugfix_share',
  'person.skill_domain_footprint',
  'person.self_baseline_drift',
  'person.momentum_vs_team',
  // Probabilistic — aggregate in-session-Claude verdicts from ai_verdicts
  'person.design_bearing_ratio',
  'person.pr_review_difficulty',
  'person.pr_atomicity',
  'person.pr_description_quality',
  'person.convention_adherence',
  'pr.feedback_severity_mix_received',
  'person.review_depth_mentorship',
]

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/** Inclusive UTC instant for the start of `day` (YYYY-MM-DD). */
function dayStartMs(day) {
  return new Date(`${day}T00:00:00.000Z`).getTime()
}

/** Inclusive UTC instant for the END of `day` (last millisecond of the day). */
function dayEndMs(day) {
  return dayStartMs(day) + 24 * 60 * 60 * 1000 - 1
}

/** ISO timestamp at the start of `day`. */
function dayStartIso(day) {
  return new Date(dayStartMs(day)).toISOString()
}

/** ISO timestamp at the end of `day` (inclusive). */
function dayEndIso(day) {
  return new Date(dayEndMs(day)).toISOString()
}

/** True when an ISO timestamp (or null) falls within [from, to] inclusive. */
function inWindow(iso, fromMs, toMs) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return false
  return t >= fromMs && t <= toMs
}

/** Whole days (rounded) in the inclusive window [windowFrom, windowTo]. */
function windowDays(windowFrom, windowTo) {
  const ms = dayEndMs(windowTo) - dayStartMs(windowFrom)
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)))
}

// ---------------------------------------------------------------------------
// Store loading
// ---------------------------------------------------------------------------

/**
 * Everything the team/org metrics need, read once and reused across metrics for
 * the same scope+window. PRs/deploys/commits/check-runs are window-filtered;
 * issues + transitions are kept whole (flow/agile modules window internally).
 */

/** Resolve the single configured org id, or null if none synced. */
async function resolveOrgId(store) {
  const orgs = await store.listOrganisations()
  return orgs[0]?.id ?? null
}

/**
 * Bulk-load globally-window-INDEPENDENT lookups used across every metric and
 * day of the backfill — pr_refs, file_complexity, and the current status
 * category per status. Returns three maps:
 *   - prRefById               : prId → { repoId, baseSha, headSha }
 *   - fileComplexityByKey     : fcKey(repoId,sha,path) → { language, loc, totalCyclomatic, functionCount, functions }
 *   - statusCategoryById      : statusId → 'new' | 'indeterminate' | 'done'
 *
 * These eliminate three N+1 patterns from the snapshot backfill:
 *   1. complexity_delta            — getPrRef + getFileComplexity per PR×file×day
 *   2. maintainability_index       — same pair, per PR×file×day
 *   3. buildStatusBoundaries       — getStatusCategory per status × metric × day
 *
 * Attached to BOTH `loadFullScopeData` and `loadScopeDataWindowed` so the
 * equivalence oracle continues to compute identical values.
 */
// Per-store memo: window-INDEPENDENT global lookups don't change between window
// slices in a backfill or between the cohort load and trend load of a person
// report. WeakMap keys on the store instance so test stores GC normally and
// production stores share one lookup-load across every call inside a run.
// Tests / callers that need to force a re-read can `delete store.__lookupsMemo`
// or use a fresh store; we attach the promise (not the value) so concurrent
// callers de-dupe instead of racing duplicate scans.
const GLOBAL_LOOKUPS_MEMO = new WeakMap()
async function loadGlobalLookups(store) {
  let p = GLOBAL_LOOKUPS_MEMO.get(store)
  if (!p) {
    p = (async () => {
      const [prRefs, fcRows, statusCategoryById] = await Promise.all([
        store.getAllPrRefs(),
        store.getAllFileComplexity(),
        store.getCurrentStatusCategories(),
      ])
      const prRefById = new Map()
      for (const ref of prRefs) {
        prRefById.set(ref.prId, {
          repoId: ref.repoId,
          baseSha: ref.baseSha,
          headSha: ref.headSha,
        })
      }
      const fileComplexityByKey = new Map()
      for (const fc of fcRows) {
        fileComplexityByKey.set(fcKey(fc.repoId, fc.sha, fc.path), {
          language: fc.language,
          loc: fc.loc,
          totalCyclomatic: fc.totalCyclomatic,
          functionCount: fc.functionCount,
          functions: fc.functions,
        })
      }
      return { prRefById, fileComplexityByKey, statusCategoryById }
    })()
    GLOBAL_LOOKUPS_MEMO.set(store, p)
  }
  return p
}

/**
 * Drop the per-store memo for window-independent lookups. Call after a sync
 * (writes that mutate pr_refs / file_complexity / status_category_history)
 * so the next compute reads the fresh state. Cheap — just a WeakMap delete.
 */
export function invalidateLookupsCache(store) {
  GLOBAL_LOOKUPS_MEMO.delete(store)
}

/**
 * Load all the team/org-scoped entities for the window, once.
 * Window applies to PRs (createdAt), deploys (createdAt), commits (authoredAt),
 * check runs (completedAt/startedAt). Issues + transitions are loaded whole.
 */
export async function loadScopeData(store, windowFrom, windowTo) {
  // Single code path for on-demand (get_* tools) AND backfill: bulk-load the whole
  // dataset once, then slice the window in memory. The backfill passes the loaded
  // full dataset across all days/metrics via computeMetric's `preloaded` arg, so it
  // only pays the bulk load once per run rather than per (metric, day).
  return sliceScopeData(await loadFullScopeData(store), windowFrom, windowTo)
}

/** Group an array into a Map keyed by `keyFn`, preserving input order within each
 * bucket (callers rely on the bulk getters' ORDER BY to order each bucket). */
function groupBy(rows, keyFn) {
  const m = new Map()
  for (const row of rows) {
    const k = keyFn(row)
    const arr = m.get(k)
    if (arr) arr.push(row)
    else m.set(k, [row])
  }
  return m
}

/**
 * Bulk-load the ENTIRE scope dataset in ~10 queries (zero N+1), grouped in memory
 * by repo / parent id so any window can be sliced with `sliceScopeData` as pure
 * CPU (no further I/O). Window-independent and scope-independent — load it once
 * per backfill and reuse across every day and both the team and org scopes.
 */
export async function loadFullScopeData(store) {
  const orgId = await resolveOrgId(store)
  const repos = orgId ? await store.getRepositoriesByOrg(orgId) : []
  const repoIds = new Set(repos.map((r) => r.id))

  const allIdentities = await store.listAllIdentities()
  const botIdentityIds = new Set(allIdentities.filter((i) => i.isBot).map((i) => i.id))

  // One bulk query per table; group by repo/parent, scoped to the org's repos.
  // The getters' ORDER BY preserves the same ordering the per-scope getters used.
  const prsByRepo = new Map()
  for (const pr of await store.getAllPullRequests()) {
    if (!repoIds.has(pr.repoId)) continue
    const arr = prsByRepo.get(pr.repoId)
    if (arr) arr.push(pr)
    else prsByRepo.set(pr.repoId, [pr])
  }

  const reviewsByPr = groupBy(await store.getAllReviews(), (r) => r.prId)
  const commentsByPr = groupBy(await store.getAllReviewComments(), (c) => c.prId)
  const filesByPr = groupBy(await store.getAllPrFiles(), (f) => f.prId)

  const deploysByRepo = new Map()
  for (const d of await store.getAllDeployments()) {
    if (!repoIds.has(d.repoId)) continue
    const arr = deploysByRepo.get(d.repoId)
    if (arr) arr.push(d)
    else deploysByRepo.set(d.repoId, [d])
  }

  const commitsByRepo = new Map()
  for (const c of await store.getAllCommits()) {
    if (!repoIds.has(c.repoId)) continue
    const arr = commitsByRepo.get(c.repoId)
    if (arr) arr.push(c)
    else commitsByRepo.set(c.repoId, [c])
  }

  const checkRunsByRepo = new Map()
  for (const cr of await store.getAllCheckRuns()) {
    if (!repoIds.has(cr.repoId)) continue
    const arr = checkRunsByRepo.get(cr.repoId)
    if (arr) arr.push(cr)
    else checkRunsByRepo.set(cr.repoId, [cr])
  }

  // Issues per project (few projects — NOT an N+1 over issues); transitions bulk.
  const projects = await store.listJiraProjects()
  const issuesByProject = new Map()
  for (const project of projects) {
    issuesByProject.set(project.id, await store.getIssuesByProject(project.id))
  }
  const transitionsByIssue = groupBy(await store.getAllIssueTransitions(), (t) => t.issueId)

  // Window-INDEPENDENT global lookups (pr_refs, file_complexity, status
  // category-by-id). Attached to the scope data so per-metric code can read
  // them as in-memory maps instead of point-querying inside per-PR/per-file
  // loops on every day of the backfill.
  const lookups = await loadGlobalLookups(store)

  return {
    repos,
    prsByRepo,
    reviewsByPr,
    commentsByPr,
    filesByPr,
    deploysByRepo,
    commitsByRepo,
    checkRunsByRepo,
    projectIds: projects.map((p) => p.id),
    issuesByProject,
    transitionsByIssue,
    botIdentityIds,
    prRefById: lookups.prRefById,
    fileComplexityByKey: lookups.fileComplexityByKey,
    statusCategoryById: lookups.statusCategoryById,
  }
}

/**
 * Slice a window out of the full dataset, producing the exact ScopeData shape the
 * metric computations consume. Every predicate mirrors the corresponding store
 * getter's SQL EXACTLY (string compares on the same ISO bounds; numeric inWindow
 * for check runs) so the result is equivalent to the old per-window SQL load —
 * see loadScopeDataWindowed and its equivalence test.
 */
export function sliceScopeData(full, windowFrom, windowTo) {
  const fromMs = dayStartMs(windowFrom)
  const toMs = dayEndMs(windowTo)
  const fromIso = dayStartIso(windowFrom)
  const toIso = dayEndIso(windowTo)
  // Prior rolling-HALOC boundary (Nagappan-Ball denominator): PRs created strictly
  // before the window. Mirrors getPrFilesByRepo(repo, undefined, priorUntilIso).
  const priorUntilIso = new Date(fromMs - 1).toISOString()

  const prs = []
  const deploys = []
  const commits = []
  const checkRuns = []
  const reviewsByPr = new Map()
  const reviewCommentsByPr = new Map()
  const prFilesByPr = new Map()
  let priorHaloc = 0

  for (const repo of full.repos) {
    const repoPrs = full.prsByRepo.get(repo.id) ?? []

    // Mirror getPullRequestsForMetrics: created-in-window OR merged-in-window OR
    // still-open (created on/before the window end).
    for (const pr of repoPrs) {
      const match =
        (pr.createdAt >= fromIso && pr.createdAt <= toIso) ||
        (pr.mergedAt != null && pr.mergedAt >= fromIso && pr.mergedAt <= toIso) ||
        (pr.state === 'open' && pr.createdAt <= toIso)
      if (!match) continue
      prs.push(pr)
      reviewsByPr.set(pr.id, full.reviewsByPr.get(pr.id) ?? [])
      reviewCommentsByPr.set(pr.id, full.commentsByPr.get(pr.id) ?? [])
    }

    // pr_files + prior HALOC window on the PR's created_at (mirror getPrFilesByRepo,
    // which is independent of the PR-list predicate above).
    for (const pr of repoPrs) {
      const files = full.filesByPr.get(pr.id)
      if (!files || files.length === 0) continue
      if (pr.createdAt >= fromIso && pr.createdAt <= toIso) {
        prFilesByPr.set(pr.id, files)
      }
      if (pr.createdAt <= priorUntilIso) {
        // Filter generated/vendored files so the prior-window HALOC term matches
        // the generated-filter applied to the window numerator (totalWindowHaloc).
        // Without this, Nagappan-Ball M1 = haloc/(priorHaloc+haloc) divides an
        // authored-only numerator by a denominator polluted with lockfile/.min.js
        // churn, understating relative churn by an arbitrary factor.
        for (const f of files) {
          if (f.isGenerated) continue
          priorHaloc += f.haloc
        }
      }
    }

    for (const d of full.deploysByRepo.get(repo.id) ?? []) {
      if (d.createdAt >= fromIso && d.createdAt <= toIso) deploys.push(d)
    }

    for (const c of full.commitsByRepo.get(repo.id) ?? []) {
      if (c.authoredAt >= fromIso && c.authoredAt <= toIso) {
        commits.push({ repoId: c.repoId, sha: c.sha, authoredAt: c.authoredAt })
      }
    }

    for (const cr of full.checkRunsByRepo.get(repo.id) ?? []) {
      const stamp = cr.completedAt ?? cr.startedAt
      if (!inWindow(stamp, fromMs, toMs)) continue
      checkRuns.push({
        nodeId: cr.nodeId,
        repoId: cr.repoId,
        headSha: cr.headSha,
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        startedAt: cr.startedAt,
        completedAt: cr.completedAt,
      })
    }
  }

  // Issues + transitions are window-independent (metrics window them internally).
  const issues = []
  const transitionsByIssue = new Map()
  for (const projectId of full.projectIds) {
    for (const issue of full.issuesByProject.get(projectId) ?? []) {
      issues.push(issue)
      transitionsByIssue.set(issue.id, full.transitionsByIssue.get(issue.id) ?? [])
    }
  }

  return {
    prs,
    reviewsByPr,
    reviewCommentsByPr,
    deploys,
    commits,
    checkRuns,
    issues,
    transitionsByIssue,
    projectIds: full.projectIds,
    botIdentityIds: full.botIdentityIds,
    prFilesByPr,
    priorHaloc,
    // Window-independent lookups — passed through verbatim from the bulk load.
    prRefById: full.prRefById,
    fileComplexityByKey: full.fileComplexityByKey,
    statusCategoryById: full.statusCategoryById,
  }
}

/**
 * REFERENCE IMPLEMENTATION (oracle): the original per-window SQL loader, kept as
 * the correctness oracle for `loadFullScopeData`+`sliceScopeData`. The equivalence
 * test asserts the in-memory slice yields identical metric values for every metric
 * over a range of windows. Not used on the hot path (it carries the per-PR /
 * per-issue N+1 the bulk loader eliminates).
 */
export async function loadScopeDataWindowed(store, windowFrom, windowTo) {
  const fromMs = dayStartMs(windowFrom)
  const toMs = dayEndMs(windowTo)
  const fromIso = dayStartIso(windowFrom)
  const toIso = dayEndIso(windowTo)

  const orgId = await resolveOrgId(store)
  const repos = orgId ? await store.getRepositoriesByOrg(orgId) : []

  const allIdentities = await store.listAllIdentities()
  const botIdentityIds = new Set(allIdentities.filter((i) => i.isBot).map((i) => i.id))

  const prs = []
  const deploys = []
  const commits = []
  const checkRuns = []
  const reviewsByPr = new Map()
  const reviewCommentsByPr = new Map()
  const prFilesByPr = new Map()
  let priorHaloc = 0

  for (const repo of repos) {
    const repoPrs = await store.getPullRequestsForMetrics(repo.id, fromIso, toIso)
    for (const pr of repoPrs) {
      prs.push(pr)
      reviewsByPr.set(pr.id, await store.getReviewsByPullRequest(pr.id))
      reviewCommentsByPr.set(pr.id, await store.getReviewCommentsByPullRequest(pr.id))
    }

    const repoPrFiles = await store.getPrFilesByRepo(repo.id, fromIso, toIso)
    for (const f of repoPrFiles) {
      const arr = prFilesByPr.get(f.prId)
      if (arr) arr.push(f)
      else prFilesByPr.set(f.prId, [f])
    }

    const priorUntilIso = new Date(fromMs - 1).toISOString()
    const repoPriorFiles = await store.getPrFilesByRepo(repo.id, undefined, priorUntilIso)
    // Filter generated/vendored files to match the window numerator's filter
    // (totalWindowHaloc) — see the parallel loop above for why.
    for (const f of repoPriorFiles) {
      if (f.isGenerated) continue
      priorHaloc += f.haloc
    }

    deploys.push(...(await store.getDeploymentsByRepo(repo.id, fromIso, toIso)))

    const repoCommits = await store.getCommitsByRepo(repo.id, fromIso, toIso)
    for (const c of repoCommits) {
      commits.push({ repoId: c.repoId, sha: c.sha, authoredAt: c.authoredAt })
    }

    const repoChecks = await store.getCheckRunsByRepo(repo.id)
    for (const cr of repoChecks) {
      const stamp = cr.completedAt ?? cr.startedAt
      if (!inWindow(stamp, fromMs, toMs)) continue
      checkRuns.push({
        nodeId: cr.nodeId,
        repoId: cr.repoId,
        headSha: cr.headSha,
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        startedAt: cr.startedAt,
        completedAt: cr.completedAt,
      })
    }
  }

  const projects = await store.listJiraProjects()
  const issues = []
  const transitionsByIssue = new Map()
  for (const project of projects) {
    const projectIssues = await store.getIssuesByProject(project.id)
    for (const issue of projectIssues) {
      if (issue.deletedAt !== null) continue
      issues.push(issue)
      transitionsByIssue.set(issue.id, await store.getIssueTransitions(issue.id))
    }
  }

  // Window-INDEPENDENT global lookups — attached here too so the oracle path
  // (computeMetric called with `preloaded = await loadScopeDataWindowed(...)`)
  // computes identical values to the bulk slice path. The equivalence test
  // depends on this.
  const lookups = await loadGlobalLookups(store)

  return {
    prs,
    reviewsByPr,
    reviewCommentsByPr,
    deploys,
    commits,
    checkRuns,
    issues,
    transitionsByIssue,
    projectIds: projects.map((p) => p.id),
    botIdentityIds,
    prFilesByPr,
    priorHaloc,
    prRefById: lookups.prRefById,
    fileComplexityByKey: lookups.fileComplexityByKey,
    statusCategoryById: lookups.statusCategoryById,
  }
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * Project a PR into the PrInput shape. additions/deletions/haloc are aggregated
 * from the PR's ingested pr_files (REAL diff volume) so pr.size and any
 * HALOC-derived signal reflect actual change size instead of a hardcoded 0.
 * When no files were ingested for the PR, haloc is null (size then falls back to
 * additions+deletions, which are also 0 — an honest "unknown size", not a fake 0).
 */
function toPrInput(pr, files) {
  let additions = 0
  let deletions = 0
  let haloc = 0
  let hasFiles = false
  for (const f of files ?? []) {
    hasFiles = true
    // Skip generated/vendored/lockfile/minified files. They are persisted with
    // is_generated=1 by the ingest mapper. pr.size, code.haloc_aggregate, and
    // code.change_impact all derive their authored-volume from this aggregate,
    // so the filter has to happen once HERE rather than per-metric. Robust to
    // 0/1/true/false/undefined (older rows pre-migration default to authored).
    if (f.isGenerated) continue
    additions += f.additions
    deletions += f.deletions
    haloc += f.haloc
  }
  return {
    id: pr.id,
    repoId: pr.repoId,
    number: pr.number,
    authorIdentityId: pr.authorIdentityId,
    mergedByIdentityId: pr.mergedByIdentityId,
    state: pr.state,
    isDraft: pr.isDraft,
    firstCommitAt: pr.firstCommitAt,
    createdAt: pr.createdAt,
    readyAt: pr.readyAt,
    firstReviewAt: pr.firstReviewAt,
    approvedAt: pr.approvedAt,
    mergedAt: pr.mergedAt,
    updatedAt: pr.updatedAt,
    additions,
    deletions,
    haloc: hasFiles ? haloc : null,
  }
}

function toReviewInput(r) {
  return {
    nodeId: r.nodeId,
    prId: r.prId,
    reviewerIdentityId: r.reviewerIdentityId,
    state: r.state,
    submittedAt: r.submittedAt,
  }
}

function toReviewCommentInput(c) {
  return {
    nodeId: c.nodeId,
    prId: c.prId,
    authorIdentityId: c.authorIdentityId,
    createdAt: c.createdAt,
  }
}

function toDeployRecord(d) {
  return {
    id: d.id,
    repoId: d.repoId,
    sha: d.sha,
    environment: d.environment,
    status: d.status,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt,
    source: d.source,
  }
}

function toDeployInput(d) {
  return {
    id: d.id,
    repoId: d.repoId,
    sha: d.sha,
    environment: d.environment,
    status: d.status,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt,
  }
}

function toPrRecord(pr) {
  return { id: pr.id, repoId: pr.repoId, firstCommitAt: pr.firstCommitAt, mergedAt: pr.mergedAt }
}

function toTransitionRecord(t) {
  return {
    id: t.id,
    issueId: t.issueId,
    fromStatusId: t.fromStatusId,
    toStatusId: t.toStatusId,
    transitionedAt: t.transitionedAt,
  }
}

function toFlowIssueRecord(issue, transitions) {
  return {
    id: issue.id,
    type: issue.type,
    workflowId: null,
    transitions: transitions.map(toTransitionRecord),
    currentStatusId: issue.statusId,
    createdAt: issue.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Flow boundaries (board-free via status category)
// ---------------------------------------------------------------------------

/**
 * Build started/done status sets board-free, from the store's status-category
 * lookup. Every status id seen on an issue or transition is classified:
 *   'indeterminate' → started (work in progress)
 *   'done'          → done
 *   'new'           → neither (backlog/queue)
 * This is the documented fallback when board config is absent (SPEC §8.2).
 */
async function buildStatusBoundaries(store, data) {
  const statusIds = new Set()
  for (const issue of data.issues) {
    statusIds.add(issue.statusId)
    for (const t of data.transitionsByIssue.get(issue.id) ?? []) {
      statusIds.add(t.fromStatusId)
      statusIds.add(t.toStatusId)
    }
  }

  // PERF: getStatusCategory is global (no `at`), so the bulk loader stashes a
  // statusId→category map onto `data` once per backfill. Reading from the map
  // collapses ~|statusIds| × (metric × day) point queries to zero. Defensive
  // fallback to the per-status async query for callers that build `data`
  // without the map.
  const statusCategoryById = data.statusCategoryById
  const startedIds = new Set()
  const doneIds = new Set()
  for (const statusId of statusIds) {
    const category = statusCategoryById
      ? (statusCategoryById.get(statusId) ?? null)
      : await store.getStatusCategory(statusId)
    if (category === 'indeterminate') startedIds.add(statusId)
    else if (category === 'done') doneIds.add(statusId)
  }

  const boardColumns = [
    { statusIds: [...startedIds], isStartedCol: true, isDoneCol: false },
    { statusIds: [...doneIds], isStartedCol: false, isDoneCol: true },
  ]
  return { boardColumns, startedIds, doneIds }
}

/** Whether `issue` has its first Done transition within [fromMs, toMs]. */
function firstDoneInWindow(issue, doneStatusIds, fromMs, toMs) {
  const sorted = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )
  for (const t of sorted) {
    if (doneStatusIds.has(t.toStatusId)) {
      const ms = new Date(t.transitionedAt).getTime()
      return ms >= fromMs && ms <= toMs
    }
  }
  return false
}

/**
 * The ms timestamp of an issue's FIRST transition into a Done status, or null if
 * it never reached Done. Mirrors throughput's first-Done dedup: an issue counts
 * on its first completion only.
 */
function firstDoneAtMs(issue, doneStatusIds) {
  const sorted = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )
  for (const t of sorted) {
    if (doneStatusIds.has(t.toStatusId)) {
      const ms = new Date(t.transitionedAt).getTime()
      return Number.isFinite(ms) ? ms : null
    }
  }
  return null
}

/** Whole 7-day weeks (rounded up, min 1) spanned by the inclusive [fromMs, toMs]. */
function weekCount(fromMs, toMs) {
  const weekMs = 7 * 24 * 60 * 60 * 1000
  return Math.max(1, Math.ceil((toMs - fromMs + 1) / weekMs))
}

/**
 * Per-week throughput samples for the Monte Carlo forecast: bucket each issue's
 * first-Done timestamp (within [fromMs, toMs]) into a fixed-width 7-day week
 * indexed from fromMs, and return the completion count per week. Weeks with zero
 * completions are kept (a real 0-throughput week is a valid bootstrap sample).
 */
function weeklyThroughputSamples(issues, doneStatusIds, fromMs, toMs) {
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const buckets = new Array(weekCount(fromMs, toMs)).fill(0)
  for (const issue of issues) {
    const doneMs = firstDoneAtMs(issue, doneStatusIds)
    if (doneMs === null || doneMs < fromMs || doneMs > toMs) continue
    const idx = Math.min(buckets.length - 1, Math.floor((doneMs - fromMs) / weekMs))
    buckets[idx] = (buckets[idx] ?? 0) + 1
  }
  return buckets
}

/**
 * The team's ACTIVE throughput span: the number of weeks from the first non-zero
 * completion week to the last (inclusive). Interior zero weeks count (a real slow
 * week is signal); leading/trailing zero-padding does not (the team did not exist
 * or shipped nothing yet). Returns 0 when no week had any completions. This is the
 * genuine observation count the Monte Carlo sample floor gates on, distinct from
 * the padded weeklySamples.length (the full window width).
 */
function activeThroughputSpan(weeklySamples) {
  let first = -1
  let last = -1
  for (let i = 0; i < weeklySamples.length; i++) {
    if ((weeklySamples[i] ?? 0) > 0) {
      if (first === -1) first = i
      last = i
    }
  }
  return first === -1 ? 0 : last - first + 1
}

/**
 * Count issues that are currently started-but-not-done as of `asOfMs` (open WIP) —
 * the backlog the Monte Carlo forecast projects a completion horizon for. An issue
 * counts when its latest transition at-or-before asOfMs lands it in a started
 * status (or it was created into one and never moved), and it has NOT reached Done
 * by asOfMs.
 */
function countOpenWip(issues, startedStatusIds, doneStatusIds, asOfMs) {
  let count = 0
  for (const issue of issues) {
    if (new Date(issue.createdAt).getTime() > asOfMs) continue
    const sorted = [...issue.transitions]
      .filter((t) => new Date(t.transitionedAt).getTime() <= asOfMs)
      .sort((a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime())
    const currentStatusId =
      sorted.length > 0 ? sorted[sorted.length - 1].toStatusId : issue.currentStatusId
    if (startedStatusIds.has(currentStatusId) && !doneStatusIds.has(currentStatusId)) count++
  }
  return count
}

/**
 * Deterministic 32-bit forecast seed from the window bounds. The seed +
 * engine_version together guarantee a reproducible Monte Carlo forecast per
 * install+window (SPEC §8.6) — no Math.random, no Date.now.
 */
function forecastSeed(windowFrom, windowTo) {
  const s = `${windowFrom}|${windowTo}|${ENGINE_VERSION}`
  let h = 2166136261 >>> 0 // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

// ---------------------------------------------------------------------------
// DORA incident projection
// ---------------------------------------------------------------------------

/**
 * Maximum lookback from an incident's createdAt to the deployment we attribute it
 * to. This is the standard DORA Change-Failure-Rate approximation window: an
 * incident opened within this window of a production deploy is treated as a
 * failure of that deploy. 7 days is the conventional default (Accelerate / DORA
 * "failed deployment recovery" guidance) and is generous enough to absorb the
 * detection lag between a bad release and the incident being raised.
 */
const INCIDENT_DEPLOY_PROXIMITY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Deploy `source` values that represent a REAL, authoritative deployment feed
 * (GitHub Deployments API, a published release, or a deploy workflow run) as
 * opposed to the `merge_proxy` heuristic (a merge-to-default treated as a deploy
 * because no deploy feed is connected). Drives MetricResult.dataSource for the
 * deploy-count DORA metrics so a real feed can show a benchmark band (SPEC §8.1).
 */
const REAL_DEPLOY_SOURCES = new Set(['deployments_api', 'release', 'workflow'])

/**
 * Classify the provenance of a set of deploy records for benchmark gating.
 *
 * 'real' iff there is at least one deploy AND every deploy comes from a real,
 * authoritative source (none is the `merge_proxy` heuristic). A single proxy
 * deploy in the set is enough to downgrade the whole metric to 'proxy' — the
 * conservative default, since the aggregate then rests partly on a heuristic.
 * An empty set is 'proxy' (no evidence of a real feed).
 */
function deployDataSource(deploys) {
  if (deploys.length === 0) return 'proxy'
  for (const d of deploys) {
    if (!REAL_DEPLOY_SOURCES.has(d.source)) return 'proxy'
  }
  return 'real'
}

/**
 * The first/final Done transitions of an issue and how many times it was
 * reopened (a Done→non-Done transition after a prior Done).
 *
 * Recovery time anchors on the FIRST Done transition (SPEC §8.6: "a 1h-resolved-
 * then-reopened incident recovers in 1h, not 25h"), so we compute it from the
 * transition log rather than the issue's terminal `resolvedAt` (which is the
 * FINAL resolution and would over-count reopened incidents).
 */

/**
 * Derive first/final Done transitions + reopen count for an issue from its
 * (chronologically sorted) transition log against the resolved Done status set.
 * Falls back to the issue's terminal `resolvedAt` when the issue carries no
 * transitions but is itself marked resolved — an honest best-effort anchor when
 * the changelog was not ingested, rather than dropping a genuinely-resolved
 * incident.
 */
function resolutionTrace(issue, transitions, doneStatusIds) {
  const sorted = [...transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  let firstResolvedAt = null
  let finalResolvedAt = null
  let reopenCount = 0
  let currentlyDone = false

  for (const t of sorted) {
    const toDone = doneStatusIds.has(t.toStatusId)
    if (toDone) {
      if (firstResolvedAt === null) firstResolvedAt = t.transitionedAt
      finalResolvedAt = t.transitionedAt
      currentlyDone = true
    } else if (currentlyDone) {
      // Leaving a Done status after having reached it = a reopen.
      reopenCount += 1
      currentlyDone = false
    }
  }

  // No Done transition in the log but the issue is terminally resolved: anchor
  // on resolvedAt (changelog absent / not ingested) rather than discard it.
  if (firstResolvedAt === null && sorted.length === 0 && issue.resolvedAt !== null) {
    firstResolvedAt = issue.resolvedAt
    finalResolvedAt = issue.resolvedAt
  }

  return { firstResolvedAt, finalResolvedAt, reopenCount }
}

/**
 * Build incident records from Jira issues of type 'Incident' created within the
 * window, plus a PROXY deploy↔incident linkage.
 *
 * Resolution: firstResolvedAt/finalResolvedAt + reopenCount come from the
 * issue's transition log (first vs. final Done transition), not the terminal
 * `resolvedAt`, so MTTR anchors on the first recovery (SPEC §8.6).
 *
 * Linkage (PROXY — there is no authoritative deploy↔incident join in the store):
 * each incident is attributed to the MOST RECENT production deployment whose
 * createdAt precedes the incident's createdAt within INCIDENT_DEPLOY_PROXIMITY_MS.
 * This is the standard DORA CFR temporal-proximity approximation. Note: Jira
 * incidents carry no repo, so linkage is across ALL synced repos (consistent
 * with the single-team aggregate scope model — see module header §6.5); it is a
 * heuristic, not a causal link. Incidents with no preceding deploy in the window
 * are left unlinked (linkedDeployId = null) and so do not inflate CFR.
 *
 * `prodDeploys` MUST be the production deployments already filtered/projected by
 * the caller; they are matched purely on createdAt ordering here.
 */
function buildIncidents(issues, transitionsByIssue, doneStatusIds, prodDeploys, fromMs, toMs) {
  // Deploys sorted oldest→newest so we can pick the most recent preceding one.
  const sortedDeploys = [...prodDeploys].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  const incidents = []
  for (const issue of issues) {
    if (issue.type.toLowerCase() !== 'incident') continue
    if (!inWindow(issue.createdAt, fromMs, toMs)) continue

    const openedMs = new Date(issue.createdAt).getTime()
    let linkedDeployId = null
    if (Number.isFinite(openedMs)) {
      // Walk newest→oldest; first deploy that precedes the incident within the
      // proximity window wins (most-recent preceding deploy).
      for (let i = sortedDeploys.length - 1; i >= 0; i--) {
        const d = sortedDeploys[i]
        if (d === undefined) continue
        const deployMs = new Date(d.createdAt).getTime()
        if (!Number.isFinite(deployMs)) continue
        if (deployMs > openedMs) continue
        if (openedMs - deployMs > INCIDENT_DEPLOY_PROXIMITY_MS) break
        linkedDeployId = d.id
        break
      }
    }

    const trace = resolutionTrace(issue, transitionsByIssue.get(issue.id) ?? [], doneStatusIds)
    incidents.push({
      id: issue.id,
      linkedDeployId,
      createdAt: issue.createdAt,
      firstResolvedAt: trace.firstResolvedAt,
      finalResolvedAt: trace.finalResolvedAt,
      reopenCount: trace.reopenCount,
    })
  }
  return incidents
}

// ---------------------------------------------------------------------------
// PR review aggregation
// ---------------------------------------------------------------------------

function allReviewInputs(data) {
  const out = []
  for (const revs of data.reviewsByPr.values()) {
    for (const r of revs) out.push(toReviewInput(r))
  }
  return out
}

function allReviewCommentInputs(data) {
  const out = []
  for (const comments of data.reviewCommentsByPr.values()) {
    for (const c of comments) out.push(toReviewCommentInput(c))
  }
  return out
}

// ---------------------------------------------------------------------------
// Sprint / board discovery
// ---------------------------------------------------------------------------

/**
 * Discover every sprint in the install. The Store has no enumerate-boards API,
 * so we probe each Jira project id as a candidate board id, then expand the set
 * with the board ids of any sprints found (a sprint's board id may differ from
 * the project id). Sprints found under any discovered board are returned.
 */
/**
 * Discover every sprint in the install via a direct store enumeration.
 *
 * Sprints are keyed by agile-board id, which does NOT share a namespace with
 * Jira project ids — so the previous project-id-probing heuristic discovered
 * nothing on a real install (board ids only coincided with project ids in test
 * fixtures), leaving the whole agile family permanently no_data. `data` is kept
 * in the signature for call-site compatibility.
 */
async function loadAllSprints(store, _data) {
  return store.listAllSprints()
}

/** Build the agile IssueRecord projection used by velocity. */
function toIssueRecord(issue) {
  return {
    id: issue.id,
    hierarchyLevel: issue.hierarchyLevel,
    parentId: issue.parentId,
    isSubtask: issue.isSubtask,
    storyPoints: issue.storyPoints,
    storyPointsFieldMapped: issue.storyPointsFieldId !== null,
    statusCategory: issue.statusCategory,
    completedInSprintIds: [],
    wasReopened: false,
    type: issue.type,
  }
}

/** Compute a single sprint's committed/completed points via sprintVelocity. */
async function sprintPoints(store, data, sprint, now) {
  const boardConfig = await store.getBoardConfig(sprint.boardId)
  const membershipEvents = await store.getSprintMembershipEvents(sprint.id)
  const sprintRecord = {
    id: sprint.id,
    boardId: sprint.boardId,
    type: boardConfig?.type ?? 'scrum',
    startAt: sprint.startAt,
    endAt: sprint.endAt,
    completeAt: sprint.completeAt,
  }
  const memberEvents = membershipEvents.map((e) => ({
    sprintId: e.sprintId,
    issueId: e.issueId,
    change: e.change,
    pointsAtEvent: e.pointsAtEvent,
    transitionedAt: e.transitionedAt,
    wasPresentAtStart: e.wasPresentAtStart,
  }))
  const issueRecords = data.issues.map(toIssueRecord)
  const result = sprintVelocity.compute(
    { sprint: sprintRecord, membershipEvents: memberEvents, issues: issueRecords },
    now,
  )
  return { committed: result.committed, completed: result.completed }
}

/**
 * Build pointed/completed estimation pairs: pointed issues resolved (done) within
 * the window, with cycle time = resolvedAt − createdAt (seconds). The module
 * itself excludes 0-point issues and applies the significance/sample guards.
 */
function buildEstimationPairs(data, fromMs, toMs) {
  const pairs = []
  for (const issue of data.issues) {
    if (issue.storyPoints === null || issue.storyPoints <= 0) continue
    if (issue.statusCategory !== 'done') continue
    if (!inWindow(issue.resolvedAt, fromMs, toMs)) continue
    const createdMs = new Date(issue.createdAt).getTime()
    const resolvedMs = new Date(issue.resolvedAt).getTime()
    if (!Number.isFinite(createdMs) || !Number.isFinite(resolvedMs)) continue
    pairs.push({
      issueId: issue.id,
      storyPoints: issue.storyPoints,
      cycleTimeSeconds: Math.max(0, (resolvedMs - createdMs) / 1000),
      wasReopened: false,
    })
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Code metric projection (from ingested pr_files)
// ---------------------------------------------------------------------------

/**
 * Reconstruct the unified-diff string that `computeHaloc` (in halocAggregate)
 * expects from a PR file's stored patch. The stored patch is the GitHub
 * files-API body (hunk headers + +/- lines), WITHOUT the `diff --git` header
 * the parser anchors each file on — so we prepend it (and `---`/`+++` markers
 * when absent). Files with no patch (binary/oversized) contribute an empty
 * section (HALOC 0) rather than being dropped silently.
 */
function reconstructFileDiff(path, patch) {
  if (patch === null || patch === '') return `diff --git a/${path} b/${path}\n`
  const header = `diff --git a/${path} b/${path}\n`
  const hasFileMarkers = /^---\s|\n---\s/.test(patch)
  const markers = hasFileMarkers ? '' : `--- a/${path}\n+++ b/${path}\n`
  return `${header}${markers}${patch}\n`
}

/**
 * Build one CodeChangeRecord per PR (id = PR id) from the window's pr_files.
 * `diff` is the concatenation of each file's reconstructed unified diff so
 * halocAggregate recomputes HALOC over the real ingested patches.
 */
function buildCodeChanges(data) {
  const changes = []
  for (const pr of data.prs) {
    const files = data.prFilesByPr.get(pr.id)
    if (!files || files.length === 0) continue
    const diff = files.map((f) => reconstructFileDiff(f.path, f.patch)).join('')
    changes.push({
      id: pr.id,
      author: pr.authorIdentityId,
      changedAt: pr.createdAt,
      diff,
      filePaths: files.map((f) => f.path),
    })
  }
  return changes
}

/**
 * Total HALOC across the window's pr_files (denormalised per-file haloc),
 * filtering generated/vendored files so lockfiles / .min.js / vendor blobs
 * never enter the authored-code total. Mirrors the per-file filter that
 * `toPrInput` applies for pr.size.
 */
function totalWindowHaloc(data) {
  let total = 0
  for (const files of data.prFilesByPr.values()) {
    for (const f of files) {
      if (f.isGenerated) continue
      total += f.haloc
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// no_data fallback
// ---------------------------------------------------------------------------

/** Metric module catalogue keyed by id, for trustTier/scope/formulaDoc lookup. */
const MODULES = {
  'dora.deployment_frequency': deploymentFrequency,
  'dora.lead_time': leadTime,
  'dora.change_failure_rate': changeFailureRate,
  'dora.recovery_time': recoveryTime,
  'dora.deployment_rework_rate': deploymentReworkRate,
  'dora.reliability_proxy': reliabilityProxy,
  'dora.incident_reopen_rate': incidentReopenRate,
  'flow.cycle_time': cycleTime,
  'flow.throughput': throughput,
  'flow.flow_efficiency': flowEfficiency,
  'flow.wip_load': wipLoad,
  'flow.aging_wip': agingWip,
  'flow.flow_distribution': flowDistribution,
  'flow.cfd': cfd,
  'flow.time_in_status': timeInStatus,
  'flow.monte_carlo_forecast': monteCarlo,
  'pr.cycle_time': prCycleTime,
  'pr.review_latency': reviewLatency,
  'pr.time_to_first_review': timeToFirstReview,
  'pr.time_to_merge': timeToMerge,
  'pr.size': prSize,
  'pr.ci_health': ciHealth,
  'pr.stale': stalePr,
  'pr.reviewer_load_gini': reviewerLoad,
  'pr.merge_without_review_rate': mergeWithoutReviewRate,
  'pr.review_coverage': reviewCoverage,
  'pr.reviewers_per_pr': reviewersPerPr,
  'pr.comments_per_pr': commentsPerPr,
  'pr.review_iterations': reviewIterations,
  'agile.say_do': sayDo,
  'agile.sprint_velocity': sprintVelocity,
  'agile.sprint_predictability': sprintPredictability,
  'agile.estimation_accuracy': estimationAccuracy,
  'code.haloc_aggregate': halocAggregate,
  'code.nagappan_ball': nagappanBall,
  'code.change_impact': codeChangeImpact,
  'person.review_reciprocity': reviewReciprocity,
  'person.knowledge_ownership_index': knowledgeOwnership,
  'person.ai_blend_rework_coupling': aiBlendCoupling,
  'person.ci_green_before_merge_rate': ciGreenBeforeMerge,
  'person.ticket_linkage_rate': ticketLinkageRate,
  'person.test_inclusion_rate': testInclusionRate,
  'person.wip_small_pr_discipline': smallPrDiscipline,
  'pr.changes_requested_rate_received': changesRequestedReceived,
  'pr.review_bypass_rate_received': reviewBypassReceived,
  'pr.feedback_response_latency': feedbackResponseLatency,
  'person.complexity_authored_delta': complexityAuthoredDelta,
  'person.high_complexity_file_share': highComplexityFileShare,
  'person.pr_conceptual_surface': prConceptualSurface,
  'person.worktype_mix': worktypeMix,
  'person.bugfix_share': bugfixShare,
  'person.skill_domain_footprint': skillDomainFootprint,
  'person.self_baseline_drift': selfBaselineDrift,
  'person.momentum_vs_team': momentumVsTeam,
  'person.design_bearing_ratio': designBearingRatio,
  'person.pr_review_difficulty': prReviewDifficulty,
  'person.pr_atomicity': prAtomicity,
  'person.pr_description_quality': prDescriptionQuality,
  'person.convention_adherence': conventionAdherence,
  'pr.feedback_severity_mix_received': feedbackSeverityMix,
  'person.review_depth_mentorship': reviewDepthMentorship,
}

/**
 * Public transparency lookup for `explain_metric`. Returns the engine module's
 * own `formulaDoc` (and trustTier/scope) keyed by the FULLY-QUALIFIED metric id
 * the get_* tools and schema guide use (e.g. 'dora.lead_time',
 * 'code.haloc_aggregate', 'person.review_reciprocity'). Returns null for an
 * unknown id so the caller can report `found: false` honestly. Sourcing the doc
 * from the module — rather than a hand-maintained short-name table — keeps
 * explain_metric in lockstep with what the engine actually computes and covers
 * all wired metrics, not a curated subset.
 */
export function metricFormulaDoc(metricId) {
  const mod = MODULES[metricId]
  if (mod === undefined) return null
  return {
    formulaDoc: mod.formulaDoc ?? `Metric ${metricId} is wired but carries no formula doc.`,
    trustTier: mod.trustTier ?? 'deterministic',
    scope: mod.scope ?? 'team',
  }
}

/** Every fully-qualified metric id the engine has a module for. */
export function knownMetricIds() {
  return Object.keys(MODULES)
}

/** Best-effort default unit for an unknown metric, derived from its id family. */
function defaultUnitFor(metricId) {
  if (metricId.endsWith('_rate') || metricId.includes('failure') || metricId.includes('say_do')) {
    return 'ratio'
  }
  if (metricId.includes('time') || metricId.includes('latency') || metricId.includes('recovery')) {
    return 'seconds'
  }
  return 'count'
}

// Specific no_data reasons for code.* metrics whose required inputs we do not
// yet ingest. These name the EXACT missing input (honest scoping, SPEC §8.4),
// not a blanket "code metrics unsupported" short-circuit.
const COMPLEXITY_DELTA_NO_DATA =
  'code.complexity_delta has no ingested whole-file complexity for this window: ' +
  'no supported-language (JS/TS/Python/Go) files were analysed at the PRs base/head ' +
  'refs — either no such files changed, or their contents were unavailable (binary, ' +
  '>1MB, or fetch failure). Returns no_data until such files are ingested (SPEC §8.4).'
const MAINTAINABILITY_INDEX_NO_DATA =
  'code.maintainability_index has no ingested whole-file complexity for this window: ' +
  'no supported-language (JS/TS/Python/Go) files were analysed at the PR head refs to ' +
  'derive average cyclomatic complexity and LOC. Returns no_data until such files are ' +
  'ingested (SPEC §8.4).'
const REWORK_CHURN_NO_DATA =
  'code.rework_churn requires per-line git blame (author + commit age) to classify ' +
  'New / Legacy-Refactor / Help-Others / Rework lines; the GitHub API does not ' +
  'expose blame and we do not ingest it. Returns no_data until git-blame ingestion ' +
  'is added (SPEC §8.4).'

/** Build a valid no_data MetricResult for an unsupported / undatable metric. */
function noDataResult(metricId, scope, asOf, formulaDocOverride) {
  const mod = MODULES[metricId]
  return {
    id: metricId,
    trustTier: mod?.trustTier ?? 'deterministic',
    scope: mod?.scope ?? scope,
    value: null,
    unit: defaultUnitFor(metricId),
    dataQuality: 'no_data',
    engineVersion: ENGINE_VERSION,
    asOf,
    formulaDoc:
      formulaDocOverride ??
      mod?.formulaDoc ??
      `Metric ${metricId} is not available at this scope. Code/quality and other ` +
        'per-person signals are computed by get_person_report, not the team metric ' +
        'tools; team-scoped metrics return no_data when requested for a person.',
  }
}

// ---------------------------------------------------------------------------
// computeMetric
// ---------------------------------------------------------------------------

/**
 * Internal metric dispatch over the already-loaded ScopeData. Returns the raw
 * MetricResult (un-annotated). computeMetric loads `data`, calls this, then runs
 * the anti-gaming annotation pass over the same `data` (no second store read).
 */
async function computeRaw(store, scopeType, metricId, windowFrom, windowTo, now, data) {
  const fromMs = dayStartMs(windowFrom)
  const toMs = dayEndMs(windowTo)
  const winDays = windowDays(windowFrom, windowTo)

  switch (metricId) {
    // --- DORA -------------------------------------------------------------
    // dataSource: deploy-count DORA metrics (frequency / lead time) are REAL
    // when every backing deploy comes from an authoritative feed; a `merge_proxy`
    // deploy downgrades them to proxy. The incident-linked metrics (CFR / MTTR /
    // reopen / reliability / rework) rest on the temporal-proximity incident
    // linkage (WS-3) — a heuristic with no authoritative deploy↔incident join in
    // the store — so they are always 'proxy'. dataSource gates the benchmark band
    // downstream; the preset's `proxy` flag means proxy-CAPABLE, real data wins.
    case 'dora.deployment_frequency': {
      const deploys = data.deploys.map(toDeployRecord)
      const result = deploymentFrequency.compute({ deploys, windowDays: winDays }, now)
      return { ...result, dataSource: deployDataSource(deploys) }
    }

    case 'dora.lead_time': {
      const deploys = data.deploys.map(toDeployRecord)
      const result = leadTime.compute(
        {
          deploys,
          prs: data.prs.map(toPrRecord),
          commits: data.commits,
          windowDays: winDays,
        },
        now,
      )
      return { ...result, dataSource: deployDataSource(deploys) }
    }

    case 'dora.change_failure_rate': {
      // PROXY linkage: incidents are attributed to the most-recent preceding
      // production deploy (INCIDENT_DEPLOY_PROXIMITY_MS). Numerator = distinct
      // deploys with ≥1 linked incident; denominator = all prod deploys. Module
      // returns no_data when there are zero prod deploys in the window.
      const { doneIds } = await buildStatusBoundaries(store, data)
      const deploys = data.deploys.map(toDeployRecord)
      const prodDeploys = deploys.filter((d) => isProductionEnv(d.environment))
      const incidents = buildIncidents(
        data.issues,
        data.transitionsByIssue,
        doneIds,
        prodDeploys,
        fromMs,
        toMs,
      )
      const deployIncidentLinks = incidents
        .filter((i) => i.linkedDeployId !== null)
        .map((i) => ({ deployId: i.linkedDeployId, incidentIssueId: i.id }))
      // dataSource is always 'proxy': the deploy↔incident linkage is the
      // temporal-proximity heuristic (WS-3), never an authoritative join.
      const result = changeFailureRate.compute({ deploys, deployIncidentLinks }, now)
      return { ...result, dataSource: 'proxy' }
    }

    case 'dora.recovery_time': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      const prodDeploys = data.deploys
        .map(toDeployRecord)
        .filter((d) => isProductionEnv(d.environment))
      // Prefer REAL deployment-to-recovery time (failed→next-success deploy) from
      // ingested statuses; fall back to the proximity-linked incident set when no
      // failed deployment is observed. dataSource follows the signal actually used.
      const result = recoveryTime.compute(
        {
          deploys: prodDeploys,
          environment: 'production',
          incidents: buildIncidents(
            data.issues,
            data.transitionsByIssue,
            doneIds,
            prodDeploys,
            fromMs,
            toMs,
          ),
        },
        now,
      )
      return { ...result, dataSource: result.recoverySource === 'deployment' ? 'real' : 'proxy' }
    }

    case 'dora.incident_reopen_rate': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      const prodDeploys = data.deploys
        .map(toDeployRecord)
        .filter((d) => isProductionEnv(d.environment))
      // dataSource 'proxy': derived from the proximity-linked incident set.
      const result = incidentReopenRate.compute(
        {
          incidents: buildIncidents(
            data.issues,
            data.transitionsByIssue,
            doneIds,
            prodDeploys,
            fromMs,
            toMs,
          ),
        },
        now,
      )
      return { ...result, dataSource: 'proxy' }
    }

    case 'dora.reliability_proxy': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      const prodDeploys = data.deploys
        .map(toDeployRecord)
        .filter((d) => isProductionEnv(d.environment))
      // dataSource 'proxy': derived from the proximity-linked incident set.
      const result = reliabilityProxy.compute(
        {
          incidents: buildIncidents(
            data.issues,
            data.transitionsByIssue,
            doneIds,
            prodDeploys,
            fromMs,
            toMs,
          ),
          windowDays: winDays,
        },
        now,
      )
      return { ...result, dataSource: 'proxy' }
    }

    case 'dora.deployment_rework_rate': {
      // Hotfix/unplanned deploys: (a) incident-linked prod deploys (the proxy
      // CFR linkage above), unioned with (b) deploys whose source signals a
      // hotfix (branch/source heuristic). We only have `source` ∈ {deployments_api,
      // release, workflow, merge_proxy} here — none of which is a hotfix marker —
      // so the rework signal is driven entirely by incident linkage, which is the
      // honest available signal. Module returns no_data on zero prod deploys.
      const { doneIds } = await buildStatusBoundaries(store, data)
      const deploys = data.deploys.map(toDeployRecord)
      const prodDeploys = deploys.filter((d) => isProductionEnv(d.environment))
      const incidents = buildIncidents(
        data.issues,
        data.transitionsByIssue,
        doneIds,
        prodDeploys,
        fromMs,
        toMs,
      )
      const hotfixDeployIds = new Set(
        incidents.map((i) => i.linkedDeployId).filter((id) => id !== null),
      )
      // dataSource 'proxy': rework is driven by the proximity-linked incident set.
      const result = deploymentReworkRate.compute({ deploys, hotfixDeployIds }, now)
      return { ...result, dataSource: 'proxy' }
    }

    // --- Flow -------------------------------------------------------------
    case 'flow.cycle_time': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      return cycleTime.compute(
        {
          issues: flowIssues,
          boardColumns,
          resolveFlowState: () => null,
          windowStart: dayStartIso(windowFrom),
          windowEnd: dayEndIso(windowTo),
          now,
        },
        now,
      )
    }

    case 'flow.throughput': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      return throughput.compute(
        {
          issues: flowIssues,
          doneStatusIds: doneIds,
          windowStart: dayStartIso(windowFrom),
          windowEnd: dayEndIso(windowTo),
        },
        now,
      )
    }

    case 'flow.flow_efficiency': {
      const { doneIds, startedIds } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      // Resolve flow state from the started/done sets: started → active,
      // done → done, everything else → wait (the conservative default).
      const resolver = (statusId) => {
        if (startedIds.has(statusId)) return 'active'
        if (doneIds.has(statusId)) return 'done'
        return 'wait'
      }
      return flowEfficiency.compute(
        { issues: flowIssues, resolveFlowState: resolver, doneStatusIds: doneIds, now },
        now,
      )
    }

    case 'flow.wip_load': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      // Derive the window cycle-time p50 (in days) so Little's-Law sanity-check
      // and the stationarity guard actually fire — previously hardcoded null,
      // which made the entire avgCycleTimeDays branch permanently dead.
      const ctResult = cycleTime.compute(
        {
          issues: flowIssues,
          boardColumns,
          resolveFlowState: () => null,
          windowStart: dayStartIso(windowFrom),
          windowEnd: dayEndIso(windowTo),
          now,
        },
        now,
      )
      const avgCycleTimeDays =
        ctResult.p50Seconds !== null && ctResult.p50Seconds > 0 ? ctResult.p50Seconds / 86400 : null
      return wipLoad.compute({ issues: flowIssues, boardColumns, now, avgCycleTimeDays }, now)
    }

    case 'flow.aging_wip': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      return agingWip.compute({ issues: flowIssues, boardColumns, now }, now)
    }

    case 'flow.flow_distribution': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      const completed = flowIssues.filter((i) => firstDoneInWindow(i, doneIds, fromMs, toMs))
      return flowDistribution.compute({ issues: completed }, now)
    }

    case 'flow.time_in_status': {
      // Sum the time each issue spent in every status across its (whole) changelog.
      // The module windows nothing — it reports cumulative dwell per status — so we
      // pass every loaded issue and the injected clock for the open-interval tail.
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      return timeInStatus.compute({ issues: flowIssues, now }, now)
    }

    case 'flow.cfd': {
      // Cumulative Flow Diagram across [windowFrom, windowTo]. The flow-state
      // resolver is board-free (status category): started→active, done→done,
      // everything else→wait. Our status categories are not effective-dated in the
      // store, so the resolver ignores the `at` argument (the classification is
      // time-invariant here) — the effective-dating hook is preserved for when a
      // dated flow_state model is ingested.
      const { doneIds, startedIds } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      const resolver = (statusId) => {
        if (startedIds.has(statusId)) return 'active'
        if (doneIds.has(statusId)) return 'done'
        return 'wait'
      }
      return cfd.compute(
        {
          issues: flowIssues,
          resolveFlowState: resolver,
          windowStart: dayStartIso(windowFrom),
          windowEnd: dayEndIso(windowTo),
          now,
        },
        now,
      )
    }

    case 'flow.monte_carlo_forecast': {
      // Bootstrap forecast over historical weekly throughput. We derive the inputs
      // entirely from the already-loaded flow data:
      //   - weeklySamples: issues whose FIRST Done transition falls in each ISO week
      //     of the window (the same first-Done dedup throughput uses).
      //   - remainingItems: issues currently started-but-not-done (open WIP) — the
      //     backlog the forecast projects a completion horizon for.
      //   - seed: derived deterministically from the window bounds so the forecast
      //     is reproducible per install+window (SPEC §8.6 randomness contract) with
      //     no Math.random / Date.now.
      const { doneIds, startedIds } = await buildStatusBoundaries(store, data)
      const flowIssues = data.issues.map((i) =>
        toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []),
      )
      const weeklySamples = weeklyThroughputSamples(flowIssues, doneIds, fromMs, toMs)
      const remainingItems = countOpenWip(flowIssues, startedIds, doneIds, toMs)
      // observedWeeks = the team's ACTIVE span (first→last non-zero throughput
      // week, inclusive), not the padded window width. The sample floor must
      // count genuine observations, not leading/trailing zero-padding for weeks
      // the team did not exist or shipped nothing — otherwise the upper
      // percentiles read precise off a couple of real data points.
      const observedWeeks = activeThroughputSpan(weeklySamples)
      // remainingItems === 0 → nothing to forecast: the module returns value=null
      // with dataQuality 'ok' (no backlog, not missing data). weeklySamples empty →
      // the module returns no_data. Both are honest module-level outcomes.
      return monteCarlo.compute(
        {
          weeklySamples,
          observedWeeks,
          remainingItems,
          seed: forecastSeed(windowFrom, windowTo),
        },
        now,
      )
    }

    // --- PR ---------------------------------------------------------------
    case 'pr.cycle_time':
      return prCycleTime.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          deploys: data.deploys.map(toDeployInput),
        },
        now,
      )

    case 'pr.review_latency':
      return reviewLatency.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
        },
        now,
      )

    case 'pr.time_to_first_review':
      return timeToFirstReview.compute(
        { prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))) },
        now,
      )

    case 'pr.time_to_merge':
      return timeToMerge.compute(
        { prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))) },
        now,
      )

    case 'pr.size':
      return prSize.compute(
        { prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))) },
        now,
      )

    case 'pr.ci_health':
      return ciHealth.compute({ checkRuns: data.checkRuns }, now)

    case 'pr.stale':
      return stalePr.compute(
        {
          prs: data.prs.map((pr) => ({
            id: pr.id,
            state: pr.state,
            isDraft: pr.isDraft,
            createdAt: pr.createdAt,
            updatedAt: pr.updatedAt,
          })),
          reviews: allReviewInputs(data),
          reviewComments: allReviewCommentInputs(data),
        },
        now,
      )

    case 'pr.reviewer_load_gini':
      return reviewerLoad.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    case 'pr.merge_without_review_rate':
      return mergeWithoutReviewRate.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    case 'pr.review_coverage':
      // Merged PRs with ≥1 non-author human review / total merged PRs.
      return reviewCoverage.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    case 'pr.reviewers_per_pr':
      // Mean unique non-author, non-bot reviewers per merged PR.
      return reviewersPerPr.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    case 'pr.comments_per_pr':
      // Mean review comments per merged PR — uses the REAL ingested comments.
      return commentsPerPr.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: allReviewCommentInputs(data),
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    case 'pr.review_iterations':
      // Mean changes_requested rounds (each followed by a later review) per merged PR.
      return reviewIterations.compute(
        {
          prs: data.prs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id))),
          reviews: allReviewInputs(data),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )

    // --- Agile ------------------------------------------------------------
    case 'agile.say_do': {
      const sprints = (await loadAllSprints(store, data)).filter((s) =>
        inWindow(s.completeAt, fromMs, toMs),
      )
      let committed = 0
      let completed = 0
      let any = false
      for (const sprint of sprints) {
        const pts = await sprintPoints(store, data, sprint, now)
        if (pts.committed != null && pts.completed != null) {
          committed += pts.committed
          completed += pts.completed
          any = true
        }
      }
      return sayDo.compute(
        { committed: any ? committed : null, completed: any ? completed : null },
        now,
      )
    }

    case 'agile.sprint_velocity': {
      const sprints = (await loadAllSprints(store, data))
        .filter((s) => inWindow(s.completeAt, fromMs, toMs))
        .sort(
          (a, b) => new Date(b.completeAt ?? 0).getTime() - new Date(a.completeAt ?? 0).getTime(),
        )
      const latest = sprints[0]
      if (!latest) return noDataResult(metricId, scopeType, now)
      const boardConfig = await store.getBoardConfig(latest.boardId)
      const membershipEvents = await store.getSprintMembershipEvents(latest.id)
      const sprintRecord = {
        id: latest.id,
        boardId: latest.boardId,
        type: boardConfig?.type ?? 'scrum',
        startAt: latest.startAt,
        endAt: latest.endAt,
        completeAt: latest.completeAt,
      }
      const memberEvents = membershipEvents.map((e) => ({
        sprintId: e.sprintId,
        issueId: e.issueId,
        change: e.change,
        pointsAtEvent: e.pointsAtEvent,
        transitionedAt: e.transitionedAt,
        wasPresentAtStart: e.wasPresentAtStart,
      }))
      const issueRecords = data.issues.map(toIssueRecord)
      const latestResult = sprintVelocity.compute(
        {
          sprint: sprintRecord,
          membershipEvents: memberEvents,
          issues: issueRecords,
        },
        now,
      )
      // HONESTY: the headline `value` is the LATEST sprint's completed points,
      // not a window total/trend. Surface sprintCount + the window average of
      // completed points across all in-window sprints so a consumer never reads
      // a single sprint as the period's velocity.
      const completedAcrossWindow = []
      for (const s of sprints) {
        const bc = await store.getBoardConfig(s.boardId)
        const events = (await store.getSprintMembershipEvents(s.id)).map((e) => ({
          sprintId: e.sprintId,
          issueId: e.issueId,
          change: e.change,
          pointsAtEvent: e.pointsAtEvent,
          transitionedAt: e.transitionedAt,
          wasPresentAtStart: e.wasPresentAtStart,
        }))
        const r = sprintVelocity.compute(
          {
            sprint: {
              id: s.id,
              boardId: s.boardId,
              type: bc?.type ?? 'scrum',
              startAt: s.startAt,
              endAt: s.endAt,
              completeAt: s.completeAt,
            },
            membershipEvents: events,
            issues: issueRecords,
          },
          now,
        )
        if (r.completed !== null) completedAcrossWindow.push(r.completed)
      }
      const windowAvgCompleted =
        completedAcrossWindow.length > 0
          ? completedAcrossWindow.reduce((a, b) => a + b, 0) / completedAcrossWindow.length
          : null
      return {
        ...latestResult,
        sprintCount: sprints.length,
        sprintId: latest.id,
        sprintName: latest.name ?? null,
        isLatestSprintOnly: true,
        windowAvgCompleted,
      }
    }

    case 'agile.sprint_predictability': {
      const sprints = (await loadAllSprints(store, data)).filter((s) =>
        inWindow(s.completeAt, fromMs, toMs),
      )
      const records = []
      for (const sprint of sprints) {
        const pts = await sprintPoints(store, data, sprint, now)
        if (pts.committed != null && pts.completed != null) {
          records.push({ sprintId: sprint.id, committed: pts.committed, completed: pts.completed })
        }
      }
      return sprintPredictability.compute({ sprints: records }, now)
    }

    case 'agile.estimation_accuracy':
      return estimationAccuracy.compute({ pairs: buildEstimationPairs(data, fromMs, toMs) }, now)

    // --- Code (Group D) ----------------------------------------------------
    case 'code.haloc_aggregate': {
      // REAL: recomputes HALOC over the ingested per-PR diffs. Returns no_data
      // inside the module when no pr_files were ingested for the window.
      const changes = buildCodeChanges(data)
      const result = halocAggregate.compute({ changes }, now)
      // GraphQL ingestion stores per-file HALOC in the denormalised column but
      // leaves pr_files.patch NULL, so the diff-recompute above only sees the
      // files whose patch has been backfilled. The denormalised column is the
      // authoritative, ALWAYS-complete source (set for every file at ingest, and
      // upgraded to the patch-derived value when a file is later backfilled), so
      // the recompute total can never legitimately EXCEED it — it equals the
      // denorm total only once every file in the window has a patch.
      //
      // Therefore: whenever the recompute is incomplete (totalHaloc < denorm),
      // use the complete denorm total. This covers BOTH the 0%-backfilled case
      // (recompute 0) AND — critically — the PARTIALLY-backfilled case the
      // post-sync auto-backfill creates, where a non-zero-but-undercounted
      // recompute would otherwise be reported at "ok" quality (a silent
      // undercount). The precise per-hunk recompute is only trusted when it has
      // seen the whole window (totalHaloc === denorm). `halocSource` records the
      // path for transparency.
      const denormHaloc = totalWindowHaloc(data)
      if (denormHaloc > 0 && result.totalHaloc < denormHaloc) {
        return {
          ...result,
          value: denormHaloc,
          totalHaloc: denormHaloc,
          avgHalocPerChange: result.changeCount > 0 ? denormHaloc / result.changeCount : null,
          halocSource: 'denormalized_prfile_column',
        }
      }
      return { ...result, halocSource: 'recomputed_from_patch' }
    }

    case 'code.nagappan_ball': {
      // M1 (relative churn) and M2 (churn rate) are REAL from the window HALOC,
      // the prior rolling HALOC, and the window length. M3 (rework density)
      // needs git blame to classify Rework lines, which we do not ingest, so
      // reworkLines is 0 (no lines classified) — the module's formulaDoc states
      // M3 = reworkLines/(totalLines+1). The headline value is M1.
      const haloc = totalWindowHaloc(data)
      let changedLines = 0
      for (const files of data.prFilesByPr.values()) {
        // Filter generated/vendored files: lockfile churn is not authored intent
        // and would inflate the rework-rate denominator at scale.
        for (const f of files) {
          if (f.isGenerated) continue
          changedLines += f.additions + f.deletions
        }
      }
      return nagappanBall.compute(
        {
          haloc,
          priorHaloc: data.priorHaloc,
          windowDays: winDays,
          // Blame not ingested → rework lines are NOT MEASURED. Pass null (not 0)
          // so M3 reports null rather than a misleading "0 rework density" that is
          // indistinguishable from a genuine zero (see REWORK_CHURN_NO_DATA).
          reworkLines: null,
          totalLines: changedLines,
        },
        now,
      )
    }

    case 'code.change_impact': {
      // REAL deterministic blend over the window's diffs: HALOC, file paths
      // (directory spread + entropy), file count. legacyRefactorLines needs
      // blame (not ingested) so old_code_pct is null (the module handles it).
      const haloc = totalWindowHaloc(data)
      const filePaths = []
      let changedLines = 0
      for (const files of data.prFilesByPr.values()) {
        for (const f of files) {
          // Same rationale as nagappan_ball above: generated files are not
          // authored conceptual surface, do not feed the entropy of directories.
          if (f.isGenerated) continue
          filePaths.push(f.path)
          changedLines += f.additions + f.deletions
        }
      }
      if (filePaths.length === 0) {
        return noDataResult(
          metricId,
          scopeType,
          now,
          `${codeChangeImpact.formulaDoc} NOTE: no pr_files ingested for this window.`,
        )
      }
      return codeChangeImpact.compute(
        { haloc, filePaths, legacyRefactorLines: 0, totalLines: changedLines },
        now,
      )
    }

    case 'code.complexity_delta': {
      // Pair base↔head file complexity (ingested per-PR via tree-sitter) for each
      // changed code file of the window's PRs. Paths are namespaced by PR id so
      // the same file touched by two PRs is matched within its own PR, not across.
      //
      // PERF: pr_refs and file_complexity are window-INDEPENDENT, so the loader
      // bulk-loads them into data.prRefById / data.fileComplexityByKey once per
      // backfill. We read from those maps instead of doing one point query per
      // PR (×~120 days) + one per file (×~120 days), which was an N+1 storm.
      // Falls back to the point queries when a caller built `data` without the
      // bulk maps (defensive; tests + on-demand callers go through the loaders).
      const getPrRef = (prId) =>
        data.prRefById ? (data.prRefById.get(prId) ?? null) : store.getPrRef(prId)
      const getFc = (repoId, sha, path) =>
        data.fileComplexityByKey
          ? (data.fileComplexityByKey.get(fcKey(repoId, sha, path)) ?? null)
          : store.getFileComplexity(repoId, sha, path)
      const head = []
      const base = []
      for (const [prId, files] of data.prFilesByPr) {
        const ref = await getPrRef(prId)
        if (!ref?.headSha) continue
        for (const f of files) {
          const headC = await getFc(ref.repoId, ref.headSha, f.path)
          if (!headC) continue
          const key = `${prId}::${f.path}`
          head.push({ path: key, complexity: { functions: headC.functions } })
          const baseC = ref.baseSha ? await getFc(ref.repoId, ref.baseSha, f.path) : null
          if (baseC) base.push({ path: key, complexity: { functions: baseC.functions } })
        }
      }
      if (head.length === 0) {
        return noDataResult(metricId, scopeType, now, COMPLEXITY_DELTA_NO_DATA)
      }
      return complexityDelta.compute({ head, base }, now)
    }

    case 'code.maintainability_index': {
      // Average cyclomatic-per-function + LOC over the head-side complexity of the
      // window's changed code files; avgHaloc from the same files' ingested diffs.
      //
      // PERF: same bulk-map strategy as code.complexity_delta above — read from
      // pre-loaded maps, fall back to point queries when absent.
      const getPrRef = (prId) =>
        data.prRefById ? (data.prRefById.get(prId) ?? null) : store.getPrRef(prId)
      const getFc = (repoId, sha, path) =>
        data.fileComplexityByKey
          ? (data.fileComplexityByKey.get(fcKey(repoId, sha, path)) ?? null)
          : store.getFileComplexity(repoId, sha, path)
      const seen = new Set()
      let sumCyclomatic = 0
      let sumLoc = 0
      let sumHaloc = 0
      let n = 0
      for (const [prId, files] of data.prFilesByPr) {
        const ref = await getPrRef(prId)
        if (!ref?.headSha) continue
        for (const f of files) {
          const key = `${ref.headSha}::${f.path}`
          if (seen.has(key)) continue
          const c = await getFc(ref.repoId, ref.headSha, f.path)
          if (!c) continue
          seen.add(key)
          sumCyclomatic += c.functionCount > 0 ? c.totalCyclomatic / c.functionCount : 0
          sumLoc += c.loc
          sumHaloc += f.haloc ?? 0
          n++
        }
      }
      if (n === 0) {
        return noDataResult(metricId, scopeType, now, MAINTAINABILITY_INDEX_NO_DATA)
      }
      return maintainabilityIndex.compute(
        { avgCyclomatic: sumCyclomatic / n, avgLoc: sumLoc / n, avgHaloc: sumHaloc / n },
        now,
      )
    }

    case 'code.rework_churn':
      // Needs per-line git blame; the GitHub API does not expose it.
      return noDataResult(metricId, scopeType, now, REWORK_CHURN_NO_DATA)

    default:
      return noDataResult(metricId, scopeType, now)
  }
}

// ---------------------------------------------------------------------------
// Anti-gaming annotation (SPEC §10)
// ---------------------------------------------------------------------------

/**
 * Run the relevant gaming detectors for `metricId` over the already-loaded
 * ScopeData and return any flags raised. Side-effect-free and cheap (single pass
 * per detector over in-memory arrays). Each metric family is matched to the
 * detector(s) that target the behaviour it is most vulnerable to:
 *   - deploy-count DORA (frequency / lead time): deploy-frequency inflation
 *     (non-prod deploys counted, rapid redeploys).
 *   - flow efficiency / cycle time: status juggling (rapid active⇄wait bouncing).
 *   - throughput / PR count: trivial PR splitting (a burst of tiny PRs).
 * Detectors return 'ok' when clean; we only surface non-'ok' flags.
 */
function detectGamingFor(metricId, data) {
  const flags = []

  if (metricId === 'dora.deployment_frequency' || metricId === 'dora.lead_time') {
    const r = detectDeployInflation(
      data.deploys.map((d) => ({ id: d.id, environment: d.environment, createdAt: d.createdAt })),
    )
    if (r.flag !== 'ok') flags.push({ flag: r.flag, reason: r.reason })
  }

  if (metricId === 'flow.flow_efficiency' || metricId === 'flow.cycle_time') {
    const r = detectStatusJuggling(
      data.issues.map((i) => ({
        issueId: i.id,
        transitions: (data.transitionsByIssue.get(i.id) ?? []).map((t) => ({
          fromStatusId: t.fromStatusId,
          toStatusId: t.toStatusId,
          transitionedAt: t.transitionedAt,
        })),
      })),
    )
    if (r.flag !== 'ok') flags.push({ flag: r.flag, reason: r.reason })
  }

  if (metricId === 'flow.throughput' || metricId === 'pr.size') {
    const r = detectTrivialPrSplitting(
      data.prs.map((pr) => {
        const files = data.prFilesByPr.get(pr.id) ?? []
        let size = 0
        for (const f of files) size += f.haloc
        return {
          prId: pr.id,
          authorPersonId: pr.authorIdentityId,
          size,
          createdAt: pr.createdAt,
        }
      }),
    )
    if (r.flag !== 'ok') flags.push({ flag: r.flag, reason: r.reason })
  }

  return flags
}

// ---------------------------------------------------------------------------
// computeMetric
// ---------------------------------------------------------------------------

/**
 * Compute a single metric over the store for a scope + window, then annotate the
 * result with anti-gaming signals (SPEC §10): zero or more `gamingFlags` from the
 * detectors relevant to the metric, plus a `goodhartWarning` when the metric id is
 * one that is easy to game if pinned as a hard target. Annotation NEVER changes
 * the metric `value` — it surfaces concerns for the MCP/explain/report layer.
 *
 * @param store      - the entity store to read from
 * @param scopeType  - 'team' | 'org' aggregate across all data; 'person' | 'self'
 *                     return no_data (no wired metric supports per-identity filtering)
 * @param scopeId    - the scope identifier (informational for aggregate scopes)
 * @param metricId   - the metric id to compute
 * @param windowFrom - inclusive ISO day 'YYYY-MM-DD'
 * @param windowTo   - inclusive ISO day 'YYYY-MM-DD'
 * @param now        - injected ISO timestamp (never Date.now())
 */
/**
 * Metric ids that carry a faithful PER-PERSON meaning. Person scope is an IC
 * SELF-VIEW (SPEC §11 personScope): a narrow flow slice judged against the
 * person's OWN baseline, never a ranking. Team-only metrics (DORA, anything
 * aggregated across the team — flow_efficiency, flow_distribution, reviewer-load
 * Gini, agile sprint metrics, Monte Carlo) are intentionally no_data at person
 * scope rather than fabricated per-head.
 */
const PERSON_SUPPORTED_METRICS = new Set([
  'flow.cycle_time', // issues assigned to the person
  'flow.aging_wip',
  'flow.wip_load',
  'flow.throughput',
  'pr.cycle_time', // PRs the person authored
  'pr.size',
  'pr.time_to_merge',
  'pr.time_to_first_review',
  'pr.review_latency', // review latency the person GIVES (as reviewer)
  // Q5 best-practice + Q6 feedback RECEIVED, scoped to the person's authored PRs:
  'pr.review_coverage', // were their PRs reviewed before merge?
  'pr.merge_without_review_rate', // self-merge / review-bypass on their PRs
  'pr.reviewers_per_pr', // how many reviewers their PRs draw
  'pr.comments_per_pr', // feedback density received
  'pr.review_iterations', // changes-requested rounds received (rework signal)
  'person.review_reciprocity', // reviews given vs received (collaboration balance)
  // New per-person signals computed by computePersonRaw from loaded data + extras.
  'person.knowledge_ownership_index',
  'person.ai_blend_rework_coupling',
  'person.ci_green_before_merge_rate',
  'person.ticket_linkage_rate',
  'person.test_inclusion_rate',
  'person.wip_small_pr_discipline',
  'pr.changes_requested_rate_received',
  'pr.review_bypass_rate_received',
  'pr.feedback_response_latency',
  'person.complexity_authored_delta',
  'person.high_complexity_file_share',
  'person.pr_conceptual_surface',
  'person.worktype_mix',
  'person.bugfix_share',
  'person.skill_domain_footprint',
  // Probabilistic — aggregate stored in-session-Claude verdicts (no_data until generated).
  'person.design_bearing_ratio',
  'person.pr_review_difficulty',
  'person.pr_atomicity',
  'person.pr_description_quality',
  'person.convention_adherence',
  'pr.feedback_severity_mix_received',
  'person.review_depth_mentorship',
  // NOTE: self_baseline_drift + momentum_vs_team are trend meta-metrics computed
  // by the person-report orchestrator (they need snapshots + team context), not
  // by computePersonRaw — they intentionally stay OUT of this set.
])

/**
 * Compute a single metric for a PERSON scope by attributing the loaded data to
 * the person's identities. Issue-flow metrics use the issues ASSIGNED to the
 * person; PR-authoring metrics use the PRs they AUTHORED; review latency uses the
 * reviews they GAVE. Unsupported (team-only) metrics return no_data.
 *
 * @param identityIds  Set of identity ids belonging to the person.
 */
async function computePersonRaw(store, metricId, windowFrom, windowTo, now, data, identityIds) {
  if (!PERSON_SUPPORTED_METRICS.has(metricId)) {
    return noDataResult(metricId, 'person', now)
  }

  const windowStart = dayStartIso(windowFrom)
  const windowEnd = dayEndIso(windowTo)

  // Issues assigned to the person → their flow slice.
  const assignedFlowIssues = () =>
    data.issues
      .filter((i) => i.assigneeIdentityId !== null && identityIds.has(i.assigneeIdentityId))
      .map((i) => toFlowIssueRecord(i, data.transitionsByIssue.get(i.id) ?? []))

  // PRs the person authored → their authoring slice. Derived ONCE per (data,
  // person) and reused across every metric: identityIds is the SAME Set instance
  // for all of a person's metrics (memoised in computeMetric), so a WeakMap keyed
  // by it collapses M O(all-PRs) filter scans per person down to one.
  if (!data.__personSliceByIds) data.__personSliceByIds = new WeakMap()
  const sliceMemo = data.__personSliceByIds
  let slice = sliceMemo.get(identityIds)
  if (slice === undefined) {
    const prs = data.prs.filter(
      (pr) => pr.authorIdentityId !== null && identityIds.has(pr.authorIdentityId),
    )
    slice = { authoredPrs: prs, authoredPrIds: new Set(prs.map((pr) => pr.id)) }
    sliceMemo.set(identityIds, slice)
  }
  const { authoredPrs, authoredPrIds } = slice
  const authoredPrInputs = () => authoredPrs.map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id)))

  // Reviews / comments RECEIVED on the person's authored PRs — the basis for
  // "is their work reviewed?" (coverage, merge-without-review) and "how much
  // feedback/rework do they draw?" (comments, changes-requested iterations).
  const reviewsOnAuthoredPrs = () => {
    const out = []
    for (const [prId, revs] of data.reviewsByPr) {
      if (authoredPrIds.has(prId)) for (const r of revs) out.push(toReviewInput(r))
    }
    return out
  }
  const commentsOnAuthoredPrs = () => {
    const out = []
    for (const [prId, comments] of data.reviewCommentsByPr) {
      if (authoredPrIds.has(prId)) for (const c of comments) out.push(toReviewCommentInput(c))
    }
    return out
  }

  switch (metricId) {
    case 'flow.cycle_time': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      return cycleTime.compute(
        {
          issues: assignedFlowIssues(),
          boardColumns,
          resolveFlowState: () => null,
          windowStart,
          windowEnd,
          now,
        },
        now,
      )
    }
    case 'flow.throughput': {
      const { doneIds } = await buildStatusBoundaries(store, data)
      return throughput.compute(
        { issues: assignedFlowIssues(), doneStatusIds: doneIds, windowStart, windowEnd },
        now,
      )
    }
    case 'flow.aging_wip': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      return agingWip.compute({ issues: assignedFlowIssues(), boardColumns, now }, now)
    }
    case 'flow.wip_load': {
      const { boardColumns } = await buildStatusBoundaries(store, data)
      const personFlowIssues = assignedFlowIssues()
      const ctResult = cycleTime.compute(
        {
          issues: personFlowIssues,
          boardColumns,
          resolveFlowState: () => null,
          windowStart: dayStartIso(windowFrom),
          windowEnd: dayEndIso(windowTo),
          now,
        },
        now,
      )
      const avgCycleTimeDays =
        ctResult.p50Seconds !== null && ctResult.p50Seconds > 0 ? ctResult.p50Seconds / 86400 : null
      return wipLoad.compute({ issues: personFlowIssues, boardColumns, now, avgCycleTimeDays }, now)
    }
    case 'pr.cycle_time':
      return prCycleTime.compute(
        { prs: authoredPrInputs(), deploys: data.deploys.map(toDeployInput) },
        now,
      )
    case 'pr.size':
      return prSize.compute({ prs: authoredPrInputs() }, now)
    case 'pr.time_to_merge':
      return timeToMerge.compute({ prs: authoredPrInputs() }, now)
    case 'pr.time_to_first_review':
      return timeToFirstReview.compute({ prs: authoredPrInputs() }, now)
    case 'pr.review_latency': {
      // "Review latency you give": the reviews the PERSON submitted, on the PRs
      // they reviewed. First-response = the person's first review − PR ready.
      const reviewedPrIds = new Set()
      const personReviews = []
      for (const [prId, revs] of data.reviewsByPr) {
        for (const r of revs) {
          if (identityIds.has(r.reviewerIdentityId)) {
            reviewedPrIds.add(prId)
            personReviews.push(toReviewInput(r))
          }
        }
      }
      const prs = data.prs
        .filter((pr) => reviewedPrIds.has(pr.id))
        .map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id)))
      return reviewLatency.compute({ prs, reviews: personReviews }, now)
    }
    // --- Q5 best-practice + Q6 feedback RECEIVED on the person's authored PRs ---
    // These reuse the team modules with the inputs narrowed to authored PRs, so a
    // person's "review coverage" = coverage on the PRs THEY shipped, etc.
    case 'pr.review_coverage':
      return reviewCoverage.compute(
        {
          prs: authoredPrInputs(),
          reviews: reviewsOnAuthoredPrs(),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )
    case 'pr.merge_without_review_rate':
      return mergeWithoutReviewRate.compute(
        {
          prs: authoredPrInputs(),
          reviews: reviewsOnAuthoredPrs(),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )
    case 'pr.reviewers_per_pr':
      return reviewersPerPr.compute(
        {
          prs: authoredPrInputs(),
          reviews: reviewsOnAuthoredPrs(),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )
    case 'pr.comments_per_pr':
      return commentsPerPr.compute(
        {
          prs: authoredPrInputs(),
          reviews: reviewsOnAuthoredPrs(),
          reviewComments: commentsOnAuthoredPrs(),
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )
    case 'pr.review_iterations':
      return reviewIterations.compute(
        {
          prs: authoredPrInputs(),
          reviews: reviewsOnAuthoredPrs(),
          reviewComments: [],
          botIdentityIds: data.botIdentityIds,
        },
        now,
      )
    case 'person.review_reciprocity': {
      const bots = data.botIdentityIds ?? new Set()
      // PR→author map is person-independent — build once per data, reuse per person.
      if (!data.__prAuthorById) {
        data.__prAuthorById = new Map(data.prs.map((pr) => [pr.id, pr.authorIdentityId]))
      }
      const prAuthorById = data.__prAuthorById
      // Reviews the person GAVE on OTHER people's PRs (not self-reviews).
      let reviewsGiven = 0
      const prsReviewed = new Set()
      for (const [prId, revs] of data.reviewsByPr) {
        const authorId = prAuthorById.get(prId)
        if (authorId !== undefined && identityIds.has(authorId)) continue // own PR
        for (const r of revs) {
          if (identityIds.has(r.reviewerIdentityId)) {
            reviewsGiven++
            prsReviewed.add(prId)
          }
        }
      }
      // Non-author, non-bot reviews RECEIVED on the person's authored PRs.
      let reviewsReceived = 0
      let authoredPrsWithReview = 0
      for (const pr of authoredPrs) {
        const revs = data.reviewsByPr.get(pr.id) ?? []
        let prHadReview = false
        for (const r of revs) {
          if (!identityIds.has(r.reviewerIdentityId) && !bots.has(r.reviewerIdentityId)) {
            reviewsReceived++
            prHadReview = true
          }
        }
        if (prHadReview) authoredPrsWithReview++
      }
      return reviewReciprocity.compute(
        {
          reviewsGiven,
          reviewsReceived,
          prsReviewed: prsReviewed.size,
          authoredPrsWithReview,
        },
        now,
      )
    }
    default:
      break
  }

  // --- Metrics that need the assembled person extras (pr_refs / file_complexity
  // / pr_issue_links / ai_authorship) or the in-session-Claude verdict store ----
  const bots = data.botIdentityIds ?? new Set()
  const mergedAuthored = authoredPrs.filter((pr) => pr.state === 'merged')

  switch (metricId) {
    case 'person.ticket_linkage_rate': {
      const ex = await loadPersonExtras(store, data)
      return ticketLinkageRate.compute(
        buildTicketLinkageInputs(mergedAuthored, ex.linkCountByPr),
        now,
      )
    }
    case 'person.test_inclusion_rate':
      return testInclusionRate.compute(
        buildTestInclusionInputs(mergedAuthored, data.prFilesByPr),
        now,
      )
    case 'person.wip_small_pr_discipline': {
      const allMerged = data.prs.filter((pr) => pr.state === 'merged')
      return smallPrDiscipline.compute(
        buildSmallPrInputs(mergedAuthored, allMerged, data.prFilesByPr, null),
        now,
      )
    }
    case 'pr.changes_requested_rate_received':
      return changesRequestedReceived.compute(
        buildChangesRequestedInputs(mergedAuthored, data.reviewsByPr, identityIds, bots),
        now,
      )
    case 'pr.review_bypass_rate_received':
      return reviewBypassReceived.compute(
        buildReviewBypassInputs(mergedAuthored, data.reviewsByPr, identityIds, bots),
        now,
      )
    case 'pr.feedback_response_latency':
      return feedbackResponseLatency.compute(
        buildFeedbackLatencyInputs(mergedAuthored, data.reviewsByPr, identityIds, bots),
        now,
      )
    case 'person.skill_domain_footprint':
      return skillDomainFootprint.compute(
        buildSkillDomainInputs(authoredPrs, data.prFilesByPr),
        now,
      )
    case 'person.ci_green_before_merge_rate': {
      const ex = await loadPersonExtras(store, data)
      return ciGreenBeforeMerge.compute(
        buildCiGreenInputs(mergedAuthored, ex.refByPr, ex.checkRunsByRepoSha),
        now,
      )
    }
    case 'person.complexity_authored_delta': {
      const ex = await loadPersonExtras(store, data)
      return complexityAuthoredDelta.compute(
        buildComplexityDeltaInputs(mergedAuthored, data.prFilesByPr, ex.refByPr, ex.fcByKey),
        now,
      )
    }
    case 'person.high_complexity_file_share': {
      const ex = await loadPersonExtras(store, data)
      return highComplexityFileShare.compute(
        buildHighComplexityShareInputs(
          mergedAuthored,
          data.prFilesByPr,
          ex.refByPr,
          ex.fcByKey,
          ex.cycloThresholdByRepo,
        ),
        now,
      )
    }
    case 'person.pr_conceptual_surface': {
      const ex = await loadPersonExtras(store, data)
      return prConceptualSurface.compute(
        buildConceptualSurfaceInputs(mergedAuthored, data.prFilesByPr, ex.refByPr, ex.fcByKey),
        now,
      )
    }
    case 'person.worktype_mix':
    case 'person.bugfix_share': {
      const ex = await loadPersonExtras(store, data)
      const assignedResolved = data.issues.filter(
        (i) =>
          i.assigneeIdentityId !== null &&
          identityIds.has(i.assigneeIdentityId) &&
          (i.statusCategory === 'done' || i.resolvedAt),
      )
      const built = buildWorktypeUnits(
        mergedAuthored,
        data.prFilesByPr,
        ex.issueIdsByPr,
        ex.issuesById,
        assignedResolved,
      )
      return metricId === 'person.worktype_mix'
        ? worktypeMix.compute({ buckets: built.buckets }, now)
        : bugfixShare.compute(built.bugfix, now)
    }
    case 'person.knowledge_ownership_index': {
      const ex = await loadPersonExtras(store, data)
      return knowledgeOwnership.compute(
        buildKnowledgeOwnershipInputs(
          data.prs,
          data.prFilesByPr,
          identityIds,
          ex.latestCycloByPath,
        ),
        now,
      )
    }
    case 'person.ai_blend_rework_coupling': {
      const ex = await loadPersonExtras(store, data)
      const aiScores = []
      for (const id of identityIds) {
        for (const a of ex.aiByIdentity.get(id) ?? []) aiScores.push(a.aiScore)
      }
      return aiBlendCoupling.compute(
        buildAiBlendInputs(
          mergedAuthored,
          ex.aiByEntity,
          aiScores,
          data.reviewsByPr,
          data.reviewCommentsByPr,
          identityIds,
          bots,
        ),
        now,
      )
    }
    // --- Probabilistic: aggregate stored in-session-Claude verdicts ----------
    case 'person.design_bearing_ratio':
    case 'person.pr_review_difficulty':
    case 'person.pr_atomicity':
    case 'person.pr_description_quality':
    case 'person.convention_adherence':
    case 'pr.feedback_severity_mix_received':
    case 'person.review_depth_mentorship':
      return computeVerdictMetric(store, metricId, now, {
        authoredPrIds,
        identityIds,
        reviewsByPr: data.reviewsByPr,
        reviewCommentsByPr: data.reviewCommentsByPr,
        data,
      })
    default:
      return noDataResult(metricId, 'person', now)
  }
}

/**
 * Window-INDEPENDENT per-person extras: the maps derived purely from full tables
 * (pr_issue_links, pr_refs, file_complexity, ai_authorship). These don't change
 * with the report window, so a multi-window caller (the self-baseline trend, which
 * slices the same dataset into ~13 weekly buckets) builds them ONCE and injects the
 * result into each slice via `data.__sharedPersonExtras` — instead of re-scanning
 * the (potentially huge) file_complexity table once per week.
 */
export async function loadSharedPersonExtras(store) {
  const [prIssueLinks, prRefs, fileComplexity, aiAuthorship] = await Promise.all([
    store.getAllPrIssueLinks(),
    store.getAllPrRefs(),
    store.getAllFileComplexity(),
    store.getAllAiAuthorship(),
  ])

  const linkCountByPr = new Map()
  const issueIdsByPr = new Map()
  for (const l of prIssueLinks) {
    linkCountByPr.set(l.prId, (linkCountByPr.get(l.prId) ?? 0) + 1)
    if (!issueIdsByPr.has(l.prId)) issueIdsByPr.set(l.prId, [])
    issueIdsByPr.get(l.prId).push(l.issueId)
  }

  const refByPr = new Map(prRefs.map((r) => [r.prId, r]))

  const fcByKey = new Map()
  const cycloByRepo = new Map()
  const latestCycloByPath = new Map()
  for (const f of fileComplexity) {
    fcByKey.set(fcKey(f.repoId, f.sha, f.path), f)
    if (!cycloByRepo.has(f.repoId)) cycloByRepo.set(f.repoId, [])
    cycloByRepo.get(f.repoId).push(f.totalCyclomatic)
    const pk = repoPathKey(f.repoId, f.path)
    latestCycloByPath.set(pk, Math.max(latestCycloByPath.get(pk) ?? 0, f.totalCyclomatic))
  }
  const cycloThresholdByRepo = new Map()
  for (const [repoId, vals] of cycloByRepo) cycloThresholdByRepo.set(repoId, percentile(vals, 0.75))

  const aiByEntity = new Map(aiAuthorship.map((a) => [a.entityId, a]))
  const aiByIdentity = new Map()
  for (const a of aiAuthorship) {
    if (a.authorIdentityId === null) continue
    if (!aiByIdentity.has(a.authorIdentityId)) aiByIdentity.set(a.authorIdentityId, [])
    aiByIdentity.get(a.authorIdentityId).push(a)
  }

  return {
    linkCountByPr,
    issueIdsByPr,
    refByPr,
    fcByKey,
    cycloThresholdByRepo,
    latestCycloByPath,
    aiByEntity,
    aiByIdentity,
  }
}

/**
 * Assemble the extra per-person data the richer metrics need. The window-INDEPENDENT
 * maps come from loadSharedPersonExtras (reused via `data.__sharedPersonExtras` when
 * a caller pre-built them); only the window-DEPENDENT indexes (check-runs by head
 * SHA, issues by id) are derived from the sliced `data`. Memoised on `data` so a
 * cohort loop sharing one preloaded dataset pays the cost once.
 */
async function loadPersonExtras(store, data) {
  if (data.__personExtras) return data.__personExtras
  const shared = data.__sharedPersonExtras ?? (await loadSharedPersonExtras(store))

  const checkRunsByRepoSha = new Map()
  for (const cr of data.checkRuns ?? []) {
    const k = repoShaKey(cr.repoId, cr.headSha)
    if (!checkRunsByRepoSha.has(k)) checkRunsByRepoSha.set(k, [])
    checkRunsByRepoSha.get(k).push(cr)
  }

  const issuesById = new Map(data.issues.map((i) => [i.id, i]))

  data.__personExtras = { ...shared, checkRunsByRepoSha, issuesById }
  return data.__personExtras
}

/** ai_verdicts subject_type for each probabilistic person metric. */
function verdictSubjectType(metricId) {
  if (metricId === 'person.review_depth_mentorship') return 'review'
  if (metricId === 'pr.feedback_severity_mix_received') return 'review_comment'
  return 'pull_request'
}

/**
 * Aggregate stored in-session-Claude verdicts (ai_verdicts) into a probabilistic
 * person metric. Verdicts are produced by the current Claude session (see the
 * generate_person_verdicts tool) — NEVER by an external API. Returns no_data
 * until verdicts for the person's subjects exist.
 */
async function computeVerdictMetric(store, metricId, now, ctx) {
  // Read all verdicts for this metric ONCE per data, then index. In a report's
  // cohort loop this turns 7 metrics × (P+1) persons table reads into 7 total.
  let memo = null
  if (ctx.data) {
    if (!ctx.data.__verdictsByMetric) ctx.data.__verdictsByMetric = new Map()
    memo = ctx.data.__verdictsByMetric
  }
  let verdicts = memo ? memo.get(metricId) : undefined
  if (verdicts === undefined) {
    verdicts = await store.getAiVerdictsByMetric(verdictSubjectType(metricId), metricId)
    if (memo) memo.set(metricId, verdicts)
  }

  let relevant
  if (metricId === 'person.review_depth_mentorship') {
    const reviewNodeIds = new Set()
    for (const revs of ctx.reviewsByPr.values()) {
      for (const r of revs)
        if (ctx.identityIds.has(r.reviewerIdentityId)) reviewNodeIds.add(r.nodeId)
    }
    relevant = verdicts.filter((v) => reviewNodeIds.has(v.subjectId))
  } else if (metricId === 'pr.feedback_severity_mix_received') {
    const commentNodeIds = new Set()
    for (const [prId, comments] of ctx.reviewCommentsByPr) {
      if (ctx.authoredPrIds.has(prId)) for (const c of comments) commentNodeIds.add(c.nodeId)
    }
    relevant = verdicts.filter((v) => commentNodeIds.has(v.subjectId))
  } else {
    relevant = verdicts.filter((v) => ctx.authoredPrIds.has(v.subjectId))
  }

  const j = relevant.map((r) => r.verdict)
  switch (metricId) {
    case 'person.design_bearing_ratio':
      return designBearingRatio.compute(
        {
          verdicts: relevant.map((r) => ({
            designBearing: r.verdict.designBearing === true,
            difficulty: Number(r.verdict.difficulty ?? 0),
            confidence: r.confidence,
          })),
          minConfidence: 0.5,
        },
        now,
      )
    case 'person.pr_review_difficulty':
      return prReviewDifficulty.compute({ bands: j.map((x) => Number(x.band)) }, now)
    case 'person.pr_atomicity':
      return prAtomicity.compute(
        {
          priors: j.map((x) => Number(x.prior)),
          sprawlingFlags: j.map((x) => x.sprawling === true),
        },
        now,
      )
    case 'person.pr_description_quality':
      return prDescriptionQuality.compute({ ratings: j.map((x) => String(x.rating)) }, now)
    case 'person.convention_adherence':
      return conventionAdherence.compute({ adherence: j.map((x) => String(x.adherence)) }, now)
    case 'pr.feedback_severity_mix_received':
      return feedbackSeverityMix.compute({ severities: j.map((x) => String(x.severity)) }, now)
    case 'person.review_depth_mentorship':
      return reviewDepthMentorship.compute(
        {
          threads: j.map((x) => ({
            category: String(x.category),
            complexityWeight: Number(x.complexityWeight ?? 1),
          })),
        },
        now,
      )
    default:
      return noDataResult(metricId, 'person', now)
  }
}

/**
 * Resolve a person's identity-id Set once per (data, person) and memoise it on the
 * data object. The returned Set instance is STABLE across all of a person's metrics
 * for the same data — `computePersonRaw` keys its per-person slice cache off that
 * instance. Callers holding identities already (e.g. the report, from listPersons)
 * can pre-seed `data.__identityIdsByPerson` to skip the query entirely.
 */
async function resolvePersonIdentityIds(store, data, personId) {
  if (!data.__identityIdsByPerson) data.__identityIdsByPerson = new Map()
  const memo = data.__identityIdsByPerson
  let ids = memo.get(personId)
  if (ids === undefined) {
    ids = new Set((await store.getIdentitiesByPerson(personId)).map((i) => i.id))
    memo.set(personId, ids)
  }
  return ids
}

export async function computeMetric(
  store,
  scopeType,
  scopeId,
  metricId,
  windowFrom,
  windowTo,
  now,
  preloaded,
) {
  // Unknown / unwired metric id — valid no_data result, never throw.
  if (!COMPUTE_METRIC_IDS.includes(metricId)) {
    return noDataResult(metricId, scopeType, now)
  }

  // Person/self scope: an IC self-view. Attribute the loaded data to the person's
  // identities (issues assigned / PRs authored / reviews given) and compute the
  // per-person-meaningful subset; team-only metrics stay no_data. No gaming pass
  // runs — a private self-view is advisory, not a ranking to game.
  if (scopeType === 'person' || scopeType === 'self') {
    const personData = preloaded ?? (await loadScopeData(store, windowFrom, windowTo))
    // Resolve the person's identity ids ONCE per (data, person), memoised on the
    // data object. A caller computing M metrics for the same person — or one that
    // pre-seeds this map from listPersons() (the report does) — then pays ZERO
    // identity queries instead of one per (metric × person).
    const identityIds = await resolvePersonIdentityIds(store, personData, scopeId)
    if (identityIds.size === 0) return noDataResult(metricId, scopeType, now)
    return computePersonRaw(store, metricId, windowFrom, windowTo, now, personData, identityIds)
  }

  // `loadScopeData` depends ONLY on (windowFrom, windowTo) — not on the metric or
  // scope — so a caller computing many metrics for the same window (e.g. the
  // snapshot backfill: 39 metrics × 2 scopes per day) can load it ONCE and pass it
  // in via `preloaded`, instead of re-reading the whole scope dataset per metric.
  const data = preloaded ?? (await loadScopeData(store, windowFrom, windowTo))
  const result = await computeRaw(store, scopeType, metricId, windowFrom, windowTo, now, data)

  // Goodhart caution for pin-target-sensitive metrics (independent of data).
  const goodhart = goodhartWarning(metricId)

  // Gaming detectors are side-effect-free and operate on the same in-memory
  // ScopeData already loaded for the compute (no second store read).
  const gamingFlags = detectGamingFor(metricId, data)

  if (gamingFlags.length === 0 && goodhart === null) return result
  return {
    ...result,
    ...(gamingFlags.length > 0 ? { gamingFlags } : {}),
    ...(goodhart !== null ? { goodhartWarning: goodhart.warning } : {}),
  }
}

/**
 * Live per-person insight report: every supported metric for the person, placed
 * against the human cohort (robust-z + percentile), plus an on-demand self-baseline
 * trend — routed through the anti-weaponization contract. Injects the internal
 * loaders so personReport.js stays free of a circular import.
 */
export async function computePersonReportLive(store, personId, opts) {
  return computePersonReport(store, personId, opts, {
    computeMetric,
    loadScopeData,
    loadFullScopeData,
    sliceScopeData,
    loadSharedPersonExtras,
  })
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/** Options for {@link backfillSnapshots}. */

/**
 * Backfill versioned daily snapshots over [fromDay, toDay].
 *
 * For each day D and each metric id, computes the metric over the rolling window
 * [D-(windowDays-1), D] and writes a MetricSnapshot via `store.putSnapshot`.
 * Returns the number of snapshots written.
 */
export async function backfillSnapshots(store, opts) {
  const days = enumerateDays(opts.fromDay, opts.toDay)
  const window = Math.max(1, opts.windowDays)
  let written = 0

  const nowMs = new Date(opts.now).getTime()

  // A backfill always runs AFTER a sync's ingestion writes, so any memoised
  // global lookups (pr_refs / file_complexity / status categories) from a prior
  // run are stale here. Drop the memo so this backfill reads post-write state;
  // loadFullScopeData below then repopulates it fresh for the whole run.
  invalidateLookupsCache(store)

  // Bulk-load the ENTIRE dataset ONCE for the whole backfill (~10 queries, zero
  // N+1). Every day's window is then sliced from it in memory (pure CPU, no I/O),
  // and each day's snapshots are bulk-inserted. This replaces what was ~16M
  // queries (9,360 (metric,day) × ~1,700 reads each) with ~10 reads + chunked
  // writes.
  const full = await loadFullScopeData(store)

  for (const day of days) {
    const windowFrom = shiftDay(day, -(window - 1))
    // Clock each day's snapshot to the END of that day (clamped to the real
    // compute time), NOT to a single opts.now. Point-in-time metrics (aging_wip,
    // wip_load) and open-interval tails (cfd, time_in_status, flow_efficiency)
    // otherwise reconstruct every historical day as if it were today, making
    // every backfilled snapshot identical to the latest one.
    const dayEnd = dayEndIso(day)
    const dayNow = new Date(dayEnd).getTime() <= nowMs ? dayEnd : opts.now

    // In-memory window slice — no DB reads. Shared by all metrics for this day.
    const data = sliceScopeData(full, windowFrom, day)

    const snapshots = []
    for (const metricId of opts.metricIds) {
      const result = await computeMetric(
        store,
        opts.scopeType,
        opts.scopeId,
        metricId,
        windowFrom,
        day,
        dayNow,
        data,
      )
      snapshots.push({
        scopeType: opts.scopeType,
        scopeId: opts.scopeId,
        metric: metricId,
        day,
        value: result.value,
        window: `${window}d`,
        trustTier: result.trustTier,
        dataQuality: result.dataQuality,
        engineVersion: ENGINE_VERSION,
        ingestWatermarkVersion: opts.ingestWatermarkVersion,
        coverageFingerprint: opts.coverageFingerprint,
        computedAt: opts.now,
        isStale: false,
        dataSource: result.dataSource,
      })
    }

    // One chunked, multi-row INSERT per day (was 39 single-row writes/fsyncs).
    await store.putSnapshots(snapshots)
    written += snapshots.length
  }

  return written
}

/** Enumerate inclusive 'YYYY-MM-DD' days from `from` to `to`. */
function enumerateDays(from, to) {
  const days = []
  const cur = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return days
}

/** Shift a 'YYYY-MM-DD' day by `delta` days (UTC). */
function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}
