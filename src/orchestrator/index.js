/**
 * @lazy-flow/orchestrator — public API
 *
 * Sync orchestration (WP-SYNC-ORCH):
 *   - runSync:    full cycle (GitHub → Jira → resolveIdentities → stitchPersons → linkIssues)
 *   - syncStatus: per-resource freshness + watermark-lag + stale flags
 *   - warnOrRefuse: helper for classifying a freshness record against thresholds
 */

export { runSync } from './runSync.js'

export { syncStatus, warnOrRefuse } from './syncStatus.js'
