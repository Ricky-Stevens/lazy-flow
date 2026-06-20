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
})
