import { describe, expect, it } from 'bun:test'
import { knowledgeOwnership } from './knowledgeOwnership.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('knowledgeOwnership', () => {
  it('sums cyclomatic over owned paths and flags bus-factor-1', () => {
    const inputs = {
      paths: [
        // owned + bus-factor-1: share 0.9, sole contributor
        { path: 'a.js', personLines: 90, totalLines: 100, contributorCount: 1, cyclomatic: 10 },
        // owned but shared (share 0.6, 3 contributors) -> not bus-factor-1
        { path: 'b.js', personLines: 60, totalLines: 100, contributorCount: 3, cyclomatic: 7 },
        // not owned: share only 0.3
        { path: 'c.js', personLines: 30, totalLines: 100, contributorCount: 2, cyclomatic: 5 },
        // not owned: high share but below lineFloor (personLines 20 < 30)
        { path: 'd.js', personLines: 20, totalLines: 22, contributorCount: 1, cyclomatic: 4 },
      ],
    }
    const r = knowledgeOwnership.compute(inputs, ASOF)
    expect(r.value).toBe(17) // 10 + 7
    expect(r.ownedPaths).toBe(2)
    expect(r.busFactor1Paths).toBe(1)
    // owned complexity 17 over total complexity 26
    expect(r.ownedShareOfRepoComplexity).toBeCloseTo(17 / 26, 10)
    expect(r.evidencePaths).toEqual(['a.js', 'b.js']) // sorted by cyclomatic desc
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('index')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when paths is empty', () => {
    const r = knowledgeOwnership.compute({ paths: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.ownedPaths).toBe(0)
    expect(r.busFactor1Paths).toBe(0)
    expect(r.ownedShareOfRepoComplexity).toBeNull()
    expect(r.evidencePaths).toEqual([])
  })

  it('handles a missing paths key as no_data', () => {
    const r = knowledgeOwnership.compute({}, ASOF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('respects a custom lineFloor', () => {
    const inputs = {
      lineFloor: 100,
      paths: [
        // share 1.0 but personLines 50 < lineFloor 100 -> not owned
        { path: 'x.js', personLines: 50, totalLines: 50, contributorCount: 1, cyclomatic: 9 },
      ],
    }
    const r = knowledgeOwnership.compute(inputs, ASOF)
    expect(r.value).toBe(0)
    expect(r.ownedPaths).toBe(0)
    expect(r.ownedShareOfRepoComplexity).toBe(0) // safeRatio(0, 9)
  })

  it('edge: all paths owned with equal complexity', () => {
    const inputs = {
      paths: [
        { path: 'a.js', personLines: 80, totalLines: 100, contributorCount: 1, cyclomatic: 6 },
        { path: 'b.js', personLines: 80, totalLines: 100, contributorCount: 1, cyclomatic: 6 },
      ],
    }
    const r = knowledgeOwnership.compute(inputs, ASOF)
    expect(r.value).toBe(12)
    expect(r.busFactor1Paths).toBe(2)
    expect(r.ownedShareOfRepoComplexity).toBe(1)
    expect(r.evidencePaths.length).toBe(2)
  })
})
