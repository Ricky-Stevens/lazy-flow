/**
 * Tests for the snapshot writer (WP-SNAPSHOTS).
 *
 * Acceptance contract per SPEC WP-SNAPSHOTS:
 *   1. Recompute of a CLOSED window equals the stored snapshot.
 *   2. A late-arriving event for a closed day marks it stale → recompute →
 *      the snapshot and on-the-fly recompute reconverge.
 *   3. Closed windows with fresh, non-stale snapshots skip recomputation.
 *   4. enumerateDays / isWindowClosed behave correctly at boundaries.
 */

import type { MetricResult, MetricScope } from '@lazy-flow/core'
import { ENGINE_VERSION, migrate, NodeSqliteStore } from '@lazy-flow/core'
import { describe, expect, it } from 'vitest'
import type { ComputeDayFn, SnapshotWriterOptions } from './index.js'
import {
  buildCoverageFingerprint,
  computeSnapshotDay,
  computeSnapshotRange,
  DEFAULT_GRACE_PERIOD_MS,
  enumerateDays,
  isWindowClosed,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): NodeSqliteStore {
  const store = new NodeSqliteStore(':memory:')
  migrate(store.db)
  return store
}

/** A simple ComputeDayFn that returns a deterministic non-null result. */
function makeComputeFn(valueForDay: (day: string) => number | null = () => 42): ComputeDayFn {
  return async (
    scopeType: MetricScope,
    _scopeId: string,
    metricId: string,
    day: string,
  ): Promise<MetricResult> => ({
    id: metricId,
    trustTier: 'deterministic',
    scope: scopeType,
    value: valueForDay(day),
    unit: 'count',
    dataQuality: valueForDay(day) === null ? 'no_data' : 'ok',
    engineVersion: ENGINE_VERSION,
    asOf: `${day}T00:00:00Z`,
    formulaDoc: 'test metric',
  })
}

const NOW = '2024-06-05T00:00:00Z' // well past the grace period for days in Jan–May

// ---------------------------------------------------------------------------
// isWindowClosed
// ---------------------------------------------------------------------------

