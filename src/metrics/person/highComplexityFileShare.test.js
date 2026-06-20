import { describe, expect, it } from 'bun:test'
import { highComplexityFileShare } from './highComplexityFileShare.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('highComplexityFileShare', () => {
  it('computes the headline share, coverage, and prCountShare on a hand example', () => {
    const r = highComplexityFileShare.compute(
      {
        highLineWeight: 300,
        coveredLineWeight: 1000,
        totalLineWeight: 1000,
        highFilePrCount: 4,
        coveredPrCount: 10,
      },
      ASOF,
    )
    expect(r.value).toBeCloseTo(0.3, 10)
    expect(r.coverage).toBeCloseTo(1, 10)
    expect(r.prCountShare).toBeCloseTo(0.4, 10)
    expect(r.dataQuality).toBe('ok')
    expect(r.highLineWeight).toBe(300)
    expect(r.coveredLineWeight).toBe(1000)
    expect(r.unit).toBe('ratio')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when coveredLineWeight is 0', () => {
    const r = highComplexityFileShare.compute(
      { highLineWeight: 0, coveredLineWeight: 0, totalLineWeight: 500 },
      ASOF,
    )
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.coverage).toBe(0)
  })

  it('flags insufficient_sample when coverage < 0.5 but still returns the value', () => {
    const r = highComplexityFileShare.compute(
      {
        highLineWeight: 100,
        coveredLineWeight: 200,
        totalLineWeight: 1000,
        highFilePrCount: 1,
        coveredPrCount: 2,
      },
      ASOF,
    )
    expect(r.coverage).toBeCloseTo(0.2, 10)
    expect(r.value).toBeCloseTo(0.5, 10)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles the all-high edge: every covered line is high-complexity', () => {
    const r = highComplexityFileShare.compute(
      {
        highLineWeight: 800,
        coveredLineWeight: 800,
        totalLineWeight: 800,
        highFilePrCount: 5,
        coveredPrCount: 5,
      },
      ASOF,
    )
    expect(r.value).toBeCloseTo(1, 10)
    expect(r.coverage).toBeCloseTo(1, 10)
    expect(r.prCountShare).toBeCloseTo(1, 10)
    expect(r.dataQuality).toBe('ok')
  })

  it('treats missing inputs as zero and yields no_data', () => {
    const r = highComplexityFileShare.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.prCountShare).toBeNull()
  })
})
