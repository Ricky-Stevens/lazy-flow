/**
 * Migration 0008 — metric_snapshots.data_source (benchmark provenance gate).
 *
 * Adds a nullable `data_source` column recording whether a metric snapshot was
 * computed from a REAL authoritative feed ('real') or a heuristic PROXY
 * ('proxy') — e.g. merge-to-default deploys or temporal-proximity incident
 * linkage (SPEC §8.1). The report layer shows an industry (DORA) benchmark band
 * only when the snapshot is explicitly 'real'; NULL is treated as proxy
 * (conservative), so pre-existing rows keep their suppressed-band behaviour.
 *
 * Forward-only / additive: a single ADD COLUMN, no data backfill, no existing
 * column or table altered. SQLite ADD COLUMN is an O(1) catalog change.
 *
 * (Migration 0007 is reserved for a concurrently-developed work-stream; this
 * column is independent of it, so a version gap here is harmless — the runner
 * applies pending migrations purely by un-applied version number.)
 */

export const MIGRATION_0008_UP = /* sql */ `
ALTER TABLE metric_snapshots ADD COLUMN data_source TEXT
  CHECK (data_source IS NULL OR data_source IN ('real', 'proxy'));
`

export const MIGRATION_0008_DOWN = /* sql */ `
ALTER TABLE metric_snapshots DROP COLUMN data_source;
`
