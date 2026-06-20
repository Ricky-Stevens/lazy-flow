import { describe, expect, it } from 'bun:test'
import { testInclusionRate } from './testInclusionRate.js'

const ASOF = '2026-06-20T00:00:00.000Z'

const pr = (touchedProd, touchedTest, id) => ({ id, touchedProd, touchedTest })

describe('testInclusionRate', () => {
  it('computes rate as testful code PRs over code-changing PRs', () => {
    // 6 code-changing PRs, 4 of which also touched tests → 4/6.
    // One pure-test PR (no prod) is excluded from the denominator.
    const prs = [
      pr(true, true, 1),
      pr(true, true, 2),
      pr(true, true, 3),
      pr(true, true, 4),
      pr(true, false, 5),
      pr(true, false, 6),
      pr(false, true, 7),
    ]
    const r = testInclusionRate.compute({ prs }, ASOF)
    expect(r.value).toBeCloseTo(4 / 6, 10)
    expect(r.dataQuality).toBe('ok')
    expect(r.codeChangingPrs).toBe(6)
    expect(r.prsWithTests).toBe(4)
    expect(r.totalPrs).toBe(7)
    expect(r.id).toBe('person.test_inclusion_rate')
    expect(r.trustTier).toBe('hybrid')
    expect(r.unit).toBe('ratio')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when there are no code-changing PRs', () => {
    const prs = [pr(false, true, 1), pr(false, false, 2)]
    const r = testInclusionRate.compute({ prs }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.codeChangingPrs).toBe(0)
    expect(r.totalPrs).toBe(2)
  })

  it('returns no_data on empty / missing input', () => {
    expect(testInclusionRate.compute({ prs: [] }, ASOF).dataQuality).toBe('no_data')
    expect(testInclusionRate.compute({}, ASOF).dataQuality).toBe('no_data')
    expect(testInclusionRate.compute(undefined, ASOF).dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    // 3 code-changing PRs (< 5), all with tests → value 1 but flagged.
    const prs = [pr(true, true, 1), pr(true, true, 2), pr(true, true, 3)]
    const r = testInclusionRate.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.codeChangingPrs).toBe(3)
  })

  it('handles all-equal case: no code PR includes a test → rate 0', () => {
    const prs = [
      pr(true, false, 1),
      pr(true, false, 2),
      pr(true, false, 3),
      pr(true, false, 4),
      pr(true, false, 5),
    ]
    const r = testInclusionRate.compute({ prs }, ASOF)
    expect(r.value).toBe(0)
    expect(r.dataQuality).toBe('ok')
    expect(r.prsWithTests).toBe(0)
  })
})
