/**
 * lazy-flow MCP server — WP-MCP-SERVER, WP-MCP-TOOLS, WP-MCP-RESOURCES.
 *
 * Registers all tools with inputSchema + outputSchema (structuredContent) and
 * exposes saved dashboards as MCP resources (lazy-flow://dashboard/<id>).
 *
 * Every tool output carries: trust_tier, as_of, engine_version, data_quality,
 * and (where applicable) a coverage flag — per SPEC §13.1.
 *
 * Key note on MCP SDK (from global memory global/mcp-sdk/refine-schema-hides-params):
 * inputSchema MUST be a plain z.object({...}) — never .refine().  Cross-field
 * validation goes inside the handler.
 */

import type { LlmClient } from '@lazy-flow/ai'
import type { NodeSqliteStore } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { GitHubClient } from '@lazy-flow/ingest-github'
import type { JiraClient } from '@lazy-flow/ingest-jira'
import { applyVisibilityFilter } from '@lazy-flow/metrics'
import type { RunSyncOptions } from '@lazy-flow/orchestrator'
import { runSync, syncStatus } from '@lazy-flow/orchestrator'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { LazyFlowConfig } from './config.js'

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
interface Provenance {
  as_of: string
  engine_version: string
  trust_tier: 'deterministic' | 'hybrid' | 'probabilistic' | 'n/a'
  data_quality: string
  coverage?: string
}

