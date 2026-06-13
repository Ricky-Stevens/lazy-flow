/**
 * Tests for the rederive module (WP-REDERIVE).
 *
 * Acceptance contract:
 *   1. An engine_version bump invalidates (marks stale) + recomputes affected snapshots.
 *   2. A late-arriving event for a closed day marks it stale → recompute → the
 *      snapshot and on-the-fly recompute reconverge.
 *   3. A mixed-version series is refused without the override flag.
 *   4. With allowMixedVersions=true, mixed-version series are returned.
 *   5. markStaleAndRederive stamps the new ENGINE_VERSION.
 */

import { describe, expect, it } from 'bun:test'

import { BunSqliteStore, ENGINE_VERSION, migrate } from '../../core/index.js'

import {
  guardMixedVersionSeries,
  MixedEngineVersionError,
  markStaleAndRederive,
  rederiveStaleEngineSnapshots,
  rederiveStaleSnapshots,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

const NOW = '2024-06-05T00:00:00Z'

function makeComputeFn(value = 42) {
  return async (scopeType, _scopeId, metricId, day) => ({
    id: metricId,
    trustTier: 'deterministic',
    scope: scopeType,
    value,
    unit: 'count',
    dataQuality: 'ok',
    engineVersion: ENGINE_VERSION,
    asOf: `${day}T00:00:00Z`,
    formulaDoc: 'test',
  })
}

function makeSnapshot(scopeId, day, value, engineVersion = ENGINE_VERSION, isStale = false) {
  return {
    scopeType: 'team',
    scopeId,
    metric: 'flow.throughput',
    day,
    value,
    window: `${day}T00:00:00Z`,
    trustTier: 'deterministic',
    dataQuality: value === null ? 'no_data' : 'ok',
    engineVersion,
    ingestWatermarkVersion: 'v1',
    coverageFingerprint: 'fp-00000001',
    computedAt: NOW,
    isStale,
  }
}

// ---------------------------------------------------------------------------
// guardMixedVersionSeries
// ---------------------------------------------------------------------------

describe('guardMixedVersionSeries', () => {
  it('returns snapshots unchanged when all have the same engine version', () => {
    const snapshots = [makeSnapshot('t1', '2024-01-01', 5), makeSnapshot('t1', '2024-01-02', 10)]
    const result = guardMixedVersionSeries(snapshots)
    expect(result).toHaveLength(2)
  })

  it('returns empty array unchanged', () => {
    expect(guardMixedVersionSeries([])).toHaveLength(0)
  })

  it('throws MixedEngineVersionError when versions differ', () => {
    const snapshots = [
      makeSnapshot('t1', '2024-01-01', 5, '0.0.1'),
      makeSnapshot('t1', '2024-01-02', 10, '0.0.2'),
    ]
    expect(() => guardMixedVersionSeries(snapshots)).toThrow(MixedEngineVersionError)
  })

  it('throws and includes both versions in the error', () => {
    const snapshots = [
      makeSnapshot('t1', '2024-01-01', 5, '0.0.1'),
      makeSnapshot('t1', '2024-01-02', 10, '0.0.2'),
    ]
    try {
      guardMixedVersionSeries(snapshots)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(MixedEngineVersionError)
      const err = e
      expect(err.versions).toContain('0.0.1')
      expect(err.versions).toContain('0.0.2')
    }
  })

  it('returns mixed-version series when allowMixedVersions=true', () => {
    const snapshots = [
      makeSnapshot('t1', '2024-01-01', 5, '0.0.1'),
      makeSnapshot('t1', '2024-01-02', 10, '0.0.2'),
    ]
    const result = guardMixedVersionSeries(snapshots, { allowMixedVersions: true })
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// markStaleAndRederive
// ---------------------------------------------------------------------------

describe('markStaleAndRederive', () => {
  it('marks stale and recomputes with new value', async () => {
    const store = makeStore()

    // Seed sync_state
    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-rederive',
      cursor: null,
      watermarkAt: '2024-01-15T00:00:00Z',
      lastRunAt: '2024-01-15T00:00:00Z',
      status: 'idle',
      error: null,
    })

    // Write initial snapshot with value=10
    await store.putSnapshot(makeSnapshot('scope-rederive', '2024-01-10', 10))

    const before = await store.getSnapshots(
      'team',
      'scope-rederive',
      'flow.throughput',
      '2024-01-10',
      '2024-01-10',
    )
    expect(before[0]?.value).toBe(10)
    expect(before[0]?.isStale).toBe(false)

    // markStaleAndRederive with a new compute function → value=99
    const result = await markStaleAndRederive({
      store,
      scopeType: 'team',
      scopeId: 'scope-rederive',
      metricIds: ['flow.throughput'],
      day: '2024-01-10',
      computeFn: makeComputeFn(99),
      now: NOW,
    })

    expect(result.markedStale).toBe(1)
    expect(result.recomputed).toBe(1)
    expect(result.metricIds).toContain('flow.throughput')

    // Verify the persisted snapshot now has value=99 and is not stale
    const after = await store.getSnapshots(
      'team',
      'scope-rederive',
      'flow.throughput',
      '2024-01-10',
      '2024-01-10',
    )
    expect(after[0]?.value).toBe(99)
    expect(after[0]?.isStale).toBe(false)
    expect(after[0]?.engineVersion).toBe(ENGINE_VERSION)
  })

  it('stamps the current ENGINE_VERSION on recomputed snapshots', async () => {
    const store = makeStore()

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-version',
      cursor: null,
      watermarkAt: '2024-02-01T00:00:00Z',
      lastRunAt: '2024-02-01T00:00:00Z',
      status: 'idle',
      error: null,
    })

    // Write an "old version" snapshot manually
    await store.putSnapshot({
      ...makeSnapshot('scope-version', '2024-02-01', 5),
      engineVersion: '0.0.0', // simulated old version
    })

    await markStaleAndRederive({
      store,
      scopeType: 'team',
      scopeId: 'scope-version',
      metricIds: ['flow.throughput'],
      day: '2024-02-01',
      computeFn: makeComputeFn(77),
      now: NOW,
    })

    const after = await store.getSnapshots(
      'team',
      'scope-version',
      'flow.throughput',
      '2024-02-01',
      '2024-02-01',
    )
    // Should have a new row with current ENGINE_VERSION (old version row may still exist
    // since it has a different ingestWatermarkVersion key — find the fresh one)
    const fresh = after.find((s) => s.engineVersion === ENGINE_VERSION && !s.isStale)
    expect(fresh).toBeDefined()
    expect(fresh?.value).toBe(77)
  })
})

// ---------------------------------------------------------------------------
// rederiveStaleSnapshots
// ---------------------------------------------------------------------------

describe('rederiveStaleSnapshots', () => {
  it('recomputes all stale snapshots in a date range', async () => {
    const store = makeStore()

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-lazy',
      cursor: null,
      watermarkAt: '2024-03-10T00:00:00Z',
      lastRunAt: '2024-03-10T00:00:00Z',
      status: 'idle',
      error: null,
    })

    // Write two stale snapshots
    await store.putSnapshot(makeSnapshot('scope-lazy', '2024-03-01', 1, ENGINE_VERSION, true))
    await store.putSnapshot(makeSnapshot('scope-lazy', '2024-03-02', 2, ENGINE_VERSION, true))
    // One non-stale snapshot
    await store.putSnapshot(makeSnapshot('scope-lazy', '2024-03-03', 3, ENGINE_VERSION, false))

    const result = await rederiveStaleSnapshots(
      store,
      'team',
      'scope-lazy',
      'flow.throughput',
      '2024-03-01',
      '2024-03-03',
      makeComputeFn(100),
      NOW,
    )

    // Only 2 stale days recomputed
    expect(result.recomputed).toBe(2)

    // The stale days now have value=100 and isStale=false
    const snapshots = await store.getSnapshots(
      'team',
      'scope-lazy',
      'flow.throughput',
      '2024-03-01',
      '2024-03-03',
    )
    const day1 = snapshots.find((s) => s.day === '2024-03-01' && !s.isStale)
    const day2 = snapshots.find((s) => s.day === '2024-03-02' && !s.isStale)
    expect(day1?.value).toBe(100)
    expect(day2?.value).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Engine-version bump: full lifecycle
// ---------------------------------------------------------------------------

describe('engine_version bump lifecycle', () => {
  it('an engine version bump invalidates and recomputes affected snapshots', async () => {
    const store = makeStore()

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-bump',
      cursor: null,
      watermarkAt: '2024-04-05T00:00:00Z',
      lastRunAt: '2024-04-05T00:00:00Z',
      status: 'idle',
      error: null,
    })

    // Write snapshots with "old" engine version
    const oldVersion = '0.0.0'
    await store.putSnapshot({
      ...makeSnapshot('scope-bump', '2024-04-01', 10),
      engineVersion: oldVersion,
    })
    await store.putSnapshot({
      ...makeSnapshot('scope-bump', '2024-04-02', 20),
      engineVersion: oldVersion,
    })

    // Guard: series with old + new version should fail
    const mixedSnapshots = [
      { ...makeSnapshot('scope-bump', '2024-04-01', 10), engineVersion: oldVersion },
      { ...makeSnapshot('scope-bump', '2024-04-02', 20), engineVersion: ENGINE_VERSION },
    ]
    expect(() => guardMixedVersionSeries(mixedSnapshots)).toThrow(MixedEngineVersionError)

    // Rederive both days with the current engine
    for (const day of ['2024-04-01', '2024-04-02']) {
      await markStaleAndRederive({
        store,
        scopeType: 'team',
        scopeId: 'scope-bump',
        metricIds: ['flow.throughput'],
        day,
        computeFn: makeComputeFn(99),
        now: NOW,
      })
    }

    // Now fetch all snapshots for these days (current engine version only)
    const all = await store.getSnapshots(
      'team',
      'scope-bump',
      'flow.throughput',
      '2024-04-01',
      '2024-04-02',
    )
    const current = all.filter((s) => s.engineVersion === ENGINE_VERSION && !s.isStale)
    expect(current).toHaveLength(2)

    // No mixed-version error when all current
    expect(() => guardMixedVersionSeries(current)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// rederiveStaleEngineSnapshots — engine-bump trigger
// ---------------------------------------------------------------------------

describe('rederiveStaleEngineSnapshots', () => {
  it('re-derives a stale-version snapshot and leaves a current one untouched', async () => {
    const store = makeStore()

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'team',
      cursor: null,
      watermarkAt: '2024-05-10T00:00:00Z',
      lastRunAt: '2024-05-10T00:00:00Z',
      status: 'idle',
      error: null,
    })

    // One snapshot written by an OLDER engine version (value 10) ...
    await store.putSnapshot({
      ...makeSnapshot('team', '2024-05-01', 10),
      engineVersion: '0.0.0',
    })
    // ... and one already at the CURRENT engine version (value 20), not stale.
    await store.putSnapshot(makeSnapshot('team', '2024-05-02', 20, ENGINE_VERSION, false))

    const result = await rederiveStaleEngineSnapshots({
      store,
      scopes: [{ scopeType: 'team', scopeId: 'team' }],
      metricIds: ['flow.throughput'],
      fromDay: '2024-05-01',
      toDay: '2024-05-02',
      computeFn: makeComputeFn(99),
      now: NOW,
    })

    expect(result.bumpDetected).toBe(true)
    expect(result.markedStale).toBe(1)
    expect(result.recomputed).toBe(1)

    const snaps = await store.getSnapshots(
      'team',
      'team',
      'flow.throughput',
      '2024-05-01',
      '2024-05-02',
    )

    // The old-version day is re-derived to the current engine version + new value.
    const day1 = snaps.find((s) => s.day === '2024-05-01')
    expect(day1?.engineVersion).toBe(ENGINE_VERSION)
    expect(day1?.value).toBe(99)
    expect(day1?.isStale).toBe(false)

    // The already-current day is left exactly as it was (value not recomputed).
    const day2 = snaps.find((s) => s.day === '2024-05-02')
    expect(day2?.value).toBe(20)
    expect(day2?.isStale).toBe(false)
  })

  it('is a no-op when every stored snapshot is already at the current engine version', async () => {
    const store = makeStore()

    await store.putSnapshot(makeSnapshot('team', '2024-05-01', 10, ENGINE_VERSION, false))
    await store.putSnapshot(makeSnapshot('team', '2024-05-02', 20, ENGINE_VERSION, false))

    // computeFn that would throw if invoked — proves no recompute happens.
    const throwingCompute = async () => {
      throw new Error('compute should not be called for a no-op rederive')
    }

    const result = await rederiveStaleEngineSnapshots({
      store,
      scopes: [{ scopeType: 'team', scopeId: 'team' }],
      metricIds: ['flow.throughput'],
      fromDay: '2024-05-01',
      toDay: '2024-05-02',
      computeFn: throwingCompute,
      now: NOW,
    })

    expect(result.bumpDetected).toBe(false)
    expect(result.markedStale).toBe(0)
    expect(result.recomputed).toBe(0)
  })
})
