import { describe, expect, it } from 'bun:test'
import { skillDomainFootprint } from './skillDomainFootprint.js'

const AS_OF = '2026-06-20T00:00:00.000Z'

describe('skillDomainFootprint', () => {
  it('computes normalized Shannon entropy for an even two-domain split', () => {
    const out = skillDomainFootprint.compute(
      {
        domains: [
          { domain: 'frontend', weight: 5 },
          { domain: 'backend', weight: 5 },
        ],
      },
      AS_OF,
    )
    // Two equal domains → entropy = log(2), normalized by log(2) = 1.
    expect(out.value).toBeCloseTo(1, 12)
    expect(out.breadth).toBeCloseTo(1, 12)
    expect(out.depth).toBeCloseTo(0.5, 12)
    expect(out.dataQuality).toBe('ok')
    expect(out.distribution).toEqual({ frontend: 0.5, backend: 0.5 })
    expect(out.unit).toBe('ratio')
    expect(out.asOf).toBe(AS_OF)
  })

  it('aggregates repeated domains and skews breadth below 1 when uneven', () => {
    const out = skillDomainFootprint.compute(
      {
        domains: [
          { domain: 'backend', weight: 6 },
          { domain: 'backend', weight: 2 },
          { domain: 'frontend', weight: 2 },
        ],
      },
      AS_OF,
    )
    // backend = 8/10, frontend = 2/10.
    expect(out.distribution).toEqual({ backend: 0.8, frontend: 0.2 })
    expect(out.depth).toBeCloseTo(0.8, 12)
    expect(out.breadth).toBeLessThan(1)
    expect(out.breadth).toBeGreaterThan(0)
    expect(out.topDomains[0]).toEqual({ domain: 'backend', share: 0.8 })
  })

  it('returns no_data when domains is empty', () => {
    const out = skillDomainFootprint.compute({ domains: [] }, AS_OF)
    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
    expect(out.distribution).toEqual({})
    expect(out.topDomains).toEqual([])
  })

  it('breadth is 0 for a single domain (depth 1)', () => {
    const out = skillDomainFootprint.compute({ domains: [{ domain: 'data', weight: 9 }] }, AS_OF)
    expect(out.breadth).toBe(0)
    expect(out.value).toBe(0)
    expect(out.depth).toBe(1)
    expect(out.dataQuality).toBe('ok')
    expect(out.distribution).toEqual({ data: 1 })
  })

  it('drops domains below the floor and no_data when all are dropped', () => {
    const out = skillDomainFootprint.compute(
      {
        domains: [
          { domain: 'a', weight: 1 },
          { domain: 'b', weight: 2 },
        ],
        floor: 5,
      },
      AS_OF,
    )
    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
  })
})
