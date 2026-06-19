import { ENGINE_VERSION } from '../../core/index.js'

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
 * Load all the team/org-scoped entities for the window, once.
 * Window applies to PRs (createdAt), deploys (createdAt), commits (authoredAt),
 * check runs (completedAt/startedAt). Issues + transitions are loaded whole.
 */
async function loadScopeData(store, windowFrom, windowTo) {
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

    // Per-file diffs for PRs created in the window (code.* metric inputs).
    const repoPrFiles = await store.getPrFilesByRepo(repo.id, fromIso, toIso)
    for (const f of repoPrFiles) {
      const arr = prFilesByPr.get(f.prId)
      if (arr) arr.push(f)
      else prFilesByPr.set(f.prId, [f])
    }

    // Prior rolling HALOC: pr_files of PRs created strictly BEFORE the window
    // (Nagappan-Ball M1 relative-churn denominator). Bounded by until=fromMs-1ms.
    const priorUntilIso = new Date(fromMs - 1).toISOString()
    const repoPriorFiles = await store.getPrFilesByRepo(repo.id, undefined, priorUntilIso)
    for (const f of repoPriorFiles) priorHaloc += f.haloc

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
    additions += f.additions
    deletions += f.deletions
    haloc += f.haloc
    hasFiles = true
  }
  return {
    id: pr.id,
    repoId: pr.repoId,
    authorIdentityId: pr.authorIdentityId,
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

  const startedIds = new Set()
  const doneIds = new Set()
  for (const statusId of statusIds) {
    const category = await store.getStatusCategory(statusId)
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

/** Total HALOC across the window's pr_files (denormalised per-file haloc). */
function totalWindowHaloc(data) {
  let total = 0
  for (const files of data.prFilesByPr.values()) {
    for (const f of files) total += f.haloc
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
    formulaDoc: formulaDocOverride ?? mod?.formulaDoc ?? `Metric ${metricId} is not wired.`,
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
      const prodDeploys = deploys.filter((d) => d.environment === 'production')
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
        .filter((d) => d.environment === 'production')
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
        .filter((d) => d.environment === 'production')
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
        .filter((d) => d.environment === 'production')
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
      const prodDeploys = deploys.filter((d) => d.environment === 'production')
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
      return wipLoad.compute({ issues: flowIssues, boardColumns, now, avgCycleTimeDays: null }, now)
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
      // remainingItems === 0 → nothing to forecast: the module returns value=null
      // with dataQuality 'ok' (no backlog, not missing data). weeklySamples empty →
      // the module returns no_data. Both are honest module-level outcomes.
      return monteCarlo.compute(
        {
          weeklySamples,
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
      return sprintVelocity.compute(
        {
          sprint: sprintRecord,
          membershipEvents: memberEvents,
          issues: data.issues.map(toIssueRecord),
        },
        now,
      )
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
    case 'code.haloc_aggregate':
      // REAL: recomputes HALOC over the ingested per-PR diffs. Returns no_data
      // inside the module when no pr_files were ingested for the window.
      return halocAggregate.compute({ changes: buildCodeChanges(data) }, now)

    case 'code.nagappan_ball': {
      // M1 (relative churn) and M2 (churn rate) are REAL from the window HALOC,
      // the prior rolling HALOC, and the window length. M3 (rework density)
      // needs git blame to classify Rework lines, which we do not ingest, so
      // reworkLines is 0 (no lines classified) — the module's formulaDoc states
      // M3 = reworkLines/(totalLines+1). The headline value is M1.
      const haloc = totalWindowHaloc(data)
      let changedLines = 0
      for (const files of data.prFilesByPr.values()) {
        for (const f of files) changedLines += f.additions + f.deletions
      }
      return nagappanBall.compute(
        {
          haloc,
          priorHaloc: data.priorHaloc,
          windowDays: winDays,
          // Blame not ingested → 0 lines classified as Rework (see REWORK_CHURN_NO_DATA).
          reworkLines: 0,
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
      const head = []
      const base = []
      for (const [prId, files] of data.prFilesByPr) {
        const ref = await store.getPrRef(prId)
        if (!ref?.headSha) continue
        for (const f of files) {
          const headC = await store.getFileComplexity(ref.repoId, ref.headSha, f.path)
          if (!headC) continue
          const key = `${prId}::${f.path}`
          head.push({ path: key, complexity: { functions: headC.functions } })
          const baseC = ref.baseSha
            ? await store.getFileComplexity(ref.repoId, ref.baseSha, f.path)
            : null
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
      const seen = new Set()
      let sumCyclomatic = 0
      let sumLoc = 0
      let sumHaloc = 0
      let n = 0
      for (const [prId, files] of data.prFilesByPr) {
        const ref = await store.getPrRef(prId)
        if (!ref?.headSha) continue
        for (const f of files) {
          const key = `${ref.headSha}::${f.path}`
          if (seen.has(key)) continue
          const c = await store.getFileComplexity(ref.repoId, ref.headSha, f.path)
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

  // PRs the person authored → their authoring slice.
  const authoredPrInputs = () =>
    data.prs
      .filter((pr) => pr.authorIdentityId !== null && identityIds.has(pr.authorIdentityId))
      .map((pr) => toPrInput(pr, data.prFilesByPr.get(pr.id)))

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
      return wipLoad.compute(
        { issues: assignedFlowIssues(), boardColumns, now, avgCycleTimeDays: null },
        now,
      )
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
    default:
      return noDataResult(metricId, 'person', now)
  }
}

export async function computeMetric(
  store,
  scopeType,
  scopeId,
  metricId,
  windowFrom,
  windowTo,
  now,
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
    const identities = await store.getIdentitiesByPerson(scopeId)
    const identityIds = new Set(identities.map((i) => i.id))
    if (identityIds.size === 0) return noDataResult(metricId, scopeType, now)
    const personData = await loadScopeData(store, windowFrom, windowTo)
    return computePersonRaw(store, metricId, windowFrom, windowTo, now, personData, identityIds)
  }

  const data = await loadScopeData(store, windowFrom, windowTo)
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
  for (const day of days) {
    const windowFrom = shiftDay(day, -(window - 1))
    // Clock each day's snapshot to the END of that day (clamped to the real
    // compute time), NOT to a single opts.now. Point-in-time metrics (aging_wip,
    // wip_load) and open-interval tails (cfd, time_in_status, flow_efficiency)
    // otherwise reconstruct every historical day as if it were today, making
    // every backfilled snapshot identical to the latest one.
    const dayEnd = dayEndIso(day)
    const dayNow = new Date(dayEnd).getTime() <= nowMs ? dayEnd : opts.now
    for (const metricId of opts.metricIds) {
      const result = await computeMetric(
        store,
        opts.scopeType,
        opts.scopeId,
        metricId,
        windowFrom,
        day,
        dayNow,
      )
      await store.putSnapshot({
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
      written++
    }
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
