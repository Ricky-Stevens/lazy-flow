import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { currentVersion, MIGRATIONS, migrate } from './runner.js'

// Apply every migration strictly below `version`, recording schema_version, so we
// can land a DB at an intermediate version and then exercise the next migration as
// a real in-place upgrade (the live-DB path).
function migrateUpToBelow(db, version) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL, description TEXT NOT NULL)`,
  )
  for (const m of MIGRATIONS.filter((x) => x.version < version).sort(
    (a, b) => a.version - b.version,
  )) {
    db.exec(m.up)
    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)`,
    ).run(m.version, '2024-01-01T00:00:00.000Z', m.description)
  }
}

describe('migration 0003 — identity_audit rename action', () => {
  it('upgrades v2→v3 preserving existing audit rows and widening the action CHECK', () => {
    const db = new Database(':memory:')
    migrateUpToBelow(db, 3)
    expect(currentVersion(db)).toBe(2)

    // An audit row written under the v2 schema (the user's live DB has these).
    db.prepare(
      `INSERT INTO identity_audit
         (id, action, identity_id, from_person_id, to_person_id, match_id, decided_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a1', 'link', 'gh:x', null, 'p1', null, 'tester', 'note', '2024-01-01T00:00:00.000Z')

    // In-place upgrade applies only 0003 (the table rebuild).
    migrate(db, 'up')
    expect(currentVersion(db)).toBe(3)

    // The pre-existing row survived the rebuild, intact.
    const preserved = db
      .prepare(`SELECT action, to_person_id, note FROM identity_audit WHERE id = 'a1'`)
      .get()
    expect(preserved.action).toBe('link')
    expect(preserved.to_person_id).toBe('p1')
    expect(preserved.note).toBe('note')

    // 'rename' is now an allowed action.
    expect(() =>
      db
        .prepare(
          `INSERT INTO identity_audit (id, action, to_person_id, decided_by, created_at)
           VALUES ('a2', 'rename', 'p1', 'tester', '2024-01-02T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow()

    // An invalid action is still rejected (the CHECK was widened, not removed).
    expect(() =>
      db
        .prepare(
          `INSERT INTO identity_audit (id, action, created_at) VALUES ('a3', 'bogus', '2024-01-03T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow()

    // Indexes were recreated on the rebuilt table.
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_identity_audit_created'`,
      )
      .get()
    expect(idx?.name).toBe('idx_identity_audit_created')

    db.close()
  })

  it('is idempotent — re-running migrate() after v3 is a no-op', () => {
    const db = new Database(':memory:')
    migrate(db, 'up')
    const v = currentVersion(db)
    migrate(db, 'up')
    expect(currentVersion(db)).toBe(v)
    db.close()
  })
})
