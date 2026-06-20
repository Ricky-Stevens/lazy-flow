import { describe, expect, it } from 'bun:test'
import { worktypeMix } from './worktypeMix.js'

const AS_OF = '2026-06-20T00:00:00.000Z'

describe('worktypeMix', () => {
  it('computes the dominant bucket share on a hand example', () => {
    const buckets = ['feature', 'feature', 'feature', 'bug', 'bug', 'debt']
    const r = worktypeMix.compute({ buckets }, AS_OF)

    expect(r.dataQuality).toBe('ok')
    expect(r.total).toBe(6)
    expect(r.dominantBucket).toBe('feature')
    expect(r.value).toBe(0.5)
    expect(r.counts.feature).toBe(3)
    expect(r.counts.bug).toBe(2)
    expect(r.counts.debt).toBe(1)
    // bug share is the load-bearing reading
    expect(r.distribution.bug).toBeCloseTo(2 / 6)
    // every one of the 7 buckets is present, absent ones are 0
    expect(r.distribution.docs).toBe(0)
    expect(Object.keys(r.distribution).length).toBe(7)
    expect(r.unit).toBe('ratio')
    expect(r.trustTier).toBe('hybrid')
    expect(r.asOf).toBe(AS_OF)
  })

  it('returns no_data on an empty sample', () => {
    const r = worktypeMix.compute({ buckets: [] }, AS_OF)

    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.total).toBe(0)
    expect(r.dominantBucket).toBeNull()
    expect(r.distribution.feature).toBe(0)
    expect(Object.keys(r.distribution).length).toBe(7)
  })

  it('treats a missing buckets field as no_data', () => {
    const r = worktypeMix.compute({}, AS_OF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('handles a single-item sample as a full share', () => {
    const r = worktypeMix.compute({ buckets: ['debt'] }, AS_OF)

    expect(r.value).toBe(1)
    expect(r.dominantBucket).toBe('debt')
    expect(r.distribution.debt).toBe(1)
    expect(r.distribution.feature).toBe(0)
  })

  it('handles an all-equal split (share = 1/n, dominant deterministic)', () => {
    const r = worktypeMix.compute({ buckets: ['bug', 'docs'] }, AS_OF)

    expect(r.value).toBe(0.5)
    expect(r.distribution.bug).toBe(0.5)
    expect(r.distribution.docs).toBe(0.5)
    // tie resolves to the first bucket order, not docs
    expect(r.dominantBucket).toBe('bug')
  })

  it('folds an unknown bucket label into other', () => {
    const r = worktypeMix.compute({ buckets: ['chore', 'feature'] }, AS_OF)

    expect(r.counts.other).toBe(1)
    expect(r.total).toBe(2)
  })
})
