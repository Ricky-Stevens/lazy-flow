import { isGitHubBot, isJiraBot } from './bot.js'

// ---------------------------------------------------------------------------
// Identity ID builders (must match the convention in ingest-github/sync.ts)
// ---------------------------------------------------------------------------

/** Build a stable identity id from kind + externalId. */
export function buildIdentityId(kind, externalId) {
  return `${kind}:${externalId}`
}

// ---------------------------------------------------------------------------
// Raw payload extractors
// ---------------------------------------------------------------------------

function parseRawJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Account info extracted for a GitHub login. */

/** Extract GitHub login + account type + numeric id + verified email from a raw commit payload. */
function extractCommitAuthorLogin(raw) {
  const parsed = parseRawJson(raw)
  const author = parsed.author
  const login = author?.login
  if (typeof login === 'string' && login.length > 0) {
    const commit = parsed.commit
    const gitAuthor = commit?.author
    const email = gitAuthor?.email
    return {
      login,
      type: author?.type,
      id: typeof author?.id === 'number' ? author.id : undefined,
      email: typeof email === 'string' && email.includes('@') ? email : undefined,
    }
  }
  return null
}

/** Extract GitHub login + account type + numeric id from a PR raw payload (author). */
function extractPrAuthorLogin(raw) {
  const parsed = parseRawJson(raw)
  const user = parsed.user
  const login = user?.login
  if (typeof login === 'string' && login.length > 0) {
    return {
      login,
      type: user?.type,
      id: typeof user?.id === 'number' ? user.id : undefined,
    }
  }
  return null
}

/** A Jira identity reference (accountId + optional displayName/email). */

/** Read the scrub-exempt `_identityRefs` block embedded by the Jira ingester. */
function identityRefs(parsed) {
  const refs = parsed._identityRefs
  if (!refs || typeof refs !== 'object') return null
  return refs
}

/** Extract the Jira assignee identity from an issue raw payload. */
function extractIssueAssignee(raw) {
  const parsed = parseRawJson(raw)
  // Prefer the clean, pre-scrub structured ref (the assignee.accountId in the
  // scrubbed blob may have been redacted by the secret scrubber).
  const fromRefs = identityRefs(parsed)?.assignee
  if (fromRefs?.accountId) return fromRefs

  const fields = parsed.fields
  const assignee = fields?.assignee
  if (!assignee) return null
  const accountId = assignee.accountId
  if (typeof accountId === 'string' && accountId.length > 0) {
    return {
      accountId,
      displayName: assignee.displayName,
      emailAddress: assignee.emailAddress,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Identity builders
// ---------------------------------------------------------------------------

function buildGitHubLoginIdentity(info, now, botAllowlist) {
  const raw = { login: info.login, type: info.type ?? 'User' }
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

function buildJiraAccountIdentity(accountId, displayName, now, botAllowlist, emailAddress) {
  const raw = { accountId, displayName }
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

/**
 * Scan all ingested data and:
 *   - Upsert identities from raw payloads
 *   - Backfill issues.assignee_identity_id
 *   - Backfill issue_transitions.actor_identity_id
 */
export async function resolveIdentities(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const botAllowlist = options.botAllowlist ?? []

  let identitiesUpserted = 0
  let issuesBackfilled = 0
  let transitionsBackfilled = 0

  // Helper to upsert once and count only new/changed rows
  async function upsertIdentity(identity) {
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
  const loginInfos = new Map()
  const mergeLogin = (info) => {
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
        const consumed = new Map()
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
function extractActorMapFromIssueRaw(raw) {
  // Multiple changelog histories can share a `created` timestamp, so each
  // timestamp maps to an ORDERED list of actors (consumed positionally during
  // backfill) rather than a single value where a later entry would clobber the
  // earlier one.
  const map = new Map()
  const push = (at, info) => {
    const list = map.get(at)
    if (list) list.push(info)
    else map.set(at, [info])
  }
  try {
    const parsed = JSON.parse(raw)

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

    const changelog = parsed.changelog
    const histories = changelog?.histories
    if (!histories) return map

    for (const history of histories) {
      const created = history.created
      if (!created) continue
      const author = history.author
      if (!author) continue
      const accountId = author.accountId
      if (!accountId) continue
      push(created, {
        accountId,
        displayName: author.displayName,
        emailAddress: author.emailAddress,
      })
    }
  } catch {
    // Ignore malformed raw payloads
  }
  return map
}
