import { describe, expect, it } from 'bun:test'
import { reviewDepthMentorship } from './reviewDepthMentorship.js'

const AS_OF = '2026-06-20T00:00:00.000Z'

describe('reviewDepthMentorship', () => {
  it('weights substantive complexity over total complexity', () => {
    // substantive weight = 5 (logic) + 3 (security) = 8; total = 8 + 2 = 10
    const threads = [
      { category: 'substantive_logic', complexityWeight: 5 },
      { category: 'security', complexityWeight: 3 },
      { category: 'cosmetic_nit', complexityWeight: 1 },
      { category: 'rubber_stamp', complexityWeight: 1 },
      { category: 'design_arch', complexityWeight: 0 },
    ]
    const r = reviewDepthMentorship.compute({ threads }, AS_OF)
    expect(r.value).toBeCloseTo(0.8, 10)
    expect(r.dataQuality).toBe('ok')
    expect(r.sampleSize).toBe(5)
    // unweighted substantive count = logic + security + design_arch = 3 of 5
    expect(r.substantiveShare).toBeCloseTo(0.6, 10)
    expect(r.rubberStampShare).toBeCloseTo(0.2, 10)
    expect(r.id).toBe('person.review_depth_mentorship')
    expect(r.trustTier).toBe('probabilistic')
    expect(r.unit).toBe('ratio')
    expect(r.asOf).toBe(AS_OF)
  })

  it('returns no_data on an empty sample', () => {
    const r = reviewDepthMentorship.compute({ threads: [] }, AS_OF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.substantiveShare).toBeNull()
    expect(r.rubberStampShare).toBeNull()
    expect(r.sampleSize).toBe(0)
  })

  it('handles missing threads key like an empty sample', () => {
    const r = reviewDepthMentorship.compute({}, AS_OF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('flags insufficient_sample below the floor but still computes value', () => {
    const threads = [
      { category: 'substantive_logic', complexityWeight: 3 },
      { category: 'cosmetic_nit', complexityWeight: 1 },
    ]
    const r = reviewDepthMentorship.compute({ threads }, AS_OF)
    expect(r.value).toBeCloseTo(0.75, 10)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.sampleSize).toBe(2)
  })

  it('returns null value when all complexity weights are zero', () => {
    const threads = [
      { category: 'substantive_logic', complexityWeight: 0 },
      { category: 'cosmetic_nit', complexityWeight: 0 },
      { category: 'rubber_stamp', complexityWeight: 0 },
      { category: 'security', complexityWeight: 0 },
      { category: 'design_arch', complexityWeight: 0 },
    ]
    const r = reviewDepthMentorship.compute({ threads }, AS_OF)
    // safeRatio over a zero denominator returns null
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('ok')
    // unweighted shares still defined from counts: 3 of 5 substantive
    expect(r.substantiveShare).toBeCloseTo(0.6, 10)
    expect(r.rubberStampShare).toBeCloseTo(0.2, 10)
  })

  it('treats every substantive category as substantive', () => {
    const threads = [
      { category: 'substantive_logic', complexityWeight: 1 },
      { category: 'design_arch', complexityWeight: 1 },
      { category: 'security', complexityWeight: 1 },
      { category: 'test_coverage', complexityWeight: 1 },
      { category: 'cosmetic_nit', complexityWeight: 1 },
    ]
    const r = reviewDepthMentorship.compute({ threads }, AS_OF)
    expect(r.value).toBeCloseTo(0.8, 10)
    expect(r.substantiveShare).toBeCloseTo(0.8, 10)
  })
})
