import { describe, expect, it } from 'bun:test'
import { conventionAdherence } from './conventionAdherence.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('conventionAdherence', () => {
  it('computes follows-share, distribution and violatesShare on a hand example', () => {
    // 10 verdicts: 6 follows, 3 minor_divergence, 1 violates.
    const adherence = [
      'follows',
      'follows',
      'follows',
      'follows',
      'follows',
      'follows',
      'minor_divergence',
      'minor_divergence',
      'minor_divergence',
      'violates',
    ]
    const r = conventionAdherence.compute({ adherence }, ASOF)

    expect(r.id).toBe('person.convention_adherence')
    expect(r.trustTier).toBe('probabilistic')
    expect(r.scope).toBe('person')
    expect(r.unit).toBe('ratio')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeCloseTo(0.6, 10)
    expect(r.distribution.follows).toBeCloseTo(0.6, 10)
    expect(r.distribution.minor_divergence).toBeCloseTo(0.3, 10)
    expect(r.distribution.violates).toBeCloseTo(0.1, 10)
    expect(r.violatesShare).toBeCloseTo(0.1, 10)
    expect(r.sampleSize).toBe(10)
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data on an empty sample', () => {
    const r = conventionAdherence.compute({ adherence: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.violatesShare).toBeNull()
    expect(r.distribution).toEqual({
      follows: null,
      minor_divergence: null,
      violates: null,
    })
    expect(r.sampleSize).toBe(0)
  })

  it('treats missing adherence input as no_data', () => {
    const r = conventionAdherence.compute({}, ASOF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.sampleSize).toBe(0)
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const adherence = ['follows', 'violates', 'follows']
    const r = conventionAdherence.compute({ adherence }, ASOF)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.value).toBeCloseTo(2 / 3, 10)
    expect(r.violatesShare).toBeCloseTo(1 / 3, 10)
    expect(r.sampleSize).toBe(3)
  })

  it('handles an all-equal sample (every verdict follows)', () => {
    const adherence = ['follows', 'follows', 'follows', 'follows', 'follows']
    const r = conventionAdherence.compute({ adherence }, ASOF)
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(1)
    expect(r.distribution.follows).toBe(1)
    expect(r.distribution.minor_divergence).toBe(0)
    expect(r.violatesShare).toBe(0)
    expect(r.sampleSize).toBe(5)
  })
})
