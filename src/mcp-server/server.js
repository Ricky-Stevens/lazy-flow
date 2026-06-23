/**
 * lazy-flow MCP server — WP-MCP-SERVER, WP-MCP-TOOLS, WP-MCP-RESOURCES.
 *
 * Registers all tools with inputSchema + outputSchema (structuredContent) and
 * exposes the live DB schema + generated reports as MCP resources
 * (lazy-flow://schema, lazy-flow://report/latest).
 *
 * Every tool output carries: trust_tier, as_of, engine_version, data_quality,
 * and (where applicable) a coverage flag — per SPEC §13.1.
 *
 * Key note on MCP SDK (from global memory global/mcp-sdk/refine-schema-hides-params):
 * inputSchema MUST be a plain z.object({...}) — never .refine().  Cross-field
 * validation goes inside the handler.
 */

import { Database } from 'bun:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  listPendingAuthorshipVerdicts,
  recordAuthorshipVerdict,
} from '../core/ai/authorshipVerdicts.js'
import {
  BunSqliteStore,
  confirmCandidateMatch,
  ENGINE_VERSION,
  listCandidateMatches,
  rejectCandidateMatch,
  unmergeIdentities,
} from '../core/index.js'
import { backfillAllPatches } from '../ingest-github/index.js'
import {
  backfillSnapshots,
  COMPUTE_METRIC_IDS,
  computeMetric,
  computePersonReportLive,
  invalidateLookupsCache,
  loadScopeData,
  metricFormulaDoc,
  metricSetNeedsPatch,
  rederiveStaleEngineSnapshots,
} from '../metrics/index.js'
import {
  listPendingVerdicts,
  recordVerdict,
  VERDICT_METRICS,
  VERDICT_SHAPE,
} from '../metrics/verdicts/index.js'

import { runSync, syncStatus } from '../orchestrator/index.js'
import {
  buildBenchmarkProvider,
  generateReport,
  listPresets,
  toCsv,
  toJson,
} from '../report/index.js'
import { cascadeWarnings } from './config.js'

import {
  assertIndexedPlan,
  assertReadOnlyQuery,
  LARGE_SCAN_ROW_THRESHOLD,
  QUERY_DB_DEFAULT_MAX_ROWS,
  QUERY_DB_HARD_CAP_ROWS,
  QUERY_DB_MAX_BYTES,
  QUERY_DB_TIMEOUT_MS,
  QueryDbError,
  runBudgetedQuery,
} from './queryGuard.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'lazy-flow'
const SERVER_VERSION = '0.1.8'

// Stale threshold: warn at 4h, refuse at 24h (SPEC §7.5)
const STALE_WARN_MS = 4 * 60 * 60 * 1000
const STALE_REFUSE_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Shared output envelope helpers
// ---------------------------------------------------------------------------

/** Standard provenance envelope attached to every tool output. */

function provenance(trustTier = 'deterministic', dataQuality = 'ok', coverage) {
  return {
    as_of: new Date().toISOString(),
    engine_version: ENGINE_VERSION,
    trust_tier: trustTier,
    data_quality: dataQuality,
    ...(coverage !== undefined ? { coverage } : {}),
  }
}

