/**
 * @lazy-flow/orchestrator — public API
 *
 * Sync orchestration (WP-SYNC-ORCH):
 *   - runSync:    full cycle (GitHub → Jira → resolveIdentities → stitchPersons → linkIssues)
 *   - syncStatus: per-resource freshness + watermark-lag + stale flags
 *   - warnOrRefuse: helper for classifying a freshness record against thresholds
 */

export type { RunSyncOptions, RunSyncResult } from './runSync.js'
export { runSync } from './runSync.js'
export type { ResourceFreshness, SyncStatusOptions, SyncStatusResult } from './syncStatus.js'
export { syncStatus, warnOrRefuse } from './syncStatus.js'
