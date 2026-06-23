/**
 * Tests for BunSqliteStore and the migration runner.
 *
 * All tests use :memory: databases — no disk cleanup required.
 * Tests cover:
 *  - Schema applies cleanly to a fresh :memory: DB
 *  - Round-trip upsert→get for key tables (commits with composite PK,
 *    pull_requests, issues, issue_transitions, metric_snapshots)
 *  - Idempotent upsert (insert twice = one row)
 *  - Out-of-order convergence (older updated_at does NOT overwrite newer)
 *  - Soft-delete excluded from reads
 *  - migrate up → down → up round-trip leaves a consistent schema
 *  - appendIssueTransitions is append-only (INSERT OR IGNORE)
 *  - getFlowStateModel is effective-dated (returns the version in effect at 'at')
 *  - resolveIssueKey handles historical key resolution
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { currentVersion, MIGRATIONS, migrate } from '../migrate/runner.js'
import { BunSqliteStore } from './BunSqliteStore.js'

/**
 * The highest migration VERSION in the current migration set. Derived from the
 * actual version numbers (not array length) so a reserved gap — e.g. version 7,
 * held for a concurrently-developed work-stream — does not desync this assertion
 * from `currentVersion`, which returns MAX(version).
 */
const MAX_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemoryDb() {
  return new Database(':memory:')
}

function _freshStore() {
  const db = openMemoryDb()
  migrate(db, 'up')
  return new BunSqliteStore(':memory:')
}

/** Create a store backed by a shared already-migrated Database. */
function storeOnDb(db) {
  // BunSqliteStore opens its own connection; for in-memory we need the same
  // db handle, so we use a workaround: open the store as :memory: and replace
  // the internal db with the provided one.
  const store = new BunSqliteStore(':memory:')
  // Close the newly opened empty db and substitute the pre-migrated one.
  store.db.close()
  // TypeScript: we cast to allow replacing the readonly db for testing.
  store.db = db
  return store
}

function migratedStore() {
  const db = openMemoryDb()
  migrate(db, 'up')
  const store = storeOnDb(db)
  return { db, store }
}

const T1 = '2024-01-01T00:00:00.000Z'
const T2 = '2024-01-02T00:00:00.000Z'
const T3 = '2024-01-03T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

describe('migrate', () => {
  it('applies all migrations to a fresh :memory: DB', () => {
    const db = openMemoryDb()
    expect(() => migrate(db, 'up')).not.toThrow()
    expect(currentVersion(db)).toBe(MAX_VERSION)
  })

  it('is idempotent — running up twice does not error', () => {
    const db = openMemoryDb()
    migrate(db, 'up')
    expect(() => migrate(db, 'up')).not.toThrow()
    expect(currentVersion(db)).toBe(MAX_VERSION)
  })

  it('up → down → up round-trip leaves version at MAX_VERSION', () => {
    const db = openMemoryDb()
    // Temporarily allow down migrations for the test
    process.env.LAZYFLOW_ALLOW_DOWN_MIGRATIONS = '1'
    try {
      migrate(db, 'up')
      expect(currentVersion(db)).toBe(MAX_VERSION)

      migrate(db, 'down')
      expect(currentVersion(db)).toBe(0)

      migrate(db, 'up')
      expect(currentVersion(db)).toBe(MAX_VERSION)
    } finally {
      delete process.env.LAZYFLOW_ALLOW_DOWN_MIGRATIONS
    }
  })

  it('down is blocked without the env flag', () => {
    const db = openMemoryDb()
    migrate(db, 'up')
    expect(() => migrate(db, 'down')).toThrow(/disabled in production/)
  })

  it('schema creates all expected tables after migration', () => {
    const db = openMemoryDb()
    migrate(db, 'up')
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name)

    const expected = [
      'ai_verdicts',
      'board_columns',
      'board_configs',
      'check_runs',
      'commit_authors',
      'commits',
      'deployments',
      'flow_state_models',
      'identities',
      'issue_keys',
      'issue_transitions',
      'issues',
      'jira_projects',
      'metric_snapshots',
      'organisations',
      'persons',
      'pr_issue_links',
      'pull_requests',
      'repositories',
      'review_comments',
      'reviews',
      'schema_version',
      'sprint_membership_events',
      'sprints',
      'status_category_history',
      'sync_state',
      'team_membership',
      'teams',
      'workflow_scheme_mappings',
      'workflows',
    ]
    for (const t of expected) {
      expect(tables).toContain(t)
    }
  })
})

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

async function seedOrg(store, id = 'org-1') {
  await store.upsertOrganisation({
    id,
    githubLogin: 'acme',
    jiraCloudId: null,
    name: 'Acme',
    createdAt: T1,
    updatedAt: T1,
  })
}

async function seedIdentity(store, id = 'ident-1') {
  await store.upsertIdentity({
    id,
    personId: null,
    kind: 'github_login',
    externalId: 'alice',
    isBot: false,
    confidence: 1,
    raw: '{}',
    updatedAt: T1,
  })
}

async function seedRepo(store, id = 'repo-1') {
  await seedOrg(store)
  await store.upsertRepository({
    id,
    githubNodeId: `node-${id}`,
    orgId: 'org-1',
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    isArchived: false,
    isFork: false,
    deletedAt: null,
    raw: '{}',
    createdAt: T1,
    updatedAt: T1,
  })
}

async function seedJiraProject(store, id = 'proj-1') {
  await store.upsertJiraProject({
    id,
    key: 'ENG',
    name: 'Engineering',
    jiraCloudId: 'cloud-1',
    raw: '{}',
    createdAt: T1,
    updatedAt: T1,
  })
}

// ---------------------------------------------------------------------------
// Identities — person_id ownership / idempotency (run_sync re-run regression)
// ---------------------------------------------------------------------------

