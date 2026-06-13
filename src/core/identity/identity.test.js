/**
 * Identity stitching tests — SPEC §6.3 / WP-IDENTITY.
 *
 * Tests are run against an in-memory BunSqliteStore seeded from the
 * @lazy-flow/testkit baseOrg dataset.
 *
 * Coverage:
 *   1. resolveIdentities — Jira assignee_identity_id + actor_identity_id backfilled
 *   2. parseCommitAuthors — co-authored squash commit attributes all authors
 *   3. stitchPersons — distinct-humans-same-name do NOT auto-merge (land in queue)
 *   4. stitchPersons — one-human-many-verified-emails merge
 *   5. stitchPersons — bot identity excluded from persons/aggregates
 *   6. resolveIdentities — commits.author_identity_id already set (no regression)
 *   7. Queue API — listCandidateMatches returns pending entries
 *   8. Queue API — confirmCandidateMatch merges identities (audited)
 *   9. Queue API — unmergeIdentities is non-destructive
 *  10. parseTrailers — parses Co-authored-by and Signed-off-by lines
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { baseOrg, IDS } from '../../testkit/index.js'
import { migrate } from '../migrate/runner.js'
import { BunSqliteStore } from '../store/BunSqliteStore.js'
import { isGitHubBot } from './bot.js'
import {
  confirmCandidateMatch,
  listCandidateMatches,
  parseCommitAuthors,
  parseTrailers,
  rejectCandidateMatch,
  resolveIdentities,
  stitchPersons,
  unmergeIdentities,
} from './index.js'
import { buildIdentityId } from './resolve.js'

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  // Reuse the migrated db handle
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

const NOW = '2024-06-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Seeding helper — loads baseOrg data into the store
// ---------------------------------------------------------------------------

async function seedStore(store) {
  // Organisation
  await store.upsertOrganisation({
    id: baseOrg.org.id,
    githubLogin: baseOrg.org.githubLogin,
    jiraCloudId: baseOrg.org.jiraCloudId,
    name: 'Acme',
    createdAt: NOW,
    updatedAt: NOW,
  })

  // Repositories
  for (const repo of baseOrg.repositories) {
    await store.upsertRepository(repo)
  }

  // Persons
  for (const person of baseOrg.persons) {
    await store.upsertPerson(person)
  }

  // Identities (already linked to persons in baseOrg)
  for (const identity of baseOrg.identities) {
    await store.upsertIdentity(identity)
  }

  // Jira project
  await store.upsertJiraProject({
    id: baseOrg.jiraProject.id,
    key: baseOrg.jiraProject.key,
    name: baseOrg.jiraProject.name,
    jiraCloudId: baseOrg.jiraProject.jiraCloudId,
    raw: baseOrg.jiraProject.raw,
    createdAt: NOW,
    updatedAt: NOW,
  })

  // Issues — with assigneeIdentityId=null to simulate ingestion state
  for (const issue of baseOrg.jiraIssues) {
    await store.upsertIssue({
      ...issue,
      // Simulate ingestion leaving assignee NULL (raw has the accountId)
      assigneeIdentityId: null,
      // Embed the assignee in the raw payload so resolveIdentities can find it
      raw: buildIssueRaw(issue),
    })
  }

  // Transitions — actorIdentityId=null to simulate ingestion state
  // Embed actor accountId in a synthetic raw payload on the issue for resolution
  for (const [, transitions] of Object.entries(baseOrg.issueTransitions)) {
    const trs = transitions.map((t) => ({
      ...t,
      actorIdentityId: null, // simulates ingestion gap
    }))
    if (trs.length > 0) {
      await store.appendIssueTransitions(trs)
    }
  }

  // Update issue raw payloads to include changelog histories so resolveIdentities
  // can back-fill actor_identity_id from them
  await embedChangelogInIssueRaw(store)

  // Commits — authorIdentityId already set (GitHub sync sets this)
  for (const commit of baseOrg.commits) {
    await store.upsertCommit({
      ...commit,
      createdAt: commit.createdAt,
      updatedAt: commit.updatedAt,
    })
  }

  // Pull requests
  for (const pr of baseOrg.pullRequests) {
    await store.upsertPullRequest(pr)
  }
}

/**
 * Build a Jira-like raw payload for an issue that includes the assignee
 * with their accountId so resolveIdentities can extract it.
 */
