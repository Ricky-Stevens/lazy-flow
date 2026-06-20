import { describe, expect, it } from 'bun:test'
import { prReviewDifficulty } from './prReviewDifficulty.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('prReviewDifficulty', () => {
  it('computes the median band, pctHard and p75 on a hand example', () => {
    // 10 bands: median = 3, two of ten are >= 4 → pctHard = 0.2
    const bands = [1, 2, 2, 3, 3, 3, 3, 3, 4, 5]
    const r = prReviewDifficulty.compute({ bands }, ASOF)

    expect(r.id).toBe('person.pr_review_difficulty')
    expect(r.trustTier).toBe('probabilistic')
    expect(r.scope).toBe('person')
    expect(r.unit).toBe('band')
    expect(r.value).toBe(3)
    expect(r.pctHard).toBeCloseTo(0.2, 10)
    expect(r.sampleSize).toBe(10)
    expect(r.p75).toBe(3)
    expect(r.dataQuality).toBe('ok')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when the sample is empty', () => {
    const r = prReviewDifficulty.compute({ bands: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.pctHard).toBeNull()
    expect(r.p75).toBeNull()
    expect(r.sampleSize).toBe(0)
  })

  it('treats a missing bands field as no_data', () => {
    const r = prReviewDifficulty.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const bands = [5, 5, 4] // all hard, 3 < floor of 8
    const r = prReviewDifficulty.compute({ bands }, ASOF)
    expect(r.value).toBe(5)
    expect(r.pctHard).toBe(1)
    expect(r.sampleSize).toBe(3)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles a single band', () => {
    const r = prReviewDifficulty.compute({ bands: [2] }, ASOF)
    expect(r.value).toBe(2)
    expect(r.pctHard).toBe(0)
    expect(r.p75).toBe(2)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles all-equal bands above the floor', () => {
    const bands = [3, 3, 3, 3, 3, 3, 3, 3]
    const r = prReviewDifficulty.compute({ bands }, ASOF)
    expect(r.value).toBe(3)
    expect(r.p75).toBe(3)
    expect(r.pctHard).toBe(0)
    expect(r.dataQuality).toBe('ok')
  })
})
