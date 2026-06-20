import { describe, expect, it } from 'bun:test'
import { ciGreenBeforeMerge } from './ciGreenBeforeMerge.js'

const ASOF = '2026-06-20T00:00:00.000Z'

const pr = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  hadChecks: true,
  greenAtMerge: true,
  checksCompletedAfterMerge: false,
  ...over,
})

describe('ciGreenBeforeMerge', () => {
  it('computes green-at-merge over checked PRs on a hand example', () => {
    // 6 checked PRs, 3 green at merge → 0.5. 1 of 8 total has no CI → noCiShare.
    // 2 extra non-CI PRs make total 8; 2 checked completed post-merge.
    const prs = [
      pr({ greenAtMerge: true }),
      pr({ greenAtMerge: true }),
      pr({ greenAtMerge: true }),
      pr({ greenAtMerge: false }),
      pr({ greenAtMerge: false, checksCompletedAfterMerge: true }),
      pr({ greenAtMerge: false, checksCompletedAfterMerge: true }),
      pr({ hadChecks: false, greenAtMerge: false }),
      pr({ hadChecks: false, greenAtMerge: false }),
    ]
    const r = ciGreenBeforeMerge.compute({ prs }, ASOF)
    expect(r.value).toBe(0.5)
    expect(r.checkedPrs).toBe(6)
    expect(r.totalPrs).toBe(8)
    expect(r.noCiShare).toBe(0.25)
    expect(r.postMergeCiShare).toBe(2 / 6)
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('ratio')
    expect(r.asOf).toBe(ASOF)
  })

  it('returns no_data when no PR has checks', () => {
    const prs = [pr({ hadChecks: false }), pr({ hadChecks: false })]
    const r = ciGreenBeforeMerge.compute({ prs }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.checkedPrs).toBe(0)
    expect(r.noCiShare).toBe(1)
    // safeRatio over 0 denominator stays null, never mis-scored as discipline.
    expect(r.postMergeCiShare).toBeNull()
  })

  it('handles empty input as no_data', () => {
    const r = ciGreenBeforeMerge.compute({ prs: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.totalPrs).toBe(0)
    expect(r.noCiShare).toBeNull()
  })

  it('flags insufficient_sample below the floor but still computes', () => {
    // 4 checked PRs (< 5), all green → value 1 but flagged.
    const prs = [pr(), pr(), pr(), pr()]
    const r = ciGreenBeforeMerge.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.checkedPrs).toBe(4)
    expect(r.dataQuality).toBe('insufficient_sample')
  })
})
