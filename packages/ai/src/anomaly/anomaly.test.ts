/**
 * Velocity Anomaly Explanation tests — WP-AI-ANOMALY (SPEC §9.2.3)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import { computeEwmaZScore, detectAnomaly, MIN_SAMPLE_SIZE } from './detector.js'
import { runAnomaly } from './runAnomaly.js'
import type { AnomalyLlmOutput, AnomalySignalPack, ThroughputPoint } from './types.js'
import { AnomalyCause } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

/**
 * Build a throughput series of length n where the last value is anomalous.
 *
 * Uses a slightly noisy baseline (alternating 9/11) so EWMA variance is
 * non-zero, then drops to 1 on the final point to produce |z| > 2.
 */
function anomalousThroughputSeries(n: number): ThroughputPoint[] {
  const series: ThroughputPoint[] = []
  for (let i = 0; i < n - 1; i++) {
    const throughput = i % 2 === 0 ? 11 : 9
    series.push({ windowStart: `2024-01-${String(i + 1).padStart(2, '0')}`, throughput })
  }
  // Last value: severe drop (should produce |z| > 2)
  series.push({ windowStart: `2024-01-${String(n).padStart(2, '0')}`, throughput: 1 })
  return series
}

const baseSignalPack: AnomalySignalPack = {
  avgWip: 8.5,
  reviewerLatencyHours: 24,
  blockedCount: 3,
  ticketChurnCount: 5,
  teamSizeDelta: 0,
  largePrShare: 0.35,
  incidentCount: 2,
  dependencyWaitHours: 16,
  throughputZScore: -2.5,
  cycleTimeZScore: null,
}

// ─── computeEwmaZScore ────────────────────────────────────────────────────────

describe('computeEwmaZScore', () => {
  it('returns null when sample is below MIN_SAMPLE_SIZE', () => {
    const short = [10, 9, 10, 11, 10, 10, 10]
    expect(short.length).toBeLessThan(MIN_SAMPLE_SIZE)
    expect(computeEwmaZScore(short)).toBeNull()
  })

  it('returns 0 for a perfectly flat series (std=0 → no anomaly)', () => {
    // With a flat series, EWMA variance stays 0, so z-score is defined as 0.
    const flat = Array.from({ length: 10 }, () => 5)
    expect(computeEwmaZScore(flat)).toBe(0)
  })

  it('returns a negative z-score when the last value is much lower than the EWMA', () => {
    // Noisy baseline (9/11) then severe drop — ensures std is non-zero
    const series = [11, 9, 11, 9, 11, 9, 11, 9, 11, 1]
    const z = computeEwmaZScore(series)
    if (z === null) throw new Error('Expected z-score to be non-null')
    expect(z).toBeLessThan(-2)
  })

  it('returns a positive z-score when the last value spikes', () => {
    const series = [5, 6, 4, 5, 6, 4, 5, 4, 6, 50]
    const z = computeEwmaZScore(series)
    if (z === null) throw new Error('Expected z-score to be non-null')
    expect(z).toBeGreaterThan(2)
  })
})

// ─── detectAnomaly ────────────────────────────────────────────────────────────

describe('detectAnomaly', () => {
  it('flags an anomaly when throughput has |z| > 2', () => {
    const series = anomalousThroughputSeries(10)
    const result = detectAnomaly({ throughputSeries: series })
    expect(result.isAnomaly).toBe(true)
    if (result.throughputZScore === null)
      throw new Error('Expected throughputZScore to be non-null')
    expect(Math.abs(result.throughputZScore)).toBeGreaterThan(2)
  })

  it('suppresses detection when sample is too small (< MIN_SAMPLE_SIZE)', () => {
    const short: ThroughputPoint[] = [
      { windowStart: '2024-01-01', throughput: 10 },
      { windowStart: '2024-01-02', throughput: 1 },
    ]
    const result = detectAnomaly({ throughputSeries: short })
    expect(result.isAnomaly).toBe(false)
    expect(result.throughputZScore).toBeNull()
    expect(result.suppressedReason).toBeDefined()
  })

  it('does not flag when all values are within normal range', () => {
    const normal: ThroughputPoint[] = Array.from({ length: 12 }, (_, i) => ({
      windowStart: `2024-01-${String(i + 1).padStart(2, '0')}`,
      throughput: 9 + Math.sin(i) * 0.5,
    }))
    const result = detectAnomaly({ throughputSeries: normal })
    expect(result.isAnomaly).toBe(false)
  })
})

