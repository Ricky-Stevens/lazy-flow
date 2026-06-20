import { describe, expect, it } from 'bun:test'
import { prAtomicity } from './prAtomicity.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('prAtomicity', () => {
  it('computes the median prior and sprawling share on a hand example', () => {
    const priors = [0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 0.5, 0.7, 0.3]
    const sprawlingFlags = [true, true, false, false, false, false, true, false, false]
    const res = prAtomicity.compute({ priors, sprawlingFlags }, ASOF)

    // 9 sorted values → median is the 5th (0-indexed 4): 0.6
    expect(res.value).toBe(0.6)
    expect(res.sprawlingShare).toBeCloseTo(3 / 9, 10)
    expect(res.sampleSize).toBe(9)
    expect(res.dataQuality).toBe('ok')
    expect(res.unit).toBe('ratio')
    expect(res.trustTier).toBe('hybrid')
    expect(res.scope).toBe('person')
    expect(res.id).toBe('person.pr_atomicity')
    expect(res.asOf).toBe(ASOF)
  })

  it('returns no_data when priors are empty', () => {
    const res = prAtomicity.compute({ priors: [], sprawlingFlags: [] }, ASOF)
    expect(res.value).toBeNull()
    expect(res.dataQuality).toBe('no_data')
    expect(res.sprawlingShare).toBeNull()
    expect(res.sampleSize).toBe(0)
  })

  it('handles missing inputs as empty (no_data)', () => {
    const res = prAtomicity.compute(undefined, ASOF)
    expect(res.value).toBeNull()
    expect(res.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const priors = [0.5, 0.5, 0.5]
    const sprawlingFlags = [false, false, false]
    const res = prAtomicity.compute({ priors, sprawlingFlags }, ASOF)
    expect(res.value).toBe(0.5)
    expect(res.dataQuality).toBe('insufficient_sample')
    expect(res.sprawlingShare).toBe(0)
    expect(res.sampleSize).toBe(3)
  })

  it('handles a single all-equal prior', () => {
    const res = prAtomicity.compute({ priors: [0.42], sprawlingFlags: [true] }, ASOF)
    expect(res.value).toBe(0.42)
    expect(res.sprawlingShare).toBe(1)
    expect(res.dataQuality).toBe('insufficient_sample')
  })

  it('returns null sprawlingShare when there are no sprawling flags but priors exist', () => {
    const res = prAtomicity.compute({ priors: [0.3, 0.7], sprawlingFlags: [] }, ASOF)
    expect(res.value).toBeCloseTo(0.5, 10)
    expect(res.sprawlingShare).toBeNull()
  })
})
