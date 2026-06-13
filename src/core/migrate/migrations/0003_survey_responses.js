/**
 * Migration 0003 — survey_responses table (WP-SURVEY, SPEC D6 / §2.2 N4).
 *
 * Perceptual scores are SURVEY-SOURCED ONLY per SPEC §2.2 N4.
 * This table is append-only (no UPDATE; DELETE only for subject erasure
 * per SPEC §6.5 WP-GDPR-SCAFFOLD).
 */

export const MIGRATION_0003_UP = /* sql */ `
-- Survey responses (WP-SURVEY, SPEC D6 / §2.2 N4)
-- Perceptual scores are SURVEY-SOURCED ONLY; this table is the sole
-- permitted source for any dimension score.
CREATE TABLE IF NOT EXISTS survey_responses (
  id                   TEXT NOT NULL PRIMARY KEY,
  person_id            TEXT REFERENCES persons(id),
  team_id              TEXT NOT NULL REFERENCES teams(id),
  instrument_id        TEXT NOT NULL,
  instrument_version   TEXT NOT NULL,
  -- Per-question scores stored as a JSON object: { [questionId]: 1-5 }
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

export const MIGRATION_0003_DOWN = /* sql */ `
DROP TABLE IF EXISTS survey_responses;
`
