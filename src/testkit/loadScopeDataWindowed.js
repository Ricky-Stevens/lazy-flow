/**
 * TEST-ONLY oracle: the original per-window SQL loader that the bulk
 * `loadFullScopeData` + `sliceScopeData` rewrite replaced. Lives in testkit
 * because nothing in production calls it — its only purpose is the equivalence
 * test in `compute.test.js` that asserts the in-memory slice produces identical
 * metric values to this reference implementation for every metric over every
 * window. If a slice predicate ever diverges from its SQL counterpart, the
 * equivalence test fails here.
 *
 * Carries the per-PR / per-issue N+1 the bulk loader eliminates — DO NOT call
 * it from production code.
 */

import { loadGlobalLookups } from '../metrics/compute/index.js'

function dayStartMs(day) {
  return new Date(`${day}T00:00:00.000Z`).getTime()
}

function dayEndMs(day) {
  return dayStartMs(day) + 24 * 60 * 60 * 1000 - 1
}

function dayStartIso(day) {
  return new Date(dayStartMs(day)).toISOString()
}

function dayEndIso(day) {
  return new Date(dayEndMs(day)).toISOString()
}

function inWindow(iso, fromMs, toMs) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return false
  return t >= fromMs && t <= toMs
}

async function resolveOrgId(store) {
  const orgs = await store.listOrganisations()
  return orgs[0]?.id ?? null
}

/**
 * REFERENCE IMPLEMENTATION (oracle, test-only). Equivalent in observable output
 * to `loadFullScopeData` + `sliceScopeData`, just slower (one query per window
 * per repo, no bulk grouping). Kept as the correctness baseline the equivalence
 * test pins the perf rewrite against.
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
    // (totalWindowHaloc) — see the bulk loader's parallel loop for why.
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

  // Window-INDEPENDENT global lookups — attached so a `computeMetric` call with
  // `preloaded = await loadScopeDataWindowed(...)` computes identical values to
  // the bulk slice path. The equivalence test depends on this.
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
