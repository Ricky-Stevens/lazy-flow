/**
 * Resolution pass — SPEC §6.3 / WP-IDENTITY.
 *
 * resolveIdentities(store) scans all raw ingested data (commits, PRs, reviews,
 * review comments, issues, issue transitions) and:
 *
 *   1. Upserts `identities` rows of the appropriate kind:
 *      - github_login  for GitHub logins found in commits/PRs/reviews
 *      - commit_email  for author emails parsed from commit raw payloads
 *      - jira_account  for Jira accountIds found in issue/transition raw payloads
 *
 *   2. Backfills the NULL FK link columns that ingestion deliberately left NULL
 *      to avoid FK violations before identity rows existed:
 *      - commits.author_identity_id           (skipped — already set by GitHub sync)
 *      - pull_requests.author_identity_id     (skipped — already set by GitHub sync)
 *      - issues.assignee_identity_id          (backfilled from Jira accountId)
 *      - issue_transitions.actor_identity_id  (backfilled from Jira accountId)
 *      - reviews.reviewer_identity_id         (skipped — set by GitHub sync)
 *      - review_comments.author_identity_id   (skipped — set by GitHub sync)
 *
 * This is a pass-over-the-store operation: it reads every commit/PR/issue from
 * the store, extracts the raw payload for additional fields not yet resolved,
 * and writes back. Safe to run multiple times (idempotent).
 */

import type { Identity } from '../domain/types.js'
import type { Store } from '../store/Store.js'
import { isGitHubBot, isJiraBot } from './bot.js'

// ---------------------------------------------------------------------------
// Identity ID builders (must match the convention in ingest-github/sync.ts)
// ---------------------------------------------------------------------------

/** Build a stable identity id from kind + externalId. */
export function buildIdentityId(kind: Identity['kind'], externalId: string): string {
  return `${kind}:${externalId}`
}

// ---------------------------------------------------------------------------
// Raw payload extractors
// ---------------------------------------------------------------------------

function parseRawJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Account info extracted for a GitHub login. */
interface GitHubLoginInfo {
  login: string
  type?: string
  /** Stable numeric GitHub user id (anchors the person across login renames). */
  id?: number
  /**
   * The git author email of an attributed commit. GitHub only populates
   * `author.login` when the commit's email matches a *verified* email on that
   * account, so when both are present the email is verified-associated with the
   * login — usable for the Tier-1b email↔login auto-merge.
   */
  email?: string
}

/** Extract GitHub login + account type + numeric id + verified email from a raw commit payload. */
function extractCommitAuthorLogin(raw: string): GitHubLoginInfo | null {
  const parsed = parseRawJson(raw)
  const author = parsed.author as Record<string, unknown> | undefined
  const login = author?.login
  if (typeof login === 'string' && login.length > 0) {
    const commit = parsed.commit as Record<string, unknown> | undefined
    const gitAuthor = commit?.author as Record<string, unknown> | undefined
    const email = gitAuthor?.email
    return {
      login,
      type: author?.type as string | undefined,
      id: typeof author?.id === 'number' ? author.id : undefined,
      email: typeof email === 'string' && email.includes('@') ? email : undefined,
    }
  }
  return null
}

/** Extract GitHub login + account type + numeric id from a PR raw payload (author). */
function extractPrAuthorLogin(raw: string): GitHubLoginInfo | null {
  const parsed = parseRawJson(raw)
  const user = parsed.user as Record<string, unknown> | undefined
  const login = user?.login
  if (typeof login === 'string' && login.length > 0) {
    return {
      login,
      type: user?.type as string | undefined,
      id: typeof user?.id === 'number' ? user.id : undefined,
    }
  }
  return null
}

/** A Jira identity reference (accountId + optional displayName/email). */
interface JiraActorInfo {
  accountId: string
  displayName?: string
  emailAddress?: string
}

/** Read the scrub-exempt `_identityRefs` block embedded by the Jira ingester. */
function identityRefs(parsed: Record<string, unknown>): {
  assignee?: JiraActorInfo
  actors?: Array<{ at: string } & JiraActorInfo>
} | null {
  const refs = parsed._identityRefs
  if (!refs || typeof refs !== 'object') return null
  return refs as { assignee?: JiraActorInfo; actors?: Array<{ at: string } & JiraActorInfo> }
}

