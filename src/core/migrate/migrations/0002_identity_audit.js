/**
 * Migration 0002 — identity_audit (append-only log of manual identity-graph edits).
 *
 * The auto-stitcher records its decisions on `candidate_matches` (decided_by /
 * decided_at), but MANUAL edits made via the MCP tools — `link_identity`
 * (direct person assignment / unlink) and `resolve_identity_match` /
 * `unmerge_identity_match` — need their own trace. The identity graph drives
 * per-person metrics, so a manual merge/split must be explainable after the
 * fact: who changed what, when, and the before/after person link.
 *
 * Append-only: rows are never updated or deleted. `from_person_id` / `to_person_id`
 * capture the link transition (null = unlinked). Added as a forward migration so
 * it applies to existing databases (the baseline is never edited post-launch).
 */
export const MIGRATION_0002_UP = /* sql */ `
CREATE TABLE IF NOT EXISTS identity_audit (
  id             TEXT    NOT NULL PRIMARY KEY,
  action         TEXT    NOT NULL CHECK (action IN ('link', 'unlink', 'confirm_match', 'reject_match', 'unmerge')),
  identity_id    TEXT,
  from_person_id TEXT,
  to_person_id   TEXT,
  match_id       TEXT,
  decided_by     TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_audit_identity ON identity_audit(identity_id);
CREATE INDEX IF NOT EXISTS idx_identity_audit_created ON identity_audit(created_at);
`

export const MIGRATION_0002_DOWN = /* sql */ `
DROP TABLE IF EXISTS identity_audit;
`
