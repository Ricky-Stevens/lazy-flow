/**
 * Visibility policy enforcement — WP-VISIBILITY (SPEC §11.1 v2.1)
 *
 * This is a **presentation switch, not a security control** (SPEC §11.1).
 * Every metric derives from data already accessible to any org member via the
 * GitHub/Jira APIs — visibility governs what the MCP tools surface, not what
 * the engine can compute.
 *
 * Three policy values:
 *   public (default) — all individual metrics visible; person snapshots persisted.
 *   team  — only team/org aggregates surfaced; person scope computed on demand, not persisted.
 *   self  — each member sees only their own data + team aggregates.
 *
 * NO acknowledgement gate (LIA/DPIA) is imposed — gating already-accessible
 * derived data adds friction for zero protection (owner decision, SPEC §11.1).
 *
 * The product ships NO stack-rank / forced-curve / leaderboard tool or UI in any
 * mode (editorial choice to keep framing growth-oriented, per SPEC §2.2 N2 and §11.1).
 */

import type { MetricScope, Visibility } from '@lazy-flow/core'

// ---------------------------------------------------------------------------
// Re-export the core type so callers can import from this module
// ---------------------------------------------------------------------------

export type { Visibility }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The note surfaced in tool output when person-scope data is filtered by
 * team/self policy.
 */
export const VISIBILITY_POLICY_NOTE =
  'Per-person metrics are not surfaced under the current visibility policy ' +
  '(team/self). Set visibility=public to surface individual contributor data.'

// ---------------------------------------------------------------------------
// shouldPersistPersonSnapshot
// ---------------------------------------------------------------------------

/**
 * Returns true when a person-scope snapshot SHOULD be written to the store.
 *
 * Under `public`: person snapshots are persisted (the store is the source of
 * truth for historical per-person data).
 * Under `team` / `self`: person snapshots are NOT persisted — they are computed
 * on demand only (and then filtered by the self rule at read time).
 *
 * Non-person scopes are always persisted regardless of policy.
 */
export function shouldPersistPersonSnapshot(scopeType: MetricScope, policy: Visibility): boolean {
  if (scopeType !== 'person') return true
  return policy === 'public'
}

// ---------------------------------------------------------------------------
// applyVisibilityFilter
// ---------------------------------------------------------------------------

/**
 * Result shape from applyVisibilityFilter.
 */
export interface VisibilityFilterResult<T> {
  /** Rows that pass the filter for the requesting member. */
  rows: readonly T[]
  /**
   * When rows were hidden by policy, this contains an explanatory note.
   * Undefined when no filtering occurred.
   */
  policyNote?: string
}

/**
 * Filters a list of metric rows (or snapshots) according to the active
 * visibility policy, from the perspective of `requestingPersonId`.
 *
 * - `public`:  all rows pass through.
 * - `team`:    rows whose `scopeType === 'person'` are removed entirely;
 *              team/org/repo aggregates pass through.
 * - `self`:    only rows where `scopeId === requestingPersonId` OR
 *              `scopeType !== 'person'` pass through.
 *
 * The function is generic so it works over any projection that carries
 * `scopeType` and `scopeId`.  Callers project the store rows into this
 * minimal shape before calling.
 */
export function applyVisibilityFilter<T extends { scopeType: MetricScope; scopeId: string }>(
  rows: readonly T[],
  policy: Visibility,
  requestingPersonId: string | null,
): VisibilityFilterResult<T> {
  if (policy === 'public') {
    return { rows }
  }

  if (policy === 'team') {
    const filtered = rows.filter((r) => r.scopeType !== 'person')
    const hidden = rows.length - filtered.length
    return {
      rows: filtered,
      policyNote: hidden > 0 ? VISIBILITY_POLICY_NOTE : undefined,
    }
  }

  // policy === 'self'
  const filtered = rows.filter((r) => r.scopeType !== 'person' || r.scopeId === requestingPersonId)
  const hidden = rows.length - filtered.length
  return {
    rows: filtered,
    policyNote: hidden > 0 ? VISIBILITY_POLICY_NOTE : undefined,
  }
}

// ---------------------------------------------------------------------------
// No-ranking guard
// ---------------------------------------------------------------------------

/**
 * The product ships no stack-rank / forced-curve / leaderboard tool or UI
 * in any visibility mode (SPEC §2.2 N2, §11.1, WP-VISIBILITY).
 *
 * This is an editorial choice: the framing is growth-oriented, not comparative.
 * Call this function to assert that a given query result is NOT a ranked list
 * of individuals.  Throws if the caller attempts to emit a ranked individual list.
 *
 * A "ranking list" is defined as an array of person-scoped items sorted by a
 * metric value (ascending or descending) — i.e. a leaderboard / forced-curve output.
 */
export function assertNotRankingList<T extends { scopeType: MetricScope }>(
  rows: readonly T[],
  isSortedByMetric: boolean,
): void {
  const personRows = rows.filter((r) => r.scopeType === 'person')
  if (personRows.length > 1 && isSortedByMetric) {
    throw new Error(
      'lazy-flow does not emit stack-ranked individual lists (SPEC §2.2 N2, §11.1). ' +
        'Use team/org aggregates for comparative views.',
    )
  }
}