function buildIssueRaw(issue) {
  const base = JSON.parse(issue.raw)

  // Map our internal identity IDs back to plausible Jira accountIds
  const assigneeAccountId = mapIdentityToJiraAccountId(issue.assigneeIdentityId)
  if (!assigneeAccountId) return issue.raw

  const fields = base.fields ?? {}
  fields.assignee = {
    accountId: assigneeAccountId,
    displayName: getDisplayName(issue.assigneeIdentityId),
  }
  base.fields = fields
  return JSON.stringify(base)
}

function mapIdentityToJiraAccountId(identityId) {
  if (!identityId) return null
  // Map our internal identity ids to Jira accountIds (externalId of jira_account identities)
  // For the baseOrg, assignees use github_login identities, so we treat the externalId as accountId
  const map = {
    [IDS.identityAliceGh]: 'jira-account-alice',
    [IDS.identityBobGh]: 'jira-account-bob',
    [IDS.identityCarolGh]: 'jira-account-carol',
  }
  return map[identityId] ?? null
}

function getDisplayName(identityId) {
  if (!identityId) return 'Unknown'
  const map = {
    [IDS.identityAliceGh]: 'Alice Example',
    [IDS.identityBobGh]: 'Bob Example',
    [IDS.identityCarolGh]: 'Carol Example',
  }
  return map[identityId] ?? 'Unknown'
}

/**
 * Re-write each issue's raw payload to include a changelog.histories array
 * so resolveIdentities can extract actor accountIds for transitions.
 */
async function embedChangelogInIssueRaw(store) {
  for (const [issueId, transitions] of Object.entries(baseOrg.issueTransitions)) {
    const issue = await store.getIssue(issueId)
    if (!issue) continue

    const histories = transitions.map((t) => ({
      id: t.id,
      created: t.transitionedAt,
      author: t.actorIdentityId
        ? {
            accountId: mapIdentityToJiraAccountId(t.actorIdentityId) ?? t.actorIdentityId,
            displayName: getDisplayName(t.actorIdentityId),
          }
        : null,
      items: [{ field: 'status', from: t.fromStatusId, to: t.toStatusId }],
    }))

    const raw = JSON.parse(issue.raw)
    raw.changelog = { histories }
    await store.upsertIssue({ ...issue, raw: JSON.stringify(raw), updatedAt: NOW })
  }
}

// ---------------------------------------------------------------------------
// 1. resolveIdentities — backfills NULL link columns
// ---------------------------------------------------------------------------

