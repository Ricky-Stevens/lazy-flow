/**
 * Migration 0004 — performance indexes + sprint-membership-event dedup.
 *
 * 1. Indexes on the timestamp columns that retention pruning and date-window
 *    filters scan (issues.created_at, metric_snapshots.computed_at,
 *    ai_verdicts.created_at) so pruneOlderThan() and snapshot reads stop doing
 *    full-table scans.
 * 2. De-duplicate any sprint_membership_events rows that an earlier re-sync
 *    already duplicated, then add a UNIQUE index on the natural key so
 *    INSERT OR IGNORE makes re-syncs idempotent (prevents double-counted
 *    committed/added story points in velocity).
 *
 * SQL inlined as a TS constant for bundle-safety (SPEC §12.3 / D12).
 */

export const MIGRATION_0004_UP = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues(created_at);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_computed_at ON metric_snapshots(computed_at);
CREATE INDEX IF NOT EXISTS idx_ai_verdicts_created_at ON ai_verdicts(created_at);

-- Collapse pre-existing duplicates (keep the lowest rowid of each group) so the
-- unique index can be created on already-populated databases.
DELETE FROM sprint_membership_events
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM sprint_membership_events
  GROUP BY sprint_id, issue_id, change, transitioned_at
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sprint_membership_event
  ON sprint_membership_events(sprint_id, issue_id, change, transitioned_at);
`

export const MIGRATION_0004_DOWN = /* sql */ `
DROP INDEX IF EXISTS uq_sprint_membership_event;
DROP INDEX IF EXISTS idx_ai_verdicts_created_at;
DROP INDEX IF EXISTS idx_metric_snapshots_computed_at;
DROP INDEX IF EXISTS idx_issues_created_at;
`