describe('isWindowClosed', () => {
  it('returns false when watermark is null', () => {
    expect(isWindowClosed('2024-01-01', null, NOW)).toBe(false)
  })

  it('returns false when watermark has not passed end-of-day', () => {
    // Watermark is only mid-day on Jan 1; end-of-day not yet passed
    expect(isWindowClosed('2024-01-01', '2024-01-01T12:00:00Z', '2024-01-01T13:00:00Z')).toBe(false)
  })

  it('returns false within the grace period', () => {
    // Day = Jan 1, end-of-day = Jan 2 00:00Z
    // watermark = Jan 3 (after end-of-day) but only 1h has elapsed since end-of-day
    const watermark = '2024-01-03T00:00:00Z'
    const tooSoon = '2024-01-02T01:00:00Z' // only 1h past end-of-day Jan 1
    expect(isWindowClosed('2024-01-01', watermark, tooSoon, DEFAULT_GRACE_PERIOD_MS)).toBe(false)
  })

  it('returns true when watermark is past end-of-day AND grace period has elapsed', () => {
    // Day = Jan 1, end-of-day = Jan 2 00:00Z
    // watermark = Jan 5 (well past), now = Jan 5 (48h+ past end-of-day)
    expect(isWindowClosed('2024-01-01', '2024-01-05T00:00:00Z', '2024-06-01T00:00:00Z')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// enumerateDays
// ---------------------------------------------------------------------------

describe('enumerateDays', () => {
  it('returns a single day when from == to', () => {
    expect(enumerateDays('2024-01-15', '2024-01-15')).toEqual(['2024-01-15'])
  })

  it('returns three days for a 3-day range', () => {
    expect(enumerateDays('2024-01-01', '2024-01-03')).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ])
  })

  it('crosses month boundary correctly', () => {
    expect(enumerateDays('2024-01-30', '2024-02-01')).toEqual([
      '2024-01-30',
      '2024-01-31',
      '2024-02-01',
    ])
  })
})

// ---------------------------------------------------------------------------
// buildCoverageFingerprint
// ---------------------------------------------------------------------------

describe('buildCoverageFingerprint', () => {
  it('is deterministic — same input produces same fingerprint', () => {
    const a = buildCoverageFingerprint('watermark-2024-01-01T00:00:00Z')
    const b = buildCoverageFingerprint('watermark-2024-01-01T00:00:00Z')
    expect(a).toBe(b)
  })

  it('different inputs produce different fingerprints', () => {
    const a = buildCoverageFingerprint('watermark-A')
    const b = buildCoverageFingerprint('watermark-B')
    expect(a).not.toBe(b)
  })

  it('starts with "fp-"', () => {
    expect(buildCoverageFingerprint('anything')).toMatch(/^fp-[0-9a-f]{8}$/)
  })
})

// ---------------------------------------------------------------------------
// computeSnapshotDay — basic write
// ---------------------------------------------------------------------------

describe('computeSnapshotDay — basic write', () => {
  it('writes a snapshot for an open day', async () => {
    const store = makeStore()
    // Seed a sync_state watermark so the day is "open" (within grace period)
    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'team-alpha',
      cursor: null,
      watermarkAt: '2024-05-30T00:00:00Z', // recent, close to now → open
      lastRunAt: NOW,
      status: 'idle',
      error: null,
    })

    const opts: SnapshotWriterOptions = {
      store,
      now: '2024-05-31T00:00:00Z', // only 1 day after watermark → open
      gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
    }

    const result = await computeSnapshotDay(
      opts,
      'team',
      'team-alpha',
      ['flow.throughput'],
      '2024-05-29',
      makeComputeFn(),
    )

    expect(result.written).toBe(1)
    expect(result.metricIds).toContain('flow.throughput')
    expect(result.days).toContain('2024-05-29')

    const snapshots = await store.getSnapshots(
      'team',
      'team-alpha',
      'flow.throughput',
      '2024-05-29',
      '2024-05-29',
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.value).toBe(42)
    expect(snapshots[0]?.engineVersion).toBe(ENGINE_VERSION)
    expect(snapshots[0]?.isStale).toBe(false)
  })

  it('idempotently upserts on the same watermark version', async () => {
    const store = makeStore()
    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'team-beta',
      cursor: null,
      watermarkAt: '2024-01-10T00:00:00Z',
      lastRunAt: '2024-01-10T00:00:00Z',
      status: 'idle',
      error: null,
    })

    const opts: SnapshotWriterOptions = { store, now: NOW }
    const computeFn = makeComputeFn()

    // Write twice — second call should still result in only 1 snapshot row
    await computeSnapshotDay(
      opts,
      'team',
      'team-beta',
      ['flow.throughput'],
      '2024-01-05',
      computeFn,
    )
    await computeSnapshotDay(
      opts,
      'team',
      'team-beta',
      ['flow.throughput'],
      '2024-01-05',
      computeFn,
    )

    const snapshots = await store.getSnapshots(
      'team',
      'team-beta',
      'flow.throughput',
      '2024-01-05',
      '2024-01-05',
    )
    // Upsert → still only one row
    expect(snapshots.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// CLOSED window: recompute == snapshot
// ---------------------------------------------------------------------------

describe('closed-window acceptance: recompute == stored snapshot', () => {
  it('recompute of a closed window matches the stored snapshot value', async () => {
    const store = makeStore()
    const CLOSED_DAY = '2024-01-15'

    // Seed a watermark well in the past so the day is closed
    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-closed',
      cursor: null,
      watermarkAt: '2024-01-20T00:00:00Z',
      lastRunAt: '2024-01-20T00:00:00Z',
      status: 'idle',
      error: null,
    })

    const opts: SnapshotWriterOptions = { store, now: NOW }
    const computeFn = makeComputeFn(() => 17)

    // First write
    await computeSnapshotDay(
      opts,
      'team',
      'scope-closed',
      ['flow.throughput'],
      CLOSED_DAY,
      computeFn,
    )

    const before = await store.getSnapshots(
      'team',
      'scope-closed',
      'flow.throughput',
      CLOSED_DAY,
      CLOSED_DAY,
    )
    expect(before).toHaveLength(1)
    const stored = before[0] ?? { value: undefined, engineVersion: undefined }

    // Second call — window is closed and snapshot is fresh → should SKIP (written=0)
    const secondResult = await computeSnapshotDay(
      opts,
      'team',
      'scope-closed',
      ['flow.throughput'],
      CLOSED_DAY,
      computeFn,
    )
    expect(secondResult.written).toBe(0)

    // The stored snapshot is unchanged
    const after = await store.getSnapshots(
      'team',
      'scope-closed',
      'flow.throughput',
      CLOSED_DAY,
      CLOSED_DAY,
    )
    expect(after[0]?.value).toBe(stored.value)
    expect(after[0]?.engineVersion).toBe(stored.engineVersion)
  })
})

// ---------------------------------------------------------------------------
// Late arrival: mark stale → recompute → reconvergence
// ---------------------------------------------------------------------------

describe('late arrival: stale → recompute → reconvergence', () => {
  it('after marking stale, recompute brings snapshot in line with on-the-fly result', async () => {
    const store = makeStore()
    const CLOSED_DAY = '2024-01-10'

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-late',
      cursor: null,
      watermarkAt: '2024-01-15T00:00:00Z',
      lastRunAt: '2024-01-15T00:00:00Z',
      status: 'idle',
      error: null,
    })

    const opts: SnapshotWriterOptions = { store, now: NOW }

    // Write initial snapshot with value=10
    const initialFn = makeComputeFn(() => 10)
    await computeSnapshotDay(opts, 'team', 'scope-late', ['flow.throughput'], CLOSED_DAY, initialFn)

    const [initial] = await store.getSnapshots(
      'team',
      'scope-late',
      'flow.throughput',
      CLOSED_DAY,
      CLOSED_DAY,
    )
    expect(initial?.value).toBe(10)
    expect(initial?.isStale).toBe(false)

    // Simulate late-arriving event: mark the snapshot stale
    await store.markSnapshotsStale('team', 'scope-late', 'flow.throughput', CLOSED_DAY)

    const [staled] = await store.getSnapshots(
      'team',
      'scope-late',
      'flow.throughput',
      CLOSED_DAY,
      CLOSED_DAY,
    )
    expect(staled?.isStale).toBe(true)

    // Recompute with the "updated" function (new value=99 after late data)
    const updatedFn = makeComputeFn(() => 99)
    await computeSnapshotDay(opts, 'team', 'scope-late', ['flow.throughput'], CLOSED_DAY, updatedFn)

    // Snapshot reconverges with the on-the-fly result
    const [recomputed] = await store.getSnapshots(
      'team',
      'scope-late',
      'flow.throughput',
      CLOSED_DAY,
      CLOSED_DAY,
    )
    expect(recomputed?.value).toBe(99)
    expect(recomputed?.isStale).toBe(false)

    // On-the-fly result matches the now-stored snapshot
    const liveResult = await updatedFn('team', 'scope-late', 'flow.throughput', CLOSED_DAY)
    expect(liveResult.value).toBe(recomputed?.value)
  })
})

