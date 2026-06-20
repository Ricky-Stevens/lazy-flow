import { describe, expect, it } from 'bun:test'
import { changesRequestedReceived } from './changesRequestedReceived.js'

const ASOF = '2026-06-20T00:00:00.000Z'

const mkPrs = (withCr, total) =>
  Array.from({ length: total }, (_, i) => ({ id: `pr-${i}`, hadChangesRequested: i < withCr }))

describe('changesRequestedReceived', () => {
  it('computes the headline rate on a hand example', () => {
    // 3 of 10 authored PRs drew a changes-requested verdict → 0.3
    const out = changesRequestedReceived.compute({ prs: mkPrs(3, 10) }, ASOF)
    expect(out.value).toBe(0.3)
    expect(out.prsWithChangesRequested).toBe(3)
    expect(out.totalPrs).toBe(10)
    expect(out.dataQuality).toBe('ok')
    expect(out.unit).toBe('ratio')
    expect(out.id).toBe('pr.changes_requested_rate_received')
  })

  it('returns no_data when there are no authored PRs', () => {
    const out = changesRequestedReceived.compute({ prs: [] }, ASOF)
    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
    expect(out.totalPrs).toBe(0)
    expect(out.prsWithChangesRequested).toBe(0)
  })

  it('defaults missing prs input to no_data', () => {
    const out = changesRequestedReceived.compute({}, ASOF)
    expect(out.value).toBeNull()
    expect(out.dataQuality).toBe('no_data')
  })

  it('flags insufficient_sample below the floor but still returns the value', () => {
    // 1 of 4 (< 8) → value computed, quality flagged
    const out = changesRequestedReceived.compute({ prs: mkPrs(1, 4) }, ASOF)
    expect(out.value).toBe(0.25)
    expect(out.dataQuality).toBe('insufficient_sample')
  })

  it('handles a single PR with changes requested (edge)', () => {
    const out = changesRequestedReceived.compute({ prs: mkPrs(1, 1) }, ASOF)
    expect(out.value).toBe(1)
    expect(out.dataQuality).toBe('insufficient_sample')
  })

  it('handles all-equal: zero PRs with changes requested at the floor', () => {
    const out = changesRequestedReceived.compute({ prs: mkPrs(0, 8) }, ASOF)
    expect(out.value).toBe(0)
    expect(out.dataQuality).toBe('ok')
    expect(out.prsWithChangesRequested).toBe(0)
  })
})
