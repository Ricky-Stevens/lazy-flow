import { ENGINE_VERSION, percentile } from '../../core/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single team's contribution to the org rollup for one day. */

// ---------------------------------------------------------------------------
// computeTeamMedian
// ---------------------------------------------------------------------------

/**
 * Compute the median of non-null values from a team's daily entries
 * over a date window.
 */
function computeTeamMedian(entries) {
  const values = entries.map((e) => e.value).filter((v) => v !== null)
  if (values.length === 0) return null
  return percentile(values, 0.5)
}

// ---------------------------------------------------------------------------
// computeRollupDistribution
// ---------------------------------------------------------------------------

/**
 * Compute a distribution over an array of numeric values.
 * Uses the pinned type-7 percentile algorithm from core (SPEC §8.6).
 */
export function computeRollupDistribution(values) {
  if (values.length === 0) {
    return { min: null, p25: null, median: null, p75: null, p90: null, max: null, count: 0 }
  }

  // Filter non-finite values BEFORE sorting so min/max, percentiles and count
  // are all derived from the same clean set (percentile() filters internally,
  // so an unfiltered array here would make min/max inconsistent with the
  // percentiles — a determinism violation per SPEC §8.6). Mirrors quantiles().
  const clean = values.filter(Number.isFinite)
  if (clean.length === 0) {
    return { min: null, p25: null, median: null, p75: null, p90: null, max: null, count: 0 }
  }
  const sorted = [...clean].sort((a, b) => a - b)

  return {
    min: sorted[0] ?? null,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? null,
    count: clean.length,
  }
}

// ---------------------------------------------------------------------------
// computeOrgRollup
// ---------------------------------------------------------------------------

/**
 * Aggregate team-level daily metric values into an org-level distribution.
 *
 * NOTE: intentionally not surfaced by any MCP tool in the single-team local model
 * (the configured repos+projects are one dataset under the 'team'/'org' scopes) —
 * kept for the multi-team rollup path, deferred. Do not delete.
 *
 * Effective-dated membership is resolved upstream — callers should use
 * store.getTeamMembers(teamId, day) to project members for each day.
 *
 * @example
 * const result = computeOrgRollup({
 *   orgId: 'org-1',
 *   metricId: 'flow.throughput',
 *   teamEntries: [...],
 *   fromDay: '2024-01-01',
 *   toDay: '2024-01-31',
 *   now: '2024-02-01T00:00:00Z',
 * })
 */
export function computeOrgRollup(opts) {
  const { orgId, metricId, teamEntries, fromDay, toDay, now } = opts

  // Group entries by team
  const byTeam = new Map()
  for (const entry of teamEntries) {
    // Filter to window
    if (entry.day < fromDay || entry.day > toDay) continue
    let arr = byTeam.get(entry.teamId)
    if (!arr) {
      arr = []
      byTeam.set(entry.teamId, arr)
    }
    arr.push(entry)
  }

  // Compute per-team medians
  const teamMedians = []
  for (const [, entries] of byTeam) {
    const median = computeTeamMedian(entries)
    if (median !== null) {
      teamMedians.push(median)
    }
  }

  const distribution = computeRollupDistribution(teamMedians)
  const orgMedian = teamMedians.length > 0 ? percentile(teamMedians, 0.5) : null

  return {
    orgId,
    metricId,
    fromDay,
    toDay,
    engineVersion: ENGINE_VERSION,
    computedAt: now,
    distribution,
    orgMedian,
    teamCount: teamMedians.length,
  }
}

// ---------------------------------------------------------------------------
// buildTeamEntriesFromSnapshots
// ---------------------------------------------------------------------------

/**
 * Project MetricSnapshot records into TeamRollupEntry records.
 *
 * Filters to non-stale snapshots with the current engine version.
 * The caller should pass snapshots for a single metric across multiple teams.
 */
export function buildTeamEntriesFromSnapshots(snapshots) {
  return snapshots
    .filter((s) => !s.isStale && s.engineVersion === ENGINE_VERSION)
    .map((s) => ({
      teamId: s.scopeId,
      day: s.day,
      value: s.value,
    }))
}
