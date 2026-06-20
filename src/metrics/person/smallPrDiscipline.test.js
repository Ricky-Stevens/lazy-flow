import { describe, expect, it } from 'bun:test'
import { smallPrDiscipline } from './smallPrDiscipline.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('smallPrDiscipline', () => {
  it('computes the small-PR rate on a hand example', () => {
    // 10 PRs, threshold 100: halocs <= 100 are the small ones.
    const halocs = [10, 50, 80, 100, 120, 30, 250, 90, 40, 500]
    // small (<=100): 10,50,80,100,30,90,40 = 7 of 10
    const r = smallPrDiscipline.compute({ halocs, smallThreshold: 100, wipNow: 3 }, ASOF)
    expect(r.value).toBeCloseTo(0.7, 10)
    expect(r.smallPrRate).toBeCloseTo(0.7, 10)
    expect(r.smallPrs).toBe(7)
    expect(r.totalPrs).toBe(10)
    expect(r.wipNow).toBe(3)
    expect(r.medianHaloc).toBeCloseTo(85, 10)
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('ratio')
    expect(r.id).toBe('person.wip_small_pr_discipline')
    expect(r.trustTier).toBe('deterministic')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when there are no merged PRs', () => {
    const r = smallPrDiscipline.compute({ halocs: [], smallThreshold: 100, wipNow: null }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.smallPrRate).toBeNull()
    expect(r.smallPrs).toBe(0)
    expect(r.medianHaloc).toBeNull()
    expect(r.totalPrs).toBe(0)
  })

  it('flags insufficient_sample below the floor but still computes', () => {
    // 3 PRs (< 8): all <= threshold → rate 1, but flagged.
    const r = smallPrDiscipline.compute(
      { halocs: [10, 20, 30], smallThreshold: 100, wipNow: 1 },
      ASOF,
    )
    expect(r.value).toBe(1)
    expect(r.smallPrs).toBe(3)
    expect(r.totalPrs).toBe(3)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles an all-equal sample at the threshold boundary', () => {
    // All halocs exactly == threshold count as small (<=).
    const halocs = [100, 100, 100, 100, 100, 100, 100, 100]
    const r = smallPrDiscipline.compute({ halocs, smallThreshold: 100, wipNow: 0 }, ASOF)
    expect(r.value).toBe(1)
    expect(r.smallPrs).toBe(8)
    expect(r.medianHaloc).toBe(100)
    expect(r.dataQuality).toBe('ok')
  })
})
