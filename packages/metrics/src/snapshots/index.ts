/**
 * Snapshot writer — WP-SNAPSHOTS (SPEC §6.2, §8.6)
 *
 * Computes the metric catalogue for a scope+day and persists versioned
 * metric_snapshots keyed on (scope_type, scope_id, metric, day,
 * ingest_watermark_version) carrying engine_version, coverage_fingerprint,
 * and data_quality.
 *
 * Window-closing / grace-period rule
 * ────────────────────────────────────
 * A day D is "CLOSED" once the ingest watermark for the relevant source(s)
 * has been stable past D + gracePeriodMs (default 48 h).  A day that is still
 * within the grace window is "OPEN" — late-arriving events can still mutate it.
 *
 * Acceptance contract (SPEC WP-SNAPSHOTS v2):
 *   recompute of a CLOSED window == stored snapshot.  (NOT "always equals" —
 *   late data legitimately changes open windows.)
 *
 * The caller (MCP tool / orchestrator) is responsible for providing the
 * ComputeDayFn — a pure function that, given a scope and ISO day string,
 * calls the appropriate metric engine and returns a MetricResult.  This
 * keeps the snapshot writer decoupled from every individual metric module.
 */

import type { MetricResult, MetricScope, MetricSnapshot, Store, Visibility } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import { shouldPersistPersonSnapshot } from '../visibility/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options controlling which snapshots to write. */
export interface SnapshotWriterOptions {
  /** The store to read/write snapshots. */
  store: Store
  /** Grace period in milliseconds after which a window is considered closed. Default 48 h. */
  gracePeriodMs?: number
  /** The current wall-clock time (ISO-8601).  Injected for testability (SPEC §8.6). */
  now: string
  /**
   * Visibility policy (default: 'public').
   * Controls whether person-scope snapshots are persisted (SPEC §11.1 WP-VISIBILITY).
   * Under 'team' or 'self', person-scope snapshots are NOT written — they are
   * computed on demand only.  Non-person scopes are always persisted.
   */
  visibility?: Visibility
}

/** A function that computes a single metric for a given scope+day on demand. */
export type ComputeDayFn = (
  scopeType: MetricScope,
  scopeId: string,
  metricId: string,
  day: string,
) => Promise<MetricResult>

