import { describe, expect, it } from 'bun:test'

import { comparePersonToCohort, MIN_COHORT, selectHumanCohort } from './cohortBaseline.js'

describe('selectHumanCohort', () => {
  it('drops bot-only persons', () => {
    const persons = [
      { id: 'a', isBot: false },
      { id: 'bot', isBot: true },
      { id: 'c', isBot: false },
    ]
    expect(selectHumanCohort(persons).map((p) => p.id)).toEqual(['a', 'c'])
  })
})

describe('comparePersonToCohort', () => {
  const cohort = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('suppresses below the cohort floor (insufficient_cohort, no band emitted)', () => {
    const r = comparePersonToCohort(5, [1, 2, 3, 4], { minCohort: MIN_COHORT })
    expect(r.suppressed).toBe(true)
    expect(r.band).toBe('insufficient_cohort')
    expect(r.robustZ).toBeNull()
    expect(r.percentile).toBeNull()
  })

  it('suppresses when the person value is null', () => {
    const r = comparePersonToCohort(null, cohort)
    expect(r.suppressed).toBe(true)
    expect(r.value).toBeNull()
  })

  it('a near-median value is typical (|z|<1)', () => {
    const r = comparePersonToCohort(6, cohort)
    expect(r.suppressed).toBe(false)
    expect(r.band).toBe('typical')
    expect(r.percentile).toBeGreaterThan(0)
    expect(r.percentile).toBeLessThanOrEqual(1)
  })

  it('polarity orients the z-score so positive = better', () => {
    // Lower is better (e.g. latency): a high value should read as a NEGATIVE z.
    const high = comparePersonToCohort(10, cohort, { polarity: -1 })
    expect(high.robustZ).toBeLessThan(0)
    expect(high.direction).toBe('above') // direction is polarity-agnostic (above the median)
  })

  it('a flat / degenerate-dispersion cohort does NOT emit an explosive outlier band', () => {
    // Every peer scored exactly 1.0 (a perfectly homogeneous cohort — common when
    // a binary-ish metric has 100% of peers passing). robustSd would floor to ε
    // and any nonzero deviation would read as |z| ≫ 2 → 'outlier'. Must not.
    const flat = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const r = comparePersonToCohort(0.5, flat)
    expect(r.suppressed).toBe(false)
    expect(r.band).toBe('typical')
    expect(r.robustZ).toBe(0)
    expect(r.degenerateCohort).toBe(true)
    // The person's raw value is preserved (descriptive position is still useful).
    expect(r.value).toBe(0.5)
    // ANTI-RANKING: a meaningless cohort must not leak a percentile/direction —
    // a lone deviation below a wall of identical peers would read as "0th pct".
    expect(r.percentile).toBeNull()
    expect(r.direction).toBeNull()
  })

  it('descriptive metric (polarity 0) does NOT leak a percentile or direction (anti-ranking)', () => {
    // worktype mix, bugfix share, etc. carry no better/worse orientation, so a
    // percentile or above/below-median IS a soft rank — the exact ordinal
    // placement the anti-ranking contract forbids. Band/value stay; rank does not.
    const r = comparePersonToCohort(9, cohort, { polarity: 0 })
    expect(r.suppressed).toBe(false)
    expect(r.value).toBe(9)
    expect(r.percentile).toBeNull()
    expect(r.direction).toBeNull()
    // The robust-z is still computed for band classification, but with polarity 0
    // it carries no orientation (it is multiplied by 0).
    expect(r.robustZ).toBe(0)
    expect(['typical', 'notable', 'outlier']).toContain(r.band)
  })

  it('oriented metric (polarity ±1) STILL emits a percentile and direction', () => {
    // Regression guard: the descriptive suppression must not strip rank from
    // metrics that legitimately have a better/worse orientation.
    const r = comparePersonToCohort(9, cohort, { polarity: 1 })
    expect(r.percentile).not.toBeNull()
    expect(r.direction).not.toBeNull()
  })
})
