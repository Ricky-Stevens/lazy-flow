/**
 * Explainable Code-Change Impact tests — WP-AI-IMPACT (SPEC §9.2.7)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import { runImpact } from './runImpact.js'
import type { ImpactRationaleOutput } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

// ─── runImpact — integration ──────────────────────────────────────────────────

describe('runImpact', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  const highImpactOpts = {
    subjectId: 'pr-impact-1',
    filePaths: [
      'src/auth/middleware.ts',
      'migrations/20240101_add_sessions.sql',
      'src/api/routes.ts',
      'src/api/handlers.ts',
      'src/config/env.ts',
      'src/utils/crypto.ts',
    ],
    haloc: 320,
    legacyRefactorLines: 80,
    totalLines: 320,
  }

  it('rationale references actual changed paths', async () => {
    const llmOutput: ImpactRationaleOutput = {
      rationale:
        'touched src/auth/middleware.ts and migrations/20240101_add_sessions.sql; high blast radius due to auth + data layer changes',
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runImpact(highImpactOpts, client, store, cache)

    expect(result.rationale).toBeDefined()
    if (result.rationale === null) throw new Error('Expected rationale to be non-null')
    // Rationale must reference at least one of the changed paths
    const rationale = result.rationale
    const mentionsPath = highImpactOpts.filePaths.some((p) => {
      const filename = p.split('/').pop() ?? p
      return rationale.includes(p) || rationale.includes(filename)
    })
    expect(mentionsPath).toBe(true)
  })

  it('magnitude comes from deterministic blend, not LLM', async () => {
    // Even if LLM returns a fake rationale, the score is deterministic
    const llmOutput: ImpactRationaleOutput = {
      rationale: 'touched auth middleware; high blast radius',
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runImpact(highImpactOpts, client, store, cache)

    // Score must be in [0, 1] and come from the deterministic blend
    expect(result.impactScore).toBeGreaterThanOrEqual(0)
    expect(result.impactScore).toBeLessThanOrEqual(1)

    // For a high-change PR (6 files, HALOC=320), score should be substantial
    expect(result.impactScore).toBeGreaterThan(0.3)
  })

  it('factors and weights are surfaced in the result', async () => {
    const llmOutput: ImpactRationaleOutput = { rationale: 'auth + migration; high blast radius' }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runImpact(highImpactOpts, client, store, cache)

    // All expected factor keys must be present
    expect(result.factors).toHaveProperty('editDiversity')
    expect(result.factors).toHaveProperty('halocNorm')
    expect(result.factors).toHaveProperty('fileCountNorm')
    expect(result.factors).toHaveProperty('changeEntropy')
    expect(result.factors).toHaveProperty('oldCodePct')

    // All expected weight keys must be present
    expect(result.weights).toHaveProperty('editDiversity')
    expect(result.weights).toHaveProperty('halocNorm')
    expect(result.weights).toHaveProperty('fileCountNorm')
    expect(result.weights).toHaveProperty('changeEntropy')
    expect(result.weights).toHaveProperty('oldCodePct')
  })

  it('weightOverrides change the score', async () => {
    const llmOutput: ImpactRationaleOutput = { rationale: 'minor change to utils' }
    const llmOutput2: ImpactRationaleOutput = { rationale: 'minor change to utils' }

    const store2 = freshStore()

    const client1 = new FakeLlmClient([{ value: llmOutput }])
    const client2 = new FakeLlmClient([{ value: llmOutput2 }])

    const baseResult = await runImpact(
      { ...highImpactOpts, subjectId: 'pr-w1' },
      client1,
      store,
      cache,
    )
    const overrideResult = await runImpact(
      {
        ...highImpactOpts,
        subjectId: 'pr-w2',
        // Heavily weight HALOC, zero out others — different score expected
        weightOverrides: {
          editDiversity: 0,
          halocNorm: 1.0,
          fileCountNorm: 0,
          changeEntropy: 0,
          oldCodePct: 0,
        },
      },
      client2,
      store2,
      new VerdictCache(),
    )

    // Scores should differ when weights differ
    expect(baseResult.impactScore).not.toBe(overrideResult.impactScore)
  })

  it('returns null rationale when LLM returns null', async () => {
    const client = new FakeLlmClient([{ value: null, stopReason: 'refusal' }])
    const result = await runImpact(highImpactOpts, client, store, cache)

    // Score still deterministic
    expect(result.impactScore).toBeGreaterThanOrEqual(0)
    // Rationale is null
    expect(result.rationale).toBeNull()
  })

  it('low-impact change produces low score', async () => {
    const llmOutput: ImpactRationaleOutput = {
      rationale: 'minor tweak to a single utility function',
    }
    const client = new FakeLlmClient([{ value: llmOutput }])

    const result = await runImpact(
      {
        subjectId: 'pr-low-1',
        filePaths: ['src/utils/format.ts'],
        haloc: 5,
        legacyRefactorLines: 0,
        totalLines: 5,
      },
      client,
      store,
      cache,
    )

    expect(result.impactScore).toBeLessThan(0.5)
  })
})
