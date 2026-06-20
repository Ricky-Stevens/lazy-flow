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

  it('surfaces the synthesised diff to the judge when a patch is present', async () => {
    await store.upsertPrFile({
      prId: 'pr-1',
      repoId: 'repo-1',
      path: 'src/retry.ts',
      additions: 3,
      deletions: 1,
      haloc: 3,
      status: 'modified',
      patch: '@@ -1,1 +1,3 @@\n-old\n+new line a\n+new line b\n',
      isGenerated: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const r = await listPendingVerdicts(store, 'person.design_bearing_ratio', 'p-1')
    const file = r.pending[0].context.files.find((f) => f.path === 'src/retry.ts')
    expect(file.patch).toContain('+new line a')
    expect(r.pending[0].context.note).toMatch(/diffs are included/i)
  })

  it('flags missing diffs (patch NULL) so the judge lowers confidence', async () => {
    await store.upsertPrFile({
      prId: 'pr-1',
      repoId: 'repo-1',
      path: 'src/no-diff.ts',
      additions: 1,
      deletions: 0,
      haloc: 1,
      status: 'added',
      patch: null,
      isGenerated: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const r = await listPendingVerdicts(store, 'person.design_bearing_ratio', 'p-1')
    expect(r.pending[0].context.files[0].patch).toBeNull()
    expect(r.pending[0].context.note).toMatch(/no diffs backfilled/i)
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

  it('skips a malformed stored verdict row instead of crashing the read', async () => {
    // A valid verdict plus a corrupt structured_verdict_json (possible via the
    // directly-writable store under the full-transparency contract). The read
    // must return the valid row and silently drop the corrupt one, not throw.
    await recordVerdict(
      store,
      {
        metric: 'person.design_bearing_ratio',
        subjectId: 'pr-good',
        verdict: { designBearing: true, difficulty: 3 },
        confidence: 0.9,
      },
      { id: 'v-good', now: NOW },
    )
    // Inject a corrupt row directly.
    store.db
      .prepare(
        `INSERT INTO ai_verdicts
           (id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
            request_shape, feature_vector_json, structured_verdict_json, evidence_json,
            confidence, created_at, corrected_by, correction_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'v-bad',
        'pull_request',
        'pr-bad',
        'person.design_bearing_ratio',
        'session-claude-v1',
        'in-session-claude',
        'in-session-claude',
        'session',
        '{}',
        '{not valid json',
        '[]',
        0.5,
        NOW,
        null,
        null,
      )

    const stored = await store.getAiVerdictsByMetric('pull_request', 'person.design_bearing_ratio')
    expect(stored).toHaveLength(1)
    expect(stored[0].subjectId).toBe('pr-good')
  })
})
