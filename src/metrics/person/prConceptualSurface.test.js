import { describe, expect, it } from 'bun:test'
import { prConceptualSurface } from './prConceptualSurface.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('prConceptualSurface', () => {
  it('computes median and p75 on a hand example', () => {
    // 10 sorted values → median = avg(5th,6th item) interpolation, p75 in upper tail.
    const surfaces = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
    const r = prConceptualSurface.compute({ prSurfaces: surfaces }, ASOF)

    expect(r.id).toBe('person.pr_conceptual_surface')
    expect(r.trustTier).toBe('deterministic')
    expect(r.scope).toBe('person')
    expect(r.unit).toBe('index')
    expect(r.dataQuality).toBe('ok')
    expect(r.sampleSize).toBe(10)
    expect(r.value).toBe(11)
    expect(r.p75).toBe(15.5)
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data for an empty sample', () => {
    const r = prConceptualSurface.compute({ prSurfaces: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.p75).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.sampleSize).toBe(0)
  })

  it('treats a missing prSurfaces field as no_data', () => {
    const r = prConceptualSurface.compute({}, ASOF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const surfaces = [5, 7, 9]
    const r = prConceptualSurface.compute({ prSurfaces: surfaces }, ASOF)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.sampleSize).toBe(3)
    expect(r.value).toBe(7)
    expect(r.p75).toBe(8)
  })

  it('handles a single PR (value equals that PR surface)', () => {
    const r = prConceptualSurface.compute({ prSurfaces: [42] }, ASOF)
    expect(r.value).toBe(42)
    expect(r.p75).toBe(42)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('handles all-equal surfaces', () => {
    const surfaces = [3, 3, 3, 3, 3, 3, 3, 3, 3]
    const r = prConceptualSurface.compute({ prSurfaces: surfaces }, ASOF)
    expect(r.value).toBe(3)
    expect(r.p75).toBe(3)
    expect(r.dataQuality).toBe('ok')
  })
})
