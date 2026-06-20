import { describe, expect, it } from 'bun:test'
import { complexityAuthoredDelta } from './complexityAuthoredDelta.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('complexityAuthoredDelta', () => {
  it('reports id, tier, scope, unit and asOf', () => {
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [3] }, ASOF)
    expect(complexityAuthoredDelta.id).toBe('person.complexity_authored_delta')
    expect(r.trustTier).toBe('deterministic')
    expect(r.scope).toBe('person')
    expect(r.unit).toBe('index')
    expect(r.asOf).toBe(ASOF)
  })

  it('computes median, total and p75 on a hand example', () => {
    // [2,4,6,8,10] (type-7): median p50 = 6, p75 = 8, sum = 30, n = 5
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [2, 4, 6, 8, 10] }, ASOF)
    expect(r.value).toBe(6)
    expect(r.p75).toBe(8)
    expect(r.totalDelta).toBe(30)
    expect(r.sampleSize).toBe(5)
    expect(r.dataQuality).toBe('ok')
  })

  it('returns no_data on an empty sample', () => {
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.totalDelta).toBe(0)
    expect(r.p75).toBeNull()
    expect(r.sampleSize).toBe(0)
  })

  it('treats a missing input as no_data', () => {
    const r = complexityAuthoredDelta.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    // 4 entries (< 5 floor): median of [1,3,5,7] = 4, still computable
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [1, 3, 5, 7] }, ASOF)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.value).toBe(4)
    expect(r.totalDelta).toBe(16)
  })

  it('handles a single entry (median = that value)', () => {
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [9] }, ASOF)
    expect(r.value).toBe(9)
    expect(r.p75).toBe(9)
    expect(r.totalDelta).toBe(9)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles an all-equal sample', () => {
    const r = complexityAuthoredDelta.compute({ prPositiveDeltas: [5, 5, 5, 5, 5] }, ASOF)
    expect(r.value).toBe(5)
    expect(r.p75).toBe(5)
    expect(r.totalDelta).toBe(25)
    expect(r.dataQuality).toBe('ok')
  })
})
