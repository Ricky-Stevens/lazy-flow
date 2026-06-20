import { describe, expect, it } from 'bun:test'
import { feedbackResponseLatency } from './feedbackResponseLatency.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('feedbackResponseLatency', () => {
  it('reports p50 headline plus p75 on a hand example (R-7 interpolation)', () => {
    // [10,20,30,40,50]: p50 -> idx 2 = 30, p75 -> idx 3 = 40. <20 samples so p90 null.
    const r = feedbackResponseLatency.compute({ samples: [50, 10, 30, 20, 40] }, ASOF)
    expect(r.value).toBe(30)
    expect(r.p75).toBe(40)
    expect(r.p90).toBeNull()
    expect(r.sampleSize).toBe(5)
    expect(r.unit).toBe('seconds')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('pr.feedback_response_latency')
    expect(r.asOf).toBe(ASOF)
  })

  it('emits p90 once the sample reaches the floor of 20', () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100)
    const r = feedbackResponseLatency.compute({ samples }, ASOF)
    // p90: h = 19*0.9 = 17.1 -> sorted[17]=1800 + 0.1*(1900-1800) = 1810
    expect(r.p90).toBeCloseTo(1810, 6)
    expect(r.dataQuality).toBe('ok')
  })

  it('returns no_data on an empty sample', () => {
    const r = feedbackResponseLatency.compute({ samples: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.p75).toBeNull()
    expect(r.p90).toBeNull()
    expect(r.sampleSize).toBe(0)
  })

  it('treats missing samples input as no_data', () => {
    const r = feedbackResponseLatency.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const r = feedbackResponseLatency.compute({ samples: [120, 300] }, ASOF)
    // [120,300]: p50 -> h=0.5 -> 120 + 0.5*(300-120) = 210
    expect(r.value).toBe(210)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.p90).toBeNull()
  })

  it('handles a single observation (all-equal edge)', () => {
    const r = feedbackResponseLatency.compute({ samples: [42] }, ASOF)
    expect(r.value).toBe(42)
    expect(r.p75).toBe(42)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.sampleSize).toBe(1)
  })
})