// ---------------------------------------------------------------------------
// computeSnapshotRange
// ---------------------------------------------------------------------------

describe('computeSnapshotRange', () => {
  it('writes snapshots for all days in the range', async () => {
    const store = makeStore()

    await store.putSyncState({
      source: 'github',
      resource: 'pulls',
      scopeId: 'scope-range',
      cursor: null,
      watermarkAt: null, // no watermark → all days are open
      lastRunAt: null,
      status: 'idle',
      error: null,
    })

    const opts: SnapshotWriterOptions = { store, now: NOW }
    const result = await computeSnapshotRange(
      opts,
      'team',
      'scope-range',
      ['flow.throughput'],
      '2024-03-01',
      '2024-03-03',
      makeComputeFn((day) => (day === '2024-03-02' ? null : 5)),
    )

    expect(result.written).toBe(3)
    expect(result.days).toContain('2024-03-01')
    expect(result.days).toContain('2024-03-02')
    expect(result.days).toContain('2024-03-03')

    const snapshots = await store.getSnapshots(
      'team',
      'scope-range',
      'flow.throughput',
      '2024-03-01',
      '2024-03-03',
    )
    expect(snapshots).toHaveLength(3)

    const nullDay = snapshots.find((s) => s.day === '2024-03-02')
    expect(nullDay?.value).toBeNull()
    expect(nullDay?.dataQuality).toBe('no_data')
  })
})