/** Result from computeSnapshotDay / computeSnapshotRange. */
export interface SnapshotWriteResult {
  /** Number of snapshots written (inserted or updated). */
  written: number
  /** Metric ids that were written. */
  metricIds: readonly string[]
  /** Day(s) that were written. */
  days: readonly string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default grace period: 48 hours in milliseconds. */
export const DEFAULT_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// isWindowClosed
// ---------------------------------------------------------------------------

/**
 * Returns true when day D is "closed" — i.e. the watermark timestamp is
 * at least (end-of-day-D + gracePeriodMs) behind now.
 *
 * A "closed" day's snapshot is expected to be stable: recomputing it against
 * the same raw data must equal the stored value (SPEC WP-SNAPSHOTS acceptance).
 *
 * @param day            - ISO date string 'YYYY-MM-DD' (UTC)
 * @param watermarkAt    - ISO-8601 timestamp of the latest ingest watermark
 * @param now            - ISO-8601 current time (injected, never Date.now())
 * @param gracePeriodMs  - Grace window after which a day is considered closed
 */
export function isWindowClosed(
  day: string,
  watermarkAt: string | null,
  now: string,
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
): boolean {
  if (!watermarkAt) return false

  // End-of-day D in UTC = start of D+1
  const endOfDayMs = new Date(`${day}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000
  const watermarkMs = new Date(watermarkAt).getTime()
  const nowMs = new Date(now).getTime()

  // The watermark must have passed end-of-day, AND enough grace time has elapsed
  return watermarkMs >= endOfDayMs && nowMs - endOfDayMs >= gracePeriodMs
}

// ---------------------------------------------------------------------------
// coverageFingerprint helper
// ---------------------------------------------------------------------------

/**
 * Builds a stable coverage fingerprint from the watermark version.
 * In production this would hash the credential scope; here we use the
 * watermark string itself as a deterministic proxy (SPEC §5.3).
 */
export function buildCoverageFingerprint(ingestWatermarkVersion: string): string {
  // Simple deterministic fingerprint: SHA-256 is not available without crypto
  // in all environments, so we use a stable hash over the watermark string.
  let h = 0
  for (let i = 0; i < ingestWatermarkVersion.length; i++) {
    h = (Math.imul(31, h) + ingestWatermarkVersion.charCodeAt(i)) >>> 0
  }
  return `fp-${h.toString(16).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// computeSnapshotDay
// ---------------------------------------------------------------------------

/**
 * Computes metrics for a single scope+day and persists them.
 *
 * - Fetches the current watermark from sync_state for the scope.
 * - For CLOSED windows: skips recomputation if a non-stale snapshot already
 *   exists with the same engine_version + watermark_version.
 * - For OPEN windows or stale snapshots: always recomputes and persists.
 */
export async function computeSnapshotDay(
  opts: SnapshotWriterOptions,
  scopeType: MetricScope,
  scopeId: string,
  metricIds: readonly string[],
  day: string,
  computeFn: ComputeDayFn,
): Promise<SnapshotWriteResult> {
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
  const visibility = opts.visibility ?? 'public'

  // WP-VISIBILITY: under 'team' or 'self', person-scope snapshots are not persisted.
  // Compute on demand only (caller can call computeFn directly).
  if (!shouldPersistPersonSnapshot(scopeType, visibility)) {
    return { written: 0, metricIds: [], days: [] }
  }

  // Derive watermark from sync_state (best-effort: use the most recent GitHub cursor)
  const syncState = await opts.store.getSyncState('github', 'pulls', scopeId)
  const watermarkAt = syncState?.watermarkAt ?? null
  const ingestWatermarkVersion = watermarkAt ?? 'unknown'
  const coverageFingerprint = buildCoverageFingerprint(ingestWatermarkVersion)

  const closed = isWindowClosed(day, watermarkAt, opts.now, gracePeriodMs)

  let written = 0
  const writtenMetricIds: string[] = []

  for (const metricId of metricIds) {
    // For closed windows, check if we already have a fresh non-stale snapshot
    if (closed) {
      const existing = await opts.store.getSnapshots(scopeType, scopeId, metricId, day, day)
      const fresh = existing.find(
        (s) =>
          !s.isStale &&
          s.engineVersion === ENGINE_VERSION &&
          s.ingestWatermarkVersion === ingestWatermarkVersion,
      )
      if (fresh) {
        // Closed window, snapshot is current — no recompute needed
        continue
      }
    }

    // Compute the metric
    const result = await computeFn(scopeType, scopeId, metricId, day)

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
      coverageFingerprint,
      computedAt: opts.now,
      isStale: false,
    }

    await opts.store.putSnapshot(snapshot)
    written++
    writtenMetricIds.push(metricId)
  }

  return {
    written,
    metricIds: writtenMetricIds,
    days: written > 0 ? [day] : [],
  }
}

// ---------------------------------------------------------------------------
// computeSnapshotRange
// ---------------------------------------------------------------------------

/**
 * On-demand recompute for an arbitrary date range [fromDay, toDay] (inclusive).
 *
 * Iterates each day in the range, calling computeSnapshotDay.
 * Closed windows with fresh snapshots are skipped automatically.
 */
export async function computeSnapshotRange(
  opts: SnapshotWriterOptions,
  scopeType: MetricScope,
  scopeId: string,
  metricIds: readonly string[],
  fromDay: string,
  toDay: string,
  computeFn: ComputeDayFn,
): Promise<SnapshotWriteResult> {
  const days = enumerateDays(fromDay, toDay)
  let totalWritten = 0
  const allMetricIds = new Set<string>()
  const allDays: string[] = []

  for (const day of days) {
    const result = await computeSnapshotDay(opts, scopeType, scopeId, metricIds, day, computeFn)
    totalWritten += result.written
    for (const m of result.metricIds) allMetricIds.add(m)
    for (const d of result.days) allDays.push(d)
  }

  return {
    written: totalWritten,
    metricIds: [...allMetricIds],
    days: allDays,
  }
}

// ---------------------------------------------------------------------------
// enumerateDays helper
// ---------------------------------------------------------------------------

/**
 * Enumerates all 'YYYY-MM-DD' strings from fromDay to toDay inclusive.
 */
export function enumerateDays(fromDay: string, toDay: string): string[] {
  const days: string[] = []
  const from = new Date(`${fromDay}T00:00:00Z`)
  const to = new Date(`${toDay}T00:00:00Z`)
  const current = new Date(from)

  while (current <= to) {
    days.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return days
}
