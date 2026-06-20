/**
 * Bot detection for identity stitching (SPEC §6.3).
 *
 * A GitHub identity is a bot when ANY of the following is true:
 *   - GitHub `type` field is "Bot"
 *   - Login ends with "[bot]"
 *   - Login matches a configurable allowlist
 *   - The commit was authored by a GitHub App (login ends with "[bot]" is the common indicator)
 *
 * Bot identities are schema-level flagged (is_bot=true) so all metric paths
 * share one source of truth and do not re-detect ad-hoc.
 */

/** Default bot login suffixes. */
const BOT_SUFFIXES = ['[bot]', '-bot', '_bot']

/**
 * Default GitHub App login suffixes. GitHub Apps install themselves with logins
 * like `graphite-app`, `detail-app`, `greptile-apps`, `socket-security-app` —
 * they have `type:"Bot"` in the API but historic data persisted them as `User`,
 * so a name-shape fallback is needed. `-action` is intentionally NOT included:
 * organisation members can legitimately end in `-action` (e.g. a person named
 * "Reaction").
 */
const APP_SUFFIXES = ['-app', '-apps']

/** Default well-known bot logins (case-insensitive). */
const KNOWN_BOTS = new Set([
  'dependabot',
  'renovate',
  'github-actions',
  'snyk-bot',
  'codecov',
  'sonarcloud',
  'deepsource-autofix',
  'allcontributors',
  'greenkeeper',
  'stale',
  // Observed GitHub Apps that historically persisted with type !== 'Bot' or were
  // ingested before bot-shape detection existed. The suffix rules below subsume
  // these, but listing them explicitly anchors the contract in tests.
  'graphite-app',
  'detail-app',
  'greptile-apps',
])

/**
 * Determine whether a GitHub login should be classified as a bot.
 *
 * @param login       The GitHub login string.
 * @param accountType Optional "type" field from the GitHub Users API ("User" | "Bot" | "Organization").
 * @param allowlist   Optional per-org additional bot logins (case-insensitive).
 */
export function isGitHubBot(login, accountType, allowlist = []) {
  // Only the explicit "Bot" type is auto-flagged. "Organization" is NOT a bot —
  // organisation-attributed commits/PRs are legitimate work and flagging them
  // is_bot silently drops those contributions from every aggregate. An org
  // account that is genuinely automation will still match the suffix/known-bot
  // checks below.
  if (accountType === 'Bot') return true

  return isLikelyBotLogin(login, accountType, allowlist)
}

/**
 * Pure name-shape bot detector. Returns true when the login matches any of:
 *   - `[bot]` / `-bot` / `_bot` suffix (the GitHub Apps marketplace convention)
 *   - `-app` / `-apps` suffix (GitHub Apps installed in an org install with
 *     those marketing suffixes — historic rows ingested before bot detection
 *     persisted them with type 'User' or with type missing, so the suffix
 *     fallback catches them)
 *   - membership in the known-bot allowlist (e.g. `renovate`, `dependabot`,
 *     plus the observed app logins `graphite-app` / `detail-app` /
 *     `greptile-apps`)
 *   - membership in a per-org additional allowlist (case-insensitive)
 *
 * Exposed for unit testing the heuristic in isolation. `rawAuthor` is accepted
 * (and inspected for `__typename === 'Bot'`) so callers with a GraphQL author
 * object can lean on the type when present, without the caller needing to
 * extract it first.
 */
export function isLikelyBotLogin(login, rawAuthor, allowlist = []) {
  if (typeof login !== 'string' || login.length === 0) return false

  // Accept either an explicit account-type string or a raw author object that
  // carries a GraphQL __typename / REST type. A GraphQL `Bot` typename or REST
  // `Bot` type is definitive even when the suffix rules below would not match.
  const typeFromArg = typeof rawAuthor === 'string' ? rawAuthor : null
  const typeFromObj =
    rawAuthor && typeof rawAuthor === 'object'
      ? (rawAuthor.__typename ?? rawAuthor.type ?? null)
      : null
  if (typeFromArg === 'Bot' || typeFromObj === 'Bot') return true

  const lower = login.toLowerCase()

  for (const suffix of BOT_SUFFIXES) {
    if (lower.endsWith(suffix)) return true
  }
  for (const suffix of APP_SUFFIXES) {
    // `-app` must be a true suffix on a multi-segment login (e.g. `graphite-app`),
    // not the entire login (no login is just "-app"). Length check guards that.
    if (lower.length > suffix.length && lower.endsWith(suffix)) return true
  }

  if (KNOWN_BOTS.has(lower)) return true

  const lowerAllowlist = allowlist.map((s) => s.toLowerCase())
  if (lowerAllowlist.includes(lower)) return true

  return false
}

/**
 * Determine whether a Jira accountId / displayName should be classified as a bot.
 *
 * Jira does not have a first-class "Bot" type, so we rely on naming conventions.
 */
export function isJiraBot(displayName, allowlist = []) {
  const lower = displayName.toLowerCase()

  for (const suffix of BOT_SUFFIXES) {
    if (lower.endsWith(suffix)) return true
  }

  if (KNOWN_BOTS.has(lower)) return true

  const lowerAllowlist = allowlist.map((s) => s.toLowerCase())
  if (lowerAllowlist.includes(lower)) return true

  return false
}
