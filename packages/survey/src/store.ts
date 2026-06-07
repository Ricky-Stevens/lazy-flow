/**
 * Survey store — persistence layer for survey_responses.
 *
 * The SurveyStore interface extends the core Store seam with survey-specific
 * methods. The NodeSqliteSurveyStore implements it over node:sqlite (the
 * same driver as the core NodeSqliteStore).
 *
 * Migration: MIGRATION_0003 (migration.ts) must be applied to the DB before
 * using this store. The applyMigration() helper handles this.
 *
 * Privacy posture (SPEC §6.5):
 *   - Reads filter by teamId; person-level reads are restricted to self-scope.
 *   - No bulk "list all respondents" method is exposed.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { SurveyResponse } from './types.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SurveyStore {
  /**
   * Persist a survey response (append-only — no updates to existing rows).
   */
  insertSurveyResponse(response: SurveyResponse): void

  /**
   * List responses for a team within a time window, optionally filtered by
   * instrument. Used for team-aggregate scoring.
   */
  listTeamResponses(opts: {
    teamId: string
    from: string
    to: string
    instrumentId?: string
  }): SurveyResponse[]

  /**
   * List responses submitted by a specific person (self-scope only).
   */
  listPersonResponses(opts: { personId: string; from: string; to: string }): SurveyResponse[]
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

/** Coerce a nullable DB value to string | null. */
function rstr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return String(v)
}

export class NodeSqliteSurveyStore implements SurveyStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  insertSurveyResponse(response: SurveyResponse): void {
    this.#db
      .prepare(
        `INSERT INTO survey_responses
           (id, person_id, team_id, instrument_id, instrument_version, scores_json, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        response.id,
        response.personId,
        response.teamId,
        response.instrumentId,
        response.instrumentVersion,
        JSON.stringify(response.scores),
        response.submittedAt,
      )
  }

  listTeamResponses(opts: {
    teamId: string
    from: string
    to: string
    instrumentId?: string
  }): SurveyResponse[] {
    type Row = {
      id: unknown
      person_id: unknown
      team_id: unknown
      instrument_id: unknown
      instrument_version: unknown
      scores_json: unknown
      submitted_at: unknown
    }

    let rows: Row[]
    if (opts.instrumentId !== undefined) {
      rows = this.#db
        .prepare(
          `SELECT id, person_id, team_id, instrument_id, instrument_version, scores_json, submitted_at
             FROM survey_responses
            WHERE team_id = ?
              AND submitted_at >= ?
              AND submitted_at <= ?
              AND instrument_id = ?
            ORDER BY submitted_at ASC`,
        )
        .all(opts.teamId, opts.from, opts.to, opts.instrumentId) as Row[]
    } else {
      rows = this.#db
        .prepare(
          `SELECT id, person_id, team_id, instrument_id, instrument_version, scores_json, submitted_at
             FROM survey_responses
            WHERE team_id = ?
              AND submitted_at >= ?
              AND submitted_at <= ?
            ORDER BY submitted_at ASC`,
        )
        .all(opts.teamId, opts.from, opts.to) as Row[]
    }

    return rows.map(rowToResponse)
  }

  listPersonResponses(opts: { personId: string; from: string; to: string }): SurveyResponse[] {
    type Row = {
      id: unknown
      person_id: unknown
      team_id: unknown
      instrument_id: unknown
      instrument_version: unknown
      scores_json: unknown
      submitted_at: unknown
    }
    const rows = this.#db
      .prepare(
        `SELECT id, person_id, team_id, instrument_id, instrument_version, scores_json, submitted_at
           FROM survey_responses
          WHERE person_id = ?
            AND submitted_at >= ?
            AND submitted_at <= ?
          ORDER BY submitted_at ASC`,
      )
      .all(opts.personId, opts.from, opts.to) as Row[]

    return rows.map(rowToResponse)
  }
}

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

/**
 * Apply the survey migration (0003) to an already-open DatabaseSync.
 * Idempotent — safe to call on an existing schema.
 */
export function applyMigration(db: DatabaseSync): void {
  // Import the SQL inline to keep bundle-safe (no runtime file reads)
  const { MIGRATION_0003_UP } = (() => {
    // Dynamic import is not available in sync context; we re-inline the SQL.
    // This duplication is intentional — avoids runtime asset resolution.
    const up = /* sql */ `
CREATE TABLE IF NOT EXISTS survey_responses (
  id                   TEXT NOT NULL PRIMARY KEY,
  person_id            TEXT REFERENCES persons(id),
  team_id              TEXT NOT NULL REFERENCES teams(id),
  instrument_id        TEXT NOT NULL,
  instrument_version   TEXT NOT NULL,
  scores_json          TEXT NOT NULL,
  submitted_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_team
  ON survey_responses(team_id, submitted_at);

CREATE INDEX IF NOT EXISTS idx_survey_responses_person
  ON survey_responses(person_id) WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_survey_responses_instrument
  ON survey_responses(instrument_id, instrument_version);
`
    return { MIGRATION_0003_UP: up }
  })()

  db.exec(MIGRATION_0003_UP)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function rowToResponse(row: {
  id: unknown
  person_id: unknown
  team_id: unknown
  instrument_id: unknown
  instrument_version: unknown
  scores_json: unknown
  submitted_at: unknown
}): SurveyResponse {
  const scoresRaw = String(row.scores_json ?? '{}')
  const scores = JSON.parse(scoresRaw) as Record<string, number>
  return {
    id: String(row.id),
    personId: rstr(row.person_id),
    teamId: String(row.team_id),
    instrumentId: String(row.instrument_id),
    instrumentVersion: String(row.instrument_version),
    scores,
    submittedAt: String(row.submitted_at),
  }
}
