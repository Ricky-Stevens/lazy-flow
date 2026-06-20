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

import { ENGINE_VERSION } from '../core/index.js'
import { backfillPrPatches } from '../ingest-github/index.js'
import {
  backfillSnapshots,
  COMPUTE_METRIC_IDS,
  computeMetric,
  computePersonReportLive,
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'lazy-flow'
const SERVER_VERSION = '0.1.0'

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
const SNAPSHOT_WINDOW_DAYS = 30

/** History depth (days) for backfill / engine-bump scans. */
const SNAPSHOT_HISTORY_DAYS = 119

/**
 * Build a ComputeDayFn that computes a metric over the rolling
 * SNAPSHOT_WINDOW_DAYS window ending on `day` — the same window semantics the
 * backfill uses, so a re-derived snapshot reconverges with its backfilled value.
 */
function makeComputeDayFn(ctx, now) {
  return async (scopeType, scopeId, metricId, day) => {
    const windowFrom = new Date(Date.parse(day) - (SNAPSHOT_WINDOW_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    return computeMetric(ctx.store, scopeType, scopeId, metricId, windowFrom, day, now)
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
async function rederiveOnEngineBump(ctx, now) {
  const today = now.slice(0, 10)
  const fromDay = new Date(Date.parse(today) - SNAPSHOT_HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  return rederiveStaleEngineSnapshots({
    store: ctx.store,
    scopes: SNAPSHOT_SCOPES,
    metricIds: COMPUTE_METRIC_IDS,
    fromDay,
    toDay: today,
    computeFn: makeComputeDayFn(ctx, now),
    now,
  })
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
        'Auth validity, rate-limit headroom, sync freshness, DB integrity, Bun runtime preflight, config sanity.',
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

      // 2. GitHub token presence
      checks.push({
        name: 'github_token',
        status: ctx.config.githubToken ? 'ok' : 'warn',
        message: ctx.config.githubToken
          ? 'GitHub token configured'
          : 'LAZYFLOW_GITHUB_TOKEN not set — GitHub sync unavailable',
      })

      // 3. Jira token presence (+ Basic-auth email pairing). An API token against
      //    a Jira Cloud site URL needs LAZYFLOW_JIRA_EMAIL for Basic auth — without
      //    it the client falls back to Bearer and every call 403s.
      checks.push({
        name: 'jira_token',
        status: ctx.config.jiraToken && ctx.config.jiraEmail ? 'ok' : 'warn',
        message: !ctx.config.jiraToken
          ? 'LAZYFLOW_JIRA_TOKEN not set — Jira sync unavailable'
          : ctx.config.jiraEmail
            ? 'Jira token + email configured (Basic auth)'
            : 'LAZYFLOW_JIRA_TOKEN set but LAZYFLOW_JIRA_EMAIL missing — API tokens need email for Basic auth (will 403)',
      })

      // 4. Repos / Jira projects configured
      checks.push({
        name: 'repos_configured',
        status: ctx.config.repos.length > 0 ? 'ok' : 'warn',
        message:
          ctx.config.repos.length > 0
            ? `${ctx.config.repos.length} repo(s) configured`
            : 'LAZYFLOW_REPOS not set — no repos to sync',
      })

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
    timings_ms: z
      .object({
        sync_total: z.number(),
        github: z.number(),
        jira: z.number(),
        snapshot_backfill: z.number(),
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
          errors: ['Jira client not configured — LAZYFLOW_JIRA_TOKEN required'],
          skipped: true,
          skip_reason: 'LAZYFLOW_JIRA_TOKEN not set',
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
        { org, repos: repos.length > 0 ? repos : undefined },
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
      const backfillFrom = new Date(Date.parse(today) - 119 * 86_400_000).toISOString().slice(0, 10)
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
            windowDays: 30,
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

      const output = {
        ...provenance('n/a'),
        synced_at: result.syncedAt,
        snapshots_written: snapshotsWritten,
        timings_ms: {
          sync_total: syncMs,
          github: result.timings?.githubMs ?? 0,
          jira: result.timings?.jiraMs ?? 0,
          snapshot_backfill: backfillMs,
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
  const rows = []
  for (const metricId of metricIds) {
    const r = await computeMetric(ctx.store, scopeType, scopeId, metricId, fromDay, toDay, now)
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
      const entry = FORMULA_DOCS[metric]
      const output = {
        ...provenance('n/a'),
        metric,
        formula_doc: entry?.formula_doc ?? 'Formula not documented for this metric.',
        scope: entry?.scope ?? 'unknown',
        found: entry !== undefined,
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
//   6. Enforce max_rows (default 1000, hard cap 5000).

const QUERY_DB_DEFAULT_MAX_ROWS = 1000
const QUERY_DB_HARD_CAP_ROWS = 5000

/** Keywords that must never appear as statements in a read-only query. */
const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'CREATE',
  'ALTER',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'TRUNCATE',
]

/**
 * Strip SQL comments (-- line and / * block * /) and surrounding whitespace so we
 * can inspect the real first keyword and statement structure.
 */
function stripSqlComments(sql) {
  // Remove block comments, then line comments, then collapse whitespace edges.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
}

/**
 * Blank out the CONTENTS of string literals and quoted identifiers (length is
 * preserved; delimiters are kept) so the keyword/semicolon read-only checks
 * scan only real SQL, not data. Without this, a legitimate read query like
 * `SELECT * WHERE name = 'DELETE'` or `... LIKE '%;%'` is wrongly rejected.
 * Operates on already-comment-stripped SQL. SQLite escapes a quote by doubling
 * it ('' / "" / ``), which is handled by staying inside the quoted run.
 * Masking only ever HIDES characters from the scan, so it can never let a real
 * write keyword/extra statement that sits OUTSIDE quotes slip through.
 */
function maskSqlLiterals(sql) {
  let out = ''
  let quote = null // active closing delimiter: "'", '"', '`', or ']'
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) {
        // A doubled delimiter inside '..', ".." or `..` is an escaped literal
        // quote — stay inside and mask both characters.
        if (quote !== ']' && sql[i + 1] === quote) {
          out += '  '
          i++
        } else {
          quote = null
          out += ch
        }
      } else {
        out += ' '
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
    } else if (ch === '[') {
      quote = ']'
      out += ch
    } else {
      out += ch
    }
  }
  return out
}

/** Thrown when a query_db request fails validation; message is safe to return. */
class QueryDbError extends Error {}

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement. Throws
 * QueryDbError with a specific reason on any violation.
 */
function assertReadOnlyQuery(sql) {
  const stripped = stripSqlComments(sql)
  if (stripped.length === 0) {
    throw new QueryDbError('Empty query after stripping comments.')
  }

  // Run the structural checks against a copy with string-literal/identifier
  // CONTENTS blanked out, so keywords/semicolons that appear only inside data
  // (e.g. `WHERE name = 'DELETE'`) don't trip the guard. Real keywords and
  // statement separators outside quotes are untouched. Length is preserved, so
  // the semicolon index still lines up with the original.
  const masked = maskSqlLiterals(stripped)

  // Reject multiple statements: a ';' is only allowed as the final character.
  const semicolonIdx = masked.indexOf(';')
  if (semicolonIdx !== -1 && semicolonIdx !== masked.length - 1) {
    throw new QueryDbError(
      'Multiple statements are not allowed — submit a single SELECT/WITH query.',
    )
  }

  const firstKeywordMatch = masked.match(/^([a-zA-Z]+)/)
  const firstKeyword = firstKeywordMatch?.[1]?.toUpperCase() ?? ''
  if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
    throw new QueryDbError(
      `Only SELECT/WITH read queries are allowed (got "${firstKeyword || '?'}").`,
    )
  }

  // Reject any forbidden write/DDL/PRAGMA keyword anywhere (word-boundary match).
  // This blocks e.g. `WITH x AS (...) DELETE ...` and `PRAGMA writable_schema`.
  const upper = masked.toUpperCase()
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new QueryDbError(`Disallowed keyword "${kw}" — query_db is read-only.`)
    }
  }
}

/** A query_db parameter value: bound positionally, never interpolated. */

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
        'rejected. Params are bound positionally (use ? placeholders).',
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

      let handle = null
      try {
        assertReadOnlyQuery(sql)

        handle = acquireReadHandle(ctx)
        const stmt = handle.db.prepare(sql)
        // Fetch one extra row to detect truncation without a second query.
        const allRows = stmt.all(...bind)
        const truncated = allRows.length > maxRows
        const rows = truncated ? allRows.slice(0, maxRows) : allRows

        // Column order from the prepared statement when available, else infer
        // from the first row's keys (statements with no result columns -> []).
        // bun:sqlite exposes the result column names as `columnNames`.
        const columns =
          Array.isArray(stmt.columnNames) && stmt.columnNames.length > 0
            ? stmt.columnNames
            : rows[0] !== undefined
              ? Object.keys(rows[0])
              : []

        const output = {
          ...provenance('deterministic', rows.length === 0 ? 'no_data' : 'ok'),
          columns,
          rows,
          row_count: rows.length,
          truncated,
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
      } finally {
        handle?.close()
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
- query_db is read-only: only a single SELECT/WITH statement runs.`

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
    async () => {
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

      const body = `${SCHEMA_GUIDE}\n\n${dbPathLine}\n\n## Live schema (sqlite_master)\n\n\`\`\`sql\n${ddl}\n\`\`\`\n`

      return {
        contents: [
          {
            uri: 'lazy-flow://schema',
            mimeType: 'text/markdown',
            text: body,
          },
        ],
      }
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
          .describe('Lookback window in days (default: 90).'),
      }),
    },
    async ({ person_id, window_days }) => {
      const report = await computePersonReportLive(ctx.store, person_id, {
        windowDays: window_days ?? 90,
      })
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
      const out = await listPendingVerdicts(ctx.store, metric, person_id, limit ?? 25)
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
// Tool: backfill_pr_patches — GraphQL-only diff synthesis for pr_files.patch
// ---------------------------------------------------------------------------

function registerBackfillPrPatchesTool(server, ctx) {
  server.registerTool(
    'backfill_pr_patches',
    {
      title: 'Backfill PR File Patches',
      description:
        'Populate pr_files.patch by fetching base+head file blobs over GraphQL (NO REST) and ' +
        'synthesising the unified diff locally — unblocking exact HALOC and diff-level verdicts. ' +
        'Idempotent and incremental: only files missing a patch are processed; re-run to continue.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Max files to process this call (bounds blob volume; default 500).'),
      }),
    },
    async ({ limit }) => {
      if (!ctx.githubClient) {
        return inputError('GitHub client not configured — LAZYFLOW_GITHUB_TOKEN required.')
      }
      const cap = limit ?? 500
      // Distinct repos that still have patch-less files.
      const repoIds = [
        ...new Set(
          (await ctx.store.getAllPrFiles())
            .filter((f) => f.patch === null || f.patch === undefined)
            .map((f) => f.repoId),
        ),
      ]
      const perRepo = []
      let backfilled = 0
      let skipped = 0
      let remaining = 0
      for (const repoId of repoIds) {
        if (backfilled >= cap) {
          remaining += (await ctx.store.getAllPrFiles()).filter(
            (f) => f.repoId === repoId && (f.patch === null || f.patch === undefined),
          ).length
          continue
        }
        const repo = await ctx.store.getRepository(repoId)
        if (!repo) continue
        const res = await backfillPrPatches(ctx.store, ctx.githubClient, {
          owner: repo.owner,
          name: repo.name,
          repoId,
          limit: cap - backfilled,
        })
        backfilled += res.backfilled
        skipped += res.skipped
        remaining += res.remaining
        perRepo.push({ repo: `${repo.owner}/${repo.name}`, ...res })
      }
      const output = { backfilled, skipped, remaining, repos: perRepo }
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

  // Tools — per-person insight suite + in-session-Claude verdict pipeline
  registerGetPersonReportTool(server, ctx)
  registerListPendingVerdictsTool(server, ctx)
  registerRecordVerdictTool(server, ctx)
  registerBackfillPrPatchesTool(server, ctx)

  // Tools — reporting
  registerGenerateReportTool(server, ctx)
  registerListReportPresetsTool(server, ctx)

  // Resources
  registerReportResources(server)
  registerSchemaResource(server, ctx)

  return server
}

/** Start the MCP server on stdio. */
export async function startServer(ctx) {
  const server = createServer(ctx)

  // Engine-version-bump re-derivation on startup (SPEC §8.6): if ENGINE_VERSION
  // has bumped since the stored snapshots were written, re-derive the stale ones
  // so reads never silently mix formula versions. No-op when versions match.
  // Best-effort: a failure here must not prevent the server from starting.
  try {
    await rederiveOnEngineBump(ctx, new Date().toISOString())
  } catch (err) {
    process.stderr.write(`lazy-flow: startup rederive failed: ${String(err)}\n`)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
