import { MIGRATION_0001_DOWN, MIGRATION_0001_UP } from './migrations/0001_initial_schema.js'
import { MIGRATION_0002_DOWN, MIGRATION_0002_UP } from './migrations/0002_identity_audit.js'
import { MIGRATION_0003_DOWN, MIGRATION_0003_UP } from './migrations/0003_identity_audit_actions.js'

/**
 * The ordered list of all migrations.
 *
 * Version 1 is the consolidated pre-launch baseline; never edit it. Incremental
 * migrations resume at version 2 — they apply to existing databases on next open
 * (a new CREATE TABLE is non-destructive), which is exactly why the identity_audit
 * table is a forward migration rather than folded into the baseline.
 */
export const MIGRATIONS = [
  {
    version: 1,
    description: 'initial_schema',
    up: MIGRATION_0001_UP,
    down: MIGRATION_0001_DOWN,
  },
  {
    version: 2,
    description: 'identity_audit',
    up: MIGRATION_0002_UP,
    down: MIGRATION_0002_DOWN,
  },
  {
    version: 3,
    description: 'identity_audit_actions',
    up: MIGRATION_0003_UP,
    down: MIGRATION_0003_DOWN,
  },
]

/**
 * Apply all pending up-migrations (or all migrations down to version 0).
 *
 * @param db     An open bun:sqlite Database instance (schema_version table will be
 *               created if absent).
 * @param direction 'up' (default) or 'down'. Down is guarded by env flag.
 */
export function migrate(db, direction = 'up') {
  if (direction === 'down') {
    if (process.env.LAZYFLOW_ALLOW_DOWN_MIGRATIONS !== '1') {
      throw new Error(
        'Down migrations are disabled in production. ' +
          'Set LAZYFLOW_ALLOW_DOWN_MIGRATIONS=1 to allow.',
      )
    }
  }

  ensureVersionTable(db)

  if (direction === 'up') {
    migrateUp(db)
  } else {
    migrateDown(db)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL,
      description TEXT    NOT NULL
    )
  `)
}

function appliedVersions(db) {
  const rows = db.prepare(`SELECT version FROM schema_version`).all()

  return new Set(rows.map((r) => r.version))
}

function migrateUp(db) {
  const applied = appliedVersions(db)
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
    (a, b) => a.version - b.version,
  )
  for (const migration of pending) {
    runInTransaction(db, () => {
      db.exec(migration.up)
      db.prepare(
        `INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)`,
      ).run(migration.version, new Date().toISOString(), migration.description)
    })
  }
}

/**
 * Run a migration step atomically. SQLite supports transactional DDL, so a
 * multi-statement `up`/`down` plus its schema_version bookkeeping either fully
 * commits or fully rolls back. Without this, a failure partway through a
 * multi-CREATE migration leaves a half-applied schema with no recorded version,
 * which then fails forever on re-run (CREATE TABLE on an existing table).
 */
function runInTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function migrateDown(db) {
  const applied = appliedVersions(db)
  const toRevert = MIGRATIONS.filter((m) => applied.has(m.version)).sort(
    (a, b) => b.version - a.version, // descending
  )
  for (const migration of toRevert) {
    runInTransaction(db, () => {
      db.exec(migration.down)
      db.prepare(`DELETE FROM schema_version WHERE version = ?`).run(migration.version)
    })
  }
}

/** Return the highest applied schema version, or 0 if no migrations are applied. */
export function currentVersion(db) {
  ensureVersionTable(db)
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get()

  return row?.v ?? 0
}
