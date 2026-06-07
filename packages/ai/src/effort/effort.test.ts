/**
 * Effort Proportionality tests — WP-AI-EFFORT (SPEC §9.2.2)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import { runEffort } from './runEffort.js'
import {
  adjustConfidenceForDisagreement,
  computeCycleTimeZScore,
  computeLogRatio,
  detectDisagreement,
  zScoreToEffortBand,
} from './stats.js'
import type { EffortDistribution, EffortVector } from './types.js'
import {
  EFFORT_MIN_HISTORY_N,
  type EffortLlmOutput,
  EXEMPT_ISSUE_TYPES,
  INSUFFICIENT_HISTORY,
} from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

const baseVector: EffortVector = {
  haloc: 200,
  files: 10,
  commits: 5,
  cycleTime: 48,
  reviewRounds: 2,
  comments: 8,
  reworkCommits: 1,
}

const healthyDistribution: EffortDistribution = {
  n: 20,
  logHalocMean: Math.log(150 + 1),
  logHalocStd: 0.8,
  cycleTimeMean: 40,
  cycleTimeStd: 15,
}

// ─── Deterministic stats ──────────────────────────────────────────────────────

describe('computeLogRatio', () => {
  it('returns null when std is 0', () => {
    const dist: EffortDistribution = { ...healthyDistribution, logHalocStd: 0 }
    expect(computeLogRatio(baseVector, dist)).toBeNull()
  })

  it('returns a positive value when haloc is above the mean', () => {
    const result = computeLogRatio(baseVector, healthyDistribution)
    expect(result).not.toBeNull()
    if (result === null) throw new Error('expected non-null')
    expect(result).toBeGreaterThan(0)
  })

  it('returns 0 when haloc matches the mean exactly', () => {
    // log(150+1) = logHalocMean, so z = 0
    const v: EffortVector = { ...baseVector, haloc: 150 }
    const result = computeLogRatio(v, healthyDistribution)
    expect(result).toBeCloseTo(0, 5)
  })
})

describe('computeCycleTimeZScore', () => {
  it('returns null when std is 0', () => {
    const dist: EffortDistribution = { ...healthyDistribution, cycleTimeStd: 0 }
    expect(computeCycleTimeZScore(baseVector, dist)).toBeNull()
  })

  it('returns positive when cycle time is above mean', () => {
    const v: EffortVector = { ...baseVector, cycleTime: 80 } // above 40h mean
    expect(computeCycleTimeZScore(v, healthyDistribution)).toBeGreaterThan(0)
  })
})

describe('zScoreToEffortBand', () => {
  it('maps extreme low z-score to "much_lower"', () =>
    expect(zScoreToEffortBand(-3)).toBe('much_lower'))
  it('maps moderate low z-score to "lower"', () => expect(zScoreToEffortBand(-1)).toBe('lower'))
  it('maps near-zero z-score to "as_expected"', () =>
    expect(zScoreToEffortBand(0)).toBe('as_expected'))
  it('maps moderate high z-score to "higher"', () => expect(zScoreToEffortBand(1)).toBe('higher'))
  it('maps extreme high z-score to "much_higher"', () =>
    expect(zScoreToEffortBand(3)).toBe('much_higher'))
})

describe('detectDisagreement', () => {
  it('detects disagreement when bands are >1 step apart', () => {
    expect(detectDisagreement('much_higher', 'as_expected')).toBe(true)
    expect(detectDisagreement('much_lower', 'higher')).toBe(true)
  })

  it('does not flag adjacent bands as disagreement', () => {
    expect(detectDisagreement('higher', 'as_expected')).toBe(false)
    expect(detectDisagreement('much_higher', 'higher')).toBe(false)
  })

  it('same band is not a disagreement', () => {
    expect(detectDisagreement('as_expected', 'as_expected')).toBe(false)
  })
})

describe('adjustConfidenceForDisagreement', () => {
  it('lowers confidence when LLM and z-score disagree', () => {
    // LLM says 'much_higher', z-score maps to 'as_expected' → disagreement
    const base = 0.8
    const adjusted = adjustConfidenceForDisagreement(base, 'much_higher', 0.1)
    expect(adjusted).toBeLessThan(base)
  })

  it('does not lower confidence when bands agree', () => {
    const base = 0.8
    const adjusted = adjustConfidenceForDisagreement(base, 'higher', 1.5)
    // z=1.5 → 'higher', same as LLM → no penalty
    expect(adjusted).toBe(base)
  })

  it('returns base confidence when z-score is null', () => {
    expect(adjustConfidenceForDisagreement(0.7, 'as_expected', null)).toBe(0.7)
  })
})

// ─── runEffort integration ────────────────────────────────────────────────────

describe('runEffort', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('cold-start (n below gate) returns "insufficient_history", NOT a band', async () => {
    const coldDistribution: EffortDistribution = {
      n: 3, // below EFFORT_MIN_HISTORY_N = 10
      logHalocMean: Math.log(100 + 1),
      logHalocStd: 0.5,
      cycleTimeMean: 30,
      cycleTimeStd: 10,
    }
    // No LLM responses needed — gate fires before LLM call
    const client = new FakeLlmClient([])
    const result = await runEffort(
      {
        vector: baseVector,
        distribution: coldDistribution,
        issueType: 'Story',
        issueSummary: 'Add feature X',
        storyPoints: 3,
        subjectId: 'pr-cold',
      },
      client,
      store,
      cache,
    )

    expect(result.band).toBe(INSUFFICIENT_HISTORY)
    expect(result.logRatio).toBeNull()
    expect(result.cycleTimeZScore).toBeNull()
    expect(result.exempt).toBe(false)
  })

  it('spike issue type is exempted — returns "insufficient_history" without LLM call', async () => {
    const client = new FakeLlmClient([]) // no responses — would throw if called
    const result = await runEffort(
      {
        vector: baseVector,
        distribution: healthyDistribution,
        issueType: 'Spike', // exempt type
        issueSummary: 'Research caching options',
        storyPoints: null,
        subjectId: 'pr-spike',
      },
      client,
      store,
      cache,
    )

    expect(result.band).toBe(INSUFFICIENT_HISTORY)
    expect(result.exempt).toBe(true)
  })

  it('research issue type is also exempted', async () => {
    const client = new FakeLlmClient([])
    const result = await runEffort(
      {
        vector: baseVector,
        distribution: healthyDistribution,
        issueType: 'Research',
        issueSummary: 'Investigate new DB options',
        storyPoints: null,
        subjectId: 'pr-research',
      },
      client,
      store,
      cache,
    )

    expect(result.band).toBe(INSUFFICIENT_HISTORY)
    expect(result.exempt).toBe(true)
  })

  it('z-score disagreement lowers confidence', async () => {
    // LLM says 'much_higher', but deterministic signals say 'as_expected'
    // cycleTime=48, mean=40, std=15 → z≈0.53 → 'higher' (adjacent, not >1 step)
    // Make the z-score even smaller to force 'as_expected'
    const dist: EffortDistribution = {
      ...healthyDistribution,
      cycleTimeMean: 46,
      cycleTimeStd: 10, // cycleTime=48, z≈0.2 → 'as_expected'
    }

    const llmOutput: EffortLlmOutput = {
      band: 'much_higher', // disagrees with z-score 'as_expected' (>1 step)
      reasoning: 'This seems very large',
      confidence: 0.85,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runEffort(
      {
        vector: baseVector,
        distribution: dist,
        issueType: 'Story',
        issueSummary: 'Implement feature',
        storyPoints: 5,
        subjectId: 'pr-disagree',
      },
      client,
      store,
      cache,
    )

    expect(result.band).toBe('much_higher')
    expect(result.confidence).toBeLessThan(0.85)
  })

  it('returns band from LLM when baseline is healthy', async () => {
    const llmOutput: EffortLlmOutput = {
      band: 'as_expected',
      reasoning: 'Within normal range',
      confidence: 0.9,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runEffort(
      {
        vector: baseVector,
        distribution: healthyDistribution,
        issueType: 'Story',
        issueSummary: 'Normal feature',
        storyPoints: 3,
        subjectId: 'pr-normal',
      },
      client,
      store,
      cache,
    )

    expect(result.band).toBe('as_expected')
    expect(result.logRatio).not.toBeNull()
    expect(result.cycleTimeZScore).not.toBeNull()
    expect(result.exempt).toBe(false)
  })

  it('EFFORT_MIN_HISTORY_N is 10', () => {
    expect(EFFORT_MIN_HISTORY_N).toBe(10)
  })

  it('EXEMPT_ISSUE_TYPES includes spike and research variants', () => {
    expect(EXEMPT_ISSUE_TYPES.has('spike')).toBe(true)
    expect(EXEMPT_ISSUE_TYPES.has('Spike')).toBe(true)
    expect(EXEMPT_ISSUE_TYPES.has('research')).toBe(true)
    expect(EXEMPT_ISSUE_TYPES.has('Research')).toBe(true)
  })
})
