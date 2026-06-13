/**
 * Migration 0002 — candidate_matches table.
 *
 * Adds the human-confirm queue table used by WP-IDENTITY identity stitching.
 * Each row represents a proposed pair of identities that a human should
 * confirm or reject before they are merged into the same person.
 */

export const MIGRATION_0002_UP = /* sql */ `
-- Human-confirm queue for identity stitching (SPEC §6.3 WP-IDENTITY)
CREATE TABLE IF NOT EXISTS candidate_matches (
  id              TEXT    NOT NULL PRIMARY KEY,
  identity_id_a   TEXT    NOT NULL REFERENCES identities(id),
  identity_id_b   TEXT    NOT NULL REFERENCES identities(id),
  reason          TEXT    NOT NULL CHECK (reason IN ('local_part_name', 'fuzzy_name')),
  confidence      REAL    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  decided_at      TEXT,
  decided_by      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  -- Ordered-pair uniqueness: normalise so id_a < id_b lexicographically
  UNIQUE (identity_id_a, identity_id_b, reason)
);

CREATE INDEX IF NOT EXISTS idx_candidate_matches_status ON candidate_matches(status);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_pair ON candidate_matches(identity_id_a, identity_id_b);
`

export const MIGRATION_0002_DOWN = /* sql */ `
DROP TABLE IF EXISTS candidate_matches;
`
