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

import { execFileSync } from 'node:child_process'
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

/** First env var in `keys` with a non-empty, trimmed value; else null. */
function firstNonEmptyEnv(env, keys) {
  for (const key of keys) {
    const v = env[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/**
 * Resolve a GitHub API token from the environment only, in precedence order:
 *   1. LAZYFLOW_GITHUB_TOKEN — explicit override for this tool.
 *   2. GH_TOKEN / GITHUB_TOKEN — the conventional GitHub env vars (CI, Actions).
 *
 * Empty/whitespace is treated as UNSET. This matters because the plugin maps an
 * unfilled `github_token` config field to "" (`${user_config.github_token}`); a
 * naive `?? null` would let that "" through as a bogus empty bearer token and
 * every GitHub API call would 401. Returns null when nothing is set, leaving the
 * `gh` CLI fallback (wired in index.js) to take over.
 */
export function githubTokenFromEnv(env) {
  return firstNonEmptyEnv(env, ['LAZYFLOW_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])
}

/** Default reader for the GitHub CLI's stored token (`gh auth token`). */
function defaultGhAuthTokenReader() {
  // execFileSync (not exec) — no shell, no interpolation of any argument.
  // stderr is silenced; an unauthenticated/missing gh exits non-zero and throws.
  return execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Resolve the token held by the locally-authenticated GitHub CLI (`gh auth
 * login`). This is the local-first fallback: with no token configured, the tool
 * uses the gh account the user is already signed in as, for repos that account
 * can see. Shells out once at startup.
 *
 * Returns null when gh is absent, not on PATH, not logged in, or prints nothing —
 * GitHub sync then degrades to a warning rather than crashing. `read` is
 * injectable so the null-handling is unit-testable without a real gh binary.
 */
export function githubTokenFromGhCli(read = defaultGhAuthTokenReader) {
  try {
    const token = read()
    return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
  } catch {
    // gh not installed / not on PATH / not authenticated — no local credential.
    return null
  }
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
    // Env-only here (pure/synchronous); the `gh auth token` fallback for an
    // unset token is applied in index.js so this loader stays side-effect-free.
    githubToken: githubTokenFromEnv(env),
    jiraToken: env.LAZYFLOW_JIRA_TOKEN ?? null,
  }
}
