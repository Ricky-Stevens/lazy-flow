/**
 * In-session-Claude AI-authorship verdict pipeline tests.
 *
 * Covers (a) the list/record round-trip, ambiguous-band selection, idempotence,
 * and verdict-overrides-score in the AI-blend consumer; (b) the regression that
 * a stylometry re-score does NOT clobber an existing verdict.
 */

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildAiBlendInputs } from '../../metrics/compute/personDerive.js'
import { BunSqliteStore, migrate } from '../index.js'
import { detectAiAuthorship } from './aiAuthorship.js'
import { listPendingAuthorshipVerdicts, recordAuthorshipVerdict } from './authorshipVerdicts.js'

const NOW = '2026-06-21T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

async function seedRepo(store) {
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
  await store.upsertIdentity({
    id: 'id-dev',
    personId: null,
    kind: 'github_login',
    externalId: 'dev1',
    isBot: false,
    confidence: 1,
    raw: '{}',
    updatedAt: NOW,
  })
}

async function seedPr(store, { id, title, body }) {
  await store.upsertPullRequest({
    id,
    repoId: 'repo-1',
    number: 1,
    authorIdentityId: 'id-dev',
    state: 'merged',
    headRef: 'f',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: '2026-06-01T00:00:00Z',
    readyAt: null,
    firstCommitAt: null,
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: NOW,
    mergedByIdentityId: null,
    deletedAt: null,
    raw: JSON.stringify({ title, body }),
    updatedAt: NOW,
  })
}

async function seedCommit(store, { sha, message }) {
  await store.upsertCommit({
    repoId: 'repo-1',
    sha,
    authorIdentityId: 'id-dev',
    authoredAt: '2026-06-01T00:00:00Z',
    committedAt: '2026-06-01T00:00:00Z',
    additions: 1,
    deletions: 0,
    haloc: 1,
    raw: JSON.stringify({ commit: { message } }),
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function upsertAuthorship(store, { entityType, entityId, aiScore, authoredAt }) {
  await store.upsertAiAuthorship({
    entityType,
    entityId,
    repoId: 'repo-1',
    authorIdentityId: 'id-dev',
    authoredAt: authoredAt ?? '2026-06-01T00:00:00Z',
    aiScore,
    signalsJson: '[]',
    computedAt: NOW,
  })
}

describe('listPendingAuthorshipVerdicts', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seedRepo(store)
  })

  it('returns only ambiguous-band entities without a verdict, with text extracted', async () => {
    // Three PRs spanning the band: 0.20 (below), 0.50 (in band), 0.95 (above).
    await seedPr(store, { id: 'pr-low', title: 'tweak', body: 'fix typo' })
    await seedPr(store, { id: 'pr-mid', title: 'feat: caching', body: '## Summary\n\nadd cache' })
    await seedPr(store, { id: 'pr-high', title: 'Refactor', body: 'Generated with Claude Code' })
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-low', aiScore: 0.2 })
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-mid', aiScore: 0.5 })
    await upsertAuthorship(store, {
      entityType: 'pull_request',
      entityId: 'pr-high',
      aiScore: 0.95,
    })

    const out = await listPendingAuthorshipVerdicts(store)
    expect(out.pendingCount).toBe(1)
    expect(out.pending[0].entityType).toBe('pull_request')
    expect(out.pending[0].entityId).toBe('pr-mid')
    // Text is "title\nbody" for PRs.
    expect(out.pending[0].text).toContain('feat: caching')
    expect(out.pending[0].text).toContain('## Summary')
    expect(out.note).toMatch(/STYLE/i)
    expect(out.loBand).toBe(0.35)
    expect(out.hiBand).toBe(0.65)
  })

  it('extracts commit messages from commit.raw', async () => {
    await seedCommit(store, { sha: 'aaa', message: 'Add retry — exponential backoff' })
    await upsertAuthorship(store, {
      entityType: 'commit',
      entityId: 'repo-1:aaa',
      aiScore: 0.5,
    })
    const out = await listPendingAuthorshipVerdicts(store)
    expect(out.pendingCount).toBe(1)
    expect(out.pending[0].entityType).toBe('commit')
    expect(out.pending[0].entityId).toBe('repo-1:aaa')
    expect(out.pending[0].text).toContain('Add retry')
  })

  it('respects custom band + limit, and skips entities that already have a verdict', async () => {
    await seedPr(store, { id: 'pr-a', title: 'a', body: '' })
    await seedPr(store, { id: 'pr-b', title: 'b', body: '' })
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-a', aiScore: 0.5 })
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-b', aiScore: 0.5 })
    // Verdict on pr-a → only pr-b should remain pending.
    await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-a',
        aiAssisted: true,
        confidence: 0.9,
        reasoning: 'r',
      },
      { now: NOW },
    )

    const out = await listPendingAuthorshipVerdicts(store, { limit: 5 })
    expect(out.pendingCount).toBe(1)
    expect(out.pending[0].entityId).toBe('pr-b')
  })

  it('applies the sinceIso recency floor (only recent entities surface)', async () => {
    await seedPr(store, { id: 'pr-stale', title: 'old work', body: '## Summary' })
    await seedPr(store, { id: 'pr-fresh', title: 'new work', body: '## Summary' })
    await upsertAuthorship(store, {
      entityType: 'pull_request',
      entityId: 'pr-stale',
      aiScore: 0.5,
      authoredAt: '2026-01-01T00:00:00Z',
    })
    await upsertAuthorship(store, {
      entityType: 'pull_request',
      entityId: 'pr-fresh',
      aiScore: 0.5,
      authoredAt: '2026-06-15T00:00:00Z',
    })

    // No floor → both ambiguous-band PRs surface.
    expect((await listPendingAuthorshipVerdicts(store)).pendingCount).toBe(2)

    // With a floor at 2026-06-01, only the fresh one remains.
    const out = await listPendingAuthorshipVerdicts(store, { sinceIso: '2026-06-01T00:00:00Z' })
    expect(out.pendingCount).toBe(1)
    expect(out.pending[0].entityId).toBe('pr-fresh')
  })
})

