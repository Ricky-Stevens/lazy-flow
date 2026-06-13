import { describe, expect, it } from 'bun:test'

import { migrate } from '../migrate/runner.js'
import { BunSqliteStore } from './BunSqliteStore.js'

function mkStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

function mkBaseline(overrides = {}) {
  return {
    scopeType: 'team',
    scopeId: 'platform',
    metric: 'flow.cycle_time',
    baselineKind: 'self',
    periodKey: 'rolling-90d',
    asOfDay: '2026-05-31',
    windowKind: 'days',
    windowFrom: '2026-03-02',
    windowTo: '2026-05-31',
    n: 12,
    p50: 4,
    p75: 6,
    p90: null,
    mean: 4.5,
    sd: 1.2,
    mad: 1,
    driftZ: 0.1,
    driftStatus: 'stable',
    driftCause: null,
    superseded: false,
    trustTier: 'deterministic',
    dataQuality: 'ok',
    engineVersion: '0.1.0',
    ingestWatermarkVersion: '1',
    coverageFingerprint: 'cov-1',
    baselineVersion: '1',
    computedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('metric_baselines store (migration 0005)', () => {
  it('migration 0005 creates the table', () => {
    const store = mkStore()
    const row = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='metric_baselines'`)
      .get()
    expect(row?.name).toBe('metric_baselines')
    store.close()
  })

  it('round-trips a baseline (put → getLatest)', async () => {
    const store = mkStore()
    await store.putBaseline(mkBaseline())
    const latest = await store.getLatestBaseline(
      'team',
      'platform',
      'flow.cycle_time',
      'self',
      'rolling-90d',
    )
    expect(latest).not.toBeNull()
    expect(latest?.p50).toBe(4)
    expect(latest?.sd).toBe(1.2)
    expect(latest?.superseded).toBe(false)
    expect(latest?.driftStatus).toBe('stable')
    store.close()
  })

  it('getLatestBaseline returns the newest non-superseded by as_of_day', async () => {
    const store = mkStore()
    await store.putBaseline(mkBaseline({ asOfDay: '2026-04-30', p50: 3 }))
    await store.putBaseline(mkBaseline({ asOfDay: '2026-05-31', p50: 5 }))
    const latest = await store.getLatestBaseline(
      'team',
      'platform',
      'flow.cycle_time',
      'self',
      'rolling-90d',
    )
    expect(latest?.asOfDay).toBe('2026-05-31')
    expect(latest?.p50).toBe(5)
    store.close()
  })

  it('markBaselinesSuperseded hides prior rows from getLatest', async () => {
    const store = mkStore()
    await store.putBaseline(mkBaseline())
    await store.markBaselinesSuperseded('team', 'platform', 'flow.cycle_time', 'self')
    const latest = await store.getLatestBaseline(
      'team',
      'platform',
      'flow.cycle_time',
      'self',
      'rolling-90d',
    )
    expect(latest).toBeNull()
    // ...but the row is retained (reproducibility), just flagged superseded.
    const all = await store.getBaselines('team', 'platform', 'flow.cycle_time')
    expect(all.length).toBe(1)
    expect(all[0]?.superseded).toBe(true)
    store.close()
  })

  it('upsert (same PK) replaces non-key columns', async () => {
    const store = mkStore()
    await store.putBaseline(mkBaseline({ p50: 4 }))
    await store.putBaseline(mkBaseline({ p50: 9 }))
    const all = await store.getBaselines('team', 'platform', 'flow.cycle_time')
    expect(all.length).toBe(1)
    expect(all[0]?.p50).toBe(9)
    store.close()
  })
})