describe('resolveIdentities', () => {
  it('backfills issues.assignee_identity_id for all issues with assignees', async () => {
    const store = freshStore()
    await seedStore(store)

    // Verify NULLs before resolution
    const epicBefore = await store.getIssue(IDS.issueEpic1)
    expect(epicBefore?.assigneeIdentityId).toBeNull()

    await resolveIdentities(store, { now: NOW })

    // After resolution, issues with assignees should have identity IDs
    const epic = await store.getIssue(IDS.issueEpic1)
    expect(epic?.assigneeIdentityId).not.toBeNull()
    expect(epic?.assigneeIdentityId).toMatch(/^jira_account:/)

    const story = await store.getIssue(IDS.issueStory1)
    expect(story?.assigneeIdentityId).not.toBeNull()

    const subtask = await store.getIssue(IDS.issueSubtask1)
    expect(subtask?.assigneeIdentityId).not.toBeNull()
  })

  it('backfills issue_transitions.actor_identity_id for transitions with actors', async () => {
    const store = freshStore()
    await seedStore(store)

    // Verify NULLs before resolution
    const transitionsBefore = await store.getIssueTransitions(IDS.issueStory1)
    const nullActorsBefore = transitionsBefore.filter((t) => t.actorIdentityId === null)
    expect(nullActorsBefore.length).toBeGreaterThan(0)

    await resolveIdentities(store, { now: NOW })

    // After resolution, transitions with actor accountIds in the raw should be backfilled
    const transitions = await store.getIssueTransitions(IDS.issueStory1)
    const filled = transitions.filter((t) => t.actorIdentityId !== null)
    // The init transition has no actor; the rest should be filled
    expect(filled.length).toBeGreaterThan(0)
  })

  it('upserts jira_account identities for each distinct Jira accountId found', async () => {
    const store = freshStore()
    await seedStore(store)

    await resolveIdentities(store, { now: NOW })

    // Should have created jira_account identities for alice, bob, carol
    const aliceJira = await store.findIdentityByExternalId('jira_account', 'jira-account-alice')
    expect(aliceJira).not.toBeNull()
    expect(aliceJira?.kind).toBe('jira_account')

    const bobJira = await store.findIdentityByExternalId('jira_account', 'jira-account-bob')
    expect(bobJira).not.toBeNull()
  })

  it('is idempotent — running twice does not double-backfill', async () => {
    const store = freshStore()
    await seedStore(store)

    await resolveIdentities(store, { now: NOW })
    const result1 = await store.getIssue(IDS.issueEpic1)

    await resolveIdentities(store, { now: NOW })
    const result2 = await store.getIssue(IDS.issueEpic1)

    expect(result1?.assigneeIdentityId).toBe(result2?.assigneeIdentityId)
  })
})

// ---------------------------------------------------------------------------
// 2. parseCommitAuthors — co-authored squash commit attributes all authors
// ---------------------------------------------------------------------------

