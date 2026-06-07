/**
 * Migration runner for lazy-flow.
 *
 * Design:
 * - A `schema_version` table in the DB tracks which migrations have been applied.
 * - Migrations are ordered by version number (ascending for up, descending for down).
 * - Down migrations are only allowed when the LAZYFLOW_ALLOW_DOWN_MIGRATIONS env
 *   variable is set to "1" (forward-only-in-prod guard).
 * - Each migration is a { up: string; down: string; description: string } record.
 * - Migration 0001 is the full schema (loaded as an inline TS string constant so
 *   the bundle doesn't need to resolve a file path at runtime — bundle-safe).
 */

import type { DatabaseSync } from 'node:sqlite'
import { MIGRATION_0001_DOWN, MIGRATION_0001_UP } from './migrations/0001_initial_schema.js'
import { MIGRATION_0002_DOWN, MIGRATION_0002_UP } from './migrations/0002_candidate_matches.js'
import { MIGRATION_0003_DOWN, MIGRATION_0003_UP } from './migrations/0003_survey_responses.js'
import { MIGRATION_0004_DOWN, MIGRATION_0004_UP } from './migrations/0004_indexes_and_dedup.js'

export interface Migration {
  version: number
  description: string
  up: string
  down: string
}

/** The ordered list of all migrations. Add new migrations here. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial_schema',
    up: MIGRATION_0001_UP,
    down: MIGRATION_0001_DOWN,
  },
  {
    version: 2,
    description: 'candidate_matches',
    up: MIGRATION_0002_UP,
    down: MIGRATION_0002_DOWN,
  },
  {
    version: 3,
    description: 'survey_responses',
    up: MIGRATION_0003_UP,
    down: MIGRATION_0003_DOWN,
  },
  {
    version: 4,
    description: 'indexes_and_dedup',
    up: MIGRATION_0004_UP,
    down: MIGRATION_0004_DOWN,
  },
]

/**
 * Apply all pending up-migrations (or all migrations down to version 0).
 *
 * @param db     An open DatabaseSync instance (schema_version table will be
 *               created if absent).
 * @param direction 'up' (default) or 'down'. Down is guarded by env flag.
 */
export function migrate(db: DatabaseSync, direction: 'up' | 'down' = 'up'): void {
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

function ensureVersionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL,
      description TEXT    NOT NULL
    )
  `)
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare(`SELECT version FROM schema_version`).all() as {
    version: number
  }[]
  return new Set(rows.map((r) => r.version))
}

function migrateUp(db: DatabaseSync): void {
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
function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function migrateDown(db: DatabaseSync): void {
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
export function currentVersion(db: DatabaseSync): number {
  ensureVersionTable(db)
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as
    | { v: number | null }
    | undefined
  return row?.v ?? 0
}
