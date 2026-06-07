/**
 * Retention config + pruning helper (SPEC §11.2, WP-GDPR-SCAFFOLD).
 *
 * pruneOlderThan(store, cutoffIso) removes rows whose primary timestamp
 * is strictly older than the ISO-8601 cutoff string.
 *
 * RetentionConfig carries the window in days; deriving the cutoff from it
 * and calling pruneOlderThan is the caller's responsibility so the clock
 * is explicit and testable.
 */

import type { Store } from '../store/Store.js'

export interface RetentionConfig {
  /**
   * How many days of raw ingest data to keep.
   * Rows older than `now - retentionDays` will be pruned by pruneOlderThan.
   */
  retentionDays: number
}

/**
 * Prune store rows whose primary timestamp is strictly older than `cutoffIso`.
 *
 * Tables affected:
 *   - pull_requests  — soft-deleted (deleted_at set)
 *   - issues         — soft-deleted (deleted_at set)
 *   - metric_snapshots — hard-deleted (no deleted_at column; versioned)
 *   - ai_verdicts    — hard-deleted
 *
 * Returns a map of table name → number of rows removed.
 *
 * @param store     - The store instance to prune.
 * @param cutoffIso - ISO-8601 timestamp; rows older than this are pruned.
 */
export async function pruneOlderThan(
  store: Store,
  cutoffIso: string,
): Promise<Record<string, number>> {
  return store.pruneOlderThan(cutoffIso)
}
