/**
 * Migration 0003 — widen identity_audit.action CHECK for the manual-curation tools.
 *
 * 0002 allowed only the link/merge actions. Two manual-curation tools need new
 * action values:
 *   - set_person_display_name  → 'rename'
 *   - set_identity_bot         → 'reclassify_bot'
 * SQLite cannot ALTER a CHECK constraint in place, so this rebuilds the table with
 * the widened CHECK and copies existing rows across — append-only log, fully
 * non-destructive. identity_audit has no inbound/outbound foreign keys, so the
 * rebuild needs no foreign_keys toggling.
 *
 * A rename is recorded as action='rename', to_person_id=<person>, note='"<old>" -> "<new>"'.
 * A bot reclassify is action='reclassify_bot', identity_id=<id>, note='is_bot: <old> -> <new>'.
 */
export const MIGRATION_0003_UP = /* sql */ `
ALTER TABLE identity_audit RENAME TO identity_audit_old;

DROP INDEX IF EXISTS idx_identity_audit_identity;
DROP INDEX IF EXISTS idx_identity_audit_created;

CREATE TABLE identity_audit (
  id             TEXT    NOT NULL PRIMARY KEY,
  action         TEXT    NOT NULL CHECK (action IN ('link', 'unlink', 'confirm_match', 'reject_match', 'unmerge', 'rename', 'reclassify_bot')),
  identity_id    TEXT,
  from_person_id TEXT,
  to_person_id   TEXT,
  match_id       TEXT,
  decided_by     TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL
);

INSERT INTO identity_audit
  (id, action, identity_id, from_person_id, to_person_id, match_id, decided_by, note, created_at)
SELECT id, action, identity_id, from_person_id, to_person_id, match_id, decided_by, note, created_at
FROM identity_audit_old;

DROP TABLE identity_audit_old;

CREATE INDEX idx_identity_audit_identity ON identity_audit(identity_id);
CREATE INDEX idx_identity_audit_created ON identity_audit(created_at);
`

export const MIGRATION_0003_DOWN = /* sql */ `
ALTER TABLE identity_audit RENAME TO identity_audit_old;

DROP INDEX IF EXISTS idx_identity_audit_identity;
DROP INDEX IF EXISTS idx_identity_audit_created;

CREATE TABLE identity_audit (
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

-- Drop any 'rename'/'reclassify_bot' rows on the way down — they would violate the
-- narrowed CHECK.
INSERT INTO identity_audit
  (id, action, identity_id, from_person_id, to_person_id, match_id, decided_by, note, created_at)
SELECT id, action, identity_id, from_person_id, to_person_id, match_id, decided_by, note, created_at
FROM identity_audit_old
WHERE action IN ('link', 'unlink', 'confirm_match', 'reject_match', 'unmerge');

DROP TABLE identity_audit_old;

CREATE INDEX idx_identity_audit_identity ON identity_audit(identity_id);
CREATE INDEX idx_identity_audit_created ON identity_audit(created_at);
`
