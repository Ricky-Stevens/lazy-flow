import { describe, expect, it } from 'bun:test'
import { reviewBypassReceived } from './reviewBypassReceived.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('reviewBypassReceived', () => {
  it('computes the bypass rate on a hand example (above the sample floor)', () => {
    // 8 PRs (= floor): 6 reviewed+normal (not bypassed), then no-review,
    // self-merged (both bypassed). 2/8 = 0.25.
    const prs = [
      { id: 1, hadExternalReview: true, selfMerged: false },
      { id: 2, hadExternalReview: true, selfMerged: false },
      { id: 3, hadExternalReview: true, selfMerged: false },
      { id: 4, hadExternalReview: true, selfMerged: false },
      { id: 5, hadExternalReview: true, selfMerged: false },
      { id: 6, hadExternalReview: true, selfMerged: false },
      { id: 7, hadExternalReview: false, selfMerged: false },
      { id: 8, hadExternalReview: true, selfMerged: true },
    ]
    const r = reviewBypassReceived.compute({ prs }, ASOF)

    expect(r.totalPrs).toBe(8)
    expect(r.bypassedPrs).toBe(2)
    expect(r.selfMergedPrs).toBe(1)
    expect(r.value).toBe(0.25)
    expect(r.unit).toBe('ratio')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('pr.review_bypass_rate_received')
    expect(r.asOf).toBe(ASOF)
  })

  it('flags a thin sample as insufficient_sample, not a confident band', () => {
    // Regression: a single self-merged PR would otherwise read 100% bypass at
    // 'ok' quality and corrupt the cohort distribution. Below the floor the
    // value is still computed but quality is insufficient_sample so the report
    // excludes it from peer comparison.
    const prs = [{ id: 1, hadExternalReview: false, selfMerged: true }]
    const r = reviewBypassReceived.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.dataQuality).toBe('insufficient_sample')

    // 7 PRs is still below the floor of 8.
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: i,
      hadExternalReview: true,
      selfMerged: false,
    }))
    expect(reviewBypassReceived.compute({ prs: seven }, ASOF).dataQuality).toBe(
      'insufficient_sample',
    )
  })

  it('returns no_data when there are no PRs', () => {
    const r = reviewBypassReceived.compute({ prs: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.totalPrs).toBe(0)
    expect(r.bypassedPrs).toBe(0)
    expect(r.selfMergedPrs).toBe(0)
  })

  it('treats missing prs input as no_data', () => {
    const r = reviewBypassReceived.compute({}, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
  })

  it('edge: all PRs reviewed and none self-merged → rate 0 (thin sample flagged)', () => {
    const prs = [
      { id: 1, hadExternalReview: true, selfMerged: false },
      { id: 2, hadExternalReview: true, selfMerged: false },
    ]
    const r = reviewBypassReceived.compute({ prs }, ASOF)
    expect(r.value).toBe(0)
    expect(r.bypassedPrs).toBe(0)
    expect(r.dataQuality).toBe('insufficient_sample')
  })

  it('edge: single bypassed PR → rate 1 but insufficient_sample', () => {
    const prs = [{ id: 1, hadExternalReview: false, selfMerged: false }]
    const r = reviewBypassReceived.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.bypassedPrs).toBe(1)
    expect(r.selfMergedPrs).toBe(0)
    expect(r.dataQuality).toBe('insufficient_sample')
  })
})
