import { describe, expect, it } from 'bun:test'
import { reviewBypassReceived } from './reviewBypassReceived.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('reviewBypassReceived', () => {
  it('computes the bypass rate on a hand example', () => {
    // 4 PRs: #1 reviewed+normal (not bypassed), #2 no review (bypass),
    // #3 self-merged (bypass), #4 no review + self-merged (bypass).
    const prs = [
      { id: 1, hadExternalReview: true, selfMerged: false },
      { id: 2, hadExternalReview: false, selfMerged: false },
      { id: 3, hadExternalReview: true, selfMerged: true },
      { id: 4, hadExternalReview: false, selfMerged: true },
    ]
    const r = reviewBypassReceived.compute({ prs }, ASOF)

    expect(r.totalPrs).toBe(4)
    expect(r.bypassedPrs).toBe(3)
    expect(r.selfMergedPrs).toBe(2)
    expect(r.value).toBe(0.75)
    expect(r.unit).toBe('ratio')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('pr.review_bypass_rate_received')
    expect(r.asOf).toBe(ASOF)
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

  it('edge: all PRs reviewed and none self-merged → rate 0', () => {
    const prs = [
      { id: 1, hadExternalReview: true, selfMerged: false },
      { id: 2, hadExternalReview: true, selfMerged: false },
    ]
    const r = reviewBypassReceived.compute({ prs }, ASOF)
    expect(r.value).toBe(0)
    expect(r.bypassedPrs).toBe(0)
    expect(r.dataQuality).toBe('ok')
  })

  it('edge: single bypassed PR → rate 1', () => {
    const prs = [{ id: 1, hadExternalReview: false, selfMerged: false }]
    const r = reviewBypassReceived.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.bypassedPrs).toBe(1)
    expect(r.selfMergedPrs).toBe(0)
  })
})
