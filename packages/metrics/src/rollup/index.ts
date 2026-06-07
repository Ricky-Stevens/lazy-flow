/**
 * Rollup — WP-ROLLUP (SPEC §8.2, §5.4, WP-ROLLUP)
 *
 * Computes team → org aggregate distributions ("company-wide velocity /
 * throughput distribution") over teams/team_membership, respecting
 * effective-dated membership (a person's team at the time of the work).
 *
 * Scope: team and org only (SPEC WP-ROLLUP: "Team/org scope only").
 *
 * Design
 * ──────
 * A RollupInput carries an array of per-team MetricSnapshots.  The rollup
 * aggregates them to produce a distribution (min, p25, median, p75, p90, max)
 * across teams, plus an org-level scalar (median of team medians).
 *
 * Effective-dated membership is resolved by the caller before this function
 * is called — the caller queries store.getTeamMembers(teamId, at) for each
 * day and projects the membership into TeamMembershipRecord.
 */

import type { MetricScope, MetricSnapshot } from '@lazy-flow/core'
import { ENGINE_VERSION, percentile } from '@lazy-flow/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single team's contribution to the org rollup for one day. */
export interface TeamRollupEntry {
  teamId: string
  /** ISO 'YYYY-MM-DD' */
  day: string
  /** The scalar metric value for this team on this day (null = no data). */
  value: number | null
}

/** Options for computeOrgRollup. */
export interface OrgRollupOptions {
  scopeType: Extract<MetricScope, 'team' | 'org'>
  orgId: string
  metricId: string
  /** Per-team daily values to roll up. */
  teamEntries: readonly TeamRollupEntry[]
  /** ISO 'YYYY-MM-DD' start of window. */
  fromDay: string
  /** ISO 'YYYY-MM-DD' end of window. */
  toDay: string
  /** Current time (ISO-8601, injected). */
  now: string
}

/** Distribution statistics over a set of numeric values. */
export interface RollupDistribution {
  min: number | null
  p25: number | null
  median: number | null
  p75: number | null
  p90: number | null
  max: number | null
  /** Number of teams with non-null values. */
  count: number
}

/** Result from computeOrgRollup. */
export interface OrgRollupResult {
  orgId: string
  metricId: string
  fromDay: string
  toDay: string
  engineVersion: string
  computedAt: string
  /** Distribution across team-median values over the window. */
  distribution: RollupDistribution
  /**
   * Org-level scalar = median of team medians over the window.
   * null if no teams have data.
   */
  orgMedian: number | null
  /** Number of teams contributing data. */
  teamCount: number
}

// ---------------------------------------------------------------------------
// computeTeamMedian
// ---------------------------------------------------------------------------

/**
 * Compute the median of non-null values from a team's daily entries
 * over a date window.
 */
function computeTeamMedian(entries: readonly TeamRollupEntry[]): number | null {
  const values = entries.map((e) => e.value).filter((v): v is number => v !== null)
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
export function computeRollupDistribution(values: readonly number[]): RollupDistribution {
  if (values.length === 0) {
    return { min: null, p25: null, median: null, p75: null, p90: null, max: null, count: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)

  return {
    min: sorted[0] ?? null,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? null,
    count: values.length,
  }
}

// ---------------------------------------------------------------------------
// computeOrgRollup
// ---------------------------------------------------------------------------

/**
 * Aggregate team-level daily metric values into an org-level distribution.
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
export function computeOrgRollup(opts: OrgRollupOptions): OrgRollupResult {
  const { orgId, metricId, teamEntries, fromDay, toDay, now } = opts

  // Group entries by team
  const byTeam = new Map<string, TeamRollupEntry[]>()
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
  const teamMedians: number[] = []
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
export function buildTeamEntriesFromSnapshots(
  snapshots: readonly MetricSnapshot[],
): TeamRollupEntry[] {
  return snapshots
    .filter((s) => !s.isStale && s.engineVersion === ENGINE_VERSION)
    .map((s) => ({
      teamId: s.scopeId,
      day: s.day,
      value: s.value,
    }))
}
