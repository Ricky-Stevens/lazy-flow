import { describe, expect, it } from 'bun:test'
import { prDescriptionQuality } from './prDescriptionQuality.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('prDescriptionQuality', () => {
  it('computes the substantive share on a hand example', () => {
    const ratings = ['strong', 'adequate', 'thin', 'absent', 'strong', 'thin']
    const r = prDescriptionQuality.compute({ ratings }, ASOF)
    // 3 of 6 are adequate/strong
    expect(r.value).toBe(0.5)
    expect(r.unit).toBe('ratio')
    expect(r.dataQuality).toBe('ok')
    expect(r.sampleSize).toBe(6)
    expect(r.counts).toEqual({ absent: 1, thin: 2, adequate: 1, strong: 2 })
    expect(r.distribution.strong).toBeCloseTo(2 / 6, 10)
    expect(r.distribution.absent).toBeCloseTo(1 / 6, 10)
    const total = Object.values(r.distribution).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('returns no_data on an empty sample', () => {
    const r = prDescriptionQuality.compute({ ratings: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.sampleSize).toBe(0)
    expect(r.distribution).toEqual({ absent: 0, thin: 0, adequate: 0, strong: 0 })
  })

  it('treats a missing ratings field as no_data', () => {
    const r = prDescriptionQuality.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still computes', () => {
    const ratings = ['strong', 'thin', 'adequate']
    const r = prDescriptionQuality.compute({ ratings }, ASOF)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.value).toBeCloseTo(2 / 3, 10)
    expect(r.sampleSize).toBe(3)
  })

  it('handles an all-equal sample (all strong -> share 1)', () => {
    const ratings = ['strong', 'strong', 'strong', 'strong', 'strong']
    const r = prDescriptionQuality.compute({ ratings }, ASOF)
    expect(r.value).toBe(1)
    expect(r.dataQuality).toBe('ok')
    expect(r.distribution.strong).toBe(1)
    expect(r.distribution.absent).toBe(0)
  })

  it('ignores unknown rating labels in counts but keeps them in sampleSize', () => {
    const ratings = ['strong', 'bogus', 'adequate', 'absent', 'thin']
    const r = prDescriptionQuality.compute({ ratings }, ASOF)
    // bogus is not bucketed; 2 of 5 known-substantive over full sample of 5
    expect(r.sampleSize).toBe(5)
    expect(r.value).toBeCloseTo(2 / 5, 10)
    expect(r.counts).toEqual({ absent: 1, thin: 1, adequate: 1, strong: 1 })
  })
})
