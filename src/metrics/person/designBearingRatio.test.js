import { describe, expect, it } from 'bun:test'
import { designBearingRatio } from './designBearingRatio.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('designBearingRatio', () => {
  it('computes the difficulty-weighted design-bearing share on a hand example', () => {
    // Kept (conf >= 0.5): two design-bearing (diff 4, 2) + two mechanical (diff 1, 3).
    // The 0.3-confidence verdict is dropped before weighting.
    const inputs = {
      verdicts: [
        { designBearing: true, difficulty: 4, confidence: 0.9 },
        { designBearing: true, difficulty: 2, confidence: 0.6 },
        { designBearing: false, difficulty: 1, confidence: 0.8 },
        { designBearing: false, difficulty: 3, confidence: 0.5 },
        { designBearing: true, difficulty: 5, confidence: 0.3 },
      ],
    }
    const out = designBearingRatio.compute(inputs, ASOF)

    expect(out.value).toBeCloseTo(6 / 10, 10) // (4+2) / (4+2+1+3)
    expect(out.designBearingCount).toBe(2)
    expect(out.mechanicalCount).toBe(2)
    expect(out.sampleSize).toBe(4)
    expect(out.meanConfidence).toBeCloseTo((0.9 + 0.6 + 0.8 + 0.5) / 4, 10)
    expect(out.dataQuality).toBe('insufficient_sample') // 4 < floor of 5
    expect(out.unit).toBe('ratio')
    expect(out.trustTier).toBe('probabilistic')
    expect(out.scope).toBe('person')
  })

  it('reports ok once the kept sample reaches the floor', () => {
    const verdicts = Array.from({ length: 5 }, (_, i) => ({
      designBearing: i < 3,
      difficulty: 2,
      confidence: 0.7,
    }))
    const out = designBearingRatio.compute({ verdicts }, ASOF)

    expect(out.dataQuality).toBe('ok')
    expect(out.sampleSize).toBe(5)
    expect(out.value).toBeCloseTo((3 * 2) / (5 * 2), 10) // 0.6
  })

  it('returns no_data when no verdicts clear the confidence floor', () => {
    const inputs = {
      verdicts: [
        { designBearing: true, difficulty: 5, confidence: 0.2 },
        { designBearing: false, difficulty: 3, confidence: 0.49 },
      ],
    }
    const out = designBearingRatio.compute(inputs, ASOF)

    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
    expect(out.designBearingCount).toBe(0)
    expect(out.mechanicalCount).toBe(0)
    expect(out.meanConfidence).toBeNull()
    expect(out.sampleSize).toBe(0)
  })

  it('returns no_data on an empty verdict set', () => {
    const out = designBearingRatio.compute({ verdicts: [] }, ASOF)
    expect(out.dataQuality).toBe('no_data')
    expect(out.value).toBeNull()
  })

  it('handles an all-mechanical kept set (value 0, not null)', () => {
    const verdicts = [
      { designBearing: false, difficulty: 4, confidence: 0.9 },
      { designBearing: false, difficulty: 2, confidence: 0.9 },
    ]
    const out = designBearingRatio.compute({ verdicts }, ASOF)

    expect(out.value).toBe(0) // 0 design weight / 6 total weight
    expect(out.designBearingCount).toBe(0)
    expect(out.mechanicalCount).toBe(2)
    expect(out.dataQuality).toBe('insufficient_sample')
  })

  it('honours a custom minConfidence threshold', () => {
    const verdicts = [
      { designBearing: true, difficulty: 3, confidence: 0.6 },
      { designBearing: false, difficulty: 3, confidence: 0.6 },
    ]
    const out = designBearingRatio.compute({ verdicts, minConfidence: 0.8 }, ASOF)

    expect(out.dataQuality).toBe('no_data')
    expect(out.sampleSize).toBe(0)
  })
})