describe('parseCommitAuthors', () => {
  it('inserts a commit_authors row for the primary author', async () => {
    const store = freshStore()
    await seedStore(store)

    await parseCommitAuthors(store, { now: NOW })

    const authors = await store.getCommitAuthors(IDS.repoAlpha, IDS.commitA1)
    const primaryAuthor = authors.find((a) => a.role === 'author')
    expect(primaryAuthor).toBeDefined()
    expect(primaryAuthor?.identityId).toBe(IDS.identityAliceGh)
    expect(primaryAuthor?.source).toBe('api')
  })

  it('parses Co-authored-by trailer from squash commit and inserts co_author row', async () => {
    const store = freshStore()
    await seedStore(store)

    await parseCommitAuthors(store, { now: NOW })

    // commitSquash has "Co-authored-by: Carol Example <carol@example.com>"
    const authors = await store.getCommitAuthors(IDS.repoAlpha, IDS.commitSquash)
    const coAuthor = authors.find((a) => a.role === 'co_author')
    expect(coAuthor).toBeDefined()
    expect(coAuthor?.source).toBe('trailer')

    // The co_author identity should be a commit_email identity for carol@example.com
    // (may be either the seeded 'identity-carol-email' or 'commit_email:carol@example.com'
    // depending on which was upserted last — what matters is that the identity exists
    // and has the right externalId)
    const identityId = coAuthor?.identityId ?? ''
    // Must be a commit_email kind identity
    expect(identityId).toBeTruthy()
    // Fetch the identity by PK and verify the externalId
    const allIdentities = await store.listAllIdentities()
    const coAuthorIdentity = allIdentities.find((id) => id.id === identityId)
    expect(coAuthorIdentity?.kind).toBe('commit_email')
    expect(coAuthorIdentity?.externalId).toBe('carol@example.com')
  })

  it('squash commit attributes both primary author (alice) and co-author (carol)', async () => {
    const store = freshStore()
    await seedStore(store)

    await parseCommitAuthors(store, { now: NOW })

    const authors = await store.getCommitAuthors(IDS.repoAlpha, IDS.commitSquash)
    const roles = authors.map((a) => a.role)
    expect(roles).toContain('author')
    expect(roles).toContain('co_author')

    const authorRow = authors.find((a) => a.role === 'author')
    const coAuthorRow = authors.find((a) => a.role === 'co_author')

    // Primary author is alice
    expect(authorRow?.identityId).toBe(IDS.identityAliceGh)

    // Co-author should be a commit_email identity with carol@example.com
    const allIdentities = await store.listAllIdentities()
    const coAuthorIdentity = allIdentities.find((id) => id.id === coAuthorRow?.identityId)
    expect(coAuthorIdentity?.kind).toBe('commit_email')
    expect(coAuthorIdentity?.externalId).toBe('carol@example.com')
  })

  it('is idempotent — running twice does not create duplicate rows', async () => {
    const store = freshStore()
    await seedStore(store)

    await parseCommitAuthors(store, { now: NOW })
    await parseCommitAuthors(store, { now: NOW })

    const authors = await store.getCommitAuthors(IDS.repoAlpha, IDS.commitSquash)
    // Should have exactly 2 rows: author + co_author (not 4)
    expect(authors.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 3. parseTrailers unit tests
// ---------------------------------------------------------------------------

describe('parseTrailers', () => {
  it('parses Co-authored-by trailer', () => {
    const msg = 'feat: add widget\n\nCo-authored-by: Carol Example <carol@example.com>'
    const trailers = parseTrailers(msg)
    expect(trailers).toHaveLength(1)
    expect(trailers[0]).toMatchObject({
      role: 'co_author',
      email: 'carol@example.com',
      name: 'Carol Example',
    })
  })

  it('parses Signed-off-by trailer as co_author', () => {
    const msg = 'chore: update deps\n\nSigned-off-by: Bob Example <bob@example.com>'
    const trailers = parseTrailers(msg)
    expect(trailers).toHaveLength(1)
    expect(trailers[0]).toMatchObject({ role: 'co_author', email: 'bob@example.com' })
  })

  it('parses multiple trailers from one message', () => {
    const msg = [
      'feat: pair programming',
      '',
      'Co-authored-by: Alice <alice@example.com>',
      'Co-authored-by: Bob <bob@example.com>',
      'Signed-off-by: Carol <carol@example.com>',
    ].join('\n')
    const trailers = parseTrailers(msg)
    expect(trailers).toHaveLength(3)
    const emails = trailers.map((t) => t.email)
    expect(emails).toContain('alice@example.com')
    expect(emails).toContain('bob@example.com')
    expect(emails).toContain('carol@example.com')
  })

  it('returns empty array for a message with no trailers', () => {
    expect(parseTrailers('fix: typo')).toHaveLength(0)
  })

  it('normalises email to lowercase', () => {
    const msg = 'feat: x\n\nCo-authored-by: Person <Person@Example.COM>'
    const trailers = parseTrailers(msg)
    expect(trailers[0]?.email).toBe('person@example.com')
  })
})

// ---------------------------------------------------------------------------
// 4. stitchPersons — bot excluded from persons
// ---------------------------------------------------------------------------

describe('stitchPersons — bot exclusion', () => {
  it('bot identity (dependabot) does NOT get a person record', async () => {
    const store = freshStore()
    await seedStore(store)

    await stitchPersons(store, { now: NOW })

    // dependabot identity should still have no person_id
    const botIdentity = await store.findIdentityByExternalId('github_login', 'dependabot[bot]')
    expect(botIdentity).not.toBeNull()
    expect(botIdentity?.isBot).toBe(true)
    expect(botIdentity?.personId).toBeNull()
  })

  it('listAllIdentities returns the bot identity', async () => {
    const store = freshStore()
    await seedStore(store)

    const all = await store.listAllIdentities()
    const bot = all.find((id) => id.externalId === 'dependabot[bot]')
    expect(bot?.isBot).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. stitchPersons — distinct humans with same name do NOT auto-merge
// ---------------------------------------------------------------------------

describe('stitchPersons — distinct-humans-same-name', () => {
  it('john.smith@acme.com and john.smith@vendor.com do NOT auto-merge', async () => {
    // Set up: only migrate + seed two "same name" commit_email identities
    const db = new Database(':memory:')
    migrate(db, 'up')
    const freshSt = new BunSqliteStore(':memory:')
    freshSt.db.close()
    freshSt.db = db

    // Two people with the same local-part but different domains
    await freshSt.upsertIdentity({
      id: 'commit_email:john.smith@acme.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'john.smith@acme.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"john.smith@acme.com","name":"John Smith"}',
      updatedAt: NOW,
    })

    // Create a person for the second john so stitchPersons has an anchor to queue against
    await freshSt.upsertPerson({
      id: 'person-john-vendor',
      displayName: 'John Smith',
      primaryAccountRef: 'jira:john-vendor-account',
      updatedAt: NOW,
    })
    await freshSt.upsertIdentity({
      id: 'commit_email:john.smith@vendor.com',
      personId: 'person-john-vendor',
      kind: 'commit_email',
      externalId: 'john.smith@vendor.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"john.smith@vendor.com","name":"John Smith"}',
      updatedAt: NOW,
    })

    await stitchPersons(freshSt, { now: NOW })

    // The two identities must NOT be merged to the same person
    const johnAcme = await freshSt.findIdentityByExternalId('commit_email', 'john.smith@acme.com')
    const johnVendor = await freshSt.findIdentityByExternalId(
      'commit_email',
      'john.smith@vendor.com',
    )

    expect(johnAcme?.personId).not.toBe(johnVendor?.personId)

    // The match should be in the pending queue (local_part_name)
    const queue = await listCandidateMatches(freshSt, { status: 'pending' })
    const matchEntry = queue.find(
      (m) =>
        (m.identityIdA === johnAcme?.id || m.identityIdB === johnAcme?.id) &&
        (m.identityIdA === johnVendor?.id || m.identityIdB === johnVendor?.id),
    )
    expect(matchEntry).toBeDefined()
    expect(matchEntry?.reason).toBe('local_part_name')
    expect(matchEntry?.status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// 6. stitchPersons — one human with many verified emails
// ---------------------------------------------------------------------------

describe('stitchPersons — verified email merge', () => {
  it('github_login identity with verified email merges with matching commit_email identity', async () => {
    const store = freshStore()

    // Set up: a github_login identity with a verified email in the raw payload
    await store.upsertPerson({
      id: 'person-charlie',
      displayName: 'Charlie Dev',
      primaryAccountRef: 'gh:999001',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'github_login:charlie',
      personId: 'person-charlie',
      kind: 'github_login',
      externalId: 'charlie',
      isBot: false,
      confidence: 1,
      // raw includes a verified email
      raw: '{"login":"charlie","id":999001,"type":"User","email":"charlie@verified.com"}',
      updatedAt: NOW,
    })

    // A separate commit_email identity with the same email, not yet linked
    await store.upsertIdentity({
      id: 'commit_email:charlie@verified.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'charlie@verified.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"charlie@verified.com"}',
      updatedAt: NOW,
    })

    await stitchPersons(store, { now: NOW })

    // The commit_email identity should now be linked to person-charlie
    const emailIdentity = await store.findIdentityByExternalId(
      'commit_email',
      'charlie@verified.com',
    )
    expect(emailIdentity?.personId).toBe('person-charlie')
  })

  it('does NOT auto-merge when email is a github noreply address', async () => {
    const store = freshStore()

    await store.upsertPerson({
      id: 'person-dev',
      displayName: 'Dev',
      primaryAccountRef: 'gh:999002',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'github_login:devuser',
      personId: 'person-dev',
      kind: 'github_login',
      externalId: 'devuser',
      isBot: false,
      confidence: 1,
      // noreply email should NOT be used for auto-merge
      raw: '{"login":"devuser","id":999002,"type":"User","email":"999002+devuser@users.noreply.github.com"}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:999002+devuser@users.noreply.github.com',
      personId: null,
      kind: 'commit_email',
      externalId: '999002+devuser@users.noreply.github.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"999002+devuser@users.noreply.github.com"}',
      updatedAt: NOW,
    })

    await stitchPersons(store, { now: NOW })

    // noreply email should NOT trigger a merge
    const noreply = await store.findIdentityByExternalId(
      'commit_email',
      '999002+devuser@users.noreply.github.com',
    )
    expect(noreply?.personId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. Queue API — confirm / reject / unmerge
// ---------------------------------------------------------------------------

describe('CandidateMatch queue API', () => {
  it('confirmCandidateMatch merges identities and is audited', async () => {
    const store = freshStore()

    // Create two identities and a person for one
    await store.upsertPerson({
      id: 'person-a',
      displayName: 'Dev A',
      primaryAccountRef: 'gh:200001',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'github_login:dev-a',
      personId: 'person-a',
      kind: 'github_login',
      externalId: 'dev-a',
      isBot: false,
      confidence: 1,
      raw: '{"login":"dev-a","id":200001}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:dev-a@old.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'dev-a@old.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"dev-a@old.com"}',
      updatedAt: NOW,
    })

    // Manually add a candidate match
    await store.appendCandidateMatch({
      id: 'match-001',
      identityIdA: 'github_login:dev-a',
      identityIdB: 'commit_email:dev-a@old.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    // Confirm the match
    await confirmCandidateMatch(store, 'match-001', 'alice', NOW)

    // The match should now be confirmed
    const match = await store.getCandidateMatch('match-001')
    expect(match?.status).toBe('confirmed')
    expect(match?.decidedBy).toBe('alice')
    expect(match?.decidedAt).toBe(NOW)

    // identityB should now link to the same person as identityA
    const identityB = await store.findIdentityByExternalId('commit_email', 'dev-a@old.com')
    expect(identityB?.personId).toBe('person-a')
  })

  it('rejectCandidateMatch marks the entry as rejected without merging', async () => {
    const store = freshStore()

    await store.upsertIdentity({
      id: 'commit_email:foo@a.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'foo@a.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"foo@a.com"}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:foo@b.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'foo@b.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"foo@b.com"}',
      updatedAt: NOW,
    })

    await store.appendCandidateMatch({
      id: 'match-002',
      identityIdA: 'commit_email:foo@a.com',
      identityIdB: 'commit_email:foo@b.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    await rejectCandidateMatch(store, 'match-002', 'bob', NOW)

    const match = await store.getCandidateMatch('match-002')
    expect(match?.status).toBe('rejected')

    // Neither identity should be merged
    const fooA = await store.findIdentityByExternalId('commit_email', 'foo@a.com')
    const fooB = await store.findIdentityByExternalId('commit_email', 'foo@b.com')
    expect(fooA?.personId).toBeNull()
    expect(fooB?.personId).toBeNull()
  })

  it('unmergeIdentities is non-destructive — personId set to null on secondary identity', async () => {
    const store = freshStore()

    await store.upsertPerson({
      id: 'person-x',
      displayName: 'Dev X',
      primaryAccountRef: 'gh:300001',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'github_login:dev-x',
      personId: 'person-x',
      kind: 'github_login',
      externalId: 'dev-x',
      isBot: false,
      confidence: 1,
      raw: '{"login":"dev-x","id":300001}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:dev-x@old.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'dev-x@old.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"dev-x@old.com"}',
      updatedAt: NOW,
    })

    // Confirm a match to merge them
    await store.appendCandidateMatch({
      id: 'match-003',
      identityIdA: 'github_login:dev-x',
      identityIdB: 'commit_email:dev-x@old.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await confirmCandidateMatch(store, 'match-003', 'admin', NOW)

    // Verify merged
    const merged = await store.findIdentityByExternalId('commit_email', 'dev-x@old.com')
    expect(merged?.personId).toBe('person-x')

    // Now un-merge
    await unmergeIdentities(store, 'match-003', NOW)

    // Secondary identity should have person_id set back to null
    const unmerged = await store.findIdentityByExternalId('commit_email', 'dev-x@old.com')
    expect(unmerged?.personId).toBeNull()

    // Primary identity still has its person
    const primary = await store.findIdentityByExternalId('github_login', 'dev-x')
    expect(primary?.personId).toBe('person-x')

    // The candidate match record is NOT deleted (audit trail preserved)
    const matchRecord = await store.getCandidateMatch('match-003')
    expect(matchRecord).not.toBeNull()
    expect(matchRecord?.status).toBe('confirmed')
  })

  it('listCandidateMatches filters by status', async () => {
    const store = freshStore()

    await store.upsertIdentity({
      id: 'commit_email:p@a.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'p@a.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"p@a.com"}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:p@b.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'p@b.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"p@b.com"}',
      updatedAt: NOW,
    })

    await store.appendCandidateMatch({
      id: 'match-004',
      identityIdA: 'commit_email:p@a.com',
      identityIdB: 'commit_email:p@b.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const pending = await listCandidateMatches(store, { status: 'pending' })
    expect(pending).toHaveLength(1)

    const confirmed = await listCandidateMatches(store, { status: 'confirmed' })
    expect(confirmed).toHaveLength(0)

    const all = await store.getCandidateMatches()
    expect(all).toHaveLength(1)
  })

  it('appendCandidateMatch deduplicates by ordered pair + reason', async () => {
    const store = freshStore()

    await store.upsertIdentity({
      id: 'commit_email:dup@a.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'dup@a.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"dup@a.com"}',
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'commit_email:dup@b.com',
      personId: null,
      kind: 'commit_email',
      externalId: 'dup@b.com',
      isBot: false,
      confidence: 1,
      raw: '{"email":"dup@b.com"}',
      updatedAt: NOW,
    })

    // Insert same pair twice (also with reversed order)
    await store.appendCandidateMatch({
      id: 'match-dup-1',
      identityIdA: 'commit_email:dup@a.com',
      identityIdB: 'commit_email:dup@b.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.appendCandidateMatch({
      id: 'match-dup-2',
      identityIdA: 'commit_email:dup@b.com',
      identityIdB: 'commit_email:dup@a.com',
      reason: 'local_part_name',
      confidence: 0.8,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const all = await store.getCandidateMatches()
    // Only one row should exist (deduped by ordered pair + reason)
    expect(all).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 8. Integration: full pipeline on baseOrg
// ---------------------------------------------------------------------------

describe('full pipeline integration', () => {
  it('no NULL author_identity_id on commits after seedStore (already set by ingest)', async () => {
    const store = freshStore()
    await seedStore(store)

    // author_identity_id is set during ingest (not part of the resolution pass)
    const commits = await store.getCommitsByRepo(IDS.repoAlpha)
    for (const commit of commits) {
      expect(commit.authorIdentityId).not.toBeNull()
      expect(commit.authorIdentityId).not.toBe('')
    }
  })

  it('running all three passes in sequence populates the store correctly', async () => {
    const store = freshStore()
    await seedStore(store)

    await resolveIdentities(store, { now: NOW })
    await parseCommitAuthors(store, { now: NOW })
    await stitchPersons(store, { now: NOW })

    // Persons alice, bob, carol should exist (seeded before stitching)
    const alice = await store.getPerson(IDS.personAlice)
    expect(alice).not.toBeNull()

    // Bot (dependabot) should have no person
    const botIdentity = await store.findIdentityByExternalId('github_login', 'dependabot[bot]')
    expect(botIdentity?.personId).toBeNull()

    // Jira identities should now exist
    const aliceJira = await store.findIdentityByExternalId('jira_account', 'jira-account-alice')
    expect(aliceJira).not.toBeNull()

    // Issues should have assignee links
    const epic = await store.getIssue(IDS.issueEpic1)
    expect(epic?.assigneeIdentityId).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Audit regressions: scheme unification, bot classification, resolve enrichment, Tier 2c
// ---------------------------------------------------------------------------

describe('identity audit regressions', () => {
  it('isGitHubBot does NOT flag an Organization account as a bot', () => {
    expect(isGitHubBot('acme-eng', 'Organization')).toBe(false)
    expect(isGitHubBot('dependabot[bot]', 'Bot')).toBe(true)
    expect(isGitHubBot('renovate', 'User')).toBe(true) // known-bot list still applies
  })

  it('buildIdentityId uses the single canonical scheme', () => {
    expect(buildIdentityId('github_login', 'octocat')).toBe('github_login:octocat')
  })

  it('resolveIdentities enriches a github_login identity raw with numeric id + GitHub-verified email', async () => {
    const store = freshStore()
    await store.upsertOrganisation({
      id: 'org-1',
      githubLogin: 'acme',
      jiraCloudId: null,
      name: 'Acme',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertRepository({
      id: 'repo-1',
      githubNodeId: 'node-1',
      orgId: 'org-1',
      owner: 'acme',
      name: 'app',
      defaultBranch: 'main',
      isArchived: false,
      isFork: false,
      deletedAt: null,
      raw: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Pre-create the author identity (FK) and the commit with a rich raw payload.
    await store.upsertIdentity({
      id: buildIdentityId('github_login', 'octocat'),
      personId: null,
      kind: 'github_login',
      externalId: 'octocat',
      isBot: false,
      confidence: 1,
      raw: '{"login":"octocat"}',
      updatedAt: NOW,
    })
    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'sha1',
      authorIdentityId: buildIdentityId('github_login', 'octocat'),
      authoredAt: NOW,
      committedAt: NOW,
      additions: 1,
      deletions: 0,
      haloc: 1,
      raw: JSON.stringify({
        sha: 'sha1',
        author: { login: 'octocat', id: 583231, type: 'User' },
        commit: { author: { email: 'octocat@github.com', name: 'The Octocat' } },
      }),
      createdAt: NOW,
      updatedAt: '2024-06-02T00:00:00.000Z',
    })

    await resolveIdentities(store, { now: '2024-06-03T00:00:00.000Z' })

    const ident = await store.findIdentityByExternalId('github_login', 'octocat')
    const raw = JSON.parse(ident?.raw ?? '{}')
    expect(raw.id).toBe(583231)
    expect(raw.email).toBe('octocat@github.com')
  })

  it('stitch Tier 2c queues two unlinked same-local-part commit_email identities', async () => {
    const store = freshStore()
    // Both unlinked (personId null) — the real-pipeline case the fix targets.
    for (const domain of ['acme.com', 'vendor.com']) {
      await store.upsertIdentity({
        id: `commit_email:jane.doe@${domain}`,
        personId: null,
        kind: 'commit_email',
        externalId: `jane.doe@${domain}`,
        isBot: false,
        confidence: 1,
        raw: `{"email":"jane.doe@${domain}"}`,
        updatedAt: NOW,
      })
    }

    await stitchPersons(store, { now: NOW })

    const queue = await listCandidateMatches(store, { status: 'pending' })
    const match = queue.find((m) => m.reason === 'local_part_name')
    expect(match).toBeDefined()
  })
})