describe('recordAuthorshipVerdict', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seedRepo(store)
    await seedPr(store, { id: 'pr-x', title: 'feat', body: 'body' })
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-x', aiScore: 0.5 })
  })

  it('writes the llm_* columns + verdict_at and is idempotent', async () => {
    await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-x',
        aiAssisted: true,
        confidence: 0.8,
        reasoning: 'AI tells',
      },
      { now: NOW },
    )
    const rows = await store.getAllAiAuthorship()
    const row = rows.find((r) => r.entityId === 'pr-x')
    expect(row.llmVerdict).toBe(true)
    expect(row.llmConfidence).toBeCloseTo(0.8, 10)
    expect(row.llmReasoning).toBe('AI tells')
    expect(row.verdictAt).toBe(NOW)

    // Re-record overwrites idempotently — opposite verdict + lower confidence.
    await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-x',
        aiAssisted: false,
        confidence: 0.4,
        reasoning: 'rethink',
      },
      { now: '2026-06-22T00:00:00.000Z' },
    )
    const row2 = (await store.getAllAiAuthorship()).find((r) => r.entityId === 'pr-x')
    expect(row2.llmVerdict).toBe(false)
    expect(row2.llmConfidence).toBeCloseTo(0.4, 10)
    expect(row2.verdictAt).toBe('2026-06-22T00:00:00.000Z')
  })

  it('returns recorded:false when the entity does not exist in ai_authorship', async () => {
    // setAiAuthorshipVerdict is a bare UPDATE; if entity_id does not exist it
    // affects 0 rows. recordAuthorshipVerdict must report this honestly.
    const result = await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-does-not-exist',
        aiAssisted: true,
        confidence: 0.9,
        reasoning: 'test',
      },
      { now: NOW },
    )
    expect(result.recorded).toBe(false)
  })

  it('returns recorded:true when the entity exists and the row was updated', async () => {
    const result = await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-x',
        aiAssisted: true,
        confidence: 0.8,
        reasoning: 'AI tells',
      },
      { now: NOW },
    )
    expect(result.recorded).toBe(true)
  })

  it('rejects invalid input', async () => {
    await expect(
      recordAuthorshipVerdict(
        store,
        {
          entityType: 'pull_request',
          entityId: 'pr-x',
          aiAssisted: 'yes',
          confidence: 0.5,
          reasoning: '',
        },
        { now: NOW },
      ),
    ).rejects.toThrow(/boolean/)
    await expect(
      recordAuthorshipVerdict(
        store,
        {
          entityType: 'pull_request',
          entityId: 'pr-x',
          aiAssisted: true,
          confidence: 1.5,
          reasoning: '',
        },
        { now: NOW },
      ),
    ).rejects.toThrow(/confidence/)
  })
})

