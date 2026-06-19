import { ENGINE_VERSION } from '../../core/index.js'

import { buildCoverageFingerprint, enumerateDays } from '../snapshots/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for markStaleAndRederive. */

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
export async function markStaleAndRederive(opts) {
  const { store, scopeType, scopeId, metricIds, day, computeFn, now } = opts

  let markedStale = 0
  let recomputed = 0
  const recomputedIds = []

  for (const metricId of metricIds) {
    // Capture the existing rolling-window descriptor ('30d'/'90d'…) BEFORE marking
    // stale so the re-derived snapshot keeps the same window. The `window` column
    // is a window descriptor, not a timestamp — writing result.asOf here corrupted
    // it and broke window-scoped reads.
    const priorWindow = await readSnapshotWindow(store, scopeType, scopeId, metricId, day)

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
    const snapshot = {
      scopeType,
      scopeId,
      metric: metricId,
      day,
      value: result.value,
      window: priorWindow,
      trustTier: result.trustTier,
      dataQuality: result.dataQuality,
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion,
      coverageFingerprint: buildCoverageFingerprint(ingestWatermarkVersion),
      computedAt: now,
      isStale: false,
      dataSource: result.dataSource,
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

/**
 * Read the rolling-window descriptor ('30d', '90d', …) of the existing snapshot
 * for a (scope, metric, day), defaulting to '1d' when none is found. Used so
 * re-derivation preserves the original window rather than overwriting it.
 */
async function readSnapshotWindow(store, scopeType, scopeId, metricId, day) {
  const existing = await store.getSnapshots(scopeType, scopeId, metricId, day, day)
  return existing[0]?.window ?? '1d'
}

// ---------------------------------------------------------------------------
// Mixed-version guard
// ---------------------------------------------------------------------------

/** Error thrown when a series spans mixed engine versions without override. */
export class MixedEngineVersionError extends Error {
  versions

  constructor(versions) {
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
export function guardMixedVersionSeries(snapshots, opts = {}) {
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
  store,
  scopeType,
  scopeId,
  metricId,
  fromDay,
  toDay,
  computeFn,
  now,
) {
  const all = await store.getSnapshots(scopeType, scopeId, metricId, fromDay, toDay)
  const stale = all.filter((s) => s.isStale)

  const days = [...new Set(stale.map((s) => s.day))]
  // Preserve each day's original rolling-window descriptor (the `window` column
  // is '30d'/'90d', NOT a timestamp); writing result.asOf corrupted it.
  const windowByDay = new Map(stale.map((s) => [s.day, s.window]))

  let recomputed = 0
  const recomputedIds = []

  for (const day of days) {
    const result = await computeFn(scopeType, scopeId, metricId, day)

    const syncState = await store.getSyncState('github', 'pulls', scopeId)
    const watermarkAt = syncState?.watermarkAt ?? null
    const ingestWatermarkVersion = watermarkAt ?? 'unknown'

    const snapshot = {
      scopeType,
      scopeId,
      metric: metricId,
      day,
      value: result.value,
      window: windowByDay.get(day) ?? '1d',
      trustTier: result.trustTier,
      dataQuality: result.dataQuality,
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion,
      coverageFingerprint: buildCoverageFingerprint(ingestWatermarkVersion),
      computedAt: now,
      isStale: false,
      dataSource: result.dataSource,
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

// ---------------------------------------------------------------------------
// rederiveStaleEngineSnapshots — engine-version-bump trigger
// ---------------------------------------------------------------------------

/** One scope to scan for engine-version drift. */

/**
 * Engine-version-bump trigger (SPEC §8.6).
 *
 * Scans the given scopes/metrics over [fromDay, toDay] for snapshots whose stored
 * `engineVersion` differs from the current {@link ENGINE_VERSION} — i.e. snapshots
 * computed by an older formula version that would otherwise silently mix into a
 * series after an engine upgrade. Any such day is marked stale and re-derived at
 * the current engine version.
 *
 * This is a NO-OP (zero store writes) when every stored snapshot already carries
 * the current ENGINE_VERSION, so it is safe to call unconditionally on every sync
 * and on server startup. It is bounded by the explicit scope/metric/day window the
 * caller passes (the same window the snapshot writer populates).
 *
 * Re-derivation reuses {@link rederiveStaleSnapshots}, which recomputes only the
 * days flagged stale here and stamps the current ENGINE_VERSION + watermark.
 */
export async function rederiveStaleEngineSnapshots(opts) {
  const { store, scopes, metricIds, fromDay, toDay, computeFn, now } = opts

  // Bound the scan to the requested window up front so we never enumerate an
  // unbounded history (the window is the caller's responsibility).
  const windowDays = new Set(enumerateDays(fromDay, toDay))

  let bumpDetected = false
  let markedStale = 0
  let recomputed = 0

  for (const { scopeType, scopeId } of scopes) {
    for (const metricId of metricIds) {
      const stored = await store.getSnapshots(scopeType, scopeId, metricId, fromDay, toDay)

      // Days whose stored snapshot was computed by a DIFFERENT engine version.
      // De-duplicate days (a day can carry multiple rows across watermark versions).
      const staleDays = new Set()
      for (const snap of stored) {
        if (snap.engineVersion !== ENGINE_VERSION && windowDays.has(snap.day)) {
          staleDays.add(snap.day)
        }
      }

      if (staleDays.size === 0) continue
      bumpDetected = true

      for (const day of staleDays) {
        await store.markSnapshotsStale(scopeType, scopeId, metricId, day)
        markedStale++
      }

      // Recompute exactly the days we just flagged stale, stamping the current
      // ENGINE_VERSION. rederiveStaleSnapshots filters to isStale rows internally.
      const result = await rederiveStaleSnapshots(
        store,
        scopeType,
        scopeId,
        metricId,
        fromDay,
        toDay,
        computeFn,
        now,
      )
      recomputed += result.recomputed
    }
  }

  return { bumpDetected, markedStale, recomputed }
}