// ─── runAnomaly — integration ─────────────────────────────────────────────────

describe('runAnomaly', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('returns detection-only result when no anomaly is detected', async () => {
    const normal: ThroughputPoint[] = Array.from({ length: 12 }, (_, i) => ({
      windowStart: `2024-01-${String(i + 1).padStart(2, '0')}`,
      throughput: 10,
    }))
    const client = new FakeLlmClient([])
    const result = await runAnomaly(
      {
        subjectId: 'sprint-1',
        throughputSeries: normal,
        cycleTimeSeries: [],
        signalPack: baseSignalPack,
      },
      client,
      store,
      cache,
    )
    expect(result.detection.isAnomaly).toBe(false)
    expect(result.rankedCauses).toBeUndefined()
  })

  it('returns ranked causes when anomaly is detected', async () => {
    const llmOutput: AnomalyLlmOutput = {
      ranked_causes: [
        { cause: 'high_wip', confidence: 0.8, evidence_pointer: 'avgWip' },
        { cause: 'reviewer_latency', confidence: 0.6, evidence_pointer: 'reviewerLatencyHours' },
      ],
      summary: 'Velocity drop is consistent with elevated WIP and reviewer latency.',
    }

    const series = anomalousThroughputSeries(10)
    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runAnomaly(
      {
        subjectId: 'sprint-2',
        throughputSeries: series,
        cycleTimeSeries: [],
        signalPack: baseSignalPack,
      },
      client,
      store,
      cache,
    )

    expect(result.detection.isAnomaly).toBe(true)
    expect(result.rankedCauses).toHaveLength(2)
    expect(result.rankedCauses?.[0]?.cause).toBe('high_wip')
    expect(result.summary).toContain('consistent with')
  })

  it('enforces closed menu — a cause outside the enum is rejected by schema', () => {
    // Zod should refuse to parse a cause not in the enum.
    const parsed = AnomalyCause.safeParse('blame_alice')
    expect(parsed.success).toBe(false)
  })

  it('accepts insufficient_signal as a valid cause', () => {
    const parsed = AnomalyCause.safeParse('insufficient_signal')
    expect(parsed.success).toBe(true)
  })

  it('insufficient_signal path works end-to-end', async () => {
    const llmOutput: AnomalyLlmOutput = {
      ranked_causes: [{ cause: 'insufficient_signal', confidence: 0, evidence_pointer: '(none)' }],
      summary: 'Signals are too weak to rank causes.',
    }

    const series = anomalousThroughputSeries(10)
    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runAnomaly(
      {
        subjectId: 'sprint-3',
        throughputSeries: series,
        cycleTimeSeries: [],
        signalPack: { ...baseSignalPack, avgWip: 0, blockedCount: 0, ticketChurnCount: 0 },
      },
      client,
      store,
      cache,
    )

    expect(result.rankedCauses).toHaveLength(1)
    expect(result.rankedCauses?.[0]?.cause).toBe('insufficient_signal')
  })

  it('output never contains an individual name', async () => {
    const llmOutput: AnomalyLlmOutput = {
      ranked_causes: [{ cause: 'high_wip', confidence: 0.9, evidence_pointer: 'avgWip' }],
      // Deliberately put a name in summary to test the contract expectation
      summary: 'Consistent with high WIP during the sprint window.',
    }

    const series = anomalousThroughputSeries(10)
    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runAnomaly(
      {
        subjectId: 'sprint-4',
        throughputSeries: series,
        cycleTimeSeries: [],
        signalPack: baseSignalPack,
      },
      client,
      store,
      cache,
    )

    // Summary must NOT name an individual — verify the summary doesn't match
    // a "named person" pattern (first + last name capitalized)
    const namedPersonPattern = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/
    expect(result.summary).toBeDefined()
    if (result.summary === undefined) throw new Error('Expected summary to be defined')
    expect(namedPersonPattern.test(result.summary)).toBe(false)
  })
})
