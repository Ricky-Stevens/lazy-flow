import { describe, expect, it } from 'bun:test'
import { bugfixShare } from './bugfixShare.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('bugfixShare', () => {
  it('computes the headline share on a hand example (real source)', () => {
    // 3 of 10 units are bug fixes; 8/10 = 0.8 verified >= 0.7 → real
    const r = bugfixShare.compute({ bugUnits: 3, totalUnits: 10, verifiedUnits: 8 }, ASOF)
    expect(r.value).toBe(0.3)
    expect(r.dataQuality).toBe('ok')
    expect(r.dataSource).toBe('real')
    expect(r.unit).toBe('ratio')
    expect(r.trustTier).toBe('hybrid')
    expect(r.scope).toBe('person')
    expect(r.asOf).toBe(ASOF)
    expect(r.bugUnits).toBe(3)
    expect(r.totalUnits).toBe(10)
  })

  it('flags proxy when verified coverage is below 70%', () => {
    // 6/10 = 0.6 verified < 0.7 → proxy, value still computable
    const r = bugfixShare.compute({ bugUnits: 5, totalUnits: 10, verifiedUnits: 6 }, ASOF)
    expect(r.value).toBe(0.5)
    expect(r.dataSource).toBe('proxy')
    expect(r.dataQuality).toBe('ok')
  })

  it('returns no_data when totalUnits is 0', () => {
    const r = bugfixShare.compute({ bugUnits: 0, totalUnits: 0, verifiedUnits: 0 }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.dataSource).toBe('proxy')
  })

  it('treats missing inputs as zero → no_data', () => {
    const r = bugfixShare.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.bugUnits).toBe(0)
    expect(r.totalUnits).toBe(0)
  })

  it('edge: all units are bug fixes and fully verified → share 1.0, real', () => {
    const r = bugfixShare.compute({ bugUnits: 4, totalUnits: 4, verifiedUnits: 4 }, ASOF)
    expect(r.value).toBe(1)
    expect(r.dataSource).toBe('real')
    expect(r.dataQuality).toBe('ok')
  })

  it('edge: exactly 70% verified counts as real', () => {
    const r = bugfixShare.compute({ bugUnits: 2, totalUnits: 10, verifiedUnits: 7 }, ASOF)
    expect(r.dataSource).toBe('real')
  })
})
