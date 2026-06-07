/**
 * Alignment tests — WP-AI-ALIGNMENT (SPEC §9.2.1)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import {
  applyEvidenceGuard,
  applyMinRule,
  computeCoverageRatio,
  coverageRatioToOrdinal,
} from './evidenceGuard.js'
import { parseAcceptanceCriteria, rankDiffHunks, scoreHunkRelevance } from './featurePack.js'
import { runAlignment } from './runAlignment.js'
import type { AlignmentLlmOutput, CriterionCoverage, DiffHunk } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

// ─── parseAcceptanceCriteria ──────────────────────────────────────────────────

describe('parseAcceptanceCriteria', () => {
  it('parses bullets after an "Acceptance Criteria" heading', () => {
    const desc = `
Some description.

## Acceptance Criteria
- User can log in with email
- User sees an error on invalid password
- Session expires after 30 minutes
    `
    const criteria = parseAcceptanceCriteria(desc)
    expect(criteria).toHaveLength(3)
    expect(criteria[0]?.text).toBe('User can log in with email')
    expect(criteria[2]?.text).toBe('Session expires after 30 minutes')
  })

  it('falls back to all bullets when no AC heading found', () => {
    const desc = `
- Add retry logic
- Log errors to Sentry
    `
    const criteria = parseAcceptanceCriteria(desc)
    expect(criteria.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty array for empty description', () => {
    expect(parseAcceptanceCriteria('')).toHaveLength(0)
  })

  it('assigns sequential indices', () => {
    const desc = `## Acceptance Criteria\n- First\n- Second\n- Third`
    const criteria = parseAcceptanceCriteria(desc)
    expect(criteria.map((c) => c.index)).toEqual([0, 1, 2])
  })
})

// ─── scoreHunkRelevance ───────────────────────────────────────────────────────

describe('scoreHunkRelevance', () => {
  it('returns 0 for empty criteria', () => {
    expect(scoreHunkRelevance('some diff content here', [])).toBe(0)
  })

  it('returns a higher score when hunk contains criterion keywords', () => {
    const criteria = [{ index: 0, text: 'user login authentication token' }]
    const relevantHunk = '+  const token = authenticateUser(loginCredentials)'
    const irrelevantHunk = '+  console.log("session expiry check ran")'
    expect(scoreHunkRelevance(relevantHunk, criteria)).toBeGreaterThan(
      scoreHunkRelevance(irrelevantHunk, criteria),
    )
  })

  it('returns 0 for empty hunk', () => {
    const criteria = [{ index: 0, text: 'user login' }]
    expect(scoreHunkRelevance('', criteria)).toBe(0)
  })
})

// ─── rankDiffHunks ────────────────────────────────────────────────────────────

describe('rankDiffHunks', () => {
  it('sorts hunks descending by relevance score', () => {
    const criteria = [{ index: 0, text: 'authentication login user token' }]
    const hunks = [
      { filePath: 'a.ts', content: 'console.log("no match here at all")' },
      { filePath: 'b.ts', content: 'authenticateUser(token) login user' },
    ]
    const ranked = rankDiffHunks(hunks, criteria)
    expect(ranked[0]?.filePath).toBe('b.ts')
    expect(ranked[1]?.filePath).toBe('a.ts')
  })
})

// ─── applyEvidenceGuard ───────────────────────────────────────────────────────

describe('applyEvidenceGuard', () => {
  const criteria = [
    { index: 0, text: 'user session expiry logout token' },
    { index: 1, text: 'database connection retry error' },
  ]

  it('passes "yes" through when evidence is relevant', () => {
    const hunks: DiffHunk[] = [
      {
        filePath: 'auth.ts',
        content: '+ expireSession(user, token, logout)',
        relevanceScore: 0.4,
      },
    ]
    const input: CriterionCoverage[] = [
      { index: 0, covered: 'yes', evidence: 'expireSession(user, token, logout)' },
    ]
    const result = applyEvidenceGuard(input, criteria, hunks)
    expect(result[0]?.covered).toBe('yes')
  })

  it('demotes "yes" to "unclear" when evidence quote has no tokens matching the criterion', () => {
    // The key negative test: an LLM quotes a real diff hunk (a formatting line)
    // as evidence for "user session expiry logout token", but the hunk has no
    // domain tokens in common with the criterion → demoted to 'unclear'.
    const hunks: DiffHunk[] = [
      {
        filePath: 'logger.ts',
        // No overlap with criterion tokens (user/session/expiry/logout/token)
        content: '+ fmt.Printf("request received")',
        relevanceScore: 0.01, // well below RELEVANCE_THRESHOLD
      },
    ]
    const input: CriterionCoverage[] = [
      {
        index: 0,
        covered: 'yes',
        // Evidence from the logging hunk — tokens: fmt, printf, request, received
        // Criterion tokens: user, session, expiry, logout, token
        // Intersection = 0 → score = 0 < RELEVANCE_THRESHOLD → demote
        evidence: 'fmt.Printf("request received")',
      },
    ]
    const result = applyEvidenceGuard(input, criteria, hunks)
    expect(result[0]?.covered).toBe('unclear')
  })

  it('demotes "yes" to "unclear" when evidence is empty', () => {
    const input: CriterionCoverage[] = [{ index: 0, covered: 'yes', evidence: '' }]
    const result = applyEvidenceGuard(input, criteria, [])
    expect(result[0]?.covered).toBe('unclear')
  })

  it('passes "no" and "unclear" through unchanged', () => {
    const input: CriterionCoverage[] = [
      { index: 0, covered: 'no', evidence: '' },
      { index: 1, covered: 'unclear', evidence: 'some text' },
    ]
    const result = applyEvidenceGuard(input, criteria, [])
    expect(result[0]?.covered).toBe('no')
    expect(result[1]?.covered).toBe('unclear')
  })
})

// ─── computeCoverageRatio ─────────────────────────────────────────────────────

describe('computeCoverageRatio', () => {
  it('returns 0 for empty criteria', () => {
    expect(computeCoverageRatio([])).toBe(0)
  })

  it('computes ratio correctly', () => {
    const criteria: CriterionCoverage[] = [
      { index: 0, covered: 'yes', evidence: 'e' },
      { index: 1, covered: 'yes', evidence: 'e' },
      { index: 2, covered: 'no', evidence: '' },
      { index: 3, covered: 'unclear', evidence: '' },
    ]
    expect(computeCoverageRatio(criteria)).toBeCloseTo(0.5)
  })

  it('returns 1.0 when all criteria are covered', () => {
    const criteria: CriterionCoverage[] = [
      { index: 0, covered: 'yes', evidence: 'e' },
      { index: 1, covered: 'yes', evidence: 'e' },
    ]
    expect(computeCoverageRatio(criteria)).toBe(1.0)
  })
})

// ─── coverageRatioToOrdinal ───────────────────────────────────────────────────

describe('coverageRatioToOrdinal', () => {
  it('maps 0 → "0"', () => expect(coverageRatioToOrdinal(0)).toBe('0'))
  it('maps 0.1 → "1"', () => expect(coverageRatioToOrdinal(0.1)).toBe('1'))
  it('maps 0.5 → "3"', () => expect(coverageRatioToOrdinal(0.5)).toBe('3'))
  it('maps 1.0 → "4"', () => expect(coverageRatioToOrdinal(1.0)).toBe('4'))
  it('maps 0.75 → "4"', () => expect(coverageRatioToOrdinal(0.75)).toBe('4'))
})

// ─── applyMinRule ─────────────────────────────────────────────────────────────

describe('applyMinRule', () => {
  it('returns the lower ordinal', () => {
    expect(applyMinRule('4', '2')).toBe('2')
    expect(applyMinRule('1', '3')).toBe('1')
    expect(applyMinRule('3', '3')).toBe('3')
  })
})

// ─── runAlignment integration ─────────────────────────────────────────────────

describe('runAlignment', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  const baseFeaturePackInput = {
    issueKey: 'PROJ-42',
    issueType: 'Story',
    issueSummary: 'User authentication flow',
    issueDescription: `
## Acceptance Criteria
- User can login with email and password
- Invalid credentials show an error message
- Session token expires after 30 minutes
    `,
    prTitle: 'feat: implement login with token expiry',
    prBody: 'Implements the login endpoint with session token expiry.',
    commitMessages: ['feat: add login handler', 'feat: add token expiry check'],
    rawDiffHunks: [
      {
        filePath: 'src/auth/login.ts',
        content:
          '+ authenticateUser(email, password)\n+ const token = createSessionToken(user)\n+ expireAfter(token, 30 * 60)',
      },
      {
        filePath: 'src/auth/errors.ts',
        content: '+ throw new InvalidCredentialsError("Invalid email or password")',
      },
    ],
  }

  it('a criterion with a relevant quoted hunk is marked "yes"', async () => {
    // The LLM returns "yes" with a relevant evidence quote that passes the guard
    const llmOutput: AlignmentLlmOutput = {
      ordinal: '3',
      criteria: [
        {
          index: 0,
          covered: 'yes',
          evidence: 'authenticateUser(email, password)',
        },
        {
          index: 1,
          covered: 'yes',
          evidence: 'throw new InvalidCredentialsError("Invalid email or password")',
        },
        { index: 2, covered: 'yes', evidence: 'expireAfter(token, 30' },
      ],
      confidence: 0.9,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const { result } = await runAlignment(
      { featurePackInput: baseFeaturePackInput, prId: 'pr-1' },
      client,
      store,
      cache,
    )

    // At least criterion 0 should pass the guard (email/password tokens match)
    const c0 = result.criteria.find((c) => c.index === 0)
    expect(c0?.covered).toBe('yes')
  })

  it('a criterion whose only quote is irrelevant is demoted to "unclear" (key negative test)', async () => {
    // The LLM tries to claim criterion 2 (session expiry) is covered by a logging line.
    // The logging line has no domain-specific tokens matching "session token expires"
    // so the evidence-relevance guard should demote it to 'unclear'.
    const llmOutput: AlignmentLlmOutput = {
      ordinal: '4',
      criteria: [
        { index: 0, covered: 'yes', evidence: 'authenticateUser(email, password)' },
        { index: 1, covered: 'yes', evidence: 'throw new InvalidCredentialsError' },
        {
          index: 2,
          covered: 'yes',
          // Irrelevant logging hunk — no "session", "token", "expire" tokens
          evidence: 'console.log("request received")',
        },
      ],
      confidence: 0.95,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const { result } = await runAlignment(
      { featurePackInput: baseFeaturePackInput, prId: 'pr-2' },
      client,
      store,
      cache,
    )

    // Criterion 2 evidence is irrelevant → demoted to 'unclear'
    const c2 = result.criteria.find((c) => c.index === 2)
    expect(c2?.covered).toBe('unclear')
  })

  it('coverage_ratio is computed correctly from guarded criteria', async () => {
    // 1 of 3 criteria covered after guard
    const llmOutput: AlignmentLlmOutput = {
      ordinal: '2',
      criteria: [
        { index: 0, covered: 'yes', evidence: 'authenticateUser(email, password)' },
        { index: 1, covered: 'no', evidence: '' },
        { index: 2, covered: 'no', evidence: '' },
      ],
      confidence: 0.7,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const { result } = await runAlignment(
      { featurePackInput: baseFeaturePackInput, prId: 'pr-3' },
      client,
      store,
      cache,
    )

    // 1/3 covered → ~0.33
    expect(result.coverageRatio).toBeCloseTo(1 / 3, 1)
  })

  it('min-rule: final ordinal is min(llm ordinal, coverage-ratio band)', async () => {
    // LLM returns ordinal '4' but only 1/3 criteria covered (coverage band = '1')
    const llmOutput: AlignmentLlmOutput = {
      ordinal: '4',
      criteria: [
        { index: 0, covered: 'yes', evidence: 'authenticateUser(email, password)' },
        { index: 1, covered: 'no', evidence: '' },
        { index: 2, covered: 'no', evidence: '' },
      ],
      confidence: 0.8,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const { result } = await runAlignment(
      { featurePackInput: baseFeaturePackInput, prId: 'pr-4' },
      client,
      store,
      cache,
    )

    // Coverage ratio ~0.33 → band '1'; LLM says '4' → min = '1'
    expect(Number(result.ordinal)).toBeLessThan(Number(result.rawOrdinal))
    expect(['0', '1', '2']).toContain(result.ordinal)
  })

  it('handles LLM refusal gracefully (returns ordinal 0)', async () => {
    const client = new FakeLlmClient([{ value: null, stopReason: 'refusal' }])
    const { result } = await runAlignment(
      { featurePackInput: baseFeaturePackInput, prId: 'pr-5' },
      client,
      store,
      cache,
    )

    expect(result.ordinal).toBe('0')
    expect(result.criteria).toHaveLength(0)
    expect(result.confidence).toBe(0)
  })
})