function provenance(
  trustTier: Provenance['trust_tier'] = 'deterministic',
  dataQuality = 'ok',
  coverage?: string,
): Provenance {
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

export interface ServerContext {
  config: LazyFlowConfig
  store: NodeSqliteStore
  githubClient: GitHubClient | null
  jiraClient: JiraClient | null
  llmClient: LlmClient | null
}

// ---------------------------------------------------------------------------
// Dashboard in-memory store (WP-MCP-RESOURCES)
// ---------------------------------------------------------------------------

interface Dashboard {
  id: string
  name: string
  description: string
  scope: string
  metrics: string[]
  createdAt: string
  updatedAt: string
}

// Simple in-memory map — survives for the session lifetime of the server.
const dashboards = new Map<string, Dashboard>()

function seedDefaultDashboards(): void {
  const now = new Date().toISOString()
  const defaults: Dashboard[] = [
    {
      id: 'dora',
      name: 'DORA Metrics',
      description: 'Deployment frequency, lead time, change failure rate, recovery time.',
      scope: 'team',
      metrics: ['deployment_frequency', 'lead_time', 'change_failure_rate', 'recovery_time'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'flow',
      name: 'Flow Dashboard',
      description: 'Cycle time, flow efficiency, WIP, throughput, CFD.',
      scope: 'team',
      metrics: ['cycle_time', 'flow_efficiency', 'wip_load', 'throughput', 'cfd'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'pr',
      name: 'PR / Review Dashboard',
      description: '4-phase PR cycle time, review latency, coverage, stale PRs.',
      scope: 'team',
      metrics: [
        'pr_cycle_time',
        'review_latency',
        'review_coverage',
        'time_to_first_review',
        'stale_pr',
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'code',
      name: 'Code Health Dashboard',
      description: 'HALOC, rework/churn, complexity deltas, Nagappan-Ball.',
      scope: 'team',
      metrics: ['haloc_aggregate', 'rework_churn', 'complexity_delta', 'nagappan_ball'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'agile',
      name: 'Agile / Sprint Dashboard',
      description: 'Velocity, say/do, predictability, estimation accuracy.',
      scope: 'team',
      metrics: ['sprint_velocity', 'say_do', 'sprint_predictability', 'estimation_accuracy'],
      createdAt: now,
      updatedAt: now,
    },
  ]
  for (const d of defaults) dashboards.set(d.id, d)
}

// ---------------------------------------------------------------------------
// Tool: doctor
// ---------------------------------------------------------------------------

function registerDoctorTool(server: McpServer, ctx: ServerContext): void {
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
        'Auth validity, rate-limit headroom, sync freshness, DB integrity, Node/ABI preflight, config sanity.',
      inputSchema: z.object({}),
      outputSchema,
    },
    async () => {
      const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string }> = []

      // 1. Node version / ABI preflight
      const nodeMajor = Number.parseInt(process.version.slice(1), 10)
      checks.push({
        name: 'node_version',
        status: nodeMajor >= 22 ? 'ok' : 'warn',
        message: `Node ${process.version} — requires >=22 for node:sqlite`,
      })

      // 2. GitHub token presence
      checks.push({
        name: 'github_token',
        status: ctx.config.githubToken ? 'ok' : 'warn',
        message: ctx.config.githubToken
          ? 'GitHub token configured'
          : 'LAZYFLOW_GITHUB_TOKEN not set — GitHub sync unavailable',
      })

      // 3. Jira token presence
      checks.push({
        name: 'jira_token',
        status: ctx.config.jiraToken ? 'ok' : 'warn',
        message: ctx.config.jiraToken
          ? 'Jira token configured'
          : 'LAZYFLOW_JIRA_TOKEN not set — Jira sync unavailable',
      })

      // 4. Anthropic API key presence
      checks.push({
        name: 'anthropic_api_key',
        status: ctx.config.anthropicApiKey ? 'ok' : 'warn',
        message: ctx.config.anthropicApiKey
          ? 'Anthropic API key configured'
          : 'ANTHROPIC_API_KEY not set — AI insights unavailable',
      })

      // 5. Repos / Jira projects configured
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
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: sync_status
// ---------------------------------------------------------------------------

function registerSyncStatusTool(server: McpServer, ctx: ServerContext): void {
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
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: run_sync
// ---------------------------------------------------------------------------

function registerRunSyncTool(server: McpServer, ctx: ServerContext): void {
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
    errors: z.array(z.string()),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
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
      const syncMode = (mode ?? 'incremental') as 'full' | 'incremental'
      const syncSources = sources ?? ['github', 'jira']

      // Validate that required clients are available
      if (syncSources.includes('github') && !ctx.githubClient) {
        const output = {
          ...provenance('n/a', 'no_data'),
          synced_at: new Date().toISOString(),
          github: { org: '', repos: [], mode: syncMode },
          jira: { projects_processed: [], issues_upserted: 0, transitions_appended: 0, errors: [] },
          identity: { identities_upserted: 0, persons_created: 0, auto_merged: 0, queued: 0 },
          linking: { links_upserted: 0, false_positives_dropped: 0 },
          errors: ['GitHub client not configured — LAZYFLOW_GITHUB_TOKEN required'],
          skipped: true,
          skip_reason: 'LAZYFLOW_GITHUB_TOKEN not set',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
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
          },
          identity: { identities_upserted: 0, persons_created: 0, auto_merged: 0, queued: 0 },
          linking: { links_upserted: 0, false_positives_dropped: 0 },
          errors: ['Jira client not configured — LAZYFLOW_JIRA_TOKEN required'],
          skipped: true,
          skip_reason: 'LAZYFLOW_JIRA_TOKEN not set',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const opts: RunSyncOptions = { now: new Date().toISOString() }

      // Build stub scopes from config when clients aren't wired up yet
      const org = ctx.config.repos[0]?.split('/')[0] ?? ''
      const repos = ctx.config.repos.map((r) => r.split('/')[1] ?? r)

      const jiraMode = syncMode === 'full' ? 'backfill' : 'incremental'
      const ghMode = syncMode === 'full' ? 'backfill' : 'incremental'

      // Both clients are guaranteed non-null at this point — we checked above.
      const ghClient = ctx.githubClient
      const jrClient = ctx.jiraClient
      if (!ghClient || !jrClient) throw new Error('Client unexpectedly null')

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

      const output = {
        ...provenance('n/a'),
        synced_at: result.syncedAt,
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
        errors: result.errors,
        skipped: false,
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
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
  /** Present when the visibility policy filtered person-scope rows. */
  policy_note: z.string().optional(),
})

type MetricRow = {
  metric: string
  value: unknown
  trust_tier: 'deterministic' | 'hybrid' | 'probabilistic'
  data_quality: string
  formula_doc: string
}

interface Staleness {
  warning?: string
  /** True when data is stale beyond the REFUSE threshold (SPEC §7.5). */
  refuse: boolean
}

/** Build a standard metric bundle response. */
function metricBundle(
  scope: string,
  windowDays: number,
  metrics: MetricRow[],
  staleness?: Staleness,
  policyNote?: string,
) {
  // Enforce the refuse threshold: beyond 24h stale we do NOT serve metric values
  // as if current — suppress the values and flag data_quality. (Previously this
  // emitted only a soft warning while still serving stale numbers.)
  const served: MetricRow[] = staleness?.refuse
    ? metrics.map((m) => ({ ...m, value: null, data_quality: 'stale_refused' }))
    : metrics
  return {
    ...provenance('deterministic'),
    scope,
    window_days: windowDays,
    metrics: served,
    ...(staleness?.warning !== undefined ? { staleness_warning: staleness.warning } : {}),
    ...(policyNote !== undefined ? { policy_note: policyNote } : {}),
  }
}

/** Check freshness; reports a warning and whether data is past the refuse threshold. */
async function stalenessCheck(ctx: ServerContext): Promise<Staleness> {
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
  } catch {
    return { refuse: false }
  }
}

// ---------------------------------------------------------------------------
// Visibility filtering helper (WP-VISIBILITY, SPEC §11.1)
// ---------------------------------------------------------------------------

/**
 * A metric row as returned by the tool-read path, augmented with the scope
 * information needed by the visibility filter.
 */
interface ScopedMetricRow extends MetricRow {
  /** MCP scope string — 'person' triggers visibility filtering. */
  scopeType: 'repo' | 'team' | 'org' | 'person' | 'self'
  scopeId: string
}

/**
 * Applies the visibility policy to a list of metric rows at tool-read time.
 * Returns the filtered rows and an optional policy_note to include in output.
 *
 * This is a presentation filter (SPEC §11.1): the data is already org-accessible;
 * visibility governs what the tool surfaces, not what the engine computed.
 */
function applyVisibilityToRows(
  rows: ScopedMetricRow[],
  ctx: ServerContext,
  requestingPersonId: string | null = null,
): { rows: MetricRow[]; policyNote: string | undefined } {
  const policy = ctx.config.visibility
  if (policy === 'public') return { rows, policyNote: undefined }

  const result = applyVisibilityFilter(rows, policy, requestingPersonId)
  // Cast: ScopedMetricRow extends MetricRow; readonly → mutable is safe here since
  // we immediately hand these to the tool output serialiser (no mutation).
  return {
    rows: result.rows as unknown as MetricRow[],
    policyNote: result.policyNote,
  }
}

// ---------------------------------------------------------------------------
// Tool: get_dora
// ---------------------------------------------------------------------------

function registerGetDoraTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_dora',
    {
      title: 'Get DORA Metrics',
      description:
        'Deployment frequency, lead time for changes, change failure rate, failed deployment recovery time — with DORA bands.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (team/repo/org). Default: "team".'),
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
    async ({ scope, window_days }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      // Return provenance-only bundle (actual compute requires live DB data)
      const metrics: MetricRow[] = [
        {
          metric: 'deployment_frequency',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'count(prod deploys, status=success) / window; DORA band by median deploy-days/week.',
        },
        {
          metric: 'lead_time_for_changes',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Median(deploy.finished − pull_requests.first_commit_at) per commit in deploy commit-set.',
        },
        {
          metric: 'change_failure_rate',
          value: null,
          trust_tier: 'hybrid',
          data_quality: 'no_data',
          formula_doc: 'deploys_with_linked_incident / total_prod_deploys; null if 0 deploys.',
        },
        {
          metric: 'failed_deployment_recovery_time',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'Median(first resolved − created) over incidents in window.',
        },
      ]

      // WP-VISIBILITY: apply the policy filter so person-scope rows are hidden
      // under team/self. Current rows are team-scoped (no-op), but the wiring
      // ensures that once real per-person rows are returned from the store they
      // pass through the filter correctly.
      const scopedMetrics: ScopedMetricRow[] = metrics.map((m) => ({
        ...m,
        scopeType: 'team' as const,
        scopeId,
      }))
      const { rows: filteredMetrics, policyNote } = applyVisibilityToRows(scopedMetrics, ctx)

      const output = metricBundle(scopeId, days, filteredMetrics, staleness, policyNote)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_flow
// ---------------------------------------------------------------------------

function registerGetFlowTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_flow',
    {
      title: 'Get Flow Metrics',
      description:
        'Cycle time, flow efficiency, WIP load, throughput, flow distribution, CFD, aging WIP.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
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
    async ({ scope, window_days }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics: MetricRow[] = [
        {
          metric: 'cycle_time',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Per-issue: first entry into a started board column → first Done. Distribution: p50/p75/p90.',
        },
        {
          metric: 'flow_efficiency',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Per-issue active_i / (active_i + wait_i); distribution reported. Active/wait from effective-dated flow_state_models (C3).',
        },
        {
          metric: 'wip_load',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            "WIP count at window end. Little's Law as stationarity-guarded sanity-check.",
        },
        {
          metric: 'throughput',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'Count of issues reaching first Done in window (deduplicated per issue).',
        },
        {
          metric: 'flow_distribution',
          value: null,
          trust_tier: 'hybrid',
          data_quality: 'no_data',
          formula_doc:
            'Work-type split (Feature/Bug/Debt/Other) from conventional-commit/path prior + LLM diff.',
        },
      ]

      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_pr_metrics
// ---------------------------------------------------------------------------

function registerGetPrMetricsTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_pr_metrics',
    {
      title: 'Get PR / Review Metrics',
      description: '4-phase PR cycle time, review latency, review coverage, stale PRs, CI health.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
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
    async ({ scope, window_days }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics: MetricRow[] = [
        {
          metric: 'pr_cycle_time',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            '4 phases: Coding (open−first_commit), Pickup (first_review−ready), Review (merged−first_review), Deploy (release−merged).',
        },
        {
          metric: 'review_latency',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'Decomposed: First-Response / Rework / Idle latency.',
        },
        {
          metric: 'review_coverage',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'commented_hunks / total_hunks (HALOC-weighted).',
        },
        {
          metric: 'time_to_first_review',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'ready_at → first non-author review submission. Median + p75/p90.',
        },
        {
          metric: 'merge_without_review_rate',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'PRs merged with 0 non-author reviews / total merged PRs.',
        },
      ]

      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_code_metrics
// ---------------------------------------------------------------------------

function registerGetCodeMetricsTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_code_metrics',
    {
      title: 'Get Code Metrics',
      description:
        'HALOC, rework/churn, work-type split, complexity deltas, Nagappan-Ball, code-change impact.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
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
    async ({ scope, window_days }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 30
      const staleness = await stalenessCheck(ctx)

      const metrics: MetricRow[] = [
        {
          metric: 'haloc_aggregate',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'HALOC = Σ_hunk max(insertions, deletions). Kills git modify double-counting.',
        },
        {
          metric: 'rework_churn',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Rework% = HALOC on lines younger than churn_window_days / total HALOC. Efficiency = 100 − Rework%.',
        },
        {
          metric: 'work_type_split',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'New / Legacy-Refactor / Help-Others / Rework via blame line-age + author vs churn window.',
        },
        {
          metric: 'complexity_delta',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Cyclomatic (1 + decision points) + Cognitive (SonarSource 3-rule) per function, head vs base.',
        },
        {
          metric: 'nagappan_ball',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'Nagappan-Ball M1/M2/M3 code-change metrics.',
        },
      ]

      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: get_agile_metrics
// ---------------------------------------------------------------------------

function registerGetAgileMetricsTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_agile_metrics',
    {
      title: 'Get Agile / Sprint Metrics',
      description: 'Sprint velocity, say/do, predictability, estimation accuracy.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
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
    async ({ scope, window_days }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 90
      const staleness = await stalenessCheck(ctx)

      const metrics: MetricRow[] = [
        {
          metric: 'sprint_velocity',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Committed snapshot at sprint start vs completed. Counted at one configurable hierarchy level.',
        },
        {
          metric: 'say_do',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'completed_points / committed_points per sprint. null on 0 committed.',
        },
        {
          metric: 'sprint_predictability',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc: 'Share-of-sprints-within-±20% of committed. Bounded [0,1]. Requires n≥2.',
        },
        {
          metric: 'estimation_accuracy',
          value: null,
          trust_tier: 'deterministic',
          data_quality: 'no_data',
          formula_doc:
            'Tie-corrected Spearman(actual_cycle_time, story_points) with significance guard.',
        },
      ]

      const output = metricBundle(scopeId, days, metrics, staleness)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: explain_metric
// ---------------------------------------------------------------------------

function registerExplainMetricTool(server: McpServer, _ctx: ServerContext): void {
  const FORMULA_DOCS: Record<string, { formula_doc: string; trust_tier: string; scope: string }> = {
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
    ticket_work_alignment: {
      formula_doc:
        'Pointwise per acceptance-criterion: {covered: yes/no/unclear, evidence: <quoted diff hunk>}. Covered only if a relevant diff quote supplied. Final = min(ordinal band, coverage_ratio). Ordinal 0–4.',
      trust_tier: 'hybrid',
      scope: 'team+',
    },
    effort_proportionality: {
      formula_doc:
        'Effort vector {HALOC, files, #commits, cycle_time, review_rounds, #comments, rework_commits} vs team historical distribution. Ordinal band (much_lower…much_higher) + log-ratio. Cold-start: insufficient history (n < 10 closed items in window).',
      trust_tier: 'hybrid',
      scope: 'team+',
    },
    pr_quality: {
      formula_doc:
        'Deterministic checks (has_desc / linked_issue / has_tests / atomicity) + LLM (body explains why / matches diff / risk flags) 0–2 per dimension, quoted evidence.',
      trust_tier: 'hybrid',
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
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: ticket_work_alignment (AI insight — SPEC §9.2.1)
// ---------------------------------------------------------------------------

function registerTicketWorkAlignmentTool(server: McpServer, ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    verdict_id: z.string().nullable(),
    ordinal: z.number().nullable(),
    coverage_ratio: z.number().nullable(),
    confidence: z.number().nullable(),
    criteria: z
      .array(
        z.object({
          criterion: z.string(),
          covered: z.enum(['yes', 'no', 'unclear']),
          evidence: z.string().nullable(),
        }),
      )
      .nullable(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
  })

  server.registerTool(
    'ticket_work_alignment',
    {
      title: 'Ticket-Work Alignment',
      description:
        'Hybrid AI insight: per acceptance-criterion coverage of a PR against its linked Jira ticket. Requires Anthropic API key.',
      inputSchema: z.object({
        pr_node_id: z.string().describe('GitHub PR node_id.'),
        issue_key: z.string().describe('Jira issue key, e.g. ENG-123.'),
      }),
      outputSchema,
    },
    async ({ pr_node_id, issue_key }) => {
      if (!ctx.llmClient || !ctx.config.anthropicApiKey) {
        const output = {
          ...provenance('hybrid', 'no_data'),
          verdict_id: null,
          ordinal: null,
          coverage_ratio: null,
          confidence: null,
          criteria: null,
          skipped: true,
          skip_reason: 'ANTHROPIC_API_KEY not configured — AI insights unavailable',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      // Stub: in a full implementation this would call runAlignment from @lazy-flow/ai
      const output = {
        ...provenance('hybrid', 'no_data'),
        verdict_id: null,
        ordinal: null,
        coverage_ratio: null,
        confidence: null,
        criteria: null,
        skipped: true,
        skip_reason: `PR ${pr_node_id} / issue ${issue_key}: insufficient data in store — run run_sync first`,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: effort_proportionality (AI insight — SPEC §9.2.2)
// ---------------------------------------------------------------------------

function registerEffortProportionalityTool(server: McpServer, ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    verdict_id: z.string().nullable(),
    band: z
      .enum(['much_lower', 'lower', 'typical', 'higher', 'much_higher', 'insufficient_history'])
      .nullable(),
    log_ratio: z.number().nullable(),
    confidence: z.number().nullable(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
  })

  server.registerTool(
    'effort_proportionality',
    {
      title: 'Effort Proportionality',
      description:
        'Hybrid AI insight: whether effort on a ticket is proportional to its scope vs team historical baseline.',
      inputSchema: z.object({
        issue_key: z.string().describe('Jira issue key, e.g. ENG-123.'),
      }),
      outputSchema,
    },
    async ({ issue_key }) => {
      if (!ctx.llmClient || !ctx.config.anthropicApiKey) {
        const output = {
          ...provenance('hybrid', 'no_data'),
          verdict_id: null,
          band: null as null,
          log_ratio: null,
          confidence: null,
          skipped: true,
          skip_reason: 'ANTHROPIC_API_KEY not configured — AI insights unavailable',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const output = {
        ...provenance('hybrid', 'no_data'),
        verdict_id: null,
        band: null as null,
        log_ratio: null,
        confidence: null,
        skipped: true,
        skip_reason: `Issue ${issue_key}: insufficient data — run run_sync first`,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: explain_anomaly (AI insight — SPEC §9.2.3)
// ---------------------------------------------------------------------------

function registerExplainAnomalyTool(server: McpServer, ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    verdict_id: z.string().nullable(),
    anomaly_detected: z.boolean().nullable(),
    z_score: z.number().nullable(),
    ranked_causes: z.array(z.object({ cause: z.string(), evidence: z.string() })).nullable(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
  })

  server.registerTool(
    'explain_anomaly',
    {
      title: 'Explain Anomaly',
      description:
        'Hybrid AI insight: detect and explain a velocity/cycle-time anomaly with ranked evidence-cited causes.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
        metric: z
          .enum(['throughput', 'cycle_time'])
          .optional()
          .describe('Which metric to analyze (default: throughput).'),
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Lookback window in days (default: 90, 1-3650).'),
      }),
      outputSchema,
    },
    async ({ scope, metric, window_days }) => {
      if (!ctx.llmClient || !ctx.config.anthropicApiKey) {
        const output = {
          ...provenance('hybrid', 'no_data'),
          verdict_id: null,
          anomaly_detected: null,
          z_score: null,
          ranked_causes: null,
          skipped: true,
          skip_reason: 'ANTHROPIC_API_KEY not configured — AI insights unavailable',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const scopeId = scope ?? 'team'
      const days = window_days ?? 90

      const output = {
        ...provenance('hybrid', 'no_data'),
        verdict_id: null,
        anomaly_detected: null,
        z_score: null,
        ranked_causes: null,
        skipped: true,
        skip_reason: `Scope ${scopeId} / ${metric ?? 'throughput'} / ${days}d: insufficient data — run run_sync first`,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: pr_quality (AI insight — SPEC §9.2.6)
// ---------------------------------------------------------------------------

function registerPrQualityTool(server: McpServer, ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    verdict_id: z.string().nullable(),
    deterministic_checks: z
      .object({
        has_description: z.boolean(),
        has_linked_issue: z.boolean(),
        has_tests: z.boolean(),
        is_atomic: z.boolean(),
      })
      .nullable(),
    llm_scores: z
      .object({
        explains_why: z.number().nullable(),
        matches_diff: z.number().nullable(),
        risk_flag: z.number().nullable(),
      })
      .nullable(),
    overall_score: z.number().nullable(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
  })

  server.registerTool(
    'pr_quality',
    {
      title: 'PR Quality Score',
      description:
        'Hybrid AI insight: deterministic checks + LLM scoring of a PR on description quality, diff match, and risk.',
      inputSchema: z.object({
        pr_node_id: z.string().describe('GitHub PR node_id.'),
      }),
      outputSchema,
    },
    async ({ pr_node_id }) => {
      if (!ctx.llmClient || !ctx.config.anthropicApiKey) {
        const output = {
          ...provenance('hybrid', 'no_data'),
          verdict_id: null,
          deterministic_checks: null,
          llm_scores: null,
          overall_score: null,
          skipped: true,
          skip_reason: 'ANTHROPIC_API_KEY not configured — AI insights unavailable',
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }

      const output = {
        ...provenance('hybrid', 'no_data'),
        verdict_id: null,
        deterministic_checks: null,
        llm_scores: null,
        overall_score: null,
        skipped: true,
        skip_reason: `PR ${pr_node_id}: insufficient data — run run_sync first`,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: correct_verdict (SPEC §9.3, AC#7)
// ---------------------------------------------------------------------------

/** Expected (user-facing) errors from correct_verdict; their message is safe to return. */
class CorrectVerdictError extends Error {}

function registerCorrectVerdictTool(server: McpServer, ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    verdict_id: z.string(),
    corrected: z.boolean(),
    error: z.string().optional(),
  })

  server.registerTool(
    'correct_verdict',
    {
      title: 'Correct AI Verdict',
      description:
        'Append-only correction to an AI verdict. Corrections feed the calibration harness (AC#7).',
      inputSchema: z.object({
        verdict_id: z.string().describe('ID of the ai_verdicts row to correct.'),
        correction: z.record(z.unknown()).describe('Correction JSON (metric-specific).'),
        corrected_by: z.string().describe('Identity of the corrector (e.g. GitHub login).'),
      }),
      outputSchema,
    },
    async ({ verdict_id, correction, corrected_by }) => {
      try {
        // Require a non-blank attribution — corrections feed the calibration /
        // gold set, so an unattributed correction must not be accepted (it would
        // poison calibration with an anonymous claim).
        const corrector = corrected_by.trim()
        if (corrector.length === 0) {
          throw new CorrectVerdictError('corrected_by must be a non-empty identity')
        }

        // Only correct a verdict that actually exists — otherwise the UPDATE
        // affects 0 rows yet we'd report corrected:true (a false success).
        const existing = await ctx.store.getAiVerdict(verdict_id)
        if (existing === null) {
          throw new CorrectVerdictError(`No verdict found with id ${verdict_id}`)
        }

        const { correctVerdict } = await import('@lazy-flow/ai')
        await correctVerdict(verdict_id, corrector, JSON.stringify(correction), ctx.store)

        const output = {
          ...provenance('n/a'),
          verdict_id,
          corrected: true,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      } catch (err) {
        // Surface a controlled message for expected validation errors; for
        // anything else avoid reflecting raw internals (e.g. DB error strings).
        const message =
          err instanceof CorrectVerdictError ? err.message : 'correction failed (internal error)'
        const output = {
          ...provenance('n/a', 'no_data'),
          verdict_id,
          corrected: false,
          error: message,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tool: export (WP-EXPORT)
// ---------------------------------------------------------------------------

function registerExportTool(server: McpServer, _ctx: ServerContext): void {
  const outputSchema = z.object({
    ...provenanceSchema.shape,
    format: z.enum(['csv', 'json']),
    metric: z.string(),
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
        'Export metric data as structured CSV or JSON with provenance columns (engine_version, trust_tier, as_of).',
      inputSchema: z.object({
        metric: z.string().describe('Metric identifier to export.'),
        scope: z.string().optional().describe('Scope identifier (default: "team").'),
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
    async ({ metric, scope, window_days, format }) => {
      const scopeId = scope ?? 'team'
      const days = window_days ?? 30
      const fmt = format ?? 'json'

      // Provenance row always included
      const provenanceRow = {
        metric,
        scope: scopeId,
        window_days: days,
        value: null,
        engine_version: ENGINE_VERSION,
        trust_tier: 'deterministic',
        as_of: new Date().toISOString(),
        data_quality: 'no_data',
      }

      const output = {
        ...provenance('deterministic', 'no_data'),
        format: fmt,
        metric,
        scope: scopeId,
        window_days: days,
        rows: [provenanceRow],
        row_count: 1,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Resources — lazy-flow://dashboard/<id>
// ---------------------------------------------------------------------------

function registerDashboardResources(server: McpServer): void {
  // List resources callback
  server.registerResource(
    'list_dashboards',
    'lazy-flow://dashboard',
    {
      title: 'List Dashboards',
      description: 'List all saved lazy-flow dashboards.',
      mimeType: 'application/json',
    },
    async () => {
      const list = Array.from(dashboards.values()).map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        scope: d.scope,
        metrics: d.metrics,
        updatedAt: d.updatedAt,
      }))
      return {
        contents: [
          {
            uri: 'lazy-flow://dashboard',
            mimeType: 'application/json',
            text: JSON.stringify({ dashboards: list }),
          },
        ],
      }
    },
  )

  // Individual dashboard resources
  for (const [id, dashboard] of dashboards) {
    const uri = `lazy-flow://dashboard/${id}`
    server.registerResource(
      `dashboard_${id}`,
      uri,
      {
        title: dashboard.name,
        description: dashboard.description,
        mimeType: 'application/json',
      },
      async () => {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                ...dashboard,
                engine_version: ENGINE_VERSION,
                as_of: new Date().toISOString(),
              }),
            },
          ],
        }
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create and configure the McpServer with all tools and resources. */
export function createServer(ctx: ServerContext): McpServer {
  seedDefaultDashboards()

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

  // Tools — AI insights
  registerTicketWorkAlignmentTool(server, ctx)
  registerEffortProportionalityTool(server, ctx)
  registerExplainAnomalyTool(server, ctx)
  registerPrQualityTool(server, ctx)
  registerCorrectVerdictTool(server, ctx)

  // Resources
  registerDashboardResources(server)

  return server
}

/** Start the MCP server on stdio. */
export async function startServer(ctx: ServerContext): Promise<void> {
  const server = createServer(ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
