/**
 * Migration 0006 — pr_files (per-PR file-diff ingestion).
 *
 * Persists the per-file diffs of each pull request (GET /pulls/{n}/files) so the
 * code.* metrics (HALOC aggregation, Nagappan-Ball churn, code-change impact) can
 * be computed from real ingested diffs instead of returning a blanket no_data.
 *
 * Keyed on (pr_id, path). `patch` holds the scrubbed unified-diff text so HALOC
 * and other diff-derived signals can be recomputed without re-hitting the API.
 * `haloc` is denormalised at ingest time (Σ_hunk max(insertions, deletions)).
 *
 * FK to pull_requests(id) with ON DELETE CASCADE so a tombstoned PR's files do
 * not linger. Indexed by (repo_id) for the metrics window scan and by (pr_id)
 * for per-PR aggregation.
 *
 * Forward-only / additive: no existing table or column is altered. Commit
 * additions/deletions/haloc columns already exist on the commits table (0001),
 * so no commit-volume columns are added here.
 */

export const MIGRATION_0006_UP = /* sql */ `
CREATE TABLE IF NOT EXISTS pr_files (
  pr_id      TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  repo_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  additions  INTEGER NOT NULL DEFAULT 0,
  deletions  INTEGER NOT NULL DEFAULT 0,
  haloc      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  patch      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pr_id, path)
);

CREATE INDEX IF NOT EXISTS idx_pr_files_repo ON pr_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_files_pr   ON pr_files(pr_id);
`

export const MIGRATION_0006_DOWN = /* sql */ `
DROP TABLE IF EXISTS pr_files;
`