/** Zod schema for the standard provenance fields on every output. */
const provenanceSchema = z.object({
  as_of: z.string(),
  engine_version: z.string(),
  trust_tier: z.enum(['deterministic', 'hybrid', 'probabilistic', 'n/a']),
  data_quality: z.string(),
  coverage: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Context object threaded through tool handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Snapshot backfill / re-derivation parameters
// ---------------------------------------------------------------------------

/**
 * Canonical scopes the snapshot writer populates. The local single-team model
 * treats the configured repos+projects as one dataset, written under both the
 * 'team' and 'org' canonical scopes (see the run_sync handler).
 */
const SNAPSHOT_SCOPES = [
  { scopeType: 'team', scopeId: 'team' },
  { scopeType: 'org', scopeId: 'org' },
]

/** Rolling window (days) each snapshot day is computed over. Matches the backfill. */
const SNAPSHOT_WINDOW_DAYS_DEFAULT = 30

/** History depth (days) for backfill / engine-bump scans. */
const SNAPSHOT_HISTORY_DAYS_DEFAULT = 60

/** Rolling window (days), config-overridable (LAZYFLOW_SNAPSHOT_WINDOW_DAYS). */
function snapshotWindowDays(ctx) {
  const n = ctx?.config?.snapshotWindowDays
  return typeof n === 'number' && n > 0 ? n : SNAPSHOT_WINDOW_DAYS_DEFAULT
}

/** Snapshot horizon (days), config-overridable (LAZYFLOW_SNAPSHOT_HORIZON_DAYS). */
function snapshotHorizonDays(ctx) {
  const n = ctx?.config?.snapshotHorizonDays
  return typeof n === 'number' && n > 0 ? n : SNAPSHOT_HISTORY_DAYS_DEFAULT
}

/**
 * Recency floor (ISO) for the in-session LLM judgment queues, derived from
 * LAZYFLOW_LLM_WINDOW_DAYS. Returns null when the window is 0/unset (no floor),
 * so the verdict pipelines stay all-time unless explicitly bounded.
 */
function llmSinceIso(ctx, nowIso = new Date().toISOString()) {
  const days = ctx?.config?.llmWindowDays
  if (typeof days !== 'number' || days <= 0) return null
  return new Date(Date.parse(nowIso) - days * 86_400_000).toISOString()
}

/**
 * Build a ComputeDayFn that computes a metric over the rolling
 * SNAPSHOT_WINDOW_DAYS window ending on `day` — the same window semantics the
 * backfill uses, so a re-derived snapshot reconverges with its backfilled value.
 */
function makeComputeDayFn(ctx, now) {
  // Per-DAY batch: load + slice the rolling window ONCE (the bulk DB load is
  // memoised across the whole pass; the slice is then shared by every metric for
  // this day), then compute each metric against that in-memory slice via the
  // `preloaded` arg — no per-metric re-read or re-slice. Opt into the patch-bearing
  // pr_files variant only when a stale metric needs it. Mirrors backfillSnapshots.
  const windowDays = snapshotWindowDays(ctx)
  return async (scopeType, scopeId, day, metricIds) => {
    const windowFrom = new Date(Date.parse(day) - (windowDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const data = await loadScopeData(ctx.store, windowFrom, day, {
      needsPatch: metricSetNeedsPatch(metricIds),
    })
    const results = new Map()
    for (const metricId of metricIds) {
      results.set(
        metricId,
        await computeMetric(ctx.store, scopeType, scopeId, metricId, windowFrom, day, now, data),
      )
    }
    return results
  }
}

/**
 * Engine-version-bump re-derivation pass over the canonical snapshot scopes.
 *
 * No-op when every stored snapshot already carries the current ENGINE_VERSION;
 * otherwise the stale-version days are marked stale and recomputed. Bounded to the
 * SNAPSHOT_HISTORY_DAYS window ending today. Wired into both the post-sync path
 * (run_sync) and server startup so an engine upgrade can never leave a series
 * silently mixing formula versions.
 */
async function rederiveOnEngineBump(ctx, now, signal) {
  // Run on a DEDICATED connection so the re-derive's writes can NEVER interleave
  // into a tool call's open transaction on the shared connection. bun:sqlite is a
  // single connection: two logical transactions multiplexed over one connection
  // corrupt each other (a bare write lands inside an open BEGIN; an unrelated
  // ROLLBACK then discards it). The background startup re-derive runs concurrently
  // with tool calls (run_sync) after connect, so it MUST use its own connection;
  // WAL + busy_timeout (set by the BunSqliteStore constructor) then let the two
  // connections serialize writes safely at the SQLite file-lock level. :memory:
  // can't be shared across connections, so fall back to the shared store there
  // (ephemeral/test only — no real concurrency).
  const dbPath = ctx.config.dbPath
  const useDedicated = dbPath && dbPath !== ':memory:'
  const store = useDedicated ? new BunSqliteStore(dbPath) : ctx.store
  const localCtx = useDedicated ? { ...ctx, store } : ctx
  try {
    // Drop any stale lookup memo so the recompute reads post-write pr_refs /
    // file_complexity / statuses. (Dedicated store starts with a fresh memo.)
    invalidateLookupsCache(store)
    const today = now.slice(0, 10)
    const fromDay = new Date(Date.parse(today) - snapshotHorizonDays(localCtx) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    return await rederiveStaleEngineSnapshots({
      store,
      scopes: SNAPSHOT_SCOPES,
      metricIds: COMPUTE_METRIC_IDS,
      fromDay,
      toDay: today,
      computeDay: makeComputeDayFn(localCtx, now),
      now,
      signal,
    })
  } finally {
    if (useDedicated) store.close()
  }
}

// ---------------------------------------------------------------------------
// Tool: doctor
// ---------------------------------------------------------------------------

function registerDoctorTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.enum(['ok', 'warn', 'error']),
        message: z.string(),
      }),
    ),
    overall: z.enum(['healthy', 'degraded', 'unhealthy']),
  })

  server.registerTool(
    'doctor',
    {
      title: 'Doctor — health diagnostics',
      description:
        'Config & connectivity preflight: token/email/base-URL presence, repos & Jira projects configured, sync freshness, DB integrity, Bun runtime. (Checks config presence, not live token validity — run run_sync to confirm a token works and a wildcard resolves.)',
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const checks = []

      // 1. Bun runtime preflight — the server requires the Bun runtime for
      //    bun:sqlite. If launched under Node, `Bun` is undefined and the
      //    bun:sqlite import would have already failed; we still surface a
      //    clear diagnostic here.
      const bunVersion = typeof Bun !== 'undefined' ? Bun.version : null
      const versionParts = (bunVersion ?? '0.0.0')
        .split('.')
        .map((p) => Number.parseInt(p, 10) || 0)
      const bunMajor = versionParts[0] ?? 0
      const bunMinor = versionParts[1] ?? 0
      const bunOk = bunVersion != null && (bunMajor > 1 || (bunMajor === 1 && bunMinor >= 3))
      checks.push({
        name: 'bun_runtime',
        status: bunOk ? 'ok' : 'error',
        message: bunVersion
          ? `Bun ${bunVersion} — requires >=1.3.0 for bun:sqlite`
          : 'Not running under Bun — this server requires the Bun runtime for bun:sqlite',
      })

      // 2. GitHub token presence. The token may come from LAZYFLOW_GITHUB_TOKEN /
      //    GH_TOKEN / GITHUB_TOKEN, or fall back to the authenticated `gh` CLI
      //    (resolved at startup in index.js). A warn means none of those produced
      //    a credential.
      checks.push({
        name: 'github_token',
        status: ctx.config.githubToken ? 'ok' : 'warn',
        message: ctx.config.githubToken
          ? 'GitHub token configured'
          : 'No GitHub credential — set LAZYFLOW_GITHUB_TOKEN or run `gh auth login`; GitHub sync unavailable',
      })

      // 3. Jira config. A Jira Cloud API token needs BOTH the account email
      //    (LAZYFLOW_JIRA_EMAIL, for Basic auth — else every call 403s) AND the
      //    site base URL (LAZYFLOW_JIRA_BASE_URL — else the client is never built
      //    and run_sync silently skips Jira). Flag whichever is missing by name.
      const jiraMissing = []
      if (ctx.config.jiraToken && !ctx.config.jiraEmail) jiraMissing.push('LAZYFLOW_JIRA_EMAIL')
      if (ctx.config.jiraToken && !ctx.config.jiraBaseUrl)
        jiraMissing.push('LAZYFLOW_JIRA_BASE_URL')
      checks.push({
        name: 'jira_config',
        status: !ctx.config.jiraToken ? 'warn' : jiraMissing.length > 0 ? 'error' : 'ok',
        message: !ctx.config.jiraToken
          ? 'LAZYFLOW_JIRA_TOKEN not set — Jira sync unavailable'
          : jiraMissing.length > 0
            ? `LAZYFLOW_JIRA_TOKEN set but ${jiraMissing.join(' + ')} missing — Jira sync will be skipped/403 until set`
            : `Jira token + email + base URL (${ctx.config.jiraBaseUrl}) configured (Basic auth)`,
      })

      // 4. Repos configured. NOTE: this checks config PRESENCE, not live
      //    resolution — a wildcard (ORG/*) restricted by SSO can still resolve to
      //    0 repos at sync time (run_sync surfaces that warning).
      checks.push({
        name: 'repos_configured',
        status: ctx.config.repos.length > 0 ? 'ok' : 'warn',
        // Surface the actual patterns (not just a count) so Claude can report the
        // configured scope from this tool — it never needs to read .env to find
        // out which repos are tracked. These are non-secret operational config.
        message:
          ctx.config.repos.length > 0
            ? `${ctx.config.repos.length} repo pattern(s) configured: ${ctx.config.repos.join(', ')} (run run_sync to verify they resolve)`
            : 'LAZYFLOW_REPOS not set — no repos to sync',
      })

      // 5. Jira projects configured — without this, Jira sync succeeds with 0
      //    issues and no explanation (the project loop never runs).
      if (ctx.config.jiraToken) {
        checks.push({
          name: 'jira_projects_configured',
          status: ctx.config.jiraProjects.length > 0 ? 'ok' : 'warn',
          // Surface the actual project keys so scope is readable from doctor.
          message:
            ctx.config.jiraProjects.length > 0
              ? `${ctx.config.jiraProjects.length} Jira project(s) configured: ${ctx.config.jiraProjects.join(', ')}`
              : 'LAZYFLOW_JIRA_PROJECTS not set — Jira sync will ingest 0 issues',
        })
      }

      // 6. DB path
      checks.push({
        name: 'db_path',
        status: 'ok',
        message: `DB path: ${ctx.config.dbPath === ':memory:' ? ':memory: (ephemeral)' : ctx.config.dbPath}`,
      })

      // 7. Sync freshness check
      try {
        const status = await syncStatus(ctx.store, {
          staleThresholdMs: STALE_WARN_MS,
          refuseThresholdMs: STALE_REFUSE_MS,
        })
        const staleCount = status.warnResources.length
        const refuseCount = status.refuseResources.length
        checks.push({
          name: 'sync_freshness',
          status: refuseCount > 0 ? 'error' : staleCount > 0 ? 'warn' : 'ok',
          message:
            refuseCount > 0
              ? `${refuseCount} resource(s) stale beyond refuse threshold`
              : staleCount > 0
                ? `${staleCount} resource(s) stale beyond warn threshold`
                : status.resources.length === 0
                  ? 'No sync records yet — run run_sync first'
                  : 'All resources fresh',
        })
      } catch (err) {
        checks.push({
          name: 'sync_freshness',
          status: 'error',
          message: `Sync status check failed: ${String(err)}`,
        })
      }

      // 8. DB integrity — actually exercise the DB with a real read so this can
      // report unhealthy on a corrupt/locked DB (the body was previously empty
      // and could only ever report 'ok').
      try {
        await ctx.store.listOrganisations()
        checks.push({
          name: 'db_integrity',
          status: 'ok',
          message: 'DB open and queryable',
        })
      } catch (err) {
        checks.push({
          name: 'db_integrity',
          status: 'error',
          message: `DB integrity check failed: ${String(err)}`,
        })
      }

      // 9. Retention/window cascade invariant — surface a misconfiguration (the
      // prune floors its cutoff so data is never lost, but the user should know if
      // the store will keep more than they configured, or a window under-fills).
      const cascadeMsgs = cascadeWarnings(ctx.config)
      checks.push({
        name: 'retention_cascade',
        status: cascadeMsgs.length > 0 ? 'warn' : 'ok',
        message:
          cascadeMsgs.length > 0
            ? cascadeMsgs.join(' ')
            : `retention ${ctx.config.retentionDays}d / horizon ${snapshotHorizonDays(ctx)}d × window ${snapshotWindowDays(ctx)}d / patch ${ctx.config.patchRetentionDays}d — consistent`,
      })

      const errorCount = checks.filter((c) => c.status === 'error').length
      const warnCount = checks.filter((c) => c.status === 'warn').length
      const overall = errorCount > 0 ? 'unhealthy' : warnCount > 0 ? 'degraded' : 'healthy'

      const output = {
        ...provenance('n/a'),
        checks,
        overall,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: sync_status
// ---------------------------------------------------------------------------

function registerSyncStatusTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    resources: z.array(
      z.object({
        source: z.string(),
        resource: z.string(),
        scope_id: z.string(),
        watermark_at: z.string().nullable(),
        last_run_at: z.string().nullable(),
        lag_ms: z.number().nullable(),
        is_stale: z.boolean(),
        status: z.enum(['idle', 'running', 'error']),
        error: z.string().nullable(),
      }),
    ),
    has_stale: z.boolean(),
    warn_count: z.number(),
    refuse_count: z.number(),
  })

  server.registerTool(
    'sync_status',
    {
      title: 'Sync Status',
      description: 'Report sync freshness and watermark-lag per source/resource.',
      inputSchema: z.object({
        stale_threshold_hours: z
          .number()
          .optional()
          .describe('Warn threshold in hours (default 4).'),
        refuse_threshold_hours: z
          .number()
          .optional()
          .describe('Refuse threshold in hours (default 24).'),
      }),
      outputSchema,
    },
    async ({ stale_threshold_hours, refuse_threshold_hours }) => {
      const staleMs = (stale_threshold_hours ?? 4) * 3_600_000
      const refuseMs = (refuse_threshold_hours ?? 24) * 3_600_000

      const result = await syncStatus(ctx.store, {
        staleThresholdMs: staleMs,
        refuseThresholdMs: refuseMs,
      })

      const output = {
        ...provenance('n/a'),
        resources: result.resources.map((r) => ({
          source: r.source,
          resource: r.resource,
          scope_id: r.scopeId,
          watermark_at: r.watermarkAt,
          last_run_at: r.lastRunAt,
          lag_ms: r.lagMs,
          is_stale: r.isStale,
          status: r.status,
          error: r.error,
        })),
        has_stale: result.hasStale,
        warn_count: result.warnResources.length,
        refuse_count: result.refuseResources.length,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: run_sync
// ---------------------------------------------------------------------------

function registerRunSyncTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    synced_at: z.string(),
    github: z.object({
      org: z.string(),
      repos: z.array(z.string()),
      mode: z.string(),
    }),
    jira: z.object({
      projects_processed: z.array(z.string()),
      issues_upserted: z.number(),
      transitions_appended: z.number(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
    identity: z.object({
      identities_upserted: z.number(),
      persons_created: z.number(),
      auto_merged: z.number(),
      queued: z.number(),
    }),
    linking: z.object({
      links_upserted: z.number(),
      false_positives_dropped: z.number(),
    }),
    rederive: z
      .object({
        bump_detected: z.boolean(),
        marked_stale: z.number(),
        recomputed: z.number(),
      })
      .nullish(),
    errors: z.array(z.string()),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
    snapshots_written: z.number().optional(),
    patch_backfill: z
      .object({
        backfilled: z.number(),
        skipped: z.number(),
        remaining: z.number(),
      })
      .nullish(),
    timings_ms: z
      .object({
        sync_total: z.number(),
        github: z.number(),
        jira: z.number(),
        snapshot_backfill: z.number(),
        patch_backfill: z.number().optional(),
      })
      .optional(),
  })

  server.registerTool(
    'run_sync',
    {
      title: 'Run Sync',
      description: 'Trigger backfill or incremental sync for GitHub and/or Jira. Idempotent.',
      inputSchema: z.object({
        mode: z
          .enum(['full', 'incremental'])
          .optional()
          .describe('Sync mode: full backfill or incremental (default: incremental).'),
        sources: z
          .array(z.enum(['github', 'jira']))
          .optional()
          .describe('Which sources to sync (default: both).'),
      }),
      outputSchema,
    },
    async ({ mode, sources }) => {
      const syncMode = mode ?? 'incremental'
      const syncSources = sources ?? ['github', 'jira']

      // Validate that required clients are available
      if (syncSources.includes('github') && !ctx.githubClient) {
        const output = {
          ...provenance('n/a', 'no_data'),
          synced_at: new Date().toISOString(),
          github: { org: '', repos: [], mode: syncMode },
          jira: {
            projects_processed: [],
            issues_upserted: 0,
            transitions_appended: 0,
            errors: [],
            warnings: [],
          },
          identity: { identities_upserted: 0, persons_created: 0, auto_merged: 0, queued: 0 },
          linking: { links_upserted: 0, false_positives_dropped: 0 },
          errors: ['GitHub client not configured — LAZYFLOW_GITHUB_TOKEN required'],
          skipped: true,
          skip_reason: 'LAZYFLOW_GITHUB_TOKEN not set',
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      if (syncSources.includes('jira') && !ctx.jiraClient) {
        const output = {
          ...provenance('n/a', 'no_data'),
          synced_at: new Date().toISOString(),
          github: { org: '', repos: [], mode: syncMode },
          jira: {
            projects_processed: [],
            issues_upserted: 0,
            transitions_appended: 0,
            errors: ['Jira client not configured'],
            warnings: [],
          },
          identity: { identities_upserted: 0, persons_created: 0, auto_merged: 0, queued: 0 },
          linking: { links_upserted: 0, false_positives_dropped: 0 },
          errors: [
            'Jira client not configured — set LAZYFLOW_JIRA_TOKEN, LAZYFLOW_JIRA_EMAIL and LAZYFLOW_JIRA_BASE_URL (run doctor to see which is missing)',
          ],
          skipped: true,
          skip_reason:
            'Jira not fully configured — needs LAZYFLOW_JIRA_TOKEN + LAZYFLOW_JIRA_EMAIL + LAZYFLOW_JIRA_BASE_URL',
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const syncNow = new Date().toISOString()
      const opts = {
        now: syncNow,
        // Engine-version-bump re-derivation (SPEC §8.6). Runs inside runSync after
        // the raw sync but BEFORE the backfill below, so stale-version snapshots are
        // caught while they still carry the old engine_version. No-op when versions
        // already match. Best-effort — runSync records a failure but does not abort.
        rederive: (now) => rederiveOnEngineBump(ctx, now),
      }

      // Build stub scopes from config when clients aren't wired up yet
      const org = ctx.config.repos[0]?.split('/')[0] ?? ''
      // Pass FULL "owner/name" identifiers to the GitHub sync, which resolves
      // each repo directly. Stripping the owner here yielded bare names that
      // never matched the API's full_name, silently syncing zero repos.
      const repos = ctx.config.repos

      const jiraMode = syncMode === 'full' ? 'backfill' : 'incremental'
      const ghMode = syncMode === 'full' ? 'backfill' : 'incremental'

      // Honor the requested `sources`: pass only the clients for the sources the
      // caller asked to sync, null for the rest. Any *requested* source was
      // already validated as configured above (returning skipped=true otherwise),
      // so a requested source always has a non-null client here. A non-requested
      // source's client is passed as null and skipped inside runSync — this is
      // what lets a single-source sync (e.g. github-only on a github-only install)
      // run without requiring the other source's token to be configured.
      const ghClient = syncSources.includes('github') ? ctx.githubClient : null
      const jrClient = syncSources.includes('jira') ? ctx.jiraClient : null

      const tSync = Date.now()
      const result = await runSync(
        ctx.store,
        ghClient,
        {
          org,
          repos: repos.length > 0 ? repos : undefined,
          maxIdleDays: ctx.config.repoMaxIdleDays,
          historyDays: ctx.config.repoHistoryDays,
        },
        ghMode,
        jrClient,
        {
          jiraCloudId: ctx.config.jiraBaseUrl,
          projectKeys: ctx.config.jiraProjects,
        },
        jiraMode,
        opts,
      )
      const syncMs = Date.now() - tSync

      // Compute + persist metric snapshots so reports + get_* tools have real
      // history (the metric engine runs over the freshly-synced entities). The
      // local model treats the configured repos+projects as one dataset, written
      // under both 'team' and 'org' canonical scopes. Best-effort — a failure
      // here does not fail the sync that already succeeded.
      const today = result.syncedAt.slice(0, 10)
      const backfillFrom = new Date(Date.parse(today) - snapshotHorizonDays(ctx) * 86_400_000)
        .toISOString()
        .slice(0, 10)
      const coverageFingerprint = `${org}|${repos.join(',')}|${ctx.config.jiraProjects.join(',')}`
      let snapshotsWritten = 0
      const tBackfill = Date.now()
      try {
        for (const [scopeType, scopeId] of [
          ['team', 'team'],
          ['org', 'org'],
        ]) {
          snapshotsWritten += await backfillSnapshots(ctx.store, {
            scopeType,
            scopeId,
            metricIds: COMPUTE_METRIC_IDS,
            fromDay: backfillFrom,
            toDay: today,
            windowDays: snapshotWindowDays(ctx),
            now: result.syncedAt,
            ingestWatermarkVersion: '1',
            coverageFingerprint,
          })
        }
      } catch (err) {
        // Surface as an error string but keep the successful sync result.
        result.errors.push(`snapshot backfill failed: ${String(err)}`)
      }
      const backfillMs = Date.now() - tBackfill

      // Ongoing retention prune: delete time-series rows beyond the retention
      // window + NULL stale PR diff text + trim snapshots beyond the horizon, so
      // the DB and the engine's in-memory working set stay bounded sync-over-sync.
      // Each sync deletes only the ~1 day that newly aged out, then reclaims freed
      // pages via incremental_vacuum (no full VACUUM — that whole-file rewrite +
      // exclusive lock is left to the `prune` tool). The orphan-GC anti-join is
      // also skipped here (gcOrphans:false) and left to that tool. Best-effort — a
      // failure here never fails the sync that already succeeded.
      let pruned = null
      try {
        const res = await ctx.store.pruneOldData({
          now: result.syncedAt,
          retentionDays: ctx.config.retentionDays,
          snapshotHorizonDays: snapshotHorizonDays(ctx),
          snapshotWindowDays: snapshotWindowDays(ctx),
          patchRetentionDays: ctx.config.patchRetentionDays,
          retentionBufferDays: ctx.config.retentionBufferDays,
          gcOrphans: false,
        })
        pruned = res.counts
        await ctx.store.incrementalVacuum()
        // The prune mutated rows the scope-data memo may hold — drop it so the next
        // get_* / report reloads from the trimmed store rather than stale memory.
        invalidateLookupsCache(ctx.store)
      } catch (err) {
        result.errors.push(`prune failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      const output = {
        ...provenance('n/a'),
        synced_at: result.syncedAt,
        snapshots_written: snapshotsWritten,
        pruned,
        patch_backfill: result.patchBackfill
          ? {
              backfilled: result.patchBackfill.backfilled,
              skipped: result.patchBackfill.skipped,
              remaining: result.patchBackfill.remaining,
            }
          : null,
        timings_ms: {
          sync_total: syncMs,
          github: result.timings?.githubMs ?? 0,
          jira: result.timings?.jiraMs ?? 0,
          snapshot_backfill: backfillMs,
          patch_backfill: result.timings?.backfillMs ?? 0,
        },
        github: {
          org: result.github.org,
          repos: result.github.repos,
          mode: result.github.mode,
        },
        jira: {
          projects_processed: result.jira.projectsProcessed,
          issues_upserted: result.jira.issuesUpserted,
          transitions_appended: result.jira.transitionsAppended,
          errors: result.jira.errors,
          warnings: result.jira.warnings ?? [],
        },
        identity: {
          identities_upserted: result.identity.identitiesUpserted,
          persons_created: result.identity.personsCreated,
          auto_merged: result.identity.autoMerged,
          queued: result.identity.queued,
        },
        linking: {
          links_upserted: result.linking.linksUpserted,
          false_positives_dropped: result.linking.falsePositivesDropped,
        },
        rederive: result.rederive
          ? {
              bump_detected: result.rederive.bumpDetected,
              marked_stale: result.rederive.markedStale,
              recomputed: result.rederive.recomputed,
            }
          : null,
        errors: result.errors,
        skipped: false,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Shared metric output schema (reused by get_dora, get_flow, etc.)
// ---------------------------------------------------------------------------

const metricRowSchema = z.object({
  metric: z.string(),
  value: z.unknown(),
  trust_tier: z.enum(['deterministic', 'hybrid', 'probabilistic']),
  data_quality: z.string(),
  formula_doc: z.string(),
})

const metricBundleOutputSchema = z.object({
  ...provenanceSchema.shape,
  scope: z.string(),
  window_days: z.number(),
  metrics: z.array(metricRowSchema),
  staleness_warning: z.string().optional(),
})

/** Build a standard metric bundle response. */
function metricBundle(scope, windowDays, metrics, staleness) {
  // Enforce the refuse threshold: beyond 24h stale we do NOT serve metric values
  // as if current — suppress the values and flag data_quality. (Previously this
  // emitted only a soft warning while still serving stale numbers.)
  const served = staleness?.refuse
    ? metrics.map((m) => ({ ...m, value: null, data_quality: 'stale_refused' }))
    : metrics
  return {
    ...provenance('deterministic'),
    scope,
    window_days: windowDays,
    metrics: served,
    ...(staleness?.warning !== undefined ? { staleness_warning: staleness.warning } : {}),
  }
}

/** Check freshness; reports a warning and whether data is past the refuse threshold. */
async function stalenessCheck(ctx) {
  try {
    const result = await syncStatus(ctx.store, {
      staleThresholdMs: STALE_WARN_MS,
      refuseThresholdMs: STALE_REFUSE_MS,
    })
    if (result.refuseResources.length > 0) {
      return {
        warning: 'Sync data is stale beyond the refuse threshold — run run_sync',
        refuse: true,
      }
    }
    if (result.warnResources.length > 0)
      return { warning: 'Sync data may be outdated', refuse: false }
    return { refuse: false }
  } catch (err) {
    // The freshness check itself failed (e.g. DB locked/corrupt). Do NOT silently
    // pass it off as fresh — surface a warning so the caller knows freshness is
    // unverified. We do not refuse outright: a transient diagnostic failure
    // should not block all reporting, but it must not be invisible either.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      warning: `Sync freshness check failed (${msg}) — data freshness unverified`,
      refuse: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Live metric computation — feed stored entities into the metric engine
// ---------------------------------------------------------------------------

const DORA_METRIC_IDS = [
  'dora.deployment_frequency',
  'dora.lead_time',
  'dora.change_failure_rate',
  'dora.recovery_time',
]
const FLOW_METRIC_IDS = [
  'flow.cycle_time',
  'flow.flow_efficiency',
  'flow.wip_load',
  'flow.throughput',
  'flow.flow_distribution',
  'flow.aging_wip',
  'flow.cfd',
  'flow.time_in_status',
  'flow.monte_carlo_forecast',
]
const PR_METRIC_IDS = [
  'pr.cycle_time',
  'pr.review_latency',
  'pr.time_to_first_review',
  'pr.time_to_merge',
  'pr.size',
  'pr.ci_health',
  'pr.stale',
  'pr.merge_without_review_rate',
  'pr.review_coverage',
  'pr.reviewers_per_pr',
  'pr.comments_per_pr',
  'pr.review_iterations',
  // Person-only collaboration signal — real value at person/self scope, no_data at team.
  'person.review_reciprocity',
]
const CODE_METRIC_IDS = [
  'code.haloc_aggregate',
  'code.rework_churn',
  'code.complexity_delta',
  'code.maintainability_index',
  'code.nagappan_ball',
]
const AGILE_METRIC_IDS = [
  'agile.sprint_velocity',
  'agile.say_do',
  'agile.sprint_predictability',
  'agile.estimation_accuracy',
  'agile.priority_mix',
]

/**
 * Shared scope params for the get_* tools. `scope_type` selects team vs an
 * individual self-view; `person_id` identifies the person for person/self scope.
 * Person scope attributes work to the person's identities (PRs authored, issues
 * assigned, reviews given) — team-only metrics return no_data for a person.
 */
const SCOPE_TYPE_PARAM = z
  .enum(['team', 'person', 'self'])
  .optional()
  .describe(
    'Scope kind. "person"/"self" compute an individual view (requires person_id); team-only metrics return no_data. Default "team".',
  )
const PERSON_ID_PARAM = z
  .string()
  .optional()
  .describe(
    'Person id (the persons.id value — find it via query_db) — required when scope_type is "person" or "self".',
  )

/**
 * Resolve the (scopeType, scopeId) pair from tool args. For person/self scope a
 * person_id is mandatory; falls back to the legacy `scope` string for team scope.
 * Returns an `error` string when person/self is requested without a person_id.
 */
function resolveScopeArgs({ scope, scope_type, person_id }) {
  const scopeType = scope_type ?? 'team'
  if (scopeType === 'person' || scopeType === 'self') {
    const scopeId = person_id ?? null
    return {
      scopeType,
      scopeId,
      error: scopeId ? null : 'person_id is required when scope_type is "person" or "self".',
    }
  }
  return { scopeType: 'team', scopeId: scope ?? 'team', error: null }
}

/** MCP error result for invalid tool input (e.g. person scope without person_id). */
function inputError(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
}

/**
 * Compute a group of metrics live from the store over a trailing window ending
 * today, mapping each MetricResult to a tool MetricRow. Metrics that aren't
 * computable from stored data return data_quality 'no_data' (never a stub).
 */
async function computeRows(ctx, scopeType, scopeId, metricIds, windowDays) {
  const now = new Date().toISOString()
  const toDay = now.slice(0, 10)
  const fromDay = new Date(Date.parse(toDay) - (windowDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  // Load the scope dataset ONCE and share it across every metric in the bundle.
  // Without this, computeMetric re-runs a full-table load per metric (13× for
  // get_pr_metrics), which on a large install freezes the single-threaded server
  // for seconds and spikes memory N×. Mirrors backfillSnapshots / personReport.
  // Opt into the fat-patch pr_files variant ONLY when the bundle includes a
  // metric that re-parses unified diffs (currently `code.haloc_aggregate`);
  // every other bundle reads denormalised columns and the patch text is the
  // single largest column in the DB.
  const preloaded = await loadScopeData(ctx.store, fromDay, toDay, {
    needsPatch: metricSetNeedsPatch(metricIds),
  })
  const rows = []
  for (const metricId of metricIds) {
    const r = await computeMetric(
      ctx.store,
      scopeType,
      scopeId,
      metricId,
      fromDay,
      toDay,
      now,
      preloaded,
    )
    rows.push({
      metric: metricId,
      value: r.value,
      trust_tier: r.trustTier,
      data_quality: r.dataQuality,
      formula_doc: r.formulaDoc,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Tool: get_dora
// ---------------------------------------------------------------------------

function registerGetDoraTool(server, ctx) {
  server.registerTool(
    'get_dora',
    {
      title: 'Get DORA Metrics',
      description:
        'Deployment frequency, lead time for changes, change failure rate, failed deployment recovery time — with DORA bands.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (team/repo/org). Default: "team".'),
        scope_type: SCOPE_TYPE_PARAM,
        person_id: PERSON_ID_PARAM,
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 30, 1-3650).'),
      }),
      outputSchema: metricBundleOutputSchema,
    },
    async ({ scope, scope_type, person_id, window_days }) => {
      const { scopeType, scopeId, error } = resolveScopeArgs({ scope, scope_type, person_id })
      if (error) return inputError(error)
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics = await computeRows(ctx, scopeType, scopeId, DORA_METRIC_IDS, days)
      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_flow
// ---------------------------------------------------------------------------

function registerGetFlowTool(server, ctx) {
  server.registerTool(
    'get_flow',
    {
      title: 'Get Flow Metrics',
      description:
        'Cycle time, flow efficiency, WIP load, throughput, flow distribution, CFD, aging WIP, ' +
        'time-in-status, and a Monte Carlo completion forecast.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        scope_type: SCOPE_TYPE_PARAM,
        person_id: PERSON_ID_PARAM,
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 30, 1-3650).'),
      }),
      outputSchema: metricBundleOutputSchema,
    },
    async ({ scope, scope_type, person_id, window_days }) => {
      const { scopeType, scopeId, error } = resolveScopeArgs({ scope, scope_type, person_id })
      if (error) return inputError(error)
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics = await computeRows(ctx, scopeType, scopeId, FLOW_METRIC_IDS, days)
      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_pr_metrics
// ---------------------------------------------------------------------------

function registerGetPrMetricsTool(server, ctx) {
  server.registerTool(
    'get_pr_metrics',
    {
      title: 'Get PR / Review Metrics',
      description: '4-phase PR cycle time, review latency, review coverage, stale PRs, CI health.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        scope_type: SCOPE_TYPE_PARAM,
        person_id: PERSON_ID_PARAM,
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 30, 1-3650).'),
      }),
      outputSchema: metricBundleOutputSchema,
    },
    async ({ scope, scope_type, person_id, window_days }) => {
      const { scopeType, scopeId, error } = resolveScopeArgs({ scope, scope_type, person_id })
      if (error) return inputError(error)
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics = await computeRows(ctx, scopeType, scopeId, PR_METRIC_IDS, days)
      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_code_metrics
// ---------------------------------------------------------------------------

function registerGetCodeMetricsTool(server, ctx) {
  server.registerTool(
    'get_code_metrics',
    {
      title: 'Get Code Metrics',
      description:
        'HALOC, rework/churn, work-type split, complexity deltas, Nagappan-Ball, code-change impact.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        scope_type: SCOPE_TYPE_PARAM,
        person_id: PERSON_ID_PARAM,
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 30, 1-3650).'),
      }),
      outputSchema: metricBundleOutputSchema,
    },
    async ({ scope, scope_type, person_id, window_days }) => {
      const { scopeType, scopeId, error } = resolveScopeArgs({ scope, scope_type, person_id })
      if (error) return inputError(error)
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics = await computeRows(ctx, scopeType, scopeId, CODE_METRIC_IDS, days)
      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_agile_metrics
// ---------------------------------------------------------------------------

function registerGetAgileMetricsTool(server, ctx) {
  server.registerTool(
    'get_agile_metrics',
    {
      title: 'Get Agile / Sprint Metrics',
      description: 'Sprint velocity, say/do, predictability, estimation accuracy.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        scope_type: SCOPE_TYPE_PARAM,
        person_id: PERSON_ID_PARAM,
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 90, 1-3650).'),
      }),
      outputSchema: metricBundleOutputSchema,
    },
    async ({ scope, scope_type, person_id, window_days }) => {
      const { scopeType, scopeId, error } = resolveScopeArgs({ scope, scope_type, person_id })
      if (error) return inputError(error)
      const days = window_days ?? 90
      const staleness = await stalenessCheck(ctx)

      const metrics = await computeRows(ctx, scopeType, scopeId, AGILE_METRIC_IDS, days)
      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: explain_metric
// ---------------------------------------------------------------------------

function registerExplainMetricTool(server, _ctx) {
  const FORMULA_DOCS = {
    deployment_frequency: {
      formula_doc:
        'count(prod deploys, status=success) / window; DORA band by median deploy-days/week.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    lead_time_for_changes: {
      formula_doc:
        'Commit set = compare-API enumeration between consecutive deploy SHAs. Per-commit: deploy.finished − pull_requests.first_commit_at. Report median p50/p75/p90.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    change_failure_rate: {
      formula_doc: 'deploys_with_linked_incident / total_prod_deploys. null if 0 deploys.',
      trust_tier: 'hybrid',
      scope: 'team+',
    },
    failed_deployment_recovery_time: {
      formula_doc:
        'Median(first resolved − created) over incidents. Reopened incidents tracked as a separate reopen-rate counter-metric.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    cycle_time: {
      formula_doc:
        'Per-issue: first entry into a started board column → first Done transition. Distribution: p50/p75/p90. Effective-dated flow_state_models (C3). Re-entries accumulate.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    flow_efficiency: {
      formula_doc:
        'Per-issue active_i / (active_i + wait_i); distribution reported. Pinned estimator — avoids pooled ratio which one zombie ticket inflates to 90%. Active/wait from effective-dated flow_state_models + GitHub code-phase.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    haloc: {
      formula_doc:
        'HALOC = Σ_hunk max(insertions, deletions). Kills git modify double-counting. Binary/generated/vendored paths classified and excluded with the volume surfaced separately.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    rework_churn: {
      formula_doc:
        'Rework% = HALOC on blame lines younger than churn_window_days authored by the same author / total HALOC. Efficiency = 100 − Rework%.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    cognitive_complexity: {
      formula_doc:
        'SonarSource Cognitive Complexity (3 rules): A) structural increments (+1+nesting): if/for/while/catch/switch/ternary; B) flat increments (+1): maximal like-operator boolean sequences (a&&b||c=+2), recursive calls, single +1 per switch; C) nesting increments: each structural element gets +N for nesting depth.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    sprint_velocity: {
      formula_doc:
        'Committed snapshot at sprint start (from sprint_membership_events) vs completed points. Counted at one configurable hierarchy level — subtask points roll to parent.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
    say_do: {
      formula_doc:
        'completed_story_points / committed_story_points per sprint. null on 0 committed.',
      trust_tier: 'deterministic',
      scope: 'team+',
    },
  }

  const outputSchema = z.object({
    ...provenanceSchema.shape,
    metric: z.string(),
    formula_doc: z.string(),
    scope: z.string(),
    found: z.boolean(),
  })

  server.registerTool(
    'explain_metric',
    {
      title: 'Explain Metric',
      description:
        'Returns the published formula and inputs for a metric — the in-product "how is this computed?" transparency surface.',
      inputSchema: z.object({
        metric: z.string().describe('Metric identifier, e.g. "deployment_frequency", "haloc".'),
      }),
      outputSchema,
    },
    async ({ metric }) => {
      // Prefer the engine module's own formulaDoc keyed by the FULLY-QUALIFIED
      // id the get_* tools and schema guide emit (dora.*, flow.*, pr.*, code.*,
      // agile.*, person.*). The curated short-name table (deployment_frequency,
      // haloc, …) is kept only as a back-compat fallback for the legacy aliases.
      // Without this, explain_metric returned "not documented" for every
      // qualified id a user actually receives from the other tools.
      const engine = metricFormulaDoc(metric)
      const entry = FORMULA_DOCS[metric]
      const found = engine !== null || entry !== undefined
      const output = {
        ...provenance('n/a'),
        metric,
        formula_doc:
          engine?.formulaDoc ?? entry?.formula_doc ?? 'Formula not documented for this metric.',
        scope: engine !== null ? `${engine.scope}+` : (entry?.scope ?? 'unknown'),
        found,
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// NOTE: the built-in AI-insight tools (ticket_work_alignment, effort_proportionality,
// explain_anomaly, pr_quality) and correct_verdict were retired (WS-1) — Claude
// queries the DB itself via query_db below instead. The ai_verdicts table
// remains but is currently UNWRITTEN.

// ---------------------------------------------------------------------------
// Tool: query_db — read-only SQL over the live SQLite store (WS-0)
// ---------------------------------------------------------------------------
//
// This is the primary "ask Claude to analyse the data itself" surface. Rather
// than ship hard-wired AI-insight tools, we expose the underlying SQLite DB for
// arbitrary read-only SELECT/WITH queries. The accompanying lazy-flow://schema
// resource documents the table layout and how to resolve a person via the
// identities table.
//
// SAFETY (defense in depth):
//   1. Open a SEPARATE handle to the SAME db file with { readonly: true } and
//      PRAGMA query_only=ON — never route through the shared writer connection.
//      (For ':memory:' the writer's data is not visible to a second handle, so
//      we fall back to the store connection but keep every other guard.)
//   2. Statically reject anything whose first SQL keyword (after stripping
//      leading comments/whitespace) is not SELECT or WITH.
//   3. Reject multiple statements (a ';' that is not the trailing one).
//   4. Reject ATTACH / DETACH / PRAGMA / DDL / DML keywords outright.
//   5. Bind params positionally via prepare(sql).all(...params) — never
//      string-interpolate user input.
//   6. Enforce max_rows (default 1000, hard cap 5000), a byte budget, an index
//      pre-flight, and a hard wall-clock timeout via out-of-process execution.
//
// The validation/budget/plan-guard primitives live in ./queryGuard.js so the
// queryRunner child process can share them. See that module's header for the
// full threat model.

/**
 * Acquire a read-only Database handle for a query. For an on-disk DB this
 * opens a SEPARATE readonly connection (with query_only=ON) so a malicious query
 * can never reach the shared writer. For ':memory:' a second handle would see an
 * empty DB (in-memory DBs are not shared across connections), so we fall back to
 * the writer connection; there we rely on the static SELECT/WITH-only guard,
 * which already rejects every write/DDL/PRAGMA keyword before execution.
 *
 * Returns the handle plus a `close` to release it (no-op for the shared writer).
 */
function acquireReadHandle(ctx) {
  if (ctx.config.dbPath === ':memory:') {
    // Shared in-memory writer — a second handle would not see its data.
    return { db: ctx.store.db, close: () => {} }
  }
  const ro = new Database(ctx.config.dbPath, { readonly: true })
  // Defense in depth: the readonly flag already makes bun:sqlite reject writes
  // ("attempt to write a readonly database"), but we also pin query_only on this
  // dedicated connection so the guarantee does not depend on a single mechanism.
  ro.exec('PRAGMA query_only = ON')
  return { db: ro, close: () => ro.close() }
}

/** Absolute path to the query_db child-process runner. */
const QUERY_RUNNER_PATH = new URL('./queryRunner.js', import.meta.url).pathname

/**
 * Execute an arbitrary read-only query in a SEPARATE OS process bounded by a
 * hard wall-clock timeout. This is the core safeguard: an in-process query (even
 * on a worker thread) stuck inside a single native sqlite3_step() — exactly what
 * a fan-out/cartesian aggregate does — cannot be interrupted, so it can wedge the
 * single-threaded server for hours. A child process can always be SIGKILL'd, so
 * the worst case is bounded to `timeoutMs`, and the server stays responsive to
 * every other tool throughout (Bun.spawn is async).
 */
async function runQueryInSubprocess(ctx, { sql, params, maxRows }) {
  const timeoutMs = ctx.config.queryDbTimeoutMs ?? QUERY_DB_TIMEOUT_MS
  const proc = Bun.spawn(['bun', QUERY_RUNNER_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  proc.stdin.write(
    JSON.stringify({
      dbPath: ctx.config.dbPath,
      sql,
      params,
      maxRows,
      maxBytes: QUERY_DB_MAX_BYTES,
      scanThreshold: LARGE_SCAN_ROW_THRESHOLD,
    }),
  )
  proc.stdin.end()

  // Drain stdout AND stderr concurrently. If stderr is left unread and the child
  // emits a large volume (a crash dump / native assertion), its OS pipe buffer can
  // fill and deadlock the child — turning a fast error into a full timeout stall.
  const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text()])
  await proc.exited

  // Bun sets signalCode when it kills the child on timeout (killSignal above).
  if (proc.signalCode != null) {
    throw new QueryDbError(
      `Query exceeded the ${Math.round(timeoutMs / 1000)}s limit and was aborted. ` +
        'This usually means a fan-out: do not JOIN several child tables of the same ' +
        'parent in one query (it produces a cartesian product). Query each table ' +
        'separately, add an indexed WHERE filter, or use the data_overview tool for ' +
        'ingestion counts.',
    )
  }

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const detail = stderr?.trim() ? ` (${stderr.trim().slice(0, 300)})` : ''
    throw new QueryDbError(
      `query runner returned no parseable output (the query may have crashed)${detail}.`,
    )
  }
  if (!parsed.ok) {
    throw new QueryDbError(parsed.error ?? 'query failed')
  }
  return { columns: parsed.columns, rows: parsed.rows, truncated: parsed.truncated }
}

function registerQueryDbTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())),
    row_count: z.number(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })

  server.registerTool(
    'query_db',
    {
      title: 'Query DB (read-only SQL)',
      description:
        'Run a read-only SELECT/WITH SQL query against the local lazy-flow SQLite store and ' +
        'get back columns + rows. Read the lazy-flow://schema resource first for the table ' +
        'layout and how to resolve a person via the identities table. Writes/DDL/PRAGMA are ' +
        'rejected. Params are bound positionally (use ? placeholders). Queries run in an ' +
        'isolated process with a hard time limit and must use an index when scanning large ' +
        'tables — NEVER JOIN several child tables of the same parent in one query (that fans ' +
        'out to a cartesian product); query each separately. For ingestion counts, prefer the ' +
        'data_overview tool.',
      inputSchema: z.object({
        sql: z.string().describe('A single read-only SELECT/WITH query. Use ? for bound params.'),
        params: z
          .array(z.union([z.string(), z.number(), z.null()]))
          .optional()
          .describe('Positional bind values for ? placeholders, in order.'),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(QUERY_DB_HARD_CAP_ROWS)
          .optional()
          .describe(
            `Max rows to return (default ${QUERY_DB_DEFAULT_MAX_ROWS}, cap ${QUERY_DB_HARD_CAP_ROWS}).`,
          ),
      }),
      outputSchema,
    },
    async ({ sql, params, max_rows }) => {
      const maxRows = Math.min(max_rows ?? QUERY_DB_DEFAULT_MAX_ROWS, QUERY_DB_HARD_CAP_ROWS)
      const bind = params ?? []

      try {
        // Fast static reject (no process spawn) before doing any work.
        assertReadOnlyQuery(sql)

        let result
        if (ctx.config.dbPath === ':memory:') {
          // An in-memory DB is not visible to a child process, so we cannot
          // sandbox it out-of-process. Run in-process with the same index
          // pre-flight + budgets. There is no hard timeout here, but :memory: is
          // only ever ephemeral/test data of trivial size.
          const handle = acquireReadHandle(ctx)
          try {
            assertIndexedPlan(handle.db, sql, bind)
            result = runBudgetedQuery(handle.db, sql, bind, {
              maxRows,
              maxBytes: QUERY_DB_MAX_BYTES,
            })
          } finally {
            handle.close()
          }
        } else {
          // On-disk: execute in an isolated, time-bounded child process so a
          // runaway query can never wedge the long-lived server.
          result = await runQueryInSubprocess(ctx, { sql, params: bind, maxRows })
        }

        const output = {
          ...provenance('deterministic', result.rows.length === 0 ? 'no_data' : 'ok'),
          columns: result.columns,
          rows: result.rows,
          row_count: result.rows.length,
          truncated: result.truncated,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      } catch (err) {
        // Validation errors carry a safe, specific message; for anything else
        // (e.g. a SQLite syntax error) surface the engine's own message so the
        // caller can fix their query — there are no secrets in a SQL error.
        const message = err instanceof QueryDbError ? err.message : `query failed: ${String(err)}`
        const output = {
          ...provenance('deterministic', 'error'),
          columns: [],
          rows: [],
          row_count: 0,
          truncated: false,
          error: message,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: data_overview — safe, index-backed ingestion summary
// ---------------------------------------------------------------------------
//
// The descriptive "what / how much did we ingest" surface, so callers never need
// raw SQL (and never reach for a multi-child JOIN) just to see volumes. Every
// query here is a single-table COUNT / GROUP-BY on an indexed FK, merged in JS —
// there is no cross-table fan-out, so it is fast at any scale.

function registerDataOverviewTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    totals: z.record(z.number()),
    repos: z.array(z.record(z.unknown())),
    jira_projects: z.array(z.record(z.unknown())),
  })

  server.registerTool(
    'data_overview',
    {
      title: 'Data overview (ingestion summary)',
      description:
        'Per-repo and per-project counts of everything ingested (PRs, commits, deployments, ' +
        'check runs, PR files, Jira issues) plus global totals. Use this instead of writing ' +
        'raw query_db SQL when you just need to know how much data is in the store.',
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const handle = acquireReadHandle(ctx)
      try {
        const db = handle.db
        const count = (table) =>
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
        // Single-table GROUP BY on the indexed FK; merged into repos in JS. NEVER
        // a JOIN across children — that is exactly the cartesian trap this tool
        // exists to avoid.
        const groupCount = (table, col = 'repo_id') => {
          const m = new Map()
          for (const r of db
            .prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${col}`)
            .all()) {
            m.set(r.k, Number(r.n))
          }
          return m
        }

        const totals = {
          repositories: count('repositories'),
          pull_requests: count('pull_requests'),
          commits: count('commits'),
          pr_files: count('pr_files'),
          reviews: count('reviews'),
          review_comments: count('review_comments'),
          check_runs: count('check_runs'),
          deployments: count('deployments'),
          issues: count('issues'),
          issue_transitions: count('issue_transitions'),
          identities: count('identities'),
          persons: count('persons'),
          metric_snapshots: count('metric_snapshots'),
        }

        const prByRepo = groupCount('pull_requests')
        const commitByRepo = groupCount('commits')
        const deployByRepo = groupCount('deployments')
        const checkByRepo = groupCount('check_runs')
        const fileByRepo = groupCount('pr_files')
        const repos = db
          .prepare(
            "SELECT id, owner || '/' || name AS repo FROM repositories WHERE deleted_at IS NULL ORDER BY repo",
          )
          .all()
          .map((r) => ({
            repo: r.repo,
            prs: prByRepo.get(r.id) ?? 0,
            commits: commitByRepo.get(r.id) ?? 0,
            deployments: deployByRepo.get(r.id) ?? 0,
            check_runs: checkByRepo.get(r.id) ?? 0,
            pr_files: fileByRepo.get(r.id) ?? 0,
          }))

        const issuesByProject = groupCount('issues', 'project_id')
        const jiraProjects = db
          .prepare('SELECT id, key FROM jira_projects ORDER BY key')
          .all()
          .map((p) => ({ project: p.key, issues: issuesByProject.get(p.id) ?? 0 }))

        const output = {
          ...provenance('deterministic', totals.repositories === 0 ? 'no_data' : 'ok'),
          totals,
          repos,
          jira_projects: jiraProjects,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      } finally {
        handle.close()
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: export (WP-EXPORT)
// ---------------------------------------------------------------------------

const EXPORT_SCOPE_TYPES = ['repo', 'team', 'org', 'person', 'self']

function registerExportTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    format: z.enum(['csv', 'json']),
    metric: z.string(),
    scope_type: z.string(),
    scope: z.string(),
    window_days: z.number(),
    rows: z.array(z.record(z.unknown())),
    row_count: z.number(),
  })

  server.registerTool(
    'export',
    {
      title: 'Export Metric Data',
      description:
        'Export real metric snapshots as structured CSV or JSON with provenance columns ' +
        '(engine_version, trust_tier, data_quality, coverage_fingerprint, as_of, computed_at).',
      inputSchema: z.object({
        metric: z.string().describe('Metric id to export, e.g. "flow.cycle_time".'),
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        scope_type: z
          .enum(EXPORT_SCOPE_TYPES)
          .optional()
          .describe('Scope type: repo|team|org|person|self (default: team).'),
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 30, 1-3650).'),
        format: z.enum(['csv', 'json']).optional().describe('Output format (default: json).'),
      }),
      outputSchema,
    },
    async ({ metric, scope, scope_type, window_days, format }) => {
      const scopeId = scope ?? 'team'
      const scopeType = scope_type ?? 'team'
      const days = window_days ?? 30
      const fmt = format ?? 'json'

      const now = new Date()
      const fromDay = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
      const toDay = now.toISOString().slice(0, 10)

      // Read REAL snapshots from the store (the old stub returned a single no_data row).
      const snapshots = await ctx.store.getSnapshots(scopeType, scopeId, metric, fromDay, toDay)

      const rows = snapshots.map((s) => ({
        scope_type: s.scopeType,
        scope_id: s.scopeId,
        metric: s.metric,
        day: s.day,
        value: s.value,
        window: s.window,
        trust_tier: s.trustTier,
        data_quality: s.dataQuality,
        engine_version: s.engineVersion,
        ingest_watermark_version: s.ingestWatermarkVersion,
        coverage_fingerprint: s.coverageFingerprint,
        computed_at: s.computedAt,
        is_stale: s.isStale,
      }))

      // Envelope trust tier: uniform tier when all rows agree, else 'hybrid'; n/a when empty.
      const tiers = [...new Set(snapshots.map((s) => s.trustTier))]
      const envelopeTier = rows.length === 0 ? 'n/a' : tiers.length === 1 ? tiers[0] : 'hybrid'
      const dataQuality = rows.length === 0 ? 'no_data' : 'ok'
      const coverage = snapshots[0]?.coverageFingerprint

      const output = {
        ...provenance(envelopeTier, dataQuality, coverage),
        format: fmt,
        metric,
        scope_type: scopeType,
        scope: scopeId,
        window_days: days,
        rows,
        row_count: rows.length,
      }

      // CSV format returns the CSV text directly; JSON returns the full envelope.
      const text = fmt === 'csv' ? toCsv(rows) : toJson(output)
      return {
        content: [{ type: 'text', text }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create and configure the McpServer with all tools and resources. */
// ---------------------------------------------------------------------------
// Reporting tools (WP-REPORT) — generate exported artifacts, list presets
// ---------------------------------------------------------------------------

const REPORT_SCOPE_TYPES = ['repo', 'team', 'org', 'person', 'self']
const REPORT_FORMATS = ['html', 'markdown', 'csv', 'json']

/** Last HTML report generated this session, served via lazy-flow://report/latest. */
let latestReportHtml = null

/**
 * Deterministic "what changed" narrative — summarises the significant baseline
 * moves the engine already computed. Reproducible and advisory; never drives a
 * number. (The NarrativeProvider interface also accepts an LLM-backed impl.)
 */
function buildNarrativeProvider() {
  const BANDS = {
    well_below: 'well below baseline',
    below: 'below baseline',
    above: 'above baseline',
    well_above: 'well above baseline',
  }
  return {
    async forSection(req) {
      const moved = req.cells.filter((c) => c.comparison.significant)
      if (moved.length === 0) return null
      const bullets = moved.map((c) => {
        const dir = c.comparison.trendArrow === 'up' ? 'rose' : 'fell'
        const where = BANDS[c.comparison.band] ?? c.comparison.band
        return `${c.label} ${dir} vs baseline (now ${where}).`
      })
      return {
        trustTier: 'deterministic',
        summary: `${moved.length} metric${moved.length > 1 ? 's' : ''} moved beyond normal variance this period.`,
        bullets,
        promptVersion: null,
        modelSnapshot: null,
        contestable: false,
        advisory: true,
      }
    },
  }
}

function registerGenerateReportTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    preset: z.string(),
    title: z.string(),
    audience: z.string(),
    scope_type: z.string(),
    scope: z.string(),
    period_label: z.string(),
    format: z.enum(REPORT_FORMATS),
    person_scope: z.boolean(),
    bytes: z.number(),
    out_path: z.string().nullable(),
    content: z.string(),
  })

  server.registerTool(
    'generate_report',
    {
      title: 'Generate Report',
      description:
        'Generate a preset delivery report (self-contained HTML, Markdown, CSV, or JSON) for a ' +
        'scope and period from stored snapshots. An exported artifact — you share/present the file.',
      inputSchema: z.object({
        preset: z.string().describe('Preset key, e.g. "monthly:team" (see list_report_presets).'),
        scope: z.string().optional().describe('Scope id (default "team").'),
        scope_type: z.enum(REPORT_SCOPE_TYPES).optional().describe('repo|team|org|person|self.'),
        period_end: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Anchor day YYYY-MM-DD (default: today).'),
        window_days: z.number().int().min(1).max(3650).optional(),
        format: z.enum(REPORT_FORMATS).optional().describe('Output format (default: html).'),
        out_path: z
          .string()
          .optional()
          .describe('If set, also write the artifact to this absolute file path.'),
      }),
      outputSchema,
    },
    async ({ preset, scope, scope_type, period_end, window_days, format, out_path }) => {
      const now = new Date().toISOString()
      const periodEnd = period_end ?? now.slice(0, 10)
      const fmt = format ?? 'html'
      const scopeId = scope ?? 'team'
      const scopeType = scope_type ?? 'team'

      const res = await generateReport(
        {
          store: ctx.store,
          presetKey: preset,
          scope: { type: scopeType, id: scopeId },
          periodEnd,
          now,
          windowDays: window_days,
          benchmark: buildBenchmarkProvider(),
          narrative: buildNarrativeProvider(),
          // Person-scope presets have no persisted snapshots (sync only writes
          // team/org). Provide a live-compute fallback so a person report is not
          // an empty facade — mirrors get_person_report's live path.
          liveCompute: (metricId, cellScope, from, to) =>
            computeMetric(ctx.store, cellScope.type, cellScope.id, metricId, from, to, now),
        },
        fmt,
      )

      let written = null
      if (out_path !== undefined) {
        // Guard the write target. This tool runs locally as the user, but it is
        // driven by an LLM, so a poisoned prompt could try to make it overwrite an
        // arbitrary file (e.g. ~/.bashrc, an SSH key) with attacker-chosen content.
        // A report writer should only ever write a report file: reject NUL bytes
        // and require a known report extension. This blocks dotfiles/system files
        // (no report extension) while leaving the legitimate "write my report
        // anywhere" use case intact.
        if (out_path.includes('\0')) {
          throw new Error('out_path must not contain NUL bytes')
        }
        const ALLOWED_REPORT_EXTS = ['.html', '.htm', '.md', '.markdown', '.csv', '.json']
        const lower = out_path.toLowerCase()
        if (!ALLOWED_REPORT_EXTS.some((ext) => lower.endsWith(ext))) {
          throw new Error(
            `out_path must end with a report extension (${ALLOWED_REPORT_EXTS.join(', ')}) — refusing to write to "${out_path}"`,
          )
        }
        // Bun.write — recommended file-write API; creates parent dirs as needed.
        await Bun.write(out_path, res.content)
        written = out_path
      }
      if (fmt === 'html') {
        latestReportHtml = { html: res.content, title: res.model.title, asOf: now }
      }

      const tier = res.model.provenance.trustTier
      const output = {
        ...provenance(
          tier === 'mixed' ? 'hybrid' : tier,
          res.model.provenance.dataQuality,
          res.model.provenance.coverageFingerprint ?? undefined,
        ),
        preset,
        title: res.model.title,
        audience: res.model.audience,
        scope_type: scopeType,
        scope: scopeId,
        period_label: res.model.period.label,
        format: fmt,
        person_scope: res.model.personScope,
        bytes: res.content.length,
        out_path: written,
        content: res.content,
      }
      return {
        content: [{ type: 'text', text: res.content }],
        structuredContent: output,
      }
    },
  )
}

function registerListReportPresetsTool(server, _ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    presets: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        audience: z.string(),
        scope_type: z.string(),
        cadence: z.string(),
        person_scope: z.boolean(),
      }),
    ),
    count: z.number(),
  })

  server.registerTool(
    'list_report_presets',
    {
      title: 'List Report Presets',
      description: 'List the available preset reports (key, audience, cadence, scope).',
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const presets = listPresets().map((p) => ({
        key: p.key,
        title: p.title,
        audience: p.audience,
        scope_type: p.scopeType,
        cadence: p.cadence,
        person_scope: p.personScope,
      }))
      const output = { ...provenance('deterministic', 'ok'), presets, count: presets.length }
      return {
        content: [{ type: 'text', text: toJson(output) }],
        structuredContent: output,
      }
    },
  )
}

function registerReportResources(server) {
  server.registerResource(
    'report_latest',
    'lazy-flow://report/latest',
    {
      title: 'Latest Generated Report',
      description: 'The most recently generated HTML report (this server session).',
      mimeType: 'text/html',
    },
    async () => ({
      contents: [
        {
          uri: 'lazy-flow://report/latest',
          mimeType: 'text/html',
          text:
            latestReportHtml?.html ??
            '<!DOCTYPE html><html lang="en"><body><p>No report generated yet this session. ' +
              'Use the <code>generate_report</code> tool.</p></body></html>',
        },
      ],
    }),
  )
}

// ---------------------------------------------------------------------------
// Resource — lazy-flow://schema (live DDL + hand-written query guide, WS-0)
// ---------------------------------------------------------------------------

/**
 * Hand-written guide that accompanies the live schema. Tells Claude how to
 * resolve a person, filter entities by identity, and where precomputed metric
 * values live — so it can write effective query_db SQL without guessing.
 *
 * Explicit transparency header: this DB (and therefore the schema/query_db
 * surface) exposes identities.external_id and raw API payloads BY DESIGN. That
 * is the product contract — local, single-user, full-transparency. It is not a
 * leak; do not redact it when answering the local user.
 */
const SCHEMA_GUIDE = `# lazy-flow SQLite schema guide

TRANSPARENCY: This local, single-user store deliberately exposes
identities.external_id (GitHub logins, commit emails, Jira account ids) and the
raw API payloads in each table's \`raw\` column. That is the product's
full-transparency contract — surface it to the local user freely.

## Resolving a person
- A real person is a row in \`persons\`. Their platform accounts (GitHub login,
  commit email, Jira account) are rows in \`identities\`, each pointing at the
  person via \`identities.person_id\` (NULL until the identity is resolved /
  confirmed). \`identities.kind\` is one of 'github_login' | 'commit_email' |
  'jira_account'; \`identities.external_id\` is the raw account handle.
- To find a person's identities:
    SELECT id, kind, external_id, person_id
    FROM identities WHERE person_id = ?;
- To go from a handle (e.g. a GitHub login) to a person:
    SELECT person_id FROM identities WHERE kind = 'github_login' AND external_id = ?;

## Attributing work
Commits, PRs, reviews, comments and issues reference an identity, NOT a person
directly. Join through identities to aggregate by person:
- commits.author_identity_id           -> identities.id
- pull_requests.author_identity_id     -> identities.id (also merged_by_identity_id)
- reviews.reviewer_identity_id         -> identities.id
- review_comments.author_identity_id   -> identities.id
- issues.assignee_identity_id          -> identities.id
Example — count merged PRs per person:
    SELECT p.id AS person_id, COUNT(*) AS merged_prs
    FROM pull_requests pr
    JOIN identities i ON i.id = pr.author_identity_id
    JOIN persons p ON p.id = i.person_id
    WHERE pr.state = 'merged'
    GROUP BY p.id;

## Precomputed metrics
- \`metric_snapshots\` holds daily precomputed metric values per scope
  (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
  coverage_fingerprint). Prefer these over recomputing from raw entities.
- \`metric_baselines\` holds derived self/peer baselines (baseline_kind in
  'self'|'peer') used by reports for "vs baseline" comparisons.

## Notes
- Soft-deleted rows (repositories, pull_requests, issues) carry a non-NULL
  \`deleted_at\`; filter \`deleted_at IS NULL\` for live data.
- Timestamps are ISO-8601 TEXT. Booleans are INTEGER 0/1.

## query_db rules (so it stays fast)
- Read-only: only a single SELECT/WITH statement runs; it executes in an isolated
  process with a hard time limit and is force-killed if it overruns.
- DO NOT join several CHILD tables of the same parent in one query
  (e.g. pull_requests + commits + deployments + check_runs all joined to
  repositories). Each parent→child join is one-to-many, so joining N children
  multiplies their row counts into a CARTESIAN PRODUCT (millions–trillions of
  intermediate rows) even when the final result is tiny. Instead, run one
  \`GROUP BY\` per child table and combine the results yourself.
- Large tables (pr_files, check_runs, commits, reviews, issue_transitions,
  metric_snapshots) must be accessed via an index — add a WHERE on an indexed
  column (repo_id, pr_id, created_at, …). A planned full scan of a large table is
  rejected up front.
- For "how much did we ingest" counts per repo/project, call the \`data_overview\`
  tool instead of writing SQL.`

/**
 * Build the schema guide + live DDL markdown. Shared by the lazy-flow://schema
 * RESOURCE and the get_schema TOOL — many subagents (and some MCP clients) only
 * call tools, never read resources, so the schema must be reachable both ways.
 */
function buildSchemaText(ctx) {
  // Pull the live DDL so the doc can never drift from the actual schema.
  let ddl = ''
  try {
    const rows = ctx.store.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
    ddl = rows.map((r) => `${r.sql};`).join('\n\n')
  } catch (err) {
    ddl = `-- failed to read live schema: ${String(err)}`
  }

  // The absolute DB path so Claude can discover it at runtime (mirrors the
  // doctor db_path check).
  const dbPathLine =
    ctx.config.dbPath === ':memory:'
      ? 'DB path: :memory: (ephemeral — not queryable across processes)'
      : `DB path: ${ctx.config.dbPath}`

  return `${SCHEMA_GUIDE}\n\n${dbPathLine}\n\n## Live schema (sqlite_master)\n\n\`\`\`sql\n${ddl}\n\`\`\`\n`
}

function registerSchemaResource(server, ctx) {
  server.registerResource(
    'schema',
    'lazy-flow://schema',
    {
      title: 'lazy-flow DB schema',
      description:
        'Live SQLite DDL (from sqlite_master) plus a guide on resolving persons via identities and ' +
        'where precomputed metrics live. Read this before writing query_db SQL.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: 'lazy-flow://schema',
          mimeType: 'text/markdown',
          text: buildSchemaText(ctx),
        },
      ],
    }),
  )
}

/**
 * Tool mirror of the lazy-flow://schema resource. Subagents that can only call
 * tools (the squad-reviewer stall was caused by reaching for a non-existent
 * resource-read) need a tool path to the same content.
 */
function registerGetSchemaTool(server, ctx) {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    schema: z.string(),
  })

  server.registerTool(
    'get_schema',
    {
      title: 'Get DB Schema',
      description:
        'Return the lazy-flow SQLite schema guide + live DDL (identical to the lazy-flow://schema ' +
        'resource) as a tool result. Call this before writing query_db SQL — it documents the ' +
        'tables, how to resolve a person via the identities table, and where precomputed metrics live.',
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const output = { ...provenance('n/a'), schema: buildSchemaText(ctx) }
      return {
        content: [{ type: 'text', text: output.schema }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tools: identity stitching review — confirm/reject queued matches + manual link
// ---------------------------------------------------------------------------

/**
 * Human-readable summary of an identity for the stitch-review tools: its kind,
 * external id, the person it links to (if any), and a best-effort display label
 * (Jira displayName / GitHub login / commit email from the raw payload).
 */
async function summariseIdentity(store, identityId) {
  if (!identityId) return null
  const id = await store.findIdentityById(identityId)
  if (!id) return { id: identityId, missing: true }
  let label = id.externalId
  try {
    const raw = JSON.parse(id.raw ?? '{}')
    label = raw.displayName ?? raw.login ?? raw.email ?? id.externalId
  } catch {
    // raw not JSON — fall back to externalId.
  }
  let personName = null
  if (id.personId) {
    const p = await store.getPerson(id.personId)
    personName = p?.displayName ?? null
  }
  return {
    id: id.id,
    kind: id.kind,
    externalId: id.externalId,
    label,
    personId: id.personId,
    personName,
  }
}

function registerListIdentityMatchesTool(server, ctx) {
  server.registerTool(
    'list_identity_matches',
    {
      title: 'List Identity Match Candidates',
      description:
        'List identity-stitch candidates from the human-confirm queue, each side resolved (kind, ' +
        'external id, linked person, display label) so you can decide. Default status "pending". ' +
        'Then use resolve_identity_match to confirm/reject, or link_identity to assign manually. ' +
        'Two candidates pointing at the SAME person are NOT a conflict — confirm both to attach two ' +
        "accounts (e.g. a person's work + personal GitHub) to one person.",
      inputSchema: z.object({
        status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
      }),
    },
    async ({ status }) => {
      const st = status ?? 'pending'
      const matches = await listCandidateMatches(ctx.store, { status: st })
      const rows = []
      for (const m of matches) {
        rows.push({
          match_id: m.id,
          reason: m.reason,
          confidence: m.confidence,
          status: m.status,
          a: await summariseIdentity(ctx.store, m.identityIdA),
          b: await summariseIdentity(ctx.store, m.identityIdB),
        })
      }
      const output = { ...provenance('n/a'), status: st, count: rows.length, matches: rows }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

function registerResolveIdentityMatchTool(server, ctx) {
  server.registerTool(
    'resolve_identity_match',
    {
      title: 'Confirm or Reject an Identity Match',
      description:
        'Confirm (merge both identities under one person — if they belong to two DIFFERENT persons, ' +
        'every identity of the loser person migrates to the winner and the loser is removed) or reject ' +
        '(keep separate; suppress from the queue) a candidate from list_identity_matches. Confirm needs ' +
        'at least ONE side already linked to a person — otherwise it errors and the match stays pending ' +
        '(use link_identity first). Pass dry_run:true to preview without writing. Audited; a confirm is ' +
        'reversible via unmerge_identity_match.',
      inputSchema: z.object({
        match_id: z.string(),
        decision: z.enum(['confirm', 'reject']),
        decided_by: z.string().optional().describe('Who decided (audit). Default "mcp-agent".'),
        dry_run: z.boolean().optional().describe('Preview the effect without writing.'),
      }),
    },
    async ({ match_id, decision, decided_by, dry_run }) => {
      const now = new Date().toISOString()
      const actor = decided_by ?? 'mcp-agent'
      const mk = (extra) => {
        const output = { ...provenance('n/a'), match_id, decision, ...extra }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }
      const match = await ctx.store.getCandidateMatch(match_id)
      if (!match) return mk({ error: `candidate match not found: ${match_id}` })
      if (match.status !== 'pending') return mk({ error: `match already ${match.status}` })

      const a = await summariseIdentity(ctx.store, match.identityIdA)
      const b = await summariseIdentity(ctx.store, match.identityIdB)

      if (decision === 'confirm') {
        const targetPersonId = a?.personId ?? b?.personId ?? null
        if (!targetPersonId) {
          return mk({
            error:
              'neither identity is linked to a person — use link_identity to assign one first, then confirm',
            a,
            b,
          })
        }
        // Would this merge two distinct persons (migrating the loser's identities)?
        const loserPersonId =
          a?.personId && b?.personId && a.personId !== b.personId
            ? a.personId === targetPersonId
              ? b.personId
              : a.personId
            : null
        if (dry_run) {
          return mk({
            dryRun: true,
            wouldLinkPersonId: targetPersonId,
            wouldMergePersons: !!loserPersonId,
            loserPersonId,
            a,
            b,
          })
        }
        try {
          await confirmCandidateMatch(ctx.store, match_id, actor, now)
        } catch (err) {
          return mk({ error: err instanceof Error ? err.message : String(err), a, b })
        }
        await ctx.store.appendIdentityAudit({
          id: crypto.randomUUID(),
          action: 'confirm_match',
          identityId: match.identityIdB,
          fromPersonId: b?.personId ?? null,
          toPersonId: targetPersonId,
          matchId: match_id,
          decidedBy: actor,
          note: loserPersonId ? `merged person ${loserPersonId} into ${targetPersonId}` : null,
          createdAt: now,
        })
        return mk({ linkedPersonId: targetPersonId, mergedPersons: !!loserPersonId, loserPersonId })
      }

      // reject
      if (dry_run) return mk({ dryRun: true, wouldReject: true, a, b })
      try {
        await rejectCandidateMatch(ctx.store, match_id, actor, now)
      } catch (err) {
        return mk({ error: err instanceof Error ? err.message : String(err) })
      }
      await ctx.store.appendIdentityAudit({
        id: crypto.randomUUID(),
        action: 'reject_match',
        identityId: match.identityIdA,
        matchId: match_id,
        decidedBy: actor,
        createdAt: now,
      })
      return mk({ rejected: true })
    },
  )
}

function registerLinkIdentityTool(server, ctx) {
  server.registerTool(
    'link_identity',
    {
      title: 'Manually Link or Unlink an Identity',
      description:
        'Manually assign an identity to a person when the auto-stitcher had no signal — e.g. a legacy ' +
        'commit email (old@company.com) or a personal GitHub account belonging to a known person. ' +
        'Provide to_person_id (a persons.id) OR to_identity_id (adopt THAT identity’s person). Set ' +
        'unlink:true to detach. Refuses bot identities and self-links; warns when it would leave the ' +
        'source person with no identities. Pass dry_run:true to preview. Audited; survives re-syncs.',
      inputSchema: z.object({
        identity_id: z.string().describe('The identity to (re)assign (identities.id).'),
        to_person_id: z.string().optional().describe('Target persons.id to link to.'),
        to_identity_id: z
          .string()
          .optional()
          .describe('Adopt the person of this already-linked identity.'),
        unlink: z.boolean().optional().describe('If true, detach the identity from its person.'),
        dry_run: z.boolean().optional().describe('Preview the effect without writing.'),
        decided_by: z.string().optional().describe('Who decided (audit). Default "mcp-agent".'),
      }),
    },
    async ({ identity_id, to_person_id, to_identity_id, unlink, dry_run, decided_by }) => {
      const now = new Date().toISOString()
      const actor = decided_by ?? 'mcp-agent'
      const mk = (extra) => {
        const output = { ...provenance('n/a'), identity_id, ...extra }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }
      // Warn if leaving `personId` with zero identities (it will be GC'd next sync).
      const orphanWarn = async (personId) => {
        if (!personId) return null
        const sibs = await ctx.store.getIdentitiesByPerson(personId)
        return sibs.length <= 1
          ? `person ${personId} will have no identities left and be removed on the next sync`
          : null
      }

      const id = await ctx.store.findIdentityById(identity_id)
      if (!id) return mk({ error: `identity not found: ${identity_id}` })
      // A bot identity must never be attached to a person (it would pollute that
      // person's metrics). Unlinking a bot is always allowed.
      if (!unlink && id.isBot) {
        return mk({ error: `${identity_id} is a bot identity — bots are excluded from persons` })
      }

      if (unlink) {
        const warning = await orphanWarn(id.personId)
        if (dry_run)
          return mk({
            dryRun: true,
            wouldUnlink: true,
            fromPersonId: id.personId,
            orphanWarning: warning,
          })
        await ctx.store.setIdentityPerson(identity_id, null, now)
        await ctx.store.appendIdentityAudit({
          id: crypto.randomUUID(),
          action: 'unlink',
          identityId: identity_id,
          fromPersonId: id.personId,
          toPersonId: null,
          decidedBy: actor,
          note: warning,
          createdAt: now,
        })
        return mk({ unlinked: true, orphanWarning: warning })
      }

      if (to_identity_id && to_identity_id === identity_id) {
        return mk({ error: 'identity_id and to_identity_id must be different' })
      }

      let targetPersonId = to_person_id ?? null
      if (!targetPersonId && to_identity_id) {
        const target = await ctx.store.findIdentityById(to_identity_id)
        if (!target) return mk({ error: `to_identity_id not found: ${to_identity_id}` })
        if (!target.personId) {
          return mk({
            error: `to_identity_id ${to_identity_id} has no person yet — pass to_person_id, or link that identity first`,
          })
        }
        targetPersonId = target.personId
      }
      if (!targetPersonId) {
        return mk({ error: 'provide one of: to_person_id, to_identity_id, or unlink:true' })
      }

      const person = await ctx.store.getPerson(targetPersonId)
      if (!person) return mk({ error: `person not found: ${targetPersonId}` })

      // Reassigning away from a current (different) person may orphan it.
      const warning =
        id.personId && id.personId !== targetPersonId ? await orphanWarn(id.personId) : null

      if (dry_run) {
        return mk({
          dryRun: true,
          wouldLinkPersonId: targetPersonId,
          personName: person.displayName ?? null,
          orphanWarning: warning,
        })
      }
      await ctx.store.setIdentityPerson(identity_id, targetPersonId, now)
      await ctx.store.appendIdentityAudit({
        id: crypto.randomUUID(),
        action: 'link',
        identityId: identity_id,
        fromPersonId: id.personId,
        toPersonId: targetPersonId,
        decidedBy: actor,
        note: warning,
        createdAt: now,
      })
      return mk({
        linkedPersonId: targetPersonId,
        personName: person.displayName ?? null,
        orphanWarning: warning,
      })
    },
  )
}

function registerUnmergeIdentityMatchTool(server, ctx) {
  server.registerTool(
    'unmerge_identity_match',
    {
      title: 'Un-merge a Confirmed Identity Match',
      description:
        'Reverse a previously CONFIRMED candidate match: detaches the less-anchored identity ' +
        '(commit_email before login/account) back to no person, non-destructively. The candidate-match ' +
        'history is preserved. Use when a confirm or auto-stitch merged the wrong identities. Audited.',
      inputSchema: z.object({
        match_id: z.string(),
        decided_by: z.string().optional().describe('Who decided (audit). Default "mcp-agent".'),
      }),
    },
    async ({ match_id, decided_by }) => {
      const now = new Date().toISOString()
      const actor = decided_by ?? 'mcp-agent'
      const mk = (extra) => {
        const output = { ...provenance('n/a'), match_id, ...extra }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }
      try {
        await unmergeIdentities(ctx.store, match_id, now)
      } catch (err) {
        return mk({ error: err instanceof Error ? err.message : String(err) })
      }
      await ctx.store.appendIdentityAudit({
        id: crypto.randomUUID(),
        action: 'unmerge',
        matchId: match_id,
        decidedBy: actor,
        createdAt: now,
      })
      return mk({ unmerged: true })
    },
  )
}

function registerSetPersonDisplayNameTool(server, ctx) {
  server.registerTool(
    'set_person_display_name',
    {
      title: 'Set a Person’s Display Name',
      description:
        'Give a person a human-readable label — use when no Jira/real name resolved and they show ' +
        'under a GitHub login (e.g. eingramiph) or a raw Jira account id. Identify the person by ' +
        'person_id (a persons.id) OR by any of their identity_id (e.g. github_login:eingramiph), which ' +
        'is resolved to its person. Pass dry_run:true to preview. Audited; survives re-syncs.',
      inputSchema: z.object({
        display_name: z.string().describe('The new human-readable display name.'),
        person_id: z.string().optional().describe('Target persons.id to relabel.'),
        identity_id: z
          .string()
          .optional()
          .describe('Relabel the person that owns THIS identity (identities.id).'),
        dry_run: z.boolean().optional().describe('Preview the effect without writing.'),
        decided_by: z.string().optional().describe('Who decided (audit). Default "mcp-agent".'),
      }),
    },
    async ({ display_name, person_id, identity_id, dry_run, decided_by }) => {
      const now = new Date().toISOString()
      const actor = decided_by ?? 'mcp-agent'
      const mk = (extra) => {
        const output = { ...provenance('n/a'), ...extra }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const name = typeof display_name === 'string' ? display_name.trim() : ''
      if (!name) return mk({ error: 'display_name must be a non-empty string' })

      // Resolve the target person from person_id, or via an identity's person.
      let targetPersonId = person_id ?? null
      if (!targetPersonId && identity_id) {
        const id = await ctx.store.findIdentityById(identity_id)
        if (!id) return mk({ error: `identity not found: ${identity_id}` })
        if (!id.personId) {
          return mk({
            error: `identity ${identity_id} has no person yet — link it first, or pass person_id`,
          })
        }
        targetPersonId = id.personId
      }
      if (!targetPersonId) {
        return mk({ error: 'provide one of: person_id or identity_id' })
      }

      const person = await ctx.store.getPerson(targetPersonId)
      if (!person) return mk({ error: `person not found: ${targetPersonId}` })

      const oldName = person.displayName ?? null
      if (dry_run) {
        return mk({ dryRun: true, personId: targetPersonId, oldName, newName: name })
      }

      await ctx.store.setPersonDisplayName(targetPersonId, name, now)
      await ctx.store.appendIdentityAudit({
        id: crypto.randomUUID(),
        action: 'rename',
        toPersonId: targetPersonId,
        decidedBy: actor,
        note: `"${oldName ?? ''}" -> "${name}"`,
        createdAt: now,
      })
      return mk({ personId: targetPersonId, oldName, newName: name })
    },
  )
}

function registerSetIdentityBotTool(server, ctx) {
  server.registerTool(
    'set_identity_bot',
    {
      title: 'Reclassify an Identity as Bot / Human',
      description:
        'Flip an identity’s is_bot flag when the heuristics misjudged it — e.g. an automation ' +
        'account (like "Automation for Jira") minted as a person, or a human wrongly flagged. ' +
        'Marking as a bot also DETACHES it from any person (a bot must not count toward a person’s ' +
        'metrics); the emptied person is GC’d on the next sync. Marking as human only clears the flag. ' +
        'Pass dry_run:true to preview. Audited; survives re-syncs.',
      inputSchema: z.object({
        identity_id: z.string().describe('The identity to reclassify (identities.id).'),
        is_bot: z.boolean().describe('true = mark as a bot (and detach); false = mark as human.'),
        dry_run: z.boolean().optional().describe('Preview the effect without writing.'),
        decided_by: z.string().optional().describe('Who decided (audit). Default "mcp-agent".'),
      }),
    },
    async ({ identity_id, is_bot, dry_run, decided_by }) => {
      const now = new Date().toISOString()
      const actor = decided_by ?? 'mcp-agent'
      const mk = (extra) => {
        const output = { ...provenance('n/a'), identity_id, ...extra }
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const id = await ctx.store.findIdentityById(identity_id)
      if (!id) return mk({ error: `identity not found: ${identity_id}` })

      const wasBot = !!id.isBot
      // Marking as a bot detaches it; warn if that empties its person (GC'd next sync).
      let orphanWarning = null
      if (is_bot && id.personId) {
        const sibs = await ctx.store.getIdentitiesByPerson(id.personId)
        if (sibs.length <= 1) {
          orphanWarning = `person ${id.personId} will have no identities left and be removed on the next sync`
        }
      }
      const willDetachFrom = is_bot ? (id.personId ?? null) : null

      if (dry_run) {
        return mk({
          dryRun: true,
          wasBot,
          willBe: is_bot,
          willDetachFromPersonId: willDetachFrom,
          orphanWarning,
        })
      }

      await ctx.store.setIdentityBot(identity_id, is_bot, now)
      await ctx.store.appendIdentityAudit({
        id: crypto.randomUUID(),
        action: 'reclassify_bot',
        identityId: identity_id,
        fromPersonId: willDetachFrom,
        decidedBy: actor,
        note: `is_bot: ${wasBot} -> ${is_bot}`,
        createdAt: now,
      })
      return mk({ isBot: is_bot, detachedFromPersonId: willDetachFrom, orphanWarning })
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_person_report — the per-person insight suite (cohort + trend)
// ---------------------------------------------------------------------------

function registerGetPersonReportTool(server, ctx) {
  server.registerTool(
    'get_person_report',
    {
      title: 'Get Per-Person Insight Report',
      description:
        'A coaching report for one person: every per-person metric placed against the human ' +
        'cohort (robust-z + percentile, suppressed below 8 peers) plus a self-baseline trend. ' +
        'Compares to the person’s OWN team distribution and OWN history — never a rank.',
      inputSchema: z.object({
        person_id: z.string().describe('Person id (persons.id — find it via query_db).'),
        window_days: z
          .number()
          .int()
          .min(7)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: the snapshot horizon, 60).'),
      }),
    },
    async ({ person_id, window_days }) => {
      // Cap the window at retention — beyond it the raw rows have been pruned, so a
      // larger window would silently compute over truncated data. retentionDays 0
      // (keep-all) imposes no cap.
      const requested = window_days ?? snapshotHorizonDays(ctx)
      const windowDays =
        ctx.config.retentionDays > 0 ? Math.min(requested, ctx.config.retentionDays) : requested
      const report = await computePersonReportLive(ctx.store, person_id, { windowDays })
      return {
        content: [{ type: 'text', text: JSON.stringify(report) }],
        structuredContent: report,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tools: in-session-Claude verdict pipeline (NO external API)
// ---------------------------------------------------------------------------

function registerListPendingVerdictsTool(server, ctx) {
  server.registerTool(
    'list_pending_verdicts',
    {
      title: 'List Pending AI Verdicts',
      description:
        'Return the artifacts (PR title/body/files, review-comment bodies, review bodies) for a ' +
        'person that still need a structured verdict for a probabilistic metric. The CURRENT ' +
        'Claude session reads these and calls record_verdict — no external model API is used. ' +
        `Verdict metrics: ${VERDICT_METRICS.join(', ')}.`,
      inputSchema: z.object({
        metric: z
          .enum(VERDICT_METRICS)
          .describe('Which probabilistic metric to gather artifacts for.'),
        person_id: z.string().describe('Person id (persons.id).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max artifacts (default 25).'),
      }),
    },
    async ({ metric, person_id, limit }) => {
      const out = await listPendingVerdicts(ctx.store, metric, person_id, limit ?? 25, {
        sinceIso: llmSinceIso(ctx),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
    },
  )
}

function registerRecordVerdictTool(server, ctx) {
  server.registerTool(
    'record_verdict',
    {
      title: 'Record an AI Verdict',
      description:
        'Persist a verdict the CURRENT Claude session produced by reading an artifact (no API). ' +
        'Idempotent per (subject, metric). The `verdict` object shape depends on the metric — ' +
        `see: ${JSON.stringify(VERDICT_SHAPE)}.`,
      inputSchema: z.object({
        metric: z.enum(VERDICT_METRICS),
        subject_id: z
          .string()
          .describe('The artifact id from list_pending_verdicts (PR/review/comment).'),
        verdict: z.record(z.any()).describe('Structured verdict matching the metric’s shape.'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Verdict confidence 0..1 (default 0.7).'),
        evidence: z
          .array(z.string())
          .optional()
          .describe('Cited evidence (file:line, quotes) for audit.'),
      }),
    },
    async ({ metric, subject_id, verdict, confidence, evidence }) => {
      const now = new Date().toISOString()
      const id = `${metric}:${subject_id}:${now}`
      const res = await recordVerdict(
        ctx.store,
        { metric, subjectId: subject_id, verdict, confidence, evidence },
        { id, now },
      )
      return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res }
    },
  )
}

// ---------------------------------------------------------------------------
// Tools: in-session-Claude AI-authorship verdict (NO external API, NO API key)
// ---------------------------------------------------------------------------

function registerListPendingAiAuthorshipTool(server, ctx) {
  server.registerTool(
    'list_pending_ai_authorship',
    {
      title: 'List Pending AI-Authorship Verdicts',
      description:
        'Return ambiguous-band commits/PRs whose deterministic stylometry score is inconclusive ' +
        '(default 0.35–0.65) and whose AI-vs-human authorship has not yet been judged. The CURRENT ' +
        'Claude session reads each change text (commit message; PR title+body) and judges writing ' +
        'STYLE / STRUCTURE, then calls record_ai_authorship_verdict. Nothing leaves the machine; ' +
        'no external model API is used and no API key is required.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max ambiguous-band entities to return (default 25).'),
        lo_band: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Lower ai_score bound for the ambiguous band (default 0.35).'),
        hi_band: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Upper ai_score bound for the ambiguous band (default 0.65).'),
      }),
    },
    async ({ limit, lo_band, hi_band }) => {
      const out = await listPendingAuthorshipVerdicts(ctx.store, {
        limit,
        loBand: lo_band,
        hiBand: hi_band,
        sinceIso: llmSinceIso(ctx),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
    },
  )
}

function registerRecordAiAuthorshipVerdictTool(server, ctx) {
  server.registerTool(
    'record_ai_authorship_verdict',
    {
      title: 'Record AI-Authorship Verdict',
      description:
        'Persist an AI-vs-human authorship verdict the CURRENT Claude session produced by reading ' +
        'a commit message or PR title+body (no API key, nothing leaves the machine). Idempotent ' +
        'per (entity_type, entity_id) — re-recording overwrites the prior verdict. The verdict ' +
        'overrides the deterministic ai_score for downstream metrics that consume it.',
      inputSchema: z.object({
        entity_type: z
          .enum(['commit', 'pull_request'])
          .describe('Which ai_authorship row to write the verdict to.'),
        entity_id: z
          .string()
          .describe('ai_authorship.entity_id (commits: "<repoId>:<sha>"; PRs: pull_request id).'),
        ai_assisted: z.boolean().describe('True if the text was written with AI assistance.'),
        confidence: z.number().min(0).max(1).describe('Verdict confidence, 0..1.'),
        reasoning: z.string().describe('One or two sentences justifying the verdict.'),
      }),
    },
    async ({ entity_type, entity_id, ai_assisted, confidence, reasoning }) => {
      const now = new Date().toISOString()
      const res = await recordAuthorshipVerdict(
        ctx.store,
        {
          entityType: entity_type,
          entityId: entity_id,
          aiAssisted: ai_assisted,
          confidence,
          reasoning,
        },
        { now },
      )
      return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: backfill_pr_patches — GraphQL-only diff synthesis for pr_files.patch
// ---------------------------------------------------------------------------

function registerBackfillPrPatchesTool(server, ctx) {
  server.registerTool(
    'backfill_pr_patches',
    {
      title: 'Backfill PR File Patches',
      description:
        'Populate pr_files.patch by fetching base+head file blobs over GraphQL (NO REST) and ' +
        'synthesising the unified diff locally — unblocking diff-level verdicts. Idempotent and ' +
        'incremental: only files missing a patch are processed; re-run to continue. Pass drain:true ' +
        'to process EVERY remaining file to completion in one call (use before a verdict pass so ' +
        'diff-level metrics see the full diff set); otherwise `limit` bounds one chunk. NOTE: ' +
        'code.haloc_aggregate does NOT need this — it always uses the complete denormalised HALOC ' +
        'column; backfill is only required for the diff-level verdict layer. Bot-authored PRs ' +
        '(dependabot etc.) are skipped by default (LAZYFLOW_SKIP_BOT_PATCHES) and reported as ' +
        'botFilesExcluded — no blobs fetched, no DB bloat.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            'Max files to process this call (bounds blob volume; default 500). Ignored when drain=true.',
          ),
        drain: z
          .boolean()
          .optional()
          .describe(
            'Process every remaining patch-less file to completion (looping in bounded chunks). ' +
              'Slower, but leaves the diff set complete; the residual `remaining` is the genuinely ' +
              'unfetchable count (e.g. blobs removed from history).',
          ),
      }),
    },
    async ({ limit, drain }) => {
      if (!ctx.githubClient) {
        return inputError('GitHub client not configured — LAZYFLOW_GITHUB_TOKEN required.')
      }
      const cap = limit ?? 500
      // Skip bot-authored PRs (dependabot lockfile bumps etc.) by default — no
      // analytical value (bots are excluded from verdicts/person metrics) and a
      // big blob-fetch + DB-bloat saving. Overridable via LAZYFLOW_SKIP_BOT_PATCHES.
      const excludeBots = ctx.config.skipBotPatches !== false
      const res = drain
        ? await backfillAllPatches(ctx.store, ctx.githubClient, { drain: true, excludeBots })
        : await backfillAllPatches(ctx.store, ctx.githubClient, { maxFiles: cap, excludeBots })
      // Backfill rewrites pr_files.patch AND the denormalised pr_files.haloc, so
      // any memoised scope data (FULL_SCOPE_MEMO) derived before the backfill will
      // contain stale haloc values. Invalidate so the next get_* call reloads.
      invalidateLookupsCache(ctx.store)
      // Honest reporting: how many patch-less files we deliberately skipped
      // because their PR author is a bot (never blob-fetched).
      const botFilesExcluded = excludeBots ? await ctx.store.countBotPrFilesMissingPatch() : 0
      const output = {
        backfilled: res.backfilled,
        skipped: res.skipped,
        remaining: res.remaining,
        botFilesExcluded,
        drained: res.drained ?? false,
        repos: res.repos,
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

function registerPruneTool(server, ctx) {
  server.registerTool(
    'prune',
    {
      title: 'Prune Old Data (retention + VACUUM)',
      description:
        'Apply the retention policy to the local store: delete commits, PRs (and their files/' +
        'reviews/comments), check-runs, deployments and AI-authorship rows older than the ' +
        'retention window; NULL PR diff text (pr_files.patch) for PRs older than the patch window ' +
        '(the denormalised line-count is kept, so code metrics are unaffected); and trim metric ' +
        'snapshots beyond the horizon. The raw cutoff is floored at the snapshot horizon + window ' +
        '+ buffer so metrics can never be starved. Jira issues are not pruned. Pass dry_run:true to ' +
        'preview the row impact WITHOUT deleting. By default VACUUMs afterwards to reclaim file space ' +
        '(a whole-file rewrite — can take a while on a large DB; skipped on a dry run). Windows come ' +
        'from config (LAZYFLOW_RETENTION_DAYS / _SNAPSHOT_HORIZON_DAYS / _PATCH_RETENTION_DAYS).',
      inputSchema: z.object({
        vacuum: z
          .boolean()
          .optional()
          .describe('Run a full VACUUM after pruning to reclaim disk space (default true).'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Preview the counts that WOULD be pruned without mutating the store (default false).',
          ),
      }),
    },
    async ({ vacuum, dry_run }) => {
      const now = new Date().toISOString()
      const res = await ctx.store.pruneOldData({
        now,
        retentionDays: ctx.config.retentionDays,
        snapshotHorizonDays: snapshotHorizonDays(ctx),
        snapshotWindowDays: snapshotWindowDays(ctx),
        patchRetentionDays: ctx.config.patchRetentionDays,
        retentionBufferDays: ctx.config.retentionBufferDays,
        dryRun: dry_run === true,
      })
      let vacuumed = false
      if (dry_run !== true) {
        // Pruned rows invalidate any memoised scope data held for get_* / reports.
        invalidateLookupsCache(ctx.store)
        if (vacuum !== false) {
          await ctx.store.vacuum()
          vacuumed = true
        }
      }
      const output = { ...res, vacuumed }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

export function createServer(ctx) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  })

  // Tools — deterministic
  registerDoctorTool(server, ctx)
  registerSyncStatusTool(server, ctx)
  registerRunSyncTool(server, ctx)
  registerGetDoraTool(server, ctx)
  registerGetFlowTool(server, ctx)
  registerGetPrMetricsTool(server, ctx)
  registerGetCodeMetricsTool(server, ctx)
  registerGetAgileMetricsTool(server, ctx)
  registerExplainMetricTool(server, ctx)
  registerExportTool(server, ctx)
  registerQueryDbTool(server, ctx)
  registerDataOverviewTool(server, ctx)

  // Tools — per-person insight suite + in-session-Claude verdict pipeline
  registerGetPersonReportTool(server, ctx)
  registerListPendingVerdictsTool(server, ctx)
  registerRecordVerdictTool(server, ctx)
  registerListPendingAiAuthorshipTool(server, ctx)
  registerRecordAiAuthorshipVerdictTool(server, ctx)
  registerBackfillPrPatchesTool(server, ctx)
  registerPruneTool(server, ctx)
  registerGetSchemaTool(server, ctx)
  registerListIdentityMatchesTool(server, ctx)
  registerResolveIdentityMatchTool(server, ctx)
  registerLinkIdentityTool(server, ctx)
  registerUnmergeIdentityMatchTool(server, ctx)
  registerSetPersonDisplayNameTool(server, ctx)
  registerSetIdentityBotTool(server, ctx)

  // Tools — reporting
  registerGenerateReportTool(server, ctx)
  registerListReportPresetsTool(server, ctx)

  // Resources
  registerReportResources(server)
  registerSchemaResource(server, ctx)

  return server
}

/**
 * Start the MCP server on stdio.
 *
 * `opts.transport` / `opts.rederive` are injectable for tests; production uses
 * the stdio transport and the real engine-bump re-derive. Returns the connected
 * server and the (still-running) background re-derive promise so callers/tests
 * can await it — the entrypoint ignores the return.
 */
export async function startServer(ctx, opts = {}) {
  const server = createServer(ctx)
  const usingDefaultTransport = !opts.transport
  const transport = opts.transport ?? new StdioServerTransport()
  // AbortSignal lets a graceful shutdown stop a long background re-derive between
  // days (see rederiveStaleEngineSnapshots) so it can't keep the event loop busy
  // through teardown.
  const abort = new AbortController()
  const rederive = opts.rederive ?? ((now, signal) => rederiveOnEngineBump(ctx, now, signal))

  // Connect FIRST so the MCP handshake always completes promptly, whatever the
  // DB size. The engine-bump re-derive (below) can take MINUTES on a large
  // pre-existing DB after an ENGINE_VERSION bump; awaiting it before connect (the
  // original ordering) stalled the handshake past the client's startup timeout,
  // so the server was killed before any tool loaded — every user with existing
  // data hit this on an engine-version upgrade.
  await server.connect(transport)

  // Only the real stdio startup installs shutdown hooks; tests inject a transport.
  if (usingDefaultTransport) {
    const onShutdown = () => abort.abort()
    process.once('SIGTERM', onShutdown)
    process.once('SIGINT', onShutdown)
  }

  // Engine-version-bump re-derivation (SPEC §8.6): if ENGINE_VERSION has bumped
  // since the stored snapshots were written, re-derive the stale ones so reads
  // never silently mix formula versions. Runs in the BACKGROUND after connect —
  // a no-op when nothing is stale, bounded to SNAPSHOT_HISTORY_DAYS when a
  // populated DB upgrades. Fire-and-forget: a slow or failing re-derive must
  // never block startup (this is the same trigger run_sync already invokes).
  const rederivePromise = Promise.resolve()
    .then(() => rederive(new Date().toISOString(), abort.signal))
    .then((res) => {
      if (res && res.failed > 0) {
        process.stderr.write(
          `lazy-flow: startup rederive recomputed ${res.recomputed} snapshot(s); ` +
            `${res.failed} left stale after compute errors\n`,
        )
      }
    })
    .catch((err) => {
      process.stderr.write(`lazy-flow: startup rederive failed: ${String(err)}\n`)
    })

  return { server, rederivePromise, abort }
}
