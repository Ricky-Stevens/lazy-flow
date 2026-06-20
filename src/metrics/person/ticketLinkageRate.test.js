import { describe, expect, it } from 'bun:test'
import { ticketLinkageRate } from './ticketLinkageRate.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('ticketLinkageRate', () => {
  it('computes linkage rate and confidence-weighted rate on a hand example', () => {
    const prs = [
      { id: 'a', linkCount: 2, maxLinkConfidence: 1 },
      { id: 'b', linkCount: 1, maxLinkConfidence: 0.5 },
      { id: 'c', linkCount: 0, maxLinkConfidence: 0 },
      { id: 'd', linkCount: 0, maxLinkConfidence: 0 },
      { id: 'e', linkCount: 1, maxLinkConfidence: 0.8 },
    ]
    const r = ticketLinkageRate.compute({ prs }, ASOF)
    expect(r.value).toBe(3 / 5)
    expect(r.confidenceWeightedRate).toBeCloseTo((1 + 0.5 + 0.8) / 5, 10)
    expect(r.linkedPrs).toBe(3)
    expect(r.totalPrs).toBe(5)
    expect(r.unlinkedEvidence).toEqual(['c', 'd'])
    expect(r.dataQuality).toBe('ok')
    expect(r.unit).toBe('ratio')
  })

  it('returns no_data when there are no PRs', () => {
    const r = ticketLinkageRate.compute({ prs: [] }, ASOF)
    expect(r.value).toBeNull()
    expect(r.dataQuality).toBe('no_data')
    expect(r.confidenceWeightedRate).toBeNull()
    expect(r.linkedPrs).toBe(0)
    expect(r.totalPrs).toBe(0)
    expect(r.unlinkedEvidence).toEqual([])
  })

  it('handles missing inputs.prs as no_data', () => {
    const r = ticketLinkageRate.compute({}, ASOF)
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    const prs = [{ id: 'x', linkCount: 1, maxLinkConfidence: 1 }]
    const r = ticketLinkageRate.compute({ prs }, ASOF)
    expect(r.value).toBe(1)
    expect(r.dataQuality).toBe('insufficient_sample')
    expect(r.linkedPrs).toBe(1)
    expect(r.unlinkedEvidence).toEqual([])
  })

  it('caps unlinkedEvidence at 5 ids when all PRs are unlinked', () => {
    const prs = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      linkCount: 0,
      maxLinkConfidence: 0,
    }))
    const r = ticketLinkageRate.compute({ prs }, ASOF)
    expect(r.value).toBe(0)
    expect(r.confidenceWeightedRate).toBe(0)
    expect(r.unlinkedEvidence).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    expect(r.dataQuality).toBe('ok')
  })
})