/** Extract the Jira assignee identity from an issue raw payload. */
function extractIssueAssignee(raw: string): JiraActorInfo | null {
  const parsed = parseRawJson(raw)
  // Prefer the clean, pre-scrub structured ref (the assignee.accountId in the
  // scrubbed blob may have been redacted by the secret scrubber).
  const fromRefs = identityRefs(parsed)?.assignee
  if (fromRefs?.accountId) return fromRefs

  const fields = parsed.fields as Record<string, unknown> | undefined
  const assignee = fields?.assignee as Record<string, unknown> | null | undefined
  if (!assignee) return null
  const accountId = assignee.accountId
  if (typeof accountId === 'string' && accountId.length > 0) {
    return {
      accountId,
      displayName: assignee.displayName as string | undefined,
      emailAddress: assignee.emailAddress as string | undefined,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Identity builders
// ---------------------------------------------------------------------------

function buildGitHubLoginIdentity(
  info: GitHubLoginInfo,
  now: string,
  botAllowlist: ReadonlyArray<string>,
): Identity {
  const raw: Record<string, unknown> = { login: info.login, type: info.type ?? 'User' }
  // Persist the stable numeric id (anchors the person via primaryAccountRef) and
  // the GitHub-verified email (enables Tier-1b email↔login auto-merge in stitch).
  if (info.id !== undefined) raw.id = info.id
  if (info.email !== undefined) raw.email = info.email
  return {
    id: buildIdentityId('github_login', info.login),
    personId: null,
    kind: 'github_login',
    externalId: info.login,
    isBot: isGitHubBot(info.login, info.type, botAllowlist),
    confidence: 1,
    raw: JSON.stringify(raw),
    updatedAt: now,
  }
}

function buildJiraAccountIdentity(
  accountId: string,
  displayName: string | undefined,
  now: string,
  botAllowlist: ReadonlyArray<string>,
  emailAddress?: string,
): Identity {
  const raw: Record<string, unknown> = { accountId, displayName }
  // Persist the Jira email when the instance exposes it (Server/DC, some Cloud
  // configs) so stitch's email↔email auto-merge can fire. Often absent on Jira
  // Cloud (GDPR), in which case stitch simply falls back to the human queue.
  if (emailAddress) raw.emailAddress = emailAddress
  return {
    id: buildIdentityId('jira_account', accountId),
    personId: null,
    kind: 'jira_account',
    externalId: accountId,
    isBot: isJiraBot(displayName ?? '', botAllowlist),
    confidence: 1,
    raw: JSON.stringify(raw),
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Main resolution pass
// ---------------------------------------------------------------------------

export interface ResolveIdentitiesOptions {
  /** Per-org bot login allowlist (in addition to built-in heuristics). */
  botAllowlist?: ReadonlyArray<string>
  /** ISO timestamp to use as updatedAt for new identity rows (default: now). */
  now?: string
}

export interface ResolveIdentitiesResult {
  identitiesUpserted: number
  issuesBackfilled: number
  transitionsBackfilled: number
}

/**
 * Scan all ingested data and:
 *   - Upsert identities from raw payloads
 *   - Backfill issues.assignee_identity_id
 *   - Backfill issue_transitions.actor_identity_id
 */
export async function resolveIdentities(
  store: Store,
  options: ResolveIdentitiesOptions = {},
): Promise<ResolveIdentitiesResult> {
  const now = options.now ?? new Date().toISOString()
  const botAllowlist = options.botAllowlist ?? []

  let identitiesUpserted = 0
  let issuesBackfilled = 0
  let transitionsBackfilled = 0

  // Helper to upsert once and count only new/changed rows
  async function upsertIdentity(identity: Identity): Promise<void> {
    await store.upsertIdentity(identity)
    identitiesUpserted++
  }

  // -------------------------------------------------------------------------
  // 1. Repositories → commits: extract author logins from raw payloads
  //    (These are already in identities from GitHub sync but we re-ensure
  //    for completeness. commit.author_identity_id is already set.)
  // -------------------------------------------------------------------------
  // Merge per-login info across all commits and PRs before upserting, so a
  // richer record (commit with verified email + numeric id) is not clobbered by
  // a poorer one (PR author without email) under last-writer-wins, and so each
  // login is upserted exactly once.
  const loginInfos = new Map<string, GitHubLoginInfo>()
  const mergeLogin = (info: GitHubLoginInfo | null): void => {
    if (!info) return
    const existing = loginInfos.get(info.login)
    if (!existing) {
      loginInfos.set(info.login, { ...info })
      return
    }
    // Prefer the first non-undefined value for each field.
    existing.type ??= info.type
    existing.id ??= info.id
    existing.email ??= info.email
  }

  // Run the whole pass in one transaction: it issues thousands of small writes
  // (one per identity/backfill), and without a single BEGIN/COMMIT each forces
  // its own WAL fsync — the dominant cost of bulk resolution.
  await store.transaction(async () => {
    const orgs = await store.listOrganisations()
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        const commits = await store.getCommitsByRepo(repo.id)
        for (const commit of commits) {
          mergeLogin(extractCommitAuthorLogin(commit.raw))
        }
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          mergeLogin(extractPrAuthorLogin(pr.raw))
        }
      }
    }

    for (const info of loginInfos.values()) {
      await upsertIdentity(buildGitHubLoginIdentity(info, now, botAllowlist))
    }

    // -----------------------------------------------------------------------
    // 2. Issues: extract Jira assignee accountId → upsert identity → backfill
    // -----------------------------------------------------------------------
    const projects = await store.listJiraProjects()
    for (const project of projects) {
      const issues = await store.getIssuesByProject(project.id)
      for (const issue of issues) {
        if (issue.deletedAt) continue

        const assigneeInfo = extractIssueAssignee(issue.raw)
        if (assigneeInfo) {
          const identity = buildJiraAccountIdentity(
            assigneeInfo.accountId,
            assigneeInfo.displayName,
            now,
            botAllowlist,
            assigneeInfo.emailAddress,
          )
          await upsertIdentity(identity)

          // Backfill the NULL assignee_identity_id
          if (issue.assigneeIdentityId === null) {
            await store.setIssueAssigneeIdentity(issue.id, identity.id)
            issuesBackfilled++
          }
        }

        const transitions = await store.getIssueTransitions(issue.id)
        // Only re-parse the (potentially large) raw changelog when there is at
        // least one transition still missing its actor.
        if (!transitions.some((t) => t.actorIdentityId === null)) continue

        // Map of (transitionedAt → ordered actor list) from the issue's
        // changelog refs; consumed positionally so same-timestamp transitions
        // get distinct actors.
        const actorMap = extractActorMapFromIssueRaw(issue.raw)
        if (actorMap.size === 0) continue
        const consumed = new Map<string, number>()
        for (const transition of transitions) {
          if (transition.actorIdentityId !== null) continue
          const list = actorMap.get(transition.transitionedAt)
          if (!list || list.length === 0) continue
          const idx = consumed.get(transition.transitionedAt) ?? 0
          const actorInfo = list[Math.min(idx, list.length - 1)]
          consumed.set(transition.transitionedAt, idx + 1)
          if (!actorInfo) continue
          const identity = buildJiraAccountIdentity(
            actorInfo.accountId,
            actorInfo.displayName,
            now,
            botAllowlist,
            actorInfo.emailAddress,
          )
          await upsertIdentity(identity)
          await store.setTransitionActorIdentity(transition.id, identity.id)
          transitionsBackfilled++
        }
      }
    }
  })

  return { identitiesUpserted, issuesBackfilled, transitionsBackfilled }
}

/**
 * Build a map of ISO timestamp → actorInfo from the raw Jira issue payload.
 *
 * The raw issue payload can contain an expanded `changelog` field with
 * histories, each of which has an `author` with accountId. This is what
 * ingestion uses to parse transitions. We re-parse here to backfill actors.
 *
 * Jira changelog history format:
 *   { histories: [{ id, author: { accountId, displayName }, created, items: [...] }] }
 */
function extractActorMapFromIssueRaw(raw: string): Map<string, JiraActorInfo[]> {
  // Multiple changelog histories can share a `created` timestamp, so each
  // timestamp maps to an ORDERED list of actors (consumed positionally during
  // backfill) rather than a single value where a later entry would clobber the
  // earlier one.
  const map = new Map<string, JiraActorInfo[]>()
  const push = (at: string, info: JiraActorInfo): void => {
    const list = map.get(at)
    if (list) list.push(info)
    else map.set(at, [info])
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // Prefer the clean, pre-scrub structured refs when present.
    const actors = identityRefs(parsed)?.actors
    if (actors && actors.length > 0) {
      for (const a of actors) {
        if (a.at && a.accountId) {
          push(a.at, {
            accountId: a.accountId,
            displayName: a.displayName,
            emailAddress: a.emailAddress,
          })
        }
      }
      return map
    }

    const changelog = parsed.changelog as Record<string, unknown> | undefined
    const histories = changelog?.histories as Array<Record<string, unknown>> | undefined
    if (!histories) return map

    for (const history of histories) {
      const created = history.created as string | undefined
      if (!created) continue
      const author = history.author as Record<string, unknown> | undefined
      if (!author) continue
      const accountId = author.accountId as string | undefined
      if (!accountId) continue
      push(created, {
        accountId,
        displayName: author.displayName as string | undefined,
        emailAddress: author.emailAddress as string | undefined,
      })
    }
  } catch {
    // Ignore malformed raw payloads
  }
  return map
}
