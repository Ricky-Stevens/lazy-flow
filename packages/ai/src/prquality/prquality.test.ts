/**
 * PR Quality Score tests — WP-AI-PRQUALITY (SPEC §9.2.6)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import { ATOMICITY_MAX_FILES, ATOMICITY_MAX_HALOC, runDeterministicChecks } from './checks.js'
import { runPrQuality } from './runPrQuality.js'
import type { PrQualityLlmOutput } from './types.js'
import { DimensionScore } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

// ─── DimensionScore enum ──────────────────────────────────────────────────────

describe('DimensionScore', () => {
  it('accepts 0, 1, 2', () => {
    expect(DimensionScore.safeParse('0').success).toBe(true)
    expect(DimensionScore.safeParse('1').success).toBe(true)
    expect(DimensionScore.safeParse('2').success).toBe(true)
  })

  it('rejects values outside 0–2', () => {
    expect(DimensionScore.safeParse('3').success).toBe(false)
    expect(DimensionScore.safeParse('-1').success).toBe(false)
    expect(DimensionScore.safeParse('high').success).toBe(false)
  })
})

// ─── runDeterministicChecks ───────────────────────────────────────────────────

describe('runDeterministicChecks', () => {
  it('detects missing description', () => {
    const result = runDeterministicChecks({
      prTitle: 'fix stuff',
      prBody: '',
      filePaths: ['src/foo.ts'],
      haloc: 10,
    })
    expect(result.has_description).toBe(false)
  })

  it('detects present description', () => {
    const result = runDeterministicChecks({
      prTitle: 'fix stuff',
      prBody: 'This PR fixes the null dereference in the auth middleware.',
      filePaths: ['src/foo.ts'],
      haloc: 10,
    })
    expect(result.has_description).toBe(true)
  })

  it('detects JIRA issue link in title', () => {
    const result = runDeterministicChecks({
      prTitle: 'PROJ-123 fix auth',
      prBody: '',
      filePaths: [],
      haloc: 0,
    })
    expect(result.linked_issue).toBe(true)
  })

  it('detects GitHub issue link in body', () => {
    const result = runDeterministicChecks({
      prTitle: 'fix auth',
      prBody: 'Closes #456',
      filePaths: [],
      haloc: 0,
    })
    expect(result.linked_issue).toBe(true)
  })

  it('returns linked_issue=false when no reference', () => {
    const result = runDeterministicChecks({
      prTitle: 'fix auth',
      prBody: 'Some description without any issue ref.',
      filePaths: [],
      haloc: 0,
    })
    expect(result.linked_issue).toBe(false)
  })

  it('detects test files', () => {
    const result = runDeterministicChecks({
      prTitle: 'add tests',
      prBody: '',
      filePaths: ['src/auth.ts', 'src/auth.test.ts'],
      haloc: 50,
    })
    expect(result.has_tests).toBe(true)
  })

  it('returns has_tests=false when no test files', () => {
    const result = runDeterministicChecks({
      prTitle: 'refactor',
      prBody: '',
      filePaths: ['src/auth.ts', 'src/utils.ts'],
      haloc: 30,
    })
    expect(result.has_tests).toBe(false)
  })

  it('flags non-atomic when file count exceeds limit', () => {
    const filePaths = Array.from({ length: ATOMICITY_MAX_FILES + 1 }, (_, i) => `src/file${i}.ts`)
    const result = runDeterministicChecks({
      prTitle: 'big refactor',
      prBody: '',
      filePaths,
      haloc: 10,
    })
    expect(result.is_atomic).toBe(false)
  })

  it('flags non-atomic when HALOC exceeds limit', () => {
    const result = runDeterministicChecks({
      prTitle: 'big change',
      prBody: '',
      filePaths: ['src/foo.ts'],
      haloc: ATOMICITY_MAX_HALOC + 1,
    })
    expect(result.is_atomic).toBe(false)
  })

  it('is atomic when within limits', () => {
    const result = runDeterministicChecks({
      prTitle: 'small fix',
      prBody: 'Fixes null pointer.',
      filePaths: ['src/foo.ts', 'src/foo.test.ts'],
      haloc: 20,
    })
    expect(result.is_atomic).toBe(true)
  })
})

// ─── runPrQuality — integration ───────────────────────────────────────────────

describe('runPrQuality', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  const baseOpts = {
    prId: 'pr-test-1',
    prTitle: 'PROJ-42 fix null deref in auth middleware',
    prBody: 'Fixes null deref when user object is missing. No auth regression expected.',
    filePaths: ['src/auth/middleware.ts', 'src/auth/middleware.test.ts'],
    haloc: 15,
    diffSummary:
      '--- a/src/auth/middleware.ts\n+++ b/src/auth/middleware.ts\n@@ -10,6 +10,7 @@ export function authMiddleware(req, res, next) {\n+  if (!req.user) return res.status(401).end()',
  }

  it('produces deterministic checks and LLM dimensions with evidence', async () => {
    const llmOutput: PrQualityLlmOutput = {
      explains_why: { score: '2', evidence: 'Fixes null deref when user object is missing.' },
      matches_diff: { score: '2', evidence: 'if (!req.user) return res.status(401).end()' },
      risk_flags: { score: '1', evidence: 'No auth regression expected.' },
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runPrQuality(baseOpts, client, store, cache)

    expect(result.deterministic.has_description).toBe(true)
    expect(result.deterministic.linked_issue).toBe(true)
    expect(result.deterministic.has_tests).toBe(true)
    expect(result.deterministic.is_atomic).toBe(true)

    expect(result.llm).toBeDefined()
    if (!result.llm) throw new Error('Expected llm result to be defined')
    expect(result.llm.explains_why.score).toBe('2')
    expect(result.llm.explains_why.evidence).toBeTruthy()
    expect(result.llm.matches_diff.evidence).toBeTruthy()
    expect(result.llm.risk_flags.evidence).toBeTruthy()
  })

  it('LLM dimensions have scores as 0/1/2 enums', async () => {
    const llmOutput: PrQualityLlmOutput = {
      explains_why: { score: '1', evidence: 'Some partial context.' },
      matches_diff: { score: '0', evidence: 'Body does not describe the diff.' },
      risk_flags: { score: '2', evidence: 'Explicitly calls out auth impact and migration risk.' },
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runPrQuality(baseOpts, client, store, cache)

    // All scores are valid enum members
    if (!result.llm) throw new Error('Expected llm result to be defined')
    for (const dim of [result.llm.explains_why, result.llm.matches_diff, result.llm.risk_flags]) {
      const parsed = DimensionScore.safeParse(dim.score)
      expect(parsed.success).toBe(true)
    }
  })

  it('eloquence-bias negative test: terse substantive PR scores at least as high as verbose empty PR', async () => {
    // Terse but substantive: explains exactly what was fixed and why
    const terseSubstantiveLlmOutput: PrQualityLlmOutput = {
      explains_why: { score: '2', evidence: 'fix null deref; caused 5xx on login' },
      matches_diff: { score: '2', evidence: 'if (!req.user) return res.status(401)' },
      risk_flags: { score: '1', evidence: 'auth path change; low risk' },
    }

    // Eloquent but empty: beautiful prose, zero substance
    const eloquentEmptyLlmOutput: PrQualityLlmOutput = {
      explains_why: {
        score: '0',
        evidence: 'Body does not explain motivation — only restates the title.',
      },
      matches_diff: {
        score: '1',
        evidence: 'Vaguely references "improvements" without specifics.',
      },
      risk_flags: { score: '0', evidence: 'No risk assessment despite touching auth.' },
    }

    const store1 = freshStore()
    const store2 = freshStore()

    const terseClient = new FakeLlmClient([{ value: terseSubstantiveLlmOutput }])
    const eloquentClient = new FakeLlmClient([{ value: eloquentEmptyLlmOutput }])

    const terseOpts = {
      ...baseOpts,
      prId: 'pr-terse-1',
      prBody: 'fix null deref; caused 5xx on login',
    }

    const eloquentOpts = {
      ...baseOpts,
      prId: 'pr-eloquent-1',
      prBody:
        'This pull request introduces a comprehensive enhancement to our authentication pipeline, ' +
        'carefully refactoring the middleware layer with attention to cross-cutting concerns, ' +
        'ensuring a seamless and robust experience across our distributed service architecture.',
    }

    const terseResult = await runPrQuality(terseOpts, terseClient, store1, new VerdictCache())
    const eloquentResult = await runPrQuality(
      eloquentOpts,
      eloquentClient,
      store2,
      new VerdictCache(),
    )

    // Terse substantive PR must NOT score lower than eloquent empty PR
    expect(terseResult.overallScore).toBeGreaterThanOrEqual(eloquentResult.overallScore)
  })

  it('overall score is sum of all dimension scores', async () => {
    const llmOutput: PrQualityLlmOutput = {
      explains_why: { score: '2', evidence: 'Clear motivation.' },
      matches_diff: { score: '1', evidence: 'Mostly matches.' },
      risk_flags: { score: '0', evidence: 'No risk noted.' },
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runPrQuality(baseOpts, client, store, cache)

    // Deterministic: has_description=T(2) + linked_issue=T(2) + has_tests=T(2) + is_atomic=T(2) = 8
    // LLM: explains_why=2 + matches_diff=1 + risk_flags=0 = 3
    // Total: 11
    expect(result.overallScore).toBe(11)
  })
})
