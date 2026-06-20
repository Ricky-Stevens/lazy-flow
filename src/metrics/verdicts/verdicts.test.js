import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { BunSqliteStore, migrate } from '../../core/index.js'
import { listPendingVerdicts, recordVerdict, verdictSubjectType } from './index.js'

const NOW = '2024-06-01T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

async function seedPr(store) {
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
    githubNodeId: 'node-repo-1',
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
  await store.upsertPerson({
    id: 'p-1',
    displayName: 'Dev One',
    primaryAccountRef: 'gh:dev1',
    updatedAt: NOW,
  })
  await store.upsertIdentity({
    id: 'id-1',
    personId: 'p-1',
    kind: 'github_login',
    externalId: 'dev1',
    isBot: false,
    confidence: 1,
    raw: '{}',
    updatedAt: NOW,
  })
  await store.upsertPullRequest({
    id: 'pr-1',
    repoId: 'repo-1',
    number: 1,
    authorIdentityId: 'id-1',
    state: 'merged',
    headRef: 'feat',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: NOW,
    readyAt: NOW,
    firstCommitAt: NOW,
    firstReviewAt: NOW,
    approvedAt: NOW,
    mergedAt: NOW,
    mergedByIdentityId: 'id-1',
    deletedAt: null,
    raw: JSON.stringify({
      title: 'Add retry state machine',
      body: '## Summary\nImplements backoff.',
    }),
    updatedAt: NOW,
  })
}

describe('verdicts pipeline (in-session, no API)', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seedPr(store)
  })

  it('maps metrics to the right ai_verdicts subject_type', () => {
    expect(verdictSubjectType('person.design_bearing_ratio')).toBe('pull_request')
    expect(verdictSubjectType('pr.feedback_severity_mix_received')).toBe('review_comment')
    expect(verdictSubjectType('person.review_depth_mentorship')).toBe('review')
  })

  it('lists the authored PR as pending with extracted title/body', async () => {
    const r = await listPendingVerdicts(store, 'person.design_bearing_ratio', 'p-1')
    expect(r.pendingCount).toBe(1)
    expect(r.pending[0].subjectId).toBe('pr-1')
    expect(r.pending[0].context.title).toBe('Add retry state machine')
    expect(r.pending[0].context.body).toContain('backoff')
  })

  it('records a verdict (idempotent) and then excludes it from pending', async () => {
    await recordVerdict(
      store,
      {
        metric: 'person.design_bearing_ratio',
        subjectId: 'pr-1',
        verdict: { designBearing: true, difficulty: 4 },
        confidence: 0.8,
        evidence: ['title: retry state machine'],
      },
      { id: 'v-1', now: NOW },
    )
    const stored = await store.getAiVerdictsByMetric('pull_request', 'person.design_bearing_ratio')
    expect(stored).toHaveLength(1)
    expect(stored[0].verdict.designBearing).toBe(true)

    // Re-record is idempotent (no duplicate).
    await recordVerdict(
      store,
      {
        metric: 'person.design_bearing_ratio',
        subjectId: 'pr-1',
        verdict: { designBearing: false, difficulty: 2 },
        confidence: 0.6,
      },
      { id: 'v-2', now: NOW },
    )
    const after = await store.getAiVerdictsByMetric('pull_request', 'person.design_bearing_ratio')
    expect(after).toHaveLength(1)
    expect(after[0].verdict.designBearing).toBe(false)

    const pend = await listPendingVerdicts(store, 'person.design_bearing_ratio', 'p-1')
    expect(pend.pendingCount).toBe(0)
  })
})
