/**
 * Tests for NodeSqliteStore and the migration runner.
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

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { currentVersion, MIGRATIONS, migrate } from '../migrate/runner.js'
import { NodeSqliteStore } from './NodeSqliteStore.js'

/** The highest migration version in the current migration set. */
const MAX_VERSION = MIGRATIONS.length

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemoryDb(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function _freshStore(): NodeSqliteStore {
  const db = openMemoryDb()
  migrate(db, 'up')
  return new NodeSqliteStore(':memory:')
}

/** Create a store backed by a shared already-migrated DatabaseSync. */
function storeOnDb(db: DatabaseSync): NodeSqliteStore {
  // NodeSqliteStore opens its own connection; for in-memory we need the same
  // db handle, so we use a workaround: open the store as :memory: and replace
  // the internal db with the provided one.
  const store = new NodeSqliteStore(':memory:')
  // Close the newly opened empty db and substitute the pre-migrated one.
  store.db.close()
  // TypeScript: we cast to allow replacing the readonly db for testing.
  ;(store as { db: DatabaseSync }).db = db
  return store
}

function migratedStore(): { db: DatabaseSync; store: NodeSqliteStore } {
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
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
        name: string
      }[]
    ).map((r) => r.name)

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
      'survey_responses',
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

async function seedOrg(store: NodeSqliteStore, id = 'org-1'): Promise<void> {
  await store.upsertOrganisation({
    id,
    githubLogin: 'acme',
    jiraCloudId: null,
    name: 'Acme',
    createdAt: T1,
    updatedAt: T1,
  })
}

async function seedIdentity(store: NodeSqliteStore, id = 'ident-1'): Promise<void> {
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

async function seedRepo(store: NodeSqliteStore, id = 'repo-1'): Promise<void> {
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

async function seedJiraProject(store: NodeSqliteStore, id = 'proj-1'): Promise<void> {
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
      state: 'open' as const,
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
    expect(got?.mergedViaQueue).toBe(false)
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
      state: 'open' as const,
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
      scopeType: 'team' as const,
      scopeId: 'team-eng',
      metric: 'deployment_frequency',
      day: '2024-01-15',
      value: 3.5,
      window: '30d',
      trustTier: 'deterministic' as const,
      dataQuality: 'ok' as const,
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
  it('round-trips a verdict and applies a correction', async () => {
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
      correctedBy: null,
      correctionJson: null,
    })

    const before = await store.getAiVerdict('verdict-1')
    expect(before?.confidence).toBe(0.85)
    expect(before?.correctedBy).toBeNull()

    await store.correctAiVerdict('verdict-1', 'human-alice', '{"ordinal": 2}')

    const after = await store.getAiVerdict('verdict-1')
    expect(after?.correctedBy).toBe('human-alice')
    expect(after?.correctionJson).toBe('{"ordinal": 2}')
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
      change: 'added' as const,
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

describe('erasePerson GDPR completeness', () => {
  it('scrubs the subject login out of attributable raw blobs and deletes their AI verdicts', async () => {
    const { store } = migratedStore()
    await seedRepo(store)
    await store.upsertPerson({
      id: 'person-1',
      displayName: 'Alice Example',
      primaryAccountRef: 'gh:alice-corp',
      updatedAt: T1,
    })
    await store.upsertIdentity({
      id: 'ident-1',
      personId: 'person-1',
      kind: 'github_login',
      externalId: 'alice-corp',
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: T1,
    })
    await store.upsertPullRequest({
      id: 'pr-erase',
      repoId: 'repo-1',
      number: 7,
      authorIdentityId: 'ident-1',
      state: 'merged',
      headRef: 'f',
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
      raw: JSON.stringify({ user: { login: 'alice-corp' }, body: 'by Alice Example' }),
      updatedAt: T1,
    })
    await store.insertAiVerdict({
      id: 'v-erase',
      subjectType: 'pull_request',
      subjectId: 'pr-erase',
      metric: 'alignment',
      promptVersion: 'v1',
      modelId: 'm',
      modelSnapshot: 'm',
      requestShape: '{}',
      featureVectorJson: JSON.stringify({ prBody: 'authored by alice-corp' }),
      structuredVerdictJson: '{}',
      evidenceJson: '[]',
      confidence: 0.5,
      createdAt: T1,
      correctedBy: null,
      correctionJson: null,
    })

    const res = await store.erasePerson('person-1')
    expect(res.erasedIdentityIds).toContain('ident-1')

    // raw blob must no longer contain the subject's login or display name.
    const rawRow = store.db
      .prepare('SELECT raw FROM pull_requests WHERE id = ?')
      .get('pr-erase') as { raw: string }
    expect(rawRow.raw).not.toContain('alice-corp')
    expect(rawRow.raw).not.toContain('Alice Example')
    expect(rawRow.raw).toContain('[ERASED]')

    // The AI verdict keyed on the subject's PR must be gone.
    expect(await store.getAiVerdict('v-erase')).toBeNull()
  })

  it('erases the subject survey_responses (and does not fail the FK on DELETE persons)', async () => {
    const { store } = migratedStore()
    await store.upsertOrganisation({
      id: 'org-s',
      githubLogin: 'org-s',
      jiraCloudId: null,
      name: 'org-s',
      createdAt: T1,
      updatedAt: T1,
    })
    store.db
      .prepare('INSERT INTO teams (id, name, org_id, updated_at) VALUES (?, ?, ?, ?)')
      .run('team-s', 'Team S', 'org-s', T1)
    await store.upsertPerson({
      id: 'person-s',
      displayName: 'Survey Subject',
      primaryAccountRef: 'gh:subj',
      updatedAt: T1,
    })
    store.db
      .prepare(
        `INSERT INTO survey_responses
           (id, person_id, team_id, instrument_id, instrument_version, scores_json, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sr-1', 'person-s', 'team-s', 'instr', '1', '{"q1":5}', T1)

    // Must not throw a FOREIGN KEY constraint failure, and must remove the row.
    await store.erasePerson('person-s')

    const remaining = store.db
      .prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE person_id = ?')
      .get('person-s') as { n: number }
    expect(remaining.n).toBe(0)
    const person = store.db.prepare('SELECT id FROM persons WHERE id = ?').get('person-s')
    expect(person).toBeUndefined()
  })
})
