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

  const lower = login.toLowerCase()

  for (const suffix of BOT_SUFFIXES) {
    if (lower.endsWith(suffix)) return true
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
