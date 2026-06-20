import { describe, expect, it } from 'bun:test'

import { reviewReciprocity } from './index.js'

const NOW = '2024-06-01T00:00:00.000Z'

describe('person.review_reciprocity', () => {
  it('returns no_data when the person neither gave nor received reviews', () => {
    const r = reviewReciprocity.compute({ reviewsGiven: 0, reviewsReceived: 0 }, NOW)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('a pure giver scores > 1 (smoothed, finite)', () => {
    const r = reviewReciprocity.compute({ reviewsGiven: 6, reviewsReceived: 0 }, NOW)
    expect(r.dataQuality).toBe('ok')
    // 6 / (0 + 1) = 6
    expect(r.value).toBeCloseTo(6, 10)
  })

  it('a net receiver scores < 1', () => {
    const r = reviewReciprocity.compute({ reviewsGiven: 1, reviewsReceived: 9 }, NOW)
    expect(r.dataQuality).toBe('ok')
    // 1 / (9 + 1) = 0.1
    expect(r.value).toBeCloseTo(0.1, 10)
    expect(r.value).toBeLessThan(1)
  })

  it('balanced give/receive sits near 1', () => {
    const r = reviewReciprocity.compute({ reviewsGiven: 5, reviewsReceived: 4 }, NOW)
    // 5 / (4 + 1) = 1.0
    expect(r.value).toBeCloseTo(1, 10)
    expect(r.scope).toBe('person')
  })
})
