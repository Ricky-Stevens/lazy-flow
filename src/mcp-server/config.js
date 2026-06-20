/**
 * Config / secret loading from environment — minimal by design.
 *
 * Only what the tool needs to OPERATE is configurable: which repos/projects to
 * track, where the local DB lives, and the secrets. Everything else (ensemble
 * thresholds, deploy-signal precedence, benchmark edition) is a sensible
 * hardcoded default, not a knob. Visibility filtering was removed — this is a
 * local, single-user, full-transparency tool.
 *
 * Secrets are NEVER logged or echoed. Env vars are the sole source.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Resolve the SQLite DB path. The DB must PERSIST so Claude can query it over
 * SQL between sessions — a `:memory:` default would discard everything on exit.
 * Default: ~/.lazy-flow/lazy-flow.db (parent dir created if missing). An explicit
 * LAZYFLOW_DB_PATH override is honoured verbatim, including ':memory:' (tests
 * rely on the ephemeral in-memory DB).
 */
function resolveDbPath(raw) {
  if (raw !== undefined && raw.trim() !== '') {
    const explicit = raw.trim()
    // ':memory:' is intentionally ephemeral — do not create a directory for it.
    if (explicit !== ':memory:') {
      // Ensure the parent directory exists so bun:sqlite can create the file.
      mkdirSync(dirname(explicit), { recursive: true })
    }
    return explicit
  }
  const defaultPath = join(homedir(), '.lazy-flow', 'lazy-flow.db')
  mkdirSync(dirname(defaultPath), { recursive: true })
  return defaultPath
}

function parseList(raw) {
  if (!raw || raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Load config from environment variables. Never reads disk or network, so it is
 * synchronous and safe at startup. Secrets are loaded but MUST NOT be logged.
 */
export function loadConfig() {
  const env = process.env
  return {
    repos: parseList(env.LAZYFLOW_REPOS),
    jiraProjects: parseList(env.LAZYFLOW_JIRA_PROJECTS),
    jiraBaseUrl: env.LAZYFLOW_JIRA_BASE_URL ?? '',
    // Atlassian account email — REQUIRED for an API token (Basic auth) against a
    // Jira Cloud site URL. Empty falls back to Bearer (OAuth 3LO) auth.
    jiraEmail: env.LAZYFLOW_JIRA_EMAIL ?? '',
    dbPath: resolveDbPath(env.LAZYFLOW_DB_PATH),
    githubToken: env.LAZYFLOW_GITHUB_TOKEN ?? null,
    jiraToken: env.LAZYFLOW_JIRA_TOKEN ?? null,
    // Optional LLM classifier for AI-authorship (the semantic tier that
    // adjudicates the deterministic residual). Entirely opt-in: absent key =>
    // the classifier is skipped and only deterministic signals are produced.
    // Model defaults to a small/fast one (this is bulk per-change classification);
    // override for a more capable judge. Nothing is sent anywhere without a key.
    anthropicApiKey: env.LAZYFLOW_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? null,
    aiClassifierModel: env.LAZYFLOW_AI_CLASSIFIER_MODEL ?? 'claude-haiku-4-5',
    aiClassifierMaxPerRun: Number(env.LAZYFLOW_AI_CLASSIFIER_MAX_PER_RUN ?? '50'),
  }
}