describe('identities — person_id ownership', () => {
  it('re-upserting an identity with a NULL person_id does NOT clobber the assignment', async () => {
    // Regression: ingestion (resolveIdentities) re-upserts every identity with
    // person_id=null and a fresh updated_at on each sync. The old conflict clause
    // overwrote person_id with that null, detaching every identity from its person
    // and making the next stitch pass re-mint orphaned persons — the run_sync
    // re-run identity-graph corruption.
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'person-1',
      displayName: 'Alice',
      primaryAccountRef: 'gh:alice',
      updatedAt: T1,
    })
    await store.upsertIdentity({
      id: 'ident-1',
      personId: null,
      kind: 'github_login',
      externalId: 'alice',
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: T1,
    })
    // Stitch assigns the person.
    await store.setIdentityPerson('ident-1', 'person-1', T2)

    // Ingestion re-upserts the SAME identity with person_id null + a NEWER ts.
    await store.upsertIdentity({
      id: 'ident-1',
      personId: null,
      kind: 'github_login',
      externalId: 'alice',
      isBot: false,
      confidence: 1,
      raw: '{"refreshed":true}',
      updatedAt: T3,
    })

    const assigned = await store.getIdentitiesByPerson('person-1')
    expect(assigned).toHaveLength(1)
    expect(assigned[0]?.id).toBe('ident-1')
    // The newer non-person fields still refreshed (raw updated) — only person_id
    // is preserved.
    expect(assigned[0]?.raw).toContain('refreshed')
  })

  it('setIdentityPerson can both assign and detach (null) a person link', async () => {
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'person-1',
      displayName: 'Alice',
      primaryAccountRef: 'gh:alice',
      updatedAt: T1,
    })
    await seedIdentity(store)
    await store.setIdentityPerson('ident-1', 'person-1', T2)
    expect(await store.getIdentitiesByPerson('person-1')).toHaveLength(1)
    // Detach (the unmerge path).
    await store.setIdentityPerson('ident-1', null, T3)
    expect(await store.getIdentitiesByPerson('person-1')).toHaveLength(0)
  })

  it('deleteOrphanPersons removes only persons with zero identities', async () => {
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'p-live',
      displayName: 'Live',
      primaryAccountRef: 'gh:a',
      updatedAt: T1,
    })
    await store.upsertPerson({
      id: 'p-orphan',
      displayName: 'Orphan',
      primaryAccountRef: 'gh:b',
      updatedAt: T1,
    })
    await seedIdentity(store)
    await store.setIdentityPerson('ident-1', 'p-live', T2)

    const removed = await store.deleteOrphanPersons()
    expect(removed).toBe(1)
    expect(await store.getPerson('p-live')).not.toBeNull()
    expect(await store.getPerson('p-orphan')).toBeNull()
  })

  it('deleteOrphanPersons does NOT delete (or FK-violate on) a team-referenced person', async () => {
    // team_membership.person_id is a NOT NULL FK to persons(id) with no cascade.
    // A zero-identity person still on a team must be retained, not deleted (which
    // would raise a FK violation and abort the GC).
    const { store } = migratedStore()
    await seedOrg(store)
    await store.upsertTeam({ id: 'team-1', name: 'Squad', orgId: 'org-1', updatedAt: T1 })
    await store.upsertPerson({
      id: 'p-team',
      displayName: 'On A Team',
      primaryAccountRef: 'gh:c',
      updatedAt: T1,
    })
    await store.upsertTeamMembership({
      teamId: 'team-1',
      personId: 'p-team',
      validFrom: T1,
      validTo: null,
    })

    // Zero-identity but team-referenced → must survive, and the GC must not throw.
    const removed = await store.deleteOrphanPersons()
    expect(removed).toBe(0)
    expect(await store.getPerson('p-team')).not.toBeNull()
  })

  it('setPersonDisplayName relabels a person and bumps updated_at', async () => {
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'p-elliott',
      displayName: 'eingramiph',
      primaryAccountRef: 'gh:eingramiph',
      updatedAt: T1,
    })

    await store.setPersonDisplayName('p-elliott', 'Elliott Ingram', T2)

    const after = await store.getPerson('p-elliott')
    expect(after?.displayName).toBe('Elliott Ingram')
    expect(after?.updatedAt).toBe(T2)
  })

  it('setPersonDisplayName throws on an unknown person id (no silent no-op)', async () => {
    const { store } = migratedStore()
    await expect(store.setPersonDisplayName('p-nope', 'Whoever', T1)).rejects.toThrow(
      /person not found/,
    )
  })

  it('setIdentityBot marks a human identity as a bot AND detaches it from its person', async () => {
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'p-auto',
      displayName: 'Automation',
      primaryAccountRef: 'jira:auto',
      updatedAt: T1,
    })
    await seedIdentity(store)
    await store.setIdentityPerson('ident-1', 'p-auto', T1)

    await store.setIdentityBot('ident-1', true, T2)

    const after = await store.findIdentityById('ident-1')
    expect(after?.isBot).toBe(true)
    expect(after?.personId).toBeNull() // detached
    expect(after?.updatedAt).toBe(T2)
  })

  it('setIdentityBot back to human clears the flag and leaves person_id untouched', async () => {
    const { store } = migratedStore()
    await seedIdentity(store)
    await store.upsertIdentity({
      id: 'ident-1',
      personId: null,
      kind: 'github_login',
      externalId: 'alice',
      isBot: true,
      confidence: 1,
      raw: '{}',
      updatedAt: T1,
    })

    await store.setIdentityBot('ident-1', false, T2)
    expect((await store.findIdentityById('ident-1'))?.isBot).toBe(false)
  })

  it('setIdentityBot throws on an unknown identity id (no silent no-op)', async () => {
    const { store } = migratedStore()
    await expect(store.setIdentityBot('nope', true, T1)).rejects.toThrow(/identity not found/)
  })

  it("identity_audit accepts a 'rename' action (migration 0003 applied)", async () => {
    // Regression: identity_audit's action CHECK only allowed the link/merge actions
    // until 0003 widened it. A 'rename' row must now insert without a CHECK violation.
    const { store } = migratedStore()
    await store.upsertPerson({
      id: 'p-x',
      displayName: 'old',
      primaryAccountRef: 'gh:x',
      updatedAt: T1,
    })
    await store.appendIdentityAudit({
      id: 'audit-rename-1',
      action: 'rename',
      toPersonId: 'p-x',
      decidedBy: 'tester',
      note: '"old" -> "New Name"',
      createdAt: T1,
    })
    // Sanity: an invalid action is still rejected by the CHECK.
    await expect(
      store.appendIdentityAudit({
        id: 'audit-bad-1',
        action: 'not_a_real_action',
        toPersonId: 'p-x',
        decidedBy: 'tester',
        createdAt: T1,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Commits (composite PK)
// ---------------------------------------------------------------------------

describe('commits — composite PK (repo_id, sha)', () => {
  it('round-trips a commit via upsert→getCommitsByRepo', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'abc123',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 10,
      deletions: 2,
      haloc: 10,
      raw: '{}',
      createdAt: T1,
      updatedAt: T1,
    })

    const commits = await store.getCommitsByRepo('repo-1')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.sha).toBe('abc123')
    expect(commits[0]?.haloc).toBe(10)
    expect(commits[0]?.repoId).toBe('repo-1')
  })

  it('idempotent upsert — inserting same (repo_id, sha) twice yields one row', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    const commit = {
      repoId: 'repo-1',
      sha: 'abc123',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 10,
      deletions: 2,
      haloc: 10,
      raw: '{}',
      createdAt: T1,
      updatedAt: T1,
    }
    await store.upsertCommit(commit)
    await store.upsertCommit(commit)

    const commits = await store.getCommitsByRepo('repo-1')
    expect(commits).toHaveLength(1)
  })

  it('out-of-order convergence — older updated_at does not overwrite newer', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    // Insert newer version first
    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'abc123',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 99,
      deletions: 0,
      haloc: 99,
      raw: '{"newer": true}',
      createdAt: T1,
      updatedAt: T2, // newer
    })

    // Try to overwrite with older updated_at
    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'abc123',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 1,
      deletions: 0,
      haloc: 1,
      raw: '{"older": true}',
      createdAt: T1,
      updatedAt: T1, // older — should NOT win
    })

    const commits = await store.getCommitsByRepo('repo-1')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.haloc).toBe(99) // newer value preserved
    expect(commits[0]?.raw).toBe('{"newer": true}')
  })

  it('SHAs that collide across repos do not interfere (composite PK isolation)', async () => {
    const { store } = migratedStore()
    await seedOrg(store)
    await seedIdentity(store)

    // Two repos, same SHA
    await store.upsertRepository({
      id: 'repo-a',
      githubNodeId: 'node-repo-a',
      orgId: 'org-1',
      owner: 'acme',
      name: 'app-a',
      defaultBranch: 'main',
      isArchived: false,
      isFork: false,
      deletedAt: null,
      raw: '{}',
      createdAt: T1,
      updatedAt: T1,
    })
    await store.upsertRepository({
      id: 'repo-b',
      githubNodeId: 'node-repo-b',
      orgId: 'org-1',
      owner: 'acme',
      name: 'app-b',
      defaultBranch: 'main',
      isArchived: false,
      isFork: false,
      deletedAt: null,
      raw: '{}',
      createdAt: T1,
      updatedAt: T1,
    })

    await store.upsertCommit({
      repoId: 'repo-a',
      sha: 'deadbeef',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 5,
      deletions: 0,
      haloc: 5,
      raw: '{"repo": "a"}',
      createdAt: T1,
      updatedAt: T1,
    })
    await store.upsertCommit({
      repoId: 'repo-b',
      sha: 'deadbeef',
      authorIdentityId: 'ident-1',
      authoredAt: T1,
      committedAt: T1,
      additions: 7,
      deletions: 0,
      haloc: 7,
      raw: '{"repo": "b"}',
      createdAt: T1,
      updatedAt: T1,
    })

    const aCommits = await store.getCommitsByRepo('repo-a')
    const bCommits = await store.getCommitsByRepo('repo-b')
    expect(aCommits).toHaveLength(1)
    expect(bCommits).toHaveLength(1)
    expect(aCommits[0]?.haloc).toBe(5)
    expect(bCommits[0]?.haloc).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

describe('pull_requests', () => {
  it('round-trips a pull request via upsert→getPullRequest', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    const pr = {
      id: 'pr-1',
      repoId: 'repo-1',
      number: 42,
      authorIdentityId: 'ident-1',
      state: 'open',
      headRef: 'feature/foo',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: T1,
      readyAt: null,
      firstCommitAt: T1,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: null,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    }

    await store.upsertPullRequest(pr)
    const got = await store.getPullRequest('pr-1')
    expect(got).not.toBeNull()
    expect(got?.number).toBe(42)
    expect(got?.headRef).toBe('feature/foo')
    expect(got?.isDraft).toBe(false)
  })

  it('soft-delete excludes PR from reads', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    await store.upsertPullRequest({
      id: 'pr-del',
      repoId: 'repo-1',
      number: 1,
      authorIdentityId: 'ident-1',
      state: 'open',
      headRef: 'feat',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: T1,
      readyAt: null,
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: null,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    // Verify it exists
    expect(await store.getPullRequest('pr-del')).not.toBeNull()

    await store.softDelete('pull_requests', 'pr-del')

    // After soft-delete it must not appear in reads
    expect(await store.getPullRequest('pr-del')).toBeNull()
    const prs = await store.getPullRequestsByRepo('repo-1')
    expect(prs).toHaveLength(0)
  })

  it('idempotent upsert — inserting same PR twice yields one row', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)

    const pr = {
      id: 'pr-idem',
      repoId: 'repo-1',
      number: 99,
      authorIdentityId: 'ident-1',
      state: 'open',
      headRef: 'x',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: T1,
      readyAt: null,
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: null,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    }
    await store.upsertPullRequest(pr)
    await store.upsertPullRequest(pr)

    const prs = await store.getPullRequestsByRepo('repo-1')
    expect(prs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// PR files (per-file diffs)
// ---------------------------------------------------------------------------

describe('patch-backfill candidate filtering (excludeBots)', () => {
  // A bot-authored PR's patch-less files must be droppable from the backfill
  // work-set AND the pending count (so `remaining` can reach 0), while a
  // human/unknown author's files are kept.
  async function seedPrWithAuthor(store, prId, repoId, authorId) {
    await store.upsertPullRequest({
      id: prId,
      repoId,
      number: Number(prId.replace(/\D/g, '')) || 1,
      authorIdentityId: authorId,
      state: 'merged',
      headRef: 'feat',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: T1,
      readyAt: null,
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: T1,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })
    await store.upsertPrFile({
      prId,
      repoId,
      path: `${prId}.txt`,
      additions: 1,
      deletions: 0,
      haloc: 1,
      status: 'added',
      patch: null,
      createdAt: T1,
      updatedAt: T1,
    })
  }

  async function seedHumanAndBot(store) {
    await seedRepo(store)
    await seedIdentity(store, 'ident-human') // isBot: false
    await store.upsertIdentity({
      id: 'ident-bot',
      personId: null,
      kind: 'github_login',
      externalId: 'dependabot[bot]',
      isBot: true,
      confidence: 1,
      raw: '{}',
      updatedAt: T1,
    })
    await seedPrWithAuthor(store, 'pr-human', 'repo-1', 'ident-human')
    await seedPrWithAuthor(store, 'pr-bot', 'repo-1', 'ident-bot')
  }

  it('getPrFilesMissingPatchByRepo + count drop bot-authored files only when excludeBots', async () => {
    const { store } = migratedStore()
    await seedHumanAndBot(store)

    // Default: both files are pending.
    expect((await store.getPrFilesMissingPatchByRepo('repo-1', 100)).length).toBe(2)
    expect(await store.countPrFilesMissingPatchByRepo('repo-1')).toBe(2)

    // excludeBots: only the human file remains, and the count agrees with the work-set.
    const human = await store.getPrFilesMissingPatchByRepo('repo-1', 100, { excludeBots: true })
    expect(human.map((f) => f.path)).toEqual(['pr-human.txt'])
    expect(await store.countPrFilesMissingPatchByRepo('repo-1', { excludeBots: true })).toBe(1)
  })

  it('getRepoIdsWithMissingPatches drops a bot-only repo under excludeBots', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await store.upsertIdentity({
      id: 'ident-bot',
      personId: null,
      kind: 'github_login',
      externalId: 'renovate[bot]',
      isBot: true,
      confidence: 1,
      raw: '{}',
      updatedAt: T1,
    })
    await seedPrWithAuthor(store, 'pr-bot', 'repo-1', 'ident-bot')

    expect(await store.getRepoIdsWithMissingPatches()).toEqual(['repo-1'])
    // The repo's only patch-less files are bot-authored → no work under excludeBots.
    expect(await store.getRepoIdsWithMissingPatches({ excludeBots: true })).toEqual([])
  })

  it('countBotPrFilesMissingPatch tallies only bot-authored patch-less files', async () => {
    const { store } = migratedStore()
    await seedHumanAndBot(store)
    expect(await store.countBotPrFilesMissingPatch()).toBe(1)
  })
})

describe('pr_files', () => {
  async function seedPr(store, id, createdAt) {
    await store.upsertPullRequest({
      id,
      repoId: 'repo-1',
      number: Number(id.replace(/\D/g, '')) || 1,
      authorIdentityId: 'ident-1',
      state: 'merged',
      headRef: 'feat',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt,
      readyAt: null,
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: createdAt,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: createdAt,
    })
  }

  it('round-trips a PR file via upsert→getPrFilesByPullRequest', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)
    await seedPr(store, 'pr-1', T1)

    await store.upsertPrFile({
      prId: 'pr-1',
      repoId: 'repo-1',
      path: 'src/widget.ts',
      additions: 5,
      deletions: 2,
      haloc: 5,
      status: 'modified',
      patch: '@@ -1 +1,5 @@\n+a\n+b',
      createdAt: T1,
      updatedAt: T1,
    })

    const files = await store.getPrFilesByPullRequest('pr-1')
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f?.path).toBe('src/widget.ts')
    expect(f?.additions).toBe(5)
    expect(f?.deletions).toBe(2)
    expect(f?.haloc).toBe(5)
    expect(f?.patch).toBe('@@ -1 +1,5 @@\n+a\n+b')
  })

  it('preserves a null patch (binary/oversized file)', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)
    await seedPr(store, 'pr-1', T1)

    await store.upsertPrFile({
      prId: 'pr-1',
      repoId: 'repo-1',
      path: 'logo.png',
      additions: 0,
      deletions: 0,
      haloc: 0,
      status: 'modified',
      patch: null,
      createdAt: T1,
      updatedAt: T1,
    })

    const files = await store.getPrFilesByPullRequest('pr-1')
    expect(files[0]?.patch).toBeNull()
  })

  it('idempotent upsert on (pr_id, path) — second write updates, not duplicates', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)
    await seedPr(store, 'pr-1', T1)

    const base = {
      prId: 'pr-1',
      repoId: 'repo-1',
      path: 'a.ts',
      additions: 1,
      deletions: 0,
      haloc: 1,
      status: 'added',
      patch: '@@ -0,0 +1 @@\n+x',
      createdAt: T1,
      updatedAt: T1,
    }
    await store.upsertPrFile(base)
    await store.upsertPrFile({ ...base, additions: 9, haloc: 9, updatedAt: T2 })

    const files = await store.getPrFilesByPullRequest('pr-1')
    expect(files).toHaveLength(1)
    expect(files[0]?.additions).toBe(9)
    expect(files[0]?.haloc).toBe(9)
  })

  it('getPrFilesByRepo windows on the PR createdAt and excludes soft-deleted PRs', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await seedIdentity(store)
    // pr-early created at T1; pr-late created at T3.
    await seedPr(store, 'pr-early', T1)
    await seedPr(store, 'pr-late', T3)
    for (const prId of ['pr-early', 'pr-late']) {
      await store.upsertPrFile({
        prId,
        repoId: 'repo-1',
        path: `${prId}.ts`,
        additions: 3,
        deletions: 1,
        haloc: 3,
        status: 'added',
        patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c',
        createdAt: T1,
        updatedAt: T1,
      })
    }

    // Window [T1, T2] includes pr-early only.
    const windowed = await store.getPrFilesByRepo('repo-1', T1, T2)
    expect(windowed.map((f) => f.prId)).toEqual(['pr-early'])

    // Whole-repo read sees both.
    const all = await store.getPrFilesByRepo('repo-1')
    expect(all).toHaveLength(2)

    // Soft-deleting pr-late removes its files from the read.
    await store.softDelete('pull_requests', 'pr-late')
    const afterDelete = await store.getPrFilesByRepo('repo-1')
    expect(afterDelete.map((f) => f.prId)).toEqual(['pr-early'])
  })
})

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

