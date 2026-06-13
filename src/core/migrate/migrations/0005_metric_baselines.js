/**
 * Migration 0005 — metric_baselines (reporting baseline layer).
 *
 * Provenance-parallel to metric_snapshots. A baseline is a derived statistical
 * summary over snapshot values for one metric + scope; the snapshot `value` is
 * read verbatim (never a new metric). Supersede instead of delete for
 * reproducibility. PK includes ingest_watermark_version so re-ingest = new row.
 */

export const MIGRATION_0005_UP = /* sql */ `
CREATE TABLE IF NOT EXISTS metric_baselines (
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('repo','team','org','person','self')),
  scope_id     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  baseline_kind TEXT NOT NULL CHECK (baseline_kind IN ('self','peer')),
  period_key   TEXT NOT NULL,
  as_of_day    TEXT NOT NULL,
  window_kind  TEXT NOT NULL CHECK (window_kind IN ('days','sprints','fixed')),
  window_from  TEXT NOT NULL,
  window_to    TEXT NOT NULL,
  n            INTEGER NOT NULL,
  p50 REAL, p75 REAL, p90 REAL,
  mean REAL, sd REAL, mad REAL,
  drift_z      REAL,
  drift_status TEXT NOT NULL CHECK (
    drift_status IN ('cold_start','establishing','stable','shifting','regime_change')
  ),
  drift_cause  TEXT,
  superseded   INTEGER NOT NULL DEFAULT 0,
  trust_tier   TEXT NOT NULL CHECK (trust_tier IN ('deterministic','hybrid','probabilistic')),
  data_quality TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  ingest_watermark_version TEXT NOT NULL,
  coverage_fingerprint TEXT NOT NULL,
  baseline_version TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, metric, baseline_kind, period_key, as_of_day, ingest_watermark_version)
);

CREATE INDEX IF NOT EXISTS idx_metric_baselines_scope
  ON metric_baselines(scope_type, scope_id, metric, baseline_kind);
CREATE INDEX IF NOT EXISTS idx_metric_baselines_anchor
  ON metric_baselines(as_of_day);
`

export const MIGRATION_0005_DOWN = /* sql */ `
DROP TABLE IF EXISTS metric_baselines;
`
