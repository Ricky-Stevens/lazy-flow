/**
 * Cross-source identity stitching (GitHub ↔ Jira) — stitchCrossSource.
 *
 * Proves the three signals resolve real people that the email-only base ladder
 * leaves split, WITHOUT false-merging distinct people:
 *   - Alex: NO Jira email → merged via name (handle/email ↔ displayName) +
 *     corroborating behavioural co-occurrence (his PRs link to his tickets).
 *   - Ricky: Jira email present → merged via deterministic email match.
 *   - Sam: weak/non-dominant behavioural overlap + no name match → NOT merged.
 *   - Idempotent: a second pass merges nothing (already paired).
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { migrate } from '../migrate/runner.js'
import { BunSqliteStore } from '../store/BunSqliteStore.js'
import { stitchCrossSource } from './crossSource.js'
import { buildIdentityId } from './resolve.js'

const NOW = '2026-06-01T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

async function seedScaffold(store) {
  await store.upsertOrganisation({
    id: 'org-1',
    githubLogin: 'acme',
    jiraCloudId: 'cloud-1',
    name: 'Acme',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertRepository({
    id: 'repo-1',
    githubNodeId: 'n1',
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
  await store.upsertJiraProject({
    id: 'proj-1',
    key: 'BP',
    name: 'Backend',
    jiraCloudId: 'cloud-1',
    raw: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function addPerson(store, id, displayName, accountRef) {
  await store.upsertPerson({ id, displayName, primaryAccountRef: accountRef, updatedAt: NOW })
}

async function addIdentity(store, personId, kind, externalId, raw) {
  await store.upsertIdentity({
    id: buildIdentityId(kind, externalId),
    personId,
    kind,
    externalId,
    isBot: false,
    confidence: 1,
    raw,
    updatedAt: NOW,
  })
}

async function addPr(store, id, authorIdentityId) {
  await store.upsertPullRequest({
    id,
    repoId: 'repo-1',
    number: Number(id.replace(/\D/g, '')) || 1,
    authorIdentityId,
    state: 'merged',
    headRef: 'feature',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: NOW,
    readyAt: null,
    firstCommitAt: null,
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: NOW,
    mergedByIdentityId: null,
    deletedAt: null,
    raw: '{}',
    updatedAt: NOW,
  })
}

async function addIssue(store, id, assigneeIdentityId) {
  await store.upsertIssue({
    id,
    projectId: 'proj-1',
    key: `BP-${id.replace(/\D/g, '')}`,
    type: 'Task',
    statusId: '1',
    statusCategory: 'done',
    storyPoints: null,
    storyPointsFieldId: null,
    storyPointsRaw: null,
    parentId: null,
    epicKey: null,
    isSubtask: false,
    hierarchyLevel: 0,
    assigneeIdentityId,
    createdAt: NOW,
    resolvedAt: null,
    deletedAt: null,
    raw: '{}',
    updatedAt: NOW,
  })
}

async function link(store, prId, issueId) {
  await store.upsertPrIssueLink({ prId, issueId, linkSource: 'regex', confidence: 1.0 })
}

/** Seed Alex (name+behavioural), Ricky (email), Sam (noise). */
async function seedTeam(store) {
  await seedScaffold(store)

  // --- Alex: GitHub person (no jira email on the Jira side) ---
  await addPerson(store, 'p-alex-gh', 'alex-barnes-IPH', 'gh:111')
  await addIdentity(
    store,
    'p-alex-gh',
    'github_login',
    'alex-barnes-IPH',
    '{"login":"alex-barnes-IPH","type":"User","id":111}',
  )
  await addIdentity(
    store,
    'p-alex-gh',
    'commit_email',
    'alex.barnes@ip-house.com',
    '{"email":"alex.barnes@ip-house.com"}',
  )
  await addPerson(store, 'p-alex-jira', 'jira-alex', 'jira:jira-alex')
  await addIdentity(
    store,
    'p-alex-jira',
    'jira_account',
    'jira-alex',
    '{"accountId":"jira-alex","displayName":"Alex Barnes"}',
  )

  // --- Ricky: Jira email present → email match ---
  await addPerson(store, 'p-ricky-gh', 'ricky-iph', 'gh:222')
  await addIdentity(
    store,
    'p-ricky-gh',
    'github_login',
    'ricky-iph',
    '{"login":"ricky-iph","type":"User","id":222,"email":"ricky.stevens@ip-house.com"}',
  )
  await addIdentity(
    store,
    'p-ricky-gh',
    'commit_email',
    'ricky.stevens@ip-house.com',
    '{"email":"ricky.stevens@ip-house.com"}',
  )
  await addPerson(store, 'p-ricky-jira', 'jira-ricky', 'jira:jira-ricky')
  await addIdentity(
    store,
    'p-ricky-jira',
    'jira_account',
    'jira-ricky',
    '{"accountId":"jira-ricky","displayName":"Ricky Stevens","emailAddress":"ricky.stevens@ip-house.com"}',
  )

  // --- Sam: a Jira-only person, distinct name, only weak behavioural overlap ---
  await addPerson(store, 'p-sam-jira', 'jira-sam', 'jira:jira-sam')
  await addIdentity(
    store,
    'p-sam-jira',
    'jira_account',
    'jira-sam',
    '{"accountId":"jira-sam","displayName":"Sam Carter"}',
  )

  // Alex authors 5 PRs, each linked to a ticket assigned to Alex (jira-alex),
  // plus ONE PR that touches a ticket assigned to Sam (noise: 1 of 6).
  for (let i = 1; i <= 5; i++) {
    await addPr(store, `pr-alex-${i}`, buildIdentityId('github_login', 'alex-barnes-IPH'))
    await addIssue(store, `iss-alex-${i}`, buildIdentityId('jira_account', 'jira-alex'))
    await link(store, `pr-alex-${i}`, `iss-alex-${i}`)
  }
  await addIssue(store, 'iss-sam-1', buildIdentityId('jira_account', 'jira-sam'))
  await link(store, 'pr-alex-1', 'iss-sam-1') // Alex↔Sam co-occurrence = 1 (below threshold)
}

