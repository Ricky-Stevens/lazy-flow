import { describe, expect, it } from 'bun:test'
import { aiBlendCoupling } from './aiBlendCoupling.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('aiBlendCoupling', () => {
  it('computes blend, pctAiHeavy and coupling on a hand example', () => {
    // scores: mean = (0.2+0.8+0.6+0.4+0.9)/5 = 0.58
    // >=0.5 → 0.8,0.6,0.9 = 3 of 5 = 0.6
    // aiHeavy median (5 samples) = 6, human median (5 samples) = 3 → coupling 2
    const r = aiBlendCoupling.compute(
      {
        aiScores: [0.2, 0.8, 0.6, 0.4, 0.9],
        aiHeavyRework: [4, 5, 6, 7, 8],
        humanRework: [1, 2, 3, 4, 5],
      },
      ASOF,
    )
    expect(r.value).toBeCloseTo(0.58, 10)
    expect(r.pctAiHeavy).toBeCloseTo(0.6, 10)
    expect(r.reworkCoupling).toBeCloseTo(2, 10)
    expect(r.aiHeavyN).toBe(5)
    expect(r.humanN).toBe(5)
    expect(r.couplingQuality).toBe('ok')
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('ratio')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when aiScores is empty', () => {
    const r = aiBlendCoupling.compute({ aiScores: [], aiHeavyRework: [], humanRework: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.reworkCoupling).toBeNull()
    expect(r.couplingQuality).toBe('no_data')
    expect(r.aiHeavyN).toBe(0)
    expect(r.humanN).toBe(0)
  })

  it('reports blend but withholds coupling below the 5-sample floor', () => {
    const r = aiBlendCoupling.compute(
      {
        aiScores: [0.5, 0.5, 0.5],
        aiHeavyRework: [2, 4],
        humanRework: [1, 2, 3, 4, 5, 6],
      },
      ASOF,
    )
    // all-equal scores at threshold → blend 0.5, all heavy
    expect(r.value).toBeCloseTo(0.5, 10)
    expect(r.pctAiHeavy).toBeCloseTo(1, 10)
    expect(r.dataQuality).toBe('ok')
    // aiHeavy group has only 2 (< 5) → insufficient even though human has 6
    expect(r.reworkCoupling).toBeNull()
    expect(r.couplingQuality).toBe('insufficient_sample')
  })

  it('honours a custom aiHeavyThreshold', () => {
    const r = aiBlendCoupling.compute(
      { aiScores: [0.3, 0.7], aiHeavyRework: [], humanRework: [], aiHeavyThreshold: 0.75 },
      ASOF,
    )
    expect(r.pctAiHeavy).toBeCloseTo(0, 10)
  })
})
