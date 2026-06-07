/**
 * WP-SYNC-ORCH — Full sync orchestration.
 *
 * Sequence:
 *   1. syncGitHub  — repos, commits, PRs, reviews, deployments
 *   2. syncJira    — projects, issues, changelogs, boards, sprints, workflows
 *   3. resolveIdentities — extract identity records from raw payloads
 *   4. stitchPersons     — auto-merge on verified email; queue the rest
 *   5. linkIssues        — populate pr_issue_links (regex, smartcommit, branch)
 *
 * Per-resource watermarks are persisted to `sync_state` by each sub-step.
 * A re-run picks up where watermarks left off (incremental mode) — idempotent.
 */

import type { Store } from '@lazy-flow/core'
import { linkIssues, resolveIdentities, stitchPersons } from '@lazy-flow/core'
import type { GitHubClient, SyncMode, SyncScope } from '@lazy-flow/ingest-github'
import { syncGitHub } from '@lazy-flow/ingest-github'
import type { JiraClient, JiraSyncMode, JiraSyncScope } from '@lazy-flow/ingest-jira'
import { syncJira } from '@lazy-flow/ingest-jira'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSyncOptions {
  /** Override the current timestamp (default: new Date().toISOString()). */
  now?: string
  /** Bot identity allowlist forwarded to resolveIdentities / stitchPersons. */
  botAllowlist?: string[]
}

export interface RunSyncResult {
  syncedAt: string
  github: {
    org: string
    repos: string[]
    mode: SyncMode
  }
  jira: {
    projectsProcessed: string[]
    issuesUpserted: number
    transitionsAppended: number
    errors: string[]
  }
  identity: {
    identitiesUpserted: number
    issuesBackfilled: number
    transitionsBackfilled: number
    personsCreated: number
    autoMerged: number
    queued: number
  }
  linking: {
    linksUpserted: number
    falsePositivesDropped: number
  }
  errors: string[]
}

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
  store: Store,
  githubClient: GitHubClient,
  githubScope: SyncScope,
  githubMode: SyncMode,
  jiraClient: JiraClient,
  jiraScope: JiraSyncScope,
  jiraMode: JiraSyncMode,
  options: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const now = options.now ?? new Date().toISOString()
  const errors: string[] = []

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
  const ghResult = await syncGitHub(store, githubClient, githubScope, githubMode, now)

  // -------------------------------------------------------------------------
  // 2. Jira sync
  // -------------------------------------------------------------------------
  const jiraResult = await syncJira(store, jiraClient, jiraScope, jiraMode, now)
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
  // 6. Persist orchestrator-level sync watermark
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
    },
    errors,
  }
}
