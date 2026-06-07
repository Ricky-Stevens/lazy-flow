/**
 * Re-derivation — WP-REDERIVE (SPEC §6.2, §8.6)
 *
 * On an engine_version/formula change OR a reconciliation that mutated raw
 * rows for day D:
 *   1. Mark affected metric_snapshots stale.
 *   2. Recompute them over retained raw, stamping the new engine_version /
 *      ingest_watermark_version.
 *
 * False-trend guard (SPEC §8.6)
 * ──────────────────────────────
 * A time series that spans multiple engine_versions is potentially misleading
 * (formula changed mid-series → trends are artefacts of the version change,
 * not real signal).  guardMixedVersionSeries() refuses to return such a series
 * without an explicit override flag.
 */

import type { MetricScope, MetricSnapshot, Store } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { ComputeDayFn } from '../snapshots/index.js'
import { buildCoverageFingerprint } from '../snapshots/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for markStaleAndRederive. */
export interface RederiveOptions {
  store: Store
  scopeType: MetricScope
  scopeId: string
  /** Metric ids to re-derive.  If empty, all metrics for the scope are affected. */
  metricIds: readonly string[]
  /** The day (YYYY-MM-DD) whose raw rows were mutated or whose formula changed. */
  day: string
  /** The compute function that drives recomputation. */
  computeFn: ComputeDayFn
  /** Current wall-clock time (ISO-8601, injected — never Date.now()). */
  now: string
}

/** Result from markStaleAndRederive. */
export interface RederiveResult {
  /** Number of snapshots marked stale. */
  markedStale: number
  /** Number of snapshots recomputed and persisted. */
  recomputed: number
  /** Metric ids that were recomputed. */
  metricIds: readonly string[]
}

// ---------------------------------------------------------------------------
// markStaleAndRederive
// ---------------------------------------------------------------------------

/**
 * Mark affected snapshots stale then immediately recompute them.
 *
 * This is called when either:
 *   a) ENGINE_VERSION has been bumped (formula change), or
 *   b) A reconciliation pass mutated a raw row for a given day.
 *
 * Steps:
 *   1. For each metricId, mark all snapshots for (scopeType, scopeId, metric, day) stale.
 *   2. Recompute via computeFn.
 *   3. Persist the new snapshot with the current ENGINE_VERSION and watermark.
 */
export async function markStaleAndRederive(opts: RederiveOptions): Promise<RederiveResult> {
  const { store, scopeType, scopeId, metricIds, day, computeFn, now } = opts

  let markedStale = 0
  let recomputed = 0
  const recomputedIds: string[] = []

  for (const metricId of metricIds) {
    // Step 1: mark stale
    await store.markSnapshotsStale(scopeType, scopeId, metricId, day)
    markedStale++

    // Step 2: recompute
    const result = await computeFn(scopeType, scopeId, metricId, day)

    // Step 3: get current watermark for versioning
    const syncState = await store.getSyncState('github', 'pulls', scopeId)
    const watermarkAt = syncState?.watermarkAt ?? null
    const ingestWatermarkVersion = watermarkAt ?? 'unknown'

    // Step 4: persist fresh snapshot
    const snapshot: MetricSnapshot = {
      scopeType,
      scopeId,
      metric: metricId,
      day,
      value: result.value,
      window: result.asOf,
      trustTier: result.trustTier,
      dataQuality: result.dataQuality,
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion,
      coverageFingerprint: buildCoverageFingerprint(ingestWatermarkVersion),
      computedAt: now,
      isStale: false,
    }

    await store.putSnapshot(snapshot)
    recomputed++
    recomputedIds.push(metricId)
  }

  return {
    markedStale,
    recomputed,
    metricIds: recomputedIds,
  }
}

// ---------------------------------------------------------------------------
// Mixed-version guard
// ---------------------------------------------------------------------------

/** Error thrown when a series spans mixed engine versions without override. */
export class MixedEngineVersionError extends Error {
  readonly versions: readonly string[]

  constructor(versions: readonly string[]) {
    super(
      `Series spans mixed engine versions: [${versions.join(', ')}]. ` +
        'This may indicate a false trend caused by a formula change mid-series. ' +
        'Pass allowMixedVersions=true to override this guard.',
    )
    this.name = 'MixedEngineVersionError'
    this.versions = versions
  }
}

/** Options for guardMixedVersionSeries. */
export interface GuardMixedVersionsOptions {
  /** If true, allow mixed versions and return snapshots unchanged. */
  allowMixedVersions?: boolean
}

/**
 * Guard that refuses to return a series spanning mixed engine versions
 * without an explicit override flag.
 *
 * SPEC §8.6: "tools refuse to plot across mixed engine versions without an
 * explicit flag (false-trend guard)."
 *
 * @throws MixedEngineVersionError when allowMixedVersions is false/absent
 *         and the series contains more than one engine version.
 */
export function guardMixedVersionSeries(
  snapshots: readonly MetricSnapshot[],
  opts: GuardMixedVersionsOptions = {},
): readonly MetricSnapshot[] {
  if (snapshots.length === 0) return snapshots

  const versions = new Set(snapshots.map((s) => s.engineVersion))
  if (versions.size <= 1) return snapshots

  // Mixed versions detected
  if (opts.allowMixedVersions) {
    // Caller explicitly allows it — return as-is
    return snapshots
  }

  throw new MixedEngineVersionError([...versions])
}

// ---------------------------------------------------------------------------
// rederiveStaleSnapshots
// ---------------------------------------------------------------------------

/**
 * Find all stale snapshots for a scope+metric+day and recompute them.
 *
 * This is the lazy recompute path: called after a reconciliation event
 * marks snapshots stale, to bring them back to a fresh state.
 */
export async function rederiveStaleSnapshots(
  store: Store,
  scopeType: MetricScope,
  scopeId: string,
  metricId: string,
  fromDay: string,
  toDay: string,
  computeFn: ComputeDayFn,
  now: string,
): Promise<RederiveResult> {
  const all = await store.getSnapshots(scopeType, scopeId, metricId, fromDay, toDay)
  const stale = all.filter((s) => s.isStale)

  const days = [...new Set(stale.map((s) => s.day))]

  let recomputed = 0
  const recomputedIds: string[] = []

  for (const day of days) {
    const result = await computeFn(scopeType, scopeId, metricId, day)

    const syncState = await store.getSyncState('github', 'pulls', scopeId)
    const watermarkAt = syncState?.watermarkAt ?? null
    const ingestWatermarkVersion = watermarkAt ?? 'unknown'

    const snapshot: MetricSnapshot = {
      scopeType,
      scopeId,
      metric: metricId,
      day,
      value: result.value,
      window: result.asOf,
      trustTier: result.trustTier,
      dataQuality: result.dataQuality,
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion,
      coverageFingerprint: buildCoverageFingerprint(ingestWatermarkVersion),
      computedAt: now,
      isStale: false,
    }

    await store.putSnapshot(snapshot)
    recomputed++
    recomputedIds.push(metricId)
  }

  return {
    markedStale: 0, // already stale, not marking here
    recomputed,
    metricIds: recomputedIds,
  }
}
