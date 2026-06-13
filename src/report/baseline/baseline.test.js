import { describe, expect, it } from 'bun:test'
import { compareToBaseline } from './compare.js'
import { polarityFor } from './polarity.js'
import { buildBaselineRecord } from './record.js'
import { classifyDrift, MIN_BASELINE_N, summarize } from './stats.js'

describe('summarize', () => {
  it('computes p50/mean and suppresses p90 below the sample floor', () => {
    const s = summarize([1, 2, 3, 4, 5])
    expect(s.n).toBe(5)
    expect(s.p50).toBe(3)
    expect(s.mean).toBe(3)
    expect(s.sd).not.toBeNull()
    expect(s.p90).toBeNull() // n < 20
  })

  it('emits p90 once the sample floor (n>=20) is met', () => {
    const s = summarize(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(s.p90).not.toBeNull()
  })

  it('handles empty + nulls', () => {
    const s = summarize([null, null])
    expect(s.n).toBe(0)
    expect(s.p50).toBeNull()
    expect(s.sd).toBeNull()
  })
})

describe('classifyDrift', () => {
  it('cold_start when there is no prior', () => {
    expect(classifyDrift(5, null).driftStatus).toBe('cold_start')
  })
  it('regime_change on a large p50 shift relative to dispersion', () => {
    const prior = summarize([10, 10, 11, 9, 10, 10])
    const d = classifyDrift(40, prior)
    expect(d.driftStatus).toBe('regime_change')
    expect(d.driftZ).not.toBeNull()
  })
  it('stable on a small shift', () => {
    const prior = summarize([10, 12, 11, 9, 10, 11, 10, 12])
    expect(classifyDrift(10.5, prior).driftStatus).toBe('stable')
  })
})

describe('compareToBaseline', () => {
  const baseline = [4, 4, 5, 4, 4, 5, 4, 4] // p50 = 4

  it('flags a significant upward move with band + delta', () => {
    const c = compareToBaseline({ value: 8, baselineValues: baseline })
    expect(c.significant).toBe(true)
    expect(c.trendArrow).toBe('up')
    expect(c.delta).toBe(4)
    expect(c.band === 'above' || c.band === 'well_above').toBe(true)
    expect(c.percentileWithin).toBe(1) // 8 is above every baseline value
  })

  it('reports "within normal variance" for a small move', () => {
    const c = compareToBaseline({ value: 4, baselineValues: baseline })
    expect(c.significant).toBe(false)
    expect(c.trendArrow).toBe('steady')
    expect(c.note).toBe('within normal variance')
  })

  it('suppresses comparison below the baseline floor', () => {
    const c = compareToBaseline({ value: 5, baselineValues: [4, 4] })
    expect(c.significant).toBe(false)
    expect(c.band).toBe('unknown')
    expect(c.note).toContain('insufficient baseline')
    expect(c.n).toBeLessThan(MIN_BASELINE_N)
  })

  it('handles a null current value', () => {
    const c = compareToBaseline({ value: null, baselineValues: baseline })
    expect(c.note).toBe('no current value')
    expect(c.delta).toBeNull()
  })
})

describe('polarityFor', () => {
  it('classifies lower/higher/neutral', () => {
    expect(polarityFor('flow.cycle_time')).toBe('lower_better')
    expect(polarityFor('flow.throughput')).toBe('higher_better')
    expect(polarityFor('flow.cfd')).toBe('neutral')
    expect(polarityFor('unknown.metric')).toBe('neutral')
  })
})

describe('buildBaselineRecord', () => {
  it('builds a persistable record with drift + data_quality', () => {
    const rec = buildBaselineRecord({
      scopeType: 'team',
      scopeId: 'platform',
      metric: 'flow.cycle_time',
      baselineKind: 'self',
      periodKey: 'rolling-90d',
      asOfDay: '2026-05-31',
      windowKind: 'days',
      windowFrom: '2026-03-02',
      windowTo: '2026-05-31',
      values: [4, 5, 4, 6, 5, 4],
      prior: null,
      trustTier: 'deterministic',
      ingestWatermarkVersion: '1',
      coverageFingerprint: 'cov-1',
      computedAt: '2026-06-01T00:00:00.000Z',
    })
    expect(rec.metric).toBe('flow.cycle_time')
    expect(rec.n).toBe(6)
    expect(rec.dataQuality).toBe('ok')
    expect(rec.driftStatus).toBe('cold_start')
    expect(rec.baselineVersion).toBe('1')
    expect(rec.superseded).toBe(false)
  })
})
