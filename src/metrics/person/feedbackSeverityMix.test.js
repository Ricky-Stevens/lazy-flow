import { describe, expect, it } from 'bun:test'
import { feedbackSeverityMix } from './feedbackSeverityMix.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('feedbackSeverityMix', () => {
  it('computes the meaningful share and full distribution on a hand example', () => {
    // 10 comments: 4 nit, 2 clarification, 2 logic, 1 architectural, 1 security.
    // meaningful = logic+architectural+security = 4 / 10 = 0.4
    const severities = [
      'nit',
      'nit',
      'nit',
      'nit',
      'clarification',
      'clarification',
      'logic',
      'logic',
      'architectural',
      'security',
    ]
    const r = feedbackSeverityMix.compute({ severities }, ASOF)

    expect(r.value).toBeCloseTo(0.4, 10)
    expect(r.sampleSize).toBe(10)
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('ratio')
    expect(r.trustTier).toBe('probabilistic')
    expect(r.distribution.nit).toBeCloseTo(0.4, 10)
    expect(r.distribution.clarification).toBeCloseTo(0.2, 10)
    expect(r.distribution.logic).toBeCloseTo(0.2, 10)
    expect(r.distribution.architectural).toBeCloseTo(0.1, 10)
    expect(r.distribution.security).toBeCloseTo(0.1, 10)
    // distribution sums to 1 across the five tiers
    const sum = Object.values(r.distribution).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  it('returns no_data when the sample is empty', () => {
    const r = feedbackSeverityMix.compute({ severities: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.sampleSize).toBe(0)
    expect(r.asOf).toBe(ASOF)
  })

  it('handles missing severities input as no_data', () => {
    const r = feedbackSeverityMix.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    // 2 comments, one meaningful → value 0.5 but below the floor of 5
    const r = feedbackSeverityMix.compute({ severities: ['nit', 'logic'] }, ASOF)
    expect(r.value).toBeCloseTo(0.5, 10)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.sampleSize).toBe(2)
  })

  it('ignores unrecognised labels (not counted in total or distribution)', () => {
    const r = feedbackSeverityMix.compute(
      { severities: ['logic', 'logic', 'praise', 'logic', 'logic', 'logic'] },
      ASOF,
    )
    // 5 valid logic comments, all meaningful
    expect(r.sampleSize).toBe(5)
    expect(r.value).toBeCloseTo(1, 10)
    expect(r.distribution.logic).toBeCloseTo(1, 10)
    expect(r.distribution.nit).toBe(0)
    expect(r.dataQuality).toBe('ok')
  })

  it('handles an all-nit sample (zero meaningful share)', () => {
    const r = feedbackSeverityMix.compute(
      { severities: ['nit', 'nit', 'nit', 'nit', 'nit', 'nit'] },
      ASOF,
    )
    expect(r.value).toBe(0)
    expect(r.distribution.nit).toBeCloseTo(1, 10)
    expect(r.dataQuality).toBe('ok')
  })
})
