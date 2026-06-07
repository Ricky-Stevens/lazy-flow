/**
 * Config / secret loading from environment — SPEC §14, WP-MCP-SERVER.
 *
 * Secrets are NEVER logged or echoed.  The env vars are the sole source;
 * a committed pluginConfigs block can add non-sensitive defaults via .mcp.json.
 *
 * Precedence: env vars → defaults (SPEC §14).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LazyFlowConfig {
  // ── Data sources ───────────────────────────────────────────────────────────
  repos: string[]
  jiraProjects: string[]
  jiraBaseUrl: string
  // ── Paths ─────────────────────────────────────────────────────────────────
  dbPath: string
  // ── Visibility ────────────────────────────────────────────────────────────
  visibility: 'public' | 'team' | 'self'
  // ── Metric tuning ─────────────────────────────────────────────────────────
  churnWindowDays: number
  deploySignalPriority: string[]
  benchmarkReport: string
  // ── AI ────────────────────────────────────────────────────────────────────
  claudeModel: string
  claudeEnsembleModel: string
  ensembleConfidenceThreshold: number
  // ── Secrets (never logged) ─────────────────────────────────────────────────
  githubToken: string | null
  jiraToken: string | null
  anthropicApiKey: string | null
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function parseList(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseFloat_(raw: string | undefined, def: number): number {
  if (!raw) return def
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : def
}

function parseInt_(raw: string | undefined, def: number): number {
  if (!raw) return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

function assertVisibility(raw: string | undefined): 'public' | 'team' | 'self' {
  if (raw === 'team' || raw === 'self') return raw
  return 'public'
}

/**
 * Load config from environment variables.  Never reads from disk or network
 * so it is synchronous and safe to call at startup.
 *
 * Secrets (LAZYFLOW_GITHUB_TOKEN, LAZYFLOW_JIRA_TOKEN, ANTHROPIC_API_KEY)
 * are loaded but MUST NOT be logged or included in tool outputs.
 */
export function loadConfig(): LazyFlowConfig {
  const env = process.env

  return {
    repos: parseList(env.LAZYFLOW_REPOS),
    jiraProjects: parseList(env.LAZYFLOW_JIRA_PROJECTS),
    jiraBaseUrl: env.LAZYFLOW_JIRA_BASE_URL ?? '',
    dbPath: env.LAZYFLOW_DB_PATH ?? ':memory:',
    visibility: assertVisibility(env.LAZYFLOW_VISIBILITY),
    churnWindowDays: parseInt_(env.LAZYFLOW_CHURN_WINDOW_DAYS, 30),
    // NOTE: `parseList(...)` returns [] (which is TRUTHY) when the var is unset,
    // so a `|| [defaults]` fallback never fired. Use a length check so the
    // default deploy-signal priority chain (SPEC D9) actually applies.
    deploySignalPriority:
      parseList(env.LAZYFLOW_DEPLOY_SIGNAL_PRIORITY).length > 0
        ? parseList(env.LAZYFLOW_DEPLOY_SIGNAL_PRIORITY)
        : ['deployments_api', 'release', 'workflow', 'merge_proxy'],
    benchmarkReport: env.LAZYFLOW_BENCHMARK_REPORT ?? 'dora-2025',
    claudeModel: env.LAZYFLOW_CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    claudeEnsembleModel: env.LAZYFLOW_CLAUDE_ENSEMBLE_MODEL ?? 'claude-opus-4-8',
    ensembleConfidenceThreshold: parseFloat_(env.LAZYFLOW_ENSEMBLE_THRESHOLD, 0.4),
    // Secrets — loaded but never logged
    githubToken: env.LAZYFLOW_GITHUB_TOKEN ?? null,
    jiraToken: env.LAZYFLOW_JIRA_TOKEN ?? null,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
  }
}