async function personIdOfIdentity(store, identityId) {
  const all = await store.listAllIdentities()
  return all.find((i) => i.id === identityId)?.personId ?? null
}

describe('stitchCrossSource', () => {
  it('merges Alex via name + behavioural (no Jira email) and names the person', async () => {
    const store = freshStore()
    await seedTeam(store)

    const res = await stitchCrossSource(store, { now: NOW })
    expect(res.autoMerged).toBeGreaterThanOrEqual(1)

    // Jira "Alex Barnes" now resolves to Alex's GitHub person.
    const jiraAlexPerson = await personIdOfIdentity(
      store,
      buildIdentityId('jira_account', 'jira-alex'),
    )
    expect(jiraAlexPerson).toBe('p-alex-gh')

    // The canonical person is renamed to the human display name.
    const person = await store.getPerson('p-alex-gh')
    expect(person?.displayName).toBe('Alex Barnes')
  })

  it('merges Ricky via deterministic email match', async () => {
    const store = freshStore()
    await seedTeam(store)
    await stitchCrossSource(store, { now: NOW })

    const jiraRickyPerson = await personIdOfIdentity(
      store,
      buildIdentityId('jira_account', 'jira-ricky'),
    )
    expect(jiraRickyPerson).toBe('p-ricky-gh')
  })

  it('does NOT false-merge Sam (weak behavioural, no name/email match)', async () => {
    const store = freshStore()
    await seedTeam(store)
    await stitchCrossSource(store, { now: NOW })

    // Sam stays his own Jira-only person — not pulled into Alex (or anyone).
    const jiraSamPerson = await personIdOfIdentity(
      store,
      buildIdentityId('jira_account', 'jira-sam'),
    )
    expect(jiraSamPerson).toBe('p-sam-jira')
  })

  it('is idempotent — a second pass merges nothing new', async () => {
    const store = freshStore()
    await seedTeam(store)
    const first = await stitchCrossSource(store, { now: NOW })
    expect(first.autoMerged).toBeGreaterThanOrEqual(2) // Alex + Ricky

    const second = await stitchCrossSource(store, { now: NOW })
    expect(second.autoMerged).toBe(0)
    expect(second.queued).toBe(0)
  })

  it('respects a prior rejection — a rejected pair is never re-merged', async () => {
    const store = freshStore()
    await seedScaffold(store)
    // Alex GitHub + Jira, with a name match that would otherwise auto-merge via
    // behaviour — but pre-record a REJECTED candidate for the pair.
    await addPerson(store, 'p-alex-gh', 'alex-barnes-IPH', 'gh:111')
    await addIdentity(
      store,
      'p-alex-gh',
      'github_login',
      'alex-barnes-IPH',
      '{"login":"alex-barnes-IPH","id":111}',
    )
    await addPerson(store, 'p-alex-jira', 'jira-alex', 'jira:jira-alex')
    await addIdentity(
      store,
      'p-alex-jira',
      'jira_account',
      'jira-alex',
      '{"accountId":"jira-alex","displayName":"Alex Barnes"}',
    )
    for (let i = 1; i <= 5; i++) {
      await addPr(store, `pr-alex-${i}`, buildIdentityId('github_login', 'alex-barnes-IPH'))
      await addIssue(store, `iss-alex-${i}`, buildIdentityId('jira_account', 'jira-alex'))
      await link(store, `pr-alex-${i}`, `iss-alex-${i}`)
    }
    await store.appendCandidateMatch({
      id: 'cm-rejected',
      identityIdA: buildIdentityId('github_login', 'alex-barnes-IPH'),
      identityIdB: buildIdentityId('jira_account', 'jira-alex'),
      reason: 'xsrc_name',
      confidence: 0.6,
      status: 'rejected',
      decidedAt: NOW,
      decidedBy: 'human',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const res = await stitchCrossSource(store, { now: NOW })
    expect(res.autoMerged).toBe(0)
    const jiraAlexPerson = await personIdOfIdentity(
      store,
      buildIdentityId('jira_account', 'jira-alex'),
    )
    expect(jiraAlexPerson).toBe('p-alex-jira') // still separate
  })
})