describe('issues', () => {
  it('round-trips an issue via upsert→getIssue', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    await store.upsertIssue({
      id: 'issue-1',
      projectId: 'proj-1',
      key: 'ENG-1',
      type: 'Story',
      statusId: 'status-todo',
      statusCategory: 'new',
      storyPoints: 5,
      storyPointsFieldId: 'customfield_10016',
      storyPointsRaw: '5',
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    const got = await store.getIssue('issue-1')
    expect(got).not.toBeNull()
    expect(got?.key).toBe('ENG-1')
    expect(got?.storyPoints).toBe(5)
    expect(got?.isSubtask).toBe(false)
    expect(got?.hierarchyLevel).toBe(1)
  })

  it('soft-delete excludes issue from reads', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    await store.upsertIssue({
      id: 'issue-del',
      projectId: 'proj-1',
      key: 'ENG-99',
      type: 'Task',
      statusId: 'status-todo',
      statusCategory: 'new',
      storyPoints: null,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    expect(await store.getIssue('issue-del')).not.toBeNull()
    await store.softDelete('issues', 'issue-del')
    expect(await store.getIssue('issue-del')).toBeNull()
  })

  it('out-of-order convergence — older updated_at preserves newer story points', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    // Insert newer first
    await store.upsertIssue({
      id: 'issue-lw',
      projectId: 'proj-1',
      key: 'ENG-2',
      type: 'Story',
      statusId: 'status-done',
      statusCategory: 'done',
      storyPoints: 8,
      storyPointsFieldId: 'cf',
      storyPointsRaw: '8',
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: T2,
      deletedAt: null,
      raw: '{}',
      updatedAt: T2,
    })

    // Older update should not overwrite
    await store.upsertIssue({
      id: 'issue-lw',
      projectId: 'proj-1',
      key: 'ENG-2',
      type: 'Story',
      statusId: 'status-inprogress',
      statusCategory: 'indeterminate',
      storyPoints: 3,
      storyPointsFieldId: 'cf',
      storyPointsRaw: '3',
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1, // older
    })

    const got = await store.getIssue('issue-lw')
    expect(got?.storyPoints).toBe(8)
    expect(got?.statusCategory).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Issue transitions (append-only)
// ---------------------------------------------------------------------------

describe('issue_transitions', () => {
  it('appends transitions and returns them sorted by transitioned_at', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    await store.upsertIssue({
      id: 'issue-t1',
      projectId: 'proj-1',
      key: 'ENG-10',
      type: 'Story',
      statusId: 'status-todo',
      statusCategory: 'new',
      storyPoints: null,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    await store.appendIssueTransitions([
      {
        id: 'tr-2',
        issueId: 'issue-t1',
        fromStatusId: 'status-inprogress',
        toStatusId: 'status-done',
        projectIdAtTransition: 'proj-1',
        transitionedAt: T3,
        actorIdentityId: null,
      },
      {
        id: 'tr-1',
        issueId: 'issue-t1',
        fromStatusId: 'status-todo',
        toStatusId: 'status-inprogress',
        projectIdAtTransition: 'proj-1',
        transitionedAt: T2,
        actorIdentityId: null,
      },
    ])

    const transitions = await store.getIssueTransitions('issue-t1')
    expect(transitions).toHaveLength(2)
    // Should be returned sorted by transitioned_at ASC
    expect(transitions[0]?.transitionedAt).toBe(T2)
    expect(transitions[1]?.transitionedAt).toBe(T3)
  })

  it('append is idempotent — duplicate ids are ignored', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    await store.upsertIssue({
      id: 'issue-t2',
      projectId: 'proj-1',
      key: 'ENG-11',
      type: 'Task',
      statusId: 'status-todo',
      statusCategory: 'new',
      storyPoints: null,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    const transition = {
      id: 'tr-dup',
      issueId: 'issue-t2',
      fromStatusId: 'status-todo',
      toStatusId: 'status-done',
      projectIdAtTransition: 'proj-1',
      transitionedAt: T2,
      actorIdentityId: null,
    }

    await store.appendIssueTransitions([transition])
    await store.appendIssueTransitions([transition]) // second call should be a no-op

    const transitions = await store.getIssueTransitions('issue-t2')
    expect(transitions).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Metric snapshots
// ---------------------------------------------------------------------------

describe('metric_snapshots', () => {
  it('round-trips a snapshot via putSnapshot→getSnapshots', async () => {
    const { store } = migratedStore()

    const snapshot = {
      scopeType: 'team',
      scopeId: 'team-eng',
      metric: 'deployment_frequency',
      day: '2024-01-15',
      value: 3.5,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '0.1.0',
      ingestWatermarkVersion: 'wm-1',
      coverageFingerprint: 'fp-abc',
      computedAt: T1,
      isStale: false,
    }

    await store.putSnapshot(snapshot)
    const got = await store.getSnapshots(
      'team',
      'team-eng',
      'deployment_frequency',
      '2024-01-01',
      '2024-01-31',
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.value).toBe(3.5)
    expect(got[0]?.isStale).toBe(false)
  })

  it('markSnapshotsStale sets is_stale = true', async () => {
    const { store } = migratedStore()

    await store.putSnapshot({
      scopeType: 'repo',
      scopeId: 'repo-abc',
      metric: 'cycle_time',
      day: '2024-02-01',
      value: 2.1,
      window: '7d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '0.1.0',
      ingestWatermarkVersion: 'wm-2',
      coverageFingerprint: 'fp-xyz',
      computedAt: T1,
      isStale: false,
    })

    await store.markSnapshotsStale('repo', 'repo-abc', 'cycle_time', '2024-02-01')

    const got = await store.getSnapshots(
      'repo',
      'repo-abc',
      'cycle_time',
      '2024-02-01',
      '2024-02-01',
    )
    expect(got[0]?.isStale).toBe(true)
  })

  it('null value is persisted and retrieved correctly', async () => {
    const { store } = migratedStore()

    await store.putSnapshot({
      scopeType: 'org',
      scopeId: 'org-1',
      metric: 'change_failure_rate',
      day: '2024-03-01',
      value: null, // zero-denominator → null
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'no_data',
      engineVersion: '0.1.0',
      ingestWatermarkVersion: 'wm-3',
      coverageFingerprint: 'fp-null',
      computedAt: T1,
      isStale: false,
    })

    const got = await store.getSnapshots(
      'org',
      'org-1',
      'change_failure_rate',
      '2024-03-01',
      '2024-03-01',
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.value).toBeNull()
    expect(got[0]?.dataQuality).toBe('no_data')
  })

  it('round-trips dataSource (real / proxy / absent→undefined) — migration 0008', async () => {
    const { store } = migratedStore()
    const base = {
      scopeType: 'org',
      scopeId: 'org-ds',
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '0.1.0',
      ingestWatermarkVersion: 'wm-ds',
      coverageFingerprint: 'fp-ds',
      computedAt: T1,
      isStale: false,
      value: 1.5,
    }

    await store.putSnapshot({
      ...base,
      metric: 'dora.deployment_frequency',
      day: '2024-04-01',
      dataSource: 'real',
    })
    await store.putSnapshot({
      ...base,
      metric: 'dora.change_failure_rate',
      day: '2024-04-01',
      dataSource: 'proxy',
    })
    // No dataSource → persisted NULL → read back as undefined.
    await store.putSnapshot({ ...base, metric: 'flow.cycle_time', day: '2024-04-01' })

    const real = await store.getSnapshots(
      'org',
      'org-ds',
      'dora.deployment_frequency',
      '2024-04-01',
      '2024-04-01',
    )
    const proxy = await store.getSnapshots(
      'org',
      'org-ds',
      'dora.change_failure_rate',
      '2024-04-01',
      '2024-04-01',
    )
    const none = await store.getSnapshots(
      'org',
      'org-ds',
      'flow.cycle_time',
      '2024-04-01',
      '2024-04-01',
    )

    expect(real[0]?.dataSource).toBe('real')
    expect(proxy[0]?.dataSource).toBe('proxy')
    expect(none[0]?.dataSource).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Flow state model (effective-dated)
// ---------------------------------------------------------------------------

describe('flow_state_models', () => {
  it('returns the model in effect at the given timestamp', async () => {
    const { store } = migratedStore()

    await store.upsertWorkflow({ workflowId: 'wf-1', name: 'Software Dev', updatedAt: T1 })

    // v1: status was classified as 'wait' from T1, ended at T3
    await store.upsertFlowStateModel({
      workflowId: 'wf-1',
      statusId: 'status-uat',
      flowState: 'wait',
      confidence: 0.9,
      confirmedBy: null,
      confirmedAt: null,
      validFrom: T1,
      validTo: T3,
    })

    // v2: after T3, same status reclassified as 'active'
    await store.upsertFlowStateModel({
      workflowId: 'wf-1',
      statusId: 'status-uat',
      flowState: 'active',
      confidence: 1.0,
      confirmedBy: null,
      confirmedAt: null,
      validFrom: T3,
      validTo: null,
    })

    const atT2 = await store.getFlowStateModel('wf-1', 'status-uat', T2)
    expect(atT2?.flowState).toBe('wait')

    const atT3 = await store.getFlowStateModel(
      'wf-1',
      'status-uat',
      new Date('2024-01-04').toISOString(),
    )
    expect(atT3?.flowState).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// Issue key resolution (historical)
// ---------------------------------------------------------------------------

describe('issue_keys', () => {
  it('resolves a historical key to the current issue id', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)

    await store.upsertIssue({
      id: 'issue-moved',
      projectId: 'proj-1',
      key: 'NEW-45',
      type: 'Story',
      statusId: 'status-todo',
      statusCategory: 'new',
      storyPoints: null,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })

    // Old key (before project move)
    await store.upsertIssueKey({
      issueId: 'issue-moved',
      key: 'PROJ-123',
      validFrom: T1,
      validTo: T2,
    })
    // New key (after project move)
    await store.upsertIssueKey({
      issueId: 'issue-moved',
      key: 'NEW-45',
      validFrom: T2,
      validTo: null,
    })

    // Resolving old key at T1 should return the issue
    const resolvedOld = await store.resolveIssueKey('PROJ-123', T1)
    expect(resolvedOld).toBe('issue-moved')

    // Resolving old key after T2 should return null (no longer valid)
    const resolvedOldAfter = await store.resolveIssueKey('PROJ-123', T3)
    expect(resolvedOldAfter).toBeNull()

    // Resolving new key at T3 should return the issue
    const resolvedNew = await store.resolveIssueKey('NEW-45', T3)
    expect(resolvedNew).toBe('issue-moved')
  })
})

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

describe('sync_state', () => {
  it('round-trips a cursor', async () => {
    const { store } = migratedStore()

    await store.putSyncState({
      source: 'github',
      resource: 'commits',
      scopeId: 'repo-1',
      cursor: 'page-3',
      watermarkAt: T2,
      lastRunAt: T1,
      status: 'idle',
      error: null,
    })

    const got = await store.getSyncState('github', 'commits', 'repo-1')
    expect(got).not.toBeNull()
    expect(got?.cursor).toBe('page-3')
    expect(got?.status).toBe('idle')
  })

  it('put overwrites an existing cursor', async () => {
    const { store } = migratedStore()

    await store.putSyncState({
      source: 'jira',
      resource: 'issues',
      scopeId: 'proj-1',
      cursor: 'start-0',
      watermarkAt: null,
      lastRunAt: T1,
      status: 'running',
      error: null,
    })

    await store.putSyncState({
      source: 'jira',
      resource: 'issues',
      scopeId: 'proj-1',
      cursor: 'start-100',
      watermarkAt: T2,
      lastRunAt: T2,
      status: 'idle',
      error: null,
    })

    const got = await store.getSyncState('jira', 'issues', 'proj-1')
    expect(got?.cursor).toBe('start-100')
    expect(got?.status).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// AI verdicts (contestability)
// ---------------------------------------------------------------------------

describe('ai_verdicts', () => {
  it('round-trips a verdict', async () => {
    const { store } = migratedStore()

    await store.insertAiVerdict({
      id: 'verdict-1',
      subjectType: 'pull_request',
      subjectId: 'pr-1',
      metric: 'pr_quality',
      promptVersion: 'v1',
      modelId: 'claude-sonnet-4-6',
      modelSnapshot: 'claude-sonnet-4-6-20250101',
      requestShape: '{}',
      featureVectorJson: '{}',
      structuredVerdictJson: '{"ordinal": 3}',
      evidenceJson: '[]',
      confidence: 0.85,
      createdAt: T1,
    })

    const got = await store.getAiVerdict('verdict-1')
    expect(got?.confidence).toBe(0.85)
    expect(got?.structuredVerdictJson).toBe('{"ordinal": 3}')
  })
})

// ---------------------------------------------------------------------------
// Hardening regressions (audit fixes)
// ---------------------------------------------------------------------------

describe('softDelete table allowlist', () => {
  it('rejects an unknown/non-soft-deletable table name', async () => {
    const { store } = migratedStore()
    await expect(store.softDelete('persons', 'x')).rejects.toThrow(/refusing/)
    // A classic injection attempt must be rejected, not interpolated.
    await expect(store.softDelete('issues; DROP TABLE issues;--', 'x')).rejects.toThrow()
  })
})

describe('transaction()', () => {
  it('rolls back all writes when the body throws', async () => {
    const { store } = migratedStore()
    await seedOrg(store)
    await expect(
      store.transaction(async () => {
        await store.upsertTeam({ id: 'team-x', name: 'X', orgId: 'org-1', updatedAt: T1 })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await store.getTeam('team-x')).toBeNull()
  })

  it('commits all writes when the body succeeds', async () => {
    const { store } = migratedStore()
    await seedOrg(store)
    await store.transaction(async () => {
      await store.upsertTeam({ id: 'team-y', name: 'Y', orgId: 'org-1', updatedAt: T1 })
    })
    expect(await store.getTeam('team-y')).not.toBeNull()
  })
})

describe('sprint membership event idempotency', () => {
  it('does not duplicate the same event on re-sync', async () => {
    const { store } = migratedStore()
    await seedJiraProject(store)
    await store.upsertIssue({
      id: 'issue-sm',
      projectId: 'proj-1',
      key: 'ENG-7',
      type: 'Story',
      statusId: 's1',
      statusCategory: 'new',
      storyPoints: 3,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: T1,
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: T1,
    })
    await store.upsertSprint({
      id: 'sprint-1',
      boardId: 'board-1',
      state: 'closed',
      startAt: T1,
      endAt: null,
      completeAt: null,
      updatedAt: T1,
    })
    const event = {
      sprintId: 'sprint-1',
      issueId: 'issue-sm',
      change: 'added',
      pointsAtEvent: 3,
      transitionedAt: T1,
      wasPresentAtStart: true,
    }
    await store.appendSprintMembershipEvent(event)
    await store.appendSprintMembershipEvent(event) // re-sync
    const events = await store.getSprintMembershipEvents('sprint-1')
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// pruneOldData — age-based retention
// ---------------------------------------------------------------------------

describe('pruneOldData', () => {
  const NOW = '2026-06-23T00:00:00.000Z'
  const ago = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
  const dayAgo = (days) => ago(days).slice(0, 10)

  /** Seed an org/identity/repo + dated time-series rows across the windows. */
  function seed(db) {
    const run = (sql, ...p) => db.prepare(sql).run(...p)
    run(
      `INSERT INTO organisations (id, name, created_at, updated_at) VALUES ('org-1','Org',?,?)`,
      NOW,
      NOW,
    )
    run(
      `INSERT INTO identities (id, kind, external_id, raw, updated_at) VALUES ('id-1','github_login','dev','{}',?)`,
      NOW,
    )
    run(
      `INSERT INTO repositories (id, github_node_id, org_id, owner, name, default_branch, raw, created_at, updated_at)
       VALUES ('repo-1','node-1','org-1','org','app','main','{}',?,?)`,
      NOW,
      NOW,
    )

    // Commits: one beyond retention (200d), one recent (5d) + a co-author row each.
    for (const [sha, days] of [
      ['old', 200],
      ['new', 5],
    ]) {
      run(
        `INSERT INTO commits (repo_id, sha, author_identity_id, authored_at, raw, created_at, updated_at)
         VALUES ('repo-1',?, 'id-1', ?, '{}', ?, ?)`,
        sha,
        ago(days),
        NOW,
        NOW,
      )
      run(
        `INSERT INTO commit_authors (repo_id, sha, identity_id, role, source) VALUES ('repo-1',?, 'id-1','author','api')`,
        sha,
      )
    }

    // PRs: OLD (200d, deleted), MID (50d, kept but patch nulled), NEW (5d, kept + patch).
    for (const [id, days] of [
      ['pr-old', 200],
      ['pr-mid', 50],
      ['pr-new', 5],
    ]) {
      run(
        `INSERT INTO pull_requests (id, repo_id, number, author_identity_id, state, head_ref, base_ref, created_at, raw, updated_at)
         VALUES (?, 'repo-1', 1, 'id-1', 'merged', 'h', 'main', ?, '{}', ?)`,
        id,
        ago(days),
        NOW,
      )
      run(
        `INSERT INTO pr_files (pr_id, repo_id, path, patch, created_at, updated_at)
         VALUES (?, 'repo-1', 'a.js', '@@ patch @@', ?, ?)`,
        id,
        NOW,
        NOW,
      )
    }
    // A review on the OLD PR (cascade-pruned) and on the NEW PR (kept).
    run(
      `INSERT INTO reviews (node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at)
       VALUES ('rev-old','pr-old','id-1','approved',?, '{}', ?)`,
      ago(200),
      NOW,
    )
    run(
      `INSERT INTO reviews (node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at)
       VALUES ('rev-new','pr-new','id-1','approved',?, '{}', ?)`,
      ago(5),
      NOW,
    )

    // Deployments, check runs, ai_authorship: one old, one recent each.
    for (const [id, days] of [
      ['dep-old', 200],
      ['dep-new', 5],
    ]) {
      run(
        `INSERT INTO deployments (id, repo_id, sha, environment, status, created_at, source, raw, updated_at)
         VALUES (?, 'repo-1', 'old', 'production', 'success', ?, 'deployments_api', '{}', ?)`,
        id,
        ago(days),
        NOW,
      )
    }
    for (const [node, days] of [
      ['cr-old', 200],
      ['cr-new', 5],
    ]) {
      run(
        `INSERT INTO check_runs (node_id, repo_id, head_sha, name, status, completed_at, updated_at)
         VALUES (?, 'repo-1', 'old', 'ci', 'completed', ?, ?)`,
        node,
        ago(days),
        NOW,
      )
    }
    for (const [eid, days] of [
      ['repo-1:old', 200],
      ['repo-1:new', 5],
    ]) {
      run(
        `INSERT INTO ai_authorship (entity_type, entity_id, repo_id, author_identity_id, authored_at, ai_score, signals_json, computed_at)
         VALUES ('commit', ?, 'repo-1', 'id-1', ?, 0.5, '[]', ?)`,
        eid,
        ago(days),
        NOW,
      )
    }

    // Snapshots: one beyond the horizon (100d), one inside (10d).
    for (const [metric, days] of [
      ['m.old', 100],
      ['m.new', 10],
    ]) {
      run(
        `INSERT INTO metric_snapshots (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality, engine_version, ingest_watermark_version, coverage_fingerprint, computed_at)
         VALUES ('team','team', ?, ?, 1, '30d', 'deterministic', 'ok', '0.1.1', '1', 'fp', ?)`,
        metric,
        dayAgo(days),
        NOW,
      )
    }

    // One ORPHAN file_complexity row (sha referenced by no commit or pr_ref) — only
    // the gcOrphans sweep removes it.
    run(
      `INSERT INTO file_complexity (repo_id, sha, path, language, loc, total_cyclomatic, function_count, functions, computed_at)
       VALUES ('repo-1', 'orphan-sha', 'x.js', 'js', 1, 1, 1, '[]', ?)`,
      NOW,
    )
  }

  it('prunes rows beyond retention, trims snapshots, and NULLs stale patch text', async () => {
    const { db, store } = migratedStore()
    seed(db)

    const { counts } = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
    })

    // Row prune (200d-old rows): exactly the old ones go.
    expect(counts.pull_requests).toBe(1)
    expect(counts.pr_files).toBe(1) // pr-old's file deleted with the PR
    expect(counts.reviews).toBe(1)
    expect(counts.commits).toBe(1)
    expect(counts.commit_authors).toBe(1)
    expect(counts.deployments).toBe(1)
    expect(counts.check_runs).toBe(1)
    expect(counts.ai_authorship).toBe(1)
    // Snapshot trim (>60d): the 100d snapshot goes, the 10d one stays.
    expect(counts.metric_snapshots).toBe(1)
    // Patch trim (>30d but within retention): pr-mid's patch is nulled, pr-new kept.
    expect(counts.pr_files_patch_nulled).toBe(1)
    // Orphan GC (default on): the unreferenced file_complexity row is removed.
    expect(counts.file_complexity).toBe(1)
    expect(db.prepare(`SELECT COUNT(*) c FROM file_complexity`).get().c).toBe(0)

    const remainingPrs = db
      .prepare(`SELECT id FROM pull_requests ORDER BY id`)
      .all()
      .map((r) => r.id)
    expect(remainingPrs).toEqual(['pr-mid', 'pr-new'])
    const midPatch = db.prepare(`SELECT patch FROM pr_files WHERE pr_id='pr-mid'`).get().patch
    const newPatch = db.prepare(`SELECT patch FROM pr_files WHERE pr_id='pr-new'`).get().patch
    expect(midPatch).toBeNull()
    expect(newPatch).toBe('@@ patch @@')
  })

  it('floors the raw cutoff at the snapshot horizon + window so metrics are never starved', async () => {
    const { db, store } = migratedStore()
    seed(db)

    // retentionDays far below the horizon: the floor (60+30=90) must still protect
    // the 50d-old PR/commit data the snapshot backfill needs.
    const { counts, cutoffs } = await store.pruneOldData({
      now: NOW,
      retentionDays: 10,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
    })

    expect(cutoffs.rawRetentionDays).toBe(90)
    // Only the 200d rows are removed; the 50d-old PR survives the floor.
    expect(counts.pull_requests).toBe(1)
    const remaining = db
      .prepare(`SELECT id FROM pull_requests ORDER BY id`)
      .all()
      .map((r) => r.id)
    expect(remaining).toEqual(['pr-mid', 'pr-new'])
  })

  it('is a no-op for row + patch prune when their windows are 0 (keep-all)', async () => {
    const { db, store } = migratedStore()
    seed(db)

    const { counts } = await store.pruneOldData({
      now: NOW,
      retentionDays: 0,
      snapshotHorizonDays: 0,
      snapshotWindowDays: 0,
      patchRetentionDays: 0,
    })

    expect(counts.pull_requests).toBe(0)
    expect(counts.commits).toBe(0)
    expect(counts.pr_files_patch_nulled).toBe(0)
    expect(counts.metric_snapshots).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) c FROM pull_requests`).get().c).toBe(3)
    expect(db.prepare(`SELECT COUNT(*) c FROM commits`).get().c).toBe(2)
  })

  it('gcOrphans:false skips the file_complexity anti-join (hot-path mode)', async () => {
    const { db, store } = migratedStore()
    seed(db)

    const { counts } = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
      gcOrphans: false,
    })

    // Row prune still runs; the orphan file_complexity row is left for the manual tool.
    expect(counts.pull_requests).toBe(1)
    expect(counts.file_complexity).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) c FROM file_complexity`).get().c).toBe(1)
  })

  it('dryRun previews the counts without mutating the store', async () => {
    const { db, store } = migratedStore()
    seed(db)

    const { dryRun, counts } = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
      dryRun: true,
    })

    // Counts reflect what WOULD be deleted…
    expect(dryRun).toBe(true)
    expect(counts.pull_requests).toBe(1)
    expect(counts.commits).toBe(1)
    expect(counts.metric_snapshots).toBe(1)
    expect(counts.pr_files_patch_nulled).toBe(1)
    expect(counts.file_complexity).toBe(1)
    // …but nothing was actually removed or NULLed.
    expect(db.prepare(`SELECT COUNT(*) c FROM pull_requests`).get().c).toBe(3)
    expect(db.prepare(`SELECT COUNT(*) c FROM commits`).get().c).toBe(2)
    expect(db.prepare(`SELECT COUNT(*) c FROM metric_snapshots`).get().c).toBe(2)
    expect(db.prepare(`SELECT COUNT(*) c FROM file_complexity`).get().c).toBe(1)
    expect(db.prepare(`SELECT patch FROM pr_files WHERE pr_id='pr-mid'`).get().patch).toBe(
      '@@ patch @@',
    )
  })

  it('retentionBufferDays extends the raw-retention floor', async () => {
    const { store } = migratedStore()

    const withBuffer = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
      retentionBufferDays: 14,
      dryRun: true,
    })
    expect(withBuffer.cutoffs.rawRetentionDays).toBe(104) // max(90, 60+30+14)

    const noBuffer = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
      retentionBufferDays: 0,
      dryRun: true,
    })
    expect(noBuffer.cutoffs.rawRetentionDays).toBe(90) // max(90, 60+30+0)
  })

  it('prunes a NULL-authored_at ai_authorship row via computed_at fallback', async () => {
    const { db, store } = migratedStore()
    seed(db)
    // A row with NULL authored_at but an OLD computed_at must not become immortal.
    db.prepare(
      `INSERT INTO ai_authorship (entity_type, entity_id, repo_id, author_identity_id, authored_at, ai_score, signals_json, computed_at)
       VALUES ('commit', 'repo-1:nulldate', 'repo-1', 'id-1', NULL, 0.5, '[]', ?)`,
    ).run(ago(200))

    const { counts } = await store.pruneOldData({
      now: NOW,
      retentionDays: 90,
      snapshotHorizonDays: 60,
      snapshotWindowDays: 30,
      patchRetentionDays: 30,
    })

    // The 200d authored row + the NULL-authored/200d-computed row both go (2 total).
    expect(counts.ai_authorship).toBe(2)
    expect(
      db.prepare(`SELECT COUNT(*) c FROM ai_authorship WHERE entity_id='repo-1:nulldate'`).get().c,
    ).toBe(0)
  })
})
