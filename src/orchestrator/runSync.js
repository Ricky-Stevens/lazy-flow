import { linkDeployIncidents, linkIssues, resolveIdentities, stitchPersons } from '../core/index.js'

import { syncGitHub } from '../ingest-github/index.js'

import { syncJira } from '../ingest-jira/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main export: runSync
// ---------------------------------------------------------------------------

/**
 * Run a full sync cycle: GitHub → Jira → resolveIdentities → stitchPersons
 * (auto-merges only; rest queued) → linkIssues.
 *
 * Watermarks are persisted by each step; re-running with mode='incremental'
 * is safe and idempotent (last-writer-wins upserts).
 */
export async function runSync(
  store,
  githubClient,
  githubScope,
  githubMode,
  jiraClient,
  jiraScope,
  jiraMode,
  options = {},
) {
  const now = options.now ?? new Date().toISOString()
  const errors = []

  // -------------------------------------------------------------------------
  // 0. Tenant-isolation guard (SPEC §6.5): hard-fail if this DB already holds a
  //    DIFFERENT org's data. Each install is single-org; this prevents one local
  //    install silently mixing two clients' repos/issues. (assertOrgBound was
  //    exported but never actually invoked by any sync path before.)
  // -------------------------------------------------------------------------
  await store.assertOrgBound(`org-${githubScope.org}`)

  // -------------------------------------------------------------------------
  // 1. GitHub sync
  // -------------------------------------------------------------------------
  // Pass the orchestrator's `now` so GitHub, Jira and the full-cycle watermark
  // all stamp one coherent timestamp for the cycle (and so deterministic
  // replays/tests that pin options.now also pin GitHub freshness).
  // A null client means the caller did not request (or has not configured) that
  // source — skip its sync and return empty results rather than crashing. The
  // downstream identity/linking passes still run over whatever is already stored.
  const tGh = Date.now()
  const ghResult = githubClient
    ? await syncGitHub(store, githubClient, githubScope, githubMode, now)
    : { org: githubScope.org ?? '', repos: [], mode: githubMode, warnings: [] }
  const githubMs = Date.now() - tGh
  // Surface repo-resolution warnings (e.g. a configured repo the token can't see)
  // so a zero-repo sync is visible instead of looking like a clean success.
  if (ghResult.warnings && ghResult.warnings.length > 0) {
    errors.push(...ghResult.warnings.map((w) => `github: ${w}`))
  }

  // -------------------------------------------------------------------------
  // 2. Jira sync
  // -------------------------------------------------------------------------
  const tJira = Date.now()
  const jiraResult = jiraClient
    ? await syncJira(store, jiraClient, jiraScope, jiraMode, now)
    : { projectsProcessed: [], issuesUpserted: 0, transitionsAppended: 0, errors: [], warnings: [] }
  const jiraMs = Date.now() - tJira
  if (jiraResult.errors.length > 0) {
    errors.push(...jiraResult.errors.map((e) => `jira: ${e}`))
  }

  // -------------------------------------------------------------------------
  // 3. Resolve identities (extract identity rows from raw payloads)
  // -------------------------------------------------------------------------
  const resolveResult = await resolveIdentities(store, {
    now,
    botAllowlist: options.botAllowlist,
  })

  // -------------------------------------------------------------------------
  // 4. Stitch persons (auto-merge on verified email only; queue the rest)
  // -------------------------------------------------------------------------
  const stitchResult = await stitchPersons(store, {
    now,
    botAllowlist: options.botAllowlist,
  })

  // -------------------------------------------------------------------------
  // 5. Link issues (populate pr_issue_links)
  // -------------------------------------------------------------------------
  const linkResult = await linkIssues(store, { now })

  // -------------------------------------------------------------------------
  // 5b. Link deployments ↔ incidents (populate deploy_incident_links) for DORA
  //     CFR / recovery / rework attribution + insight joins. Best-effort: a
  //     failure here does not fail the sync (the metric engine derives its own
  //     linkage independently).
  // -------------------------------------------------------------------------
  let deployIncidentLinks = { linksUpserted: 0 }
  try {
    deployIncidentLinks = await linkDeployIncidents(store, { now })
  } catch (err) {
    errors.push(`deploy-incident link: ${err instanceof Error ? err.message : String(err)}`)
  }

  // -------------------------------------------------------------------------
  // 6. Engine-version-bump re-derivation (SPEC §8.6).
  //    Runs AFTER raw sync (so freshly-synced rows feed the recompute) but is a
  //    no-op unless a stored snapshot carries a stale engine_version. Inverted
  //    dependency: the metrics-layer rederive fn is injected via options.
  //    Best-effort — a failure here does not fail the sync that already succeeded.
  // -------------------------------------------------------------------------
  let rederive = null
  if (options.rederive) {
    try {
      rederive = await options.rederive(now)
    } catch (err) {
      errors.push(`rederive: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // 7. Persist orchestrator-level sync watermark
  // -------------------------------------------------------------------------
  await store.putSyncState({
    source: 'orchestrator',
    resource: 'full_cycle',
    scopeId: githubScope.org,
    cursor: null,
    watermarkAt: now,
    lastRunAt: now,
    status: 'idle',
    error: errors.length > 0 ? errors.join('; ') : null,
  })

  return {
    syncedAt: now,
    github: {
      org: ghResult.org,
      repos: ghResult.repos,
      mode: ghResult.mode,
    },
    jira: {
      projectsProcessed: jiraResult.projectsProcessed,
      issuesUpserted: jiraResult.issuesUpserted,
      transitionsAppended: jiraResult.transitionsAppended,
      errors: jiraResult.errors,
      warnings: jiraResult.warnings ?? [],
    },
    identity: {
      identitiesUpserted: resolveResult.identitiesUpserted,
      issuesBackfilled: resolveResult.issuesBackfilled,
      transitionsBackfilled: resolveResult.transitionsBackfilled,
      personsCreated: stitchResult.personsCreated,
      autoMerged: stitchResult.autoMerged,
      queued: stitchResult.queued,
    },
    linking: {
      linksUpserted: linkResult.linksUpserted,
      falsePositivesDropped: linkResult.falsePositivesDropped,
      deployIncidentLinks: deployIncidentLinks.linksUpserted,
    },
    rederive,
    errors,
    timings: { githubMs, jiraMs },
  }
}