describe('stylometry re-score preserves the verdict (regression)', () => {
  it('upsertAiAuthorship leaves llm_verdict/llm_confidence/llm_reasoning/verdict_at intact', async () => {
    const store = freshStore()
    await seedRepo(store)
    await seedPr(store, { id: 'pr-1', title: 'feat', body: 'body' })
    // First stylometry pass scores the PR.
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-1', aiScore: 0.5 })
    // Session records a verdict.
    await recordAuthorshipVerdict(
      store,
      {
        entityType: 'pull_request',
        entityId: 'pr-1',
        aiAssisted: true,
        confidence: 0.85,
        reasoning: 'fits',
      },
      { now: NOW },
    )
    // A later stylometry RE-SCORE refreshes the deterministic score…
    await upsertAuthorship(store, { entityType: 'pull_request', entityId: 'pr-1', aiScore: 0.42 })
    // …and the verdict columns survive.
    const row = (await store.getAllAiAuthorship()).find((r) => r.entityId === 'pr-1')
    expect(row.aiScore).toBeCloseTo(0.42, 10)
    expect(row.llmVerdict).toBe(true)
    expect(row.llmConfidence).toBeCloseTo(0.85, 10)
    expect(row.llmReasoning).toBe('fits')
    expect(row.verdictAt).toBe(NOW)
  })

  it('detectAiAuthorship does not re-score (and therefore cannot disturb) an existing row', async () => {
    const store = freshStore()
    await seedRepo(store)
    await seedCommit(store, { sha: 'aaa', message: 'Add retry — exponential backoff' })
    const first = await detectAiAuthorship(store, { now: NOW })
    expect(first.scored).toBe(1)
    // Session verdict.
    await recordAuthorshipVerdict(
      store,
      {
        entityType: 'commit',
        entityId: 'repo-1:aaa',
        aiAssisted: false,
        confidence: 0.6,
        reasoning: 'human',
      },
      { now: NOW },
    )
    // Detect again — incremental skip means nothing new is scored.
    const second = await detectAiAuthorship(store, { now: NOW })
    expect(second.scored).toBe(0)
    const row = (await store.getAllAiAuthorship()).find((r) => r.entityId === 'repo-1:aaa')
    expect(row.llmVerdict).toBe(false)
    expect(row.llmConfidence).toBeCloseTo(0.6, 10)
  })
})

describe('verdict overrides ai_score in the AI-blend consumer', () => {
  // buildAiBlendInputs partitions PRs into ai-heavy vs human rework arrays.
  // With ONLY ai_score (0.4 = human, 0.6 = ai-heavy) one PR lands in each.
  // After recording verdicts that REVERSE both calls, the partition flips —
  // proving the verdict, not the deterministic score, drove the decision.
  function pr(id) {
    return {
      id,
      authorIdentityId: 'id-dev',
      state: 'merged',
    }
  }
  const identityIds = new Set(['id-dev'])
  const bots = new Set()
  const reviewsByPr = new Map([
    ['pr-low', []],
    ['pr-high', []],
  ])
  const commentsByPr = new Map([
    ['pr-low', [{ authorIdentityId: 'id-reviewer' }, { authorIdentityId: 'id-reviewer' }]],
    ['pr-high', [{ authorIdentityId: 'id-reviewer' }]],
  ])

  it('falls back to threshold when no verdict is recorded', () => {
    const aiByEntity = new Map([
      ['pr-low', { aiScore: 0.4, llmVerdict: null }],
      ['pr-high', { aiScore: 0.6, llmVerdict: null }],
    ])
    const inp = buildAiBlendInputs(
      [pr('pr-low'), pr('pr-high')],
      aiByEntity,
      [0.4, 0.6],
      reviewsByPr,
      commentsByPr,
      identityIds,
      bots,
    )
    // pr-high (score 0.6 ≥ 0.5) → 1 ai-heavy sample; pr-low → 1 human sample.
    expect(inp.aiHeavyRework).toEqual([1])
    expect(inp.humanRework).toEqual([2])
  })

  it('uses llmVerdict over the deterministic score when present', () => {
    // Verdicts FLIP both calls relative to the score threshold.
    const aiByEntity = new Map([
      ['pr-low', { aiScore: 0.4, llmVerdict: true }], // score human → verdict AI
      ['pr-high', { aiScore: 0.6, llmVerdict: false }], // score AI → verdict human
    ])
    const inp = buildAiBlendInputs(
      [pr('pr-low'), pr('pr-high')],
      aiByEntity,
      [0.4, 0.6],
      reviewsByPr,
      commentsByPr,
      identityIds,
      bots,
    )
    // Partition is now flipped: pr-low is ai-heavy, pr-high is human.
    expect(inp.aiHeavyRework).toEqual([2])
    expect(inp.humanRework).toEqual([1])
  })
})
