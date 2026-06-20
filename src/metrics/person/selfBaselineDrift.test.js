import { describe, expect, it } from 'bun:test'

import { selfBaselineDrift } from './selfBaselineDrift.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('selfBaselineDrift', () => {
  it('computes headline driftZ against the trailing baseline', () => {
    // baseline p50=10, sd=2, mad=0 → robustSd = max(2, 0, eps) = 2
    // current p50=14 → delta=4, z = 4/2 = 2 → regime_change (|z|>=2)
    const out = selfBaselineDrift.compute(
      { currentP50: 14, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 8 },
      ASOF,
    )
    expect(out.value).toBeCloseTo(2, 9)
    expect(out.driftZ).toBeCloseTo(2, 9)
    expect(out.driftStatus).toBe('regime_change')
    expect(out.dataQuality).toBe('ok')
    expect(out.unit).toBe('zscore')
    expect(out.currentP50).toBe(14)
    expect(out.baselineP50).toBe(10)
    expect(out.baselineN).toBe(8)
  })

  it('bands a small move as stable', () => {
    // delta=1, robustSd=2 → z=0.5 → |z|<1 → stable
    const out = selfBaselineDrift.compute(
      { currentP50: 11, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 8 },
      ASOF,
    )
    expect(out.driftStatus).toBe('stable')
    expect(out.driftZ).toBeCloseTo(0.5, 9)
  })

  it('returns no_data when there is no current sample', () => {
    const out = selfBaselineDrift.compute(
      { currentP50: null, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 8 },
      ASOF,
    )
    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
    expect(out.driftStatus).toBe('no_data')
    expect(out.driftZ).toBeNull()
  })

  it('is establishing below the baseline floor and still surfaces the level', () => {
    const out = selfBaselineDrift.compute(
      { currentP50: 14, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 3 },
      ASOF,
    )
    expect(out.value).toBe(14)
    expect(out.dataQuality).toBe('insufficient_sample')
    expect(out.driftStatus).toBe('establishing')
    expect(out.driftZ).toBeNull()
  })

  it('respects a custom minN', () => {
    const ok = selfBaselineDrift.compute(
      { currentP50: 14, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 5, minN: 4 },
      ASOF,
    )
    expect(ok.dataQuality).toBe('ok')
    const establishing = selfBaselineDrift.compute(
      { currentP50: 14, baseline: { p50: 10, sd: 2, mad: 0 }, baselineN: 5, minN: 6 },
      ASOF,
    )
    expect(establishing.dataQuality).toBe('insufficient_sample')
  })

  it('handles a flat (all-equal) baseline via relative classification', () => {
    // degenerate dispersion: sd≈mad≈0, delta=0 → stable, driftZ=0
    const out = selfBaselineDrift.compute(
      { currentP50: 5, baseline: { p50: 5, sd: 0, mad: 0 }, baselineN: 8 },
      ASOF,
    )
    expect(out.driftStatus).toBe('stable')
    expect(out.value).toBe(0)
  })
})
