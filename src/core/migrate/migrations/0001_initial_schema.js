/**
 * Migration 0001 — full initial schema (consolidated baseline).
 *
 * Pre-launch, the migration history was flattened into this single baseline:
 * the cumulative schema of the former migrations 0001–0006 + 0008 is expressed
 * here as one CREATE-only migration. The one-off data-fix step from the old
 * 0004 (de-duplicating sprint_membership_events on already-populated databases)
 * is intentionally dropped — a fresh database has no duplicates to collapse —
 * but its resulting UNIQUE index is preserved. Incremental migrations resume at
 * version 2 once v1 ships.
 *
 * The SQL is inlined as string constants so the bundled server.js has no
 * runtime file-path dependency (bundle-safe per SPEC §12.3 / D12).
 *
 * MIGRATION_0001_UP creates all tables and indexes.
 * MIGRATION_0001_DOWN drops them all in reverse FK dependency order.
 */

export const MIGRATION_0001_UP = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version tracking (also created by the runner, but idempotent here)
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
);

-- GitHub / Jira organisations
CREATE TABLE IF NOT EXISTS organisations (
  id             TEXT NOT NULL PRIMARY KEY,
  github_login   TEXT,
  jira_cloud_id  TEXT,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Canonical persons, anchored on stable account ids
CREATE TABLE IF NOT EXISTS persons (
  id                  TEXT NOT NULL PRIMARY KEY,
  display_name        TEXT NOT NULL,
  primary_account_ref TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Identity records linking platform accounts to persons
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT    NOT NULL PRIMARY KEY,
  person_id   TEXT    REFERENCES persons(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('github_login', 'commit_email', 'jira_account')),
  external_id TEXT    NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  confidence  REAL    NOT NULL DEFAULT 1.0,
  raw         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identities_person_id ON identities(person_id);
CREATE INDEX IF NOT EXISTS idx_identities_external ON identities(kind, external_id);

-- Human-confirm queue for identity stitching (SPEC §6.3 WP-IDENTITY)
CREATE TABLE IF NOT EXISTS candidate_matches (
  id              TEXT    NOT NULL PRIMARY KEY,
  identity_id_a   TEXT    NOT NULL REFERENCES identities(id),
  identity_id_b   TEXT    NOT NULL REFERENCES identities(id),
  reason          TEXT    NOT NULL CHECK (reason IN ('local_part_name', 'fuzzy_name', 'xsrc_email', 'xsrc_name', 'xsrc_behavioral', 'xsrc_name_behavioral')),
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

-- GitHub repositories; keyed on node_id to survive renames/transfers
CREATE TABLE IF NOT EXISTS repositories (
  id              TEXT    NOT NULL PRIMARY KEY,
  github_node_id  TEXT    NOT NULL UNIQUE,
  org_id          TEXT    NOT NULL REFERENCES organisations(id),
  owner           TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  is_fork         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  raw             TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repositories_org_id ON repositories(org_id);

-- Commits; composite PK (repo_id, sha)
CREATE TABLE IF NOT EXISTS commits (
  repo_id             TEXT    NOT NULL REFERENCES repositories(id),
  sha                 TEXT    NOT NULL,
  author_identity_id  TEXT    NOT NULL REFERENCES identities(id),
  authored_at         TEXT    NOT NULL,
  committed_at        TEXT    NOT NULL,
  additions           INTEGER NOT NULL DEFAULT 0,
  deletions           INTEGER NOT NULL DEFAULT 0,
  haloc               INTEGER NOT NULL DEFAULT 0,
  raw                 TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_authored_at ON commits(authored_at);

-- Co-author and trailer roles on commits
CREATE TABLE IF NOT EXISTS commit_authors (
  repo_id      TEXT NOT NULL,
  sha          TEXT NOT NULL,
  identity_id  TEXT NOT NULL REFERENCES identities(id),
  role         TEXT NOT NULL CHECK (role IN ('author', 'committer', 'co_author')),
  source       TEXT NOT NULL CHECK (source IN ('api', 'trailer')),
  PRIMARY KEY (repo_id, sha, identity_id, role),
  FOREIGN KEY (repo_id, sha) REFERENCES commits(repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commit_authors_identity ON commit_authors(identity_id);

-- Pull requests with denormalized stage timestamps
CREATE TABLE IF NOT EXISTS pull_requests (
  id                    TEXT    NOT NULL PRIMARY KEY,
  repo_id               TEXT    NOT NULL REFERENCES repositories(id),
  number                INTEGER NOT NULL,
  author_identity_id    TEXT    NOT NULL REFERENCES identities(id),
  state                 TEXT    NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  head_ref              TEXT    NOT NULL,
  base_ref              TEXT    NOT NULL,
  is_draft              INTEGER NOT NULL DEFAULT 0,
  merged_via_queue      INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  ready_at              TEXT,
  first_commit_at       TEXT,
  first_review_at       TEXT,
  approved_at           TEXT,
  merged_at             TEXT,
  merged_by_identity_id TEXT    REFERENCES identities(id),
  deleted_at            TEXT,
  raw                   TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_id ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_created_at ON pull_requests(created_at);

-- Per-PR file diffs (GET /pulls/{n}/files); source for code.* churn/HALOC metrics.
-- ON DELETE CASCADE so a tombstoned PR's files do not linger.
CREATE TABLE IF NOT EXISTS pr_files (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  additions    INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  haloc        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  patch        TEXT,
  -- 1 when the path matches generated/vendored/lockfile/minified globs (see
  -- classifyIsGenerated). Persisted so authored-code-volume metrics (pr.size,
  -- code.haloc_aggregate, code.nagappan_ball, code.change_impact, plus the
  -- per-person ownership/skill/complexity builders) can filter the numerator
  -- without re-deriving the classification at read time. Defaults to 0 so older
  -- rows (and the in-test fixture rows that never go through the mapper) are
  -- treated as authored — preserving every existing oracle test.
  is_generated INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (pr_id, path)
);

CREATE INDEX IF NOT EXISTS idx_pr_files_repo ON pr_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_files_pr   ON pr_files(pr_id);

-- Reviews; keyed on GraphQL node_id
CREATE TABLE IF NOT EXISTS reviews (
  node_id              TEXT NOT NULL PRIMARY KEY,
  pr_id                TEXT NOT NULL REFERENCES pull_requests(id),
  reviewer_identity_id TEXT NOT NULL REFERENCES identities(id),
  state                TEXT NOT NULL CHECK (state IN ('approved', 'changes_requested', 'commented', 'dismissed', 'pending')),
  submitted_at         TEXT NOT NULL,
  raw                  TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr_id ON reviews(pr_id);

-- Review comments; keyed on GraphQL node_id
CREATE TABLE IF NOT EXISTS review_comments (
  node_id            TEXT NOT NULL PRIMARY KEY,
  pr_id              TEXT NOT NULL REFERENCES pull_requests(id),
  author_identity_id TEXT NOT NULL REFERENCES identities(id),
  created_at         TEXT NOT NULL,
  in_reply_to        TEXT,
  path               TEXT,
  raw                TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_comments_pr_id ON review_comments(pr_id);

-- Check runs for CI health
CREATE TABLE IF NOT EXISTS check_runs (
  node_id      TEXT NOT NULL PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repositories(id),
  head_sha     TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,
  conclusion   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  raw          TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_runs_repo_head ON check_runs(repo_id, head_sha);

-- Deployments with source priority chain
CREATE TABLE IF NOT EXISTS deployments (
  id           TEXT NOT NULL PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repositories(id),
  sha          TEXT NOT NULL,
  environment  TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  source       TEXT NOT NULL CHECK (source IN ('deployments_api', 'release', 'workflow', 'merge_proxy')),
  raw          TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_repo_created ON deployments(repo_id, created_at);

-- Jira projects
CREATE TABLE IF NOT EXISTS jira_projects (
  id             TEXT NOT NULL PRIMARY KEY,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  jira_cloud_id  TEXT NOT NULL,
  raw            TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Jira issues with hierarchy and story-point provenance
CREATE TABLE IF NOT EXISTS issues (
  id                     TEXT    NOT NULL PRIMARY KEY,
  project_id             TEXT    NOT NULL REFERENCES jira_projects(id),
  key                    TEXT    NOT NULL,
  type                   TEXT    NOT NULL,
  status_id              TEXT    NOT NULL,
  status_category        TEXT    NOT NULL CHECK (status_category IN ('new', 'indeterminate', 'done')),
  story_points           REAL,
  story_points_field_id  TEXT,
  story_points_raw       TEXT,
  parent_id              TEXT    REFERENCES issues(id),
  epic_key               TEXT,
  is_subtask             INTEGER NOT NULL DEFAULT 0,
  hierarchy_level        INTEGER NOT NULL DEFAULT 1,
  assignee_identity_id   TEXT    REFERENCES identities(id),
  created_at             TEXT    NOT NULL,
  resolved_at            TEXT,
  deleted_at             TEXT,
  raw                    TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status_id ON issues(status_id);
CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues(created_at);

-- Issue key history for project moves
CREATE TABLE IF NOT EXISTS issue_keys (
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  key         TEXT NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (issue_id, key)
);

CREATE INDEX IF NOT EXISTS idx_issue_keys_key ON issue_keys(key);

-- Append-only issue transitions; keystone for all flow metrics
CREATE TABLE IF NOT EXISTS issue_transitions (
  id                       TEXT NOT NULL PRIMARY KEY,
  issue_id                 TEXT NOT NULL REFERENCES issues(id),
  from_status_id           TEXT NOT NULL,
  to_status_id             TEXT NOT NULL,
  project_id_at_transition TEXT NOT NULL,
  transitioned_at          TEXT NOT NULL,
  actor_identity_id        TEXT REFERENCES identities(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_transitions_issue_id ON issue_transitions(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_transitions_transitioned_at ON issue_transitions(transitioned_at);

-- Sprints
CREATE TABLE IF NOT EXISTS sprints (
  id           TEXT NOT NULL PRIMARY KEY,
  board_id     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'closed', 'future')),
  start_at     TEXT,
  end_at       TEXT,
  complete_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sprints_board_id ON sprints(board_id);

-- Sprint membership events; replaces v1 boolean sprint_issues
CREATE TABLE IF NOT EXISTS sprint_membership_events (
  sprint_id           TEXT    NOT NULL REFERENCES sprints(id),
  issue_id            TEXT    NOT NULL REFERENCES issues(id),
  change              TEXT    NOT NULL CHECK (change IN ('added', 'removed')),
  points_at_event     REAL,
  transitioned_at     TEXT    NOT NULL,
  was_present_at_start INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sprint_membership_sprint ON sprint_membership_events(sprint_id);
CREATE INDEX IF NOT EXISTS idx_sprint_membership_issue ON sprint_membership_events(issue_id);

-- Natural-key uniqueness so re-syncs are idempotent (INSERT OR IGNORE), keeping
-- committed/added story points from being double-counted in velocity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sprint_membership_event
  ON sprint_membership_events(sprint_id, issue_id, change, transitioned_at);

-- Board configuration; defines cycle-time start boundary
CREATE TABLE IF NOT EXISTS board_configs (
  board_id   TEXT NOT NULL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('scrum', 'kanban')),
  updated_at TEXT NOT NULL
);

-- Board column definitions with started/done boundaries
CREATE TABLE IF NOT EXISTS board_columns (
  board_id       TEXT    NOT NULL REFERENCES board_configs(board_id),
  column_name    TEXT    NOT NULL,
  status_ids     TEXT    NOT NULL,
  is_started_col INTEGER NOT NULL DEFAULT 0,
  is_done_col    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, column_name)
);

-- Jira workflows; resolves the orphan FK on flow_state_models
CREATE TABLE IF NOT EXISTS workflows (
  workflow_id  TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Workflow scheme mappings; issue→(project,issuetype)→workflow_id
CREATE TABLE IF NOT EXISTS workflow_scheme_mappings (
  project_id   TEXT NOT NULL REFERENCES jira_projects(id),
  issue_type   TEXT NOT NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(workflow_id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_type)
);

-- Teams; required for team/org scope rollups
CREATE TABLE IF NOT EXISTS teams (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organisations(id),
  updated_at TEXT NOT NULL
);

-- Effective-dated team membership
CREATE TABLE IF NOT EXISTS team_membership (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  person_id  TEXT NOT NULL REFERENCES persons(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  PRIMARY KEY (team_id, person_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_team_membership_person ON team_membership(person_id);

-- Survey responses (WP-SURVEY, SPEC D6 / §2.2 N4)
-- Perceptual scores are SURVEY-SOURCED ONLY; this table is the sole permitted
-- source for any dimension score. Append-only (no UPDATE; DELETE only for
-- subject erasure per SPEC §6.5 WP-GDPR-SCAFFOLD).
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

-- GitHub↔Jira issue linkage
CREATE TABLE IF NOT EXISTS pr_issue_links (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id),
  issue_id     TEXT NOT NULL REFERENCES issues(id),
  link_source  TEXT NOT NULL CHECK (link_source IN ('regex', 'smartcommit', 'branch', 'llm')),
  confidence   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (pr_id, issue_id, link_source)
);

CREATE INDEX IF NOT EXISTS idx_pr_issue_links_issue ON pr_issue_links(issue_id);

-- Versioned daily metric snapshots
CREATE TABLE IF NOT EXISTS metric_snapshots (
  scope_type               TEXT    NOT NULL CHECK (scope_type IN ('repo', 'team', 'org', 'person', 'self')),
  scope_id                 TEXT    NOT NULL,
  metric                   TEXT    NOT NULL,
  day                      TEXT    NOT NULL,
  value                    REAL,
  window                   TEXT    NOT NULL,
  trust_tier               TEXT    NOT NULL CHECK (trust_tier IN ('deterministic', 'hybrid', 'probabilistic')),
  data_quality             TEXT    NOT NULL,
  engine_version           TEXT    NOT NULL,
  ingest_watermark_version TEXT    NOT NULL,
  coverage_fingerprint     TEXT    NOT NULL,
  computed_at              TEXT    NOT NULL,
  is_stale                 INTEGER NOT NULL DEFAULT 0,
  -- Provenance gate: 'real' authoritative feed vs heuristic 'proxy'; NULL is
  -- treated as proxy (conservative) so the report suppresses benchmark bands.
  data_source              TEXT    CHECK (data_source IS NULL OR data_source IN ('real', 'proxy')),
  PRIMARY KEY (scope_type, scope_id, metric, day, ingest_watermark_version)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_scope ON metric_snapshots(scope_type, scope_id, metric);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_day ON metric_snapshots(day);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_computed_at ON metric_snapshots(computed_at);

-- Reporting baseline layer: derived statistical summaries over snapshot values.
-- Provenance-parallel to metric_snapshots; supersede instead of delete.
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

-- AI verdict audit trail
CREATE TABLE IF NOT EXISTS ai_verdicts (
  id                      TEXT NOT NULL PRIMARY KEY,
  subject_type            TEXT NOT NULL,
  subject_id              TEXT NOT NULL,
  metric                  TEXT NOT NULL,
  prompt_version          TEXT NOT NULL,
  model_id                TEXT NOT NULL,
  model_snapshot          TEXT NOT NULL,
  request_shape           TEXT NOT NULL,
  feature_vector_json     TEXT NOT NULL,
  structured_verdict_json TEXT NOT NULL,
  evidence_json           TEXT NOT NULL,
  confidence              REAL NOT NULL,
  created_at              TEXT NOT NULL,
  corrected_by            TEXT,
  correction_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_verdicts_subject ON ai_verdicts(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_ai_verdicts_metric ON ai_verdicts(metric, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_verdicts_created_at ON ai_verdicts(created_at);

-- Per-change AI-authorship signal (tool-agnostic; deterministic stylometry +
-- markers + AI-agent author). Feeds AI-adoption KPIs (per repo / author / time).
-- ai_score is a 0..1 likelihood; signals_json lists which signals fired so
-- downstream KPIs can apply their own threshold/policy.
CREATE TABLE IF NOT EXISTS ai_authorship (
  entity_type        TEXT NOT NULL CHECK (entity_type IN ('commit', 'pull_request')),
  entity_id          TEXT NOT NULL,
  repo_id            TEXT NOT NULL REFERENCES repositories(id),
  author_identity_id TEXT,
  authored_at        TEXT,
  ai_score           REAL NOT NULL,
  signals_json       TEXT NOT NULL,
  computed_at        TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_authorship_repo ON ai_authorship(repo_id, authored_at);
CREATE INDEX IF NOT EXISTS idx_ai_authorship_author ON ai_authorship(author_identity_id);

-- Repo-level AI-tooling maturity: presence of AI-assistant config (CLAUDE.md,
-- .cursor, copilot-instructions, …) and active AI agent/bot apps. Tool-agnostic
-- and configurable; the marker/bot lists are NOT hardcoded to any one vendor.
CREATE TABLE IF NOT EXISTS repo_ai_signals (
  repo_id     TEXT NOT NULL REFERENCES repositories(id),
  signal      TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('assistant_config', 'agent_bot')),
  present     INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, signal)
);

-- Per-workflow active/wait/done map; effective-dated
CREATE TABLE IF NOT EXISTS flow_state_models (
  workflow_id   TEXT NOT NULL REFERENCES workflows(workflow_id),
  status_id     TEXT NOT NULL,
  flow_state    TEXT NOT NULL CHECK (flow_state IN ('new', 'active', 'wait', 'done')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  confirmed_by  TEXT REFERENCES identities(id),
  confirmed_at  TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  PRIMARY KEY (workflow_id, status_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_flow_state_models_workflow ON flow_state_models(workflow_id, status_id);

-- Jira status/category history; snapshotted at ingest for effective-dated replay
CREATE TABLE IF NOT EXISTS status_category_history (
  status_id   TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('new', 'indeterminate', 'done')),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (status_id, valid_from)
);

-- Per-resource sync state cursors and watermarks
CREATE TABLE IF NOT EXISTS sync_state (
  source       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  cursor       TEXT,
  watermark_at TEXT,
  last_run_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  error        TEXT,
  PRIMARY KEY (source, resource, scope_id)
);

-- Deploy ↔ incident attribution (DORA CFR / recovery / rework). Recomputed each
-- sync from temporal-proximity linkage; stored so it is query_db-inspectable.
CREATE TABLE IF NOT EXISTS deploy_incident_links (
  deploy_id         TEXT NOT NULL REFERENCES deployments(id),
  incident_issue_id TEXT NOT NULL REFERENCES issues(id),
  link_type         TEXT NOT NULL CHECK (link_type IN ('proximity', 'explicit')),
  linked_at         TEXT NOT NULL,
  PRIMARY KEY (deploy_id, incident_issue_id)
);

CREATE INDEX IF NOT EXISTS idx_deploy_incident_links_deploy ON deploy_incident_links(deploy_id);
CREATE INDEX IF NOT EXISTS idx_deploy_incident_links_incident ON deploy_incident_links(incident_issue_id);

-- Whole-file complexity cache (code.complexity_delta / maintainability_index).
-- Keyed by (repo, sha, path): commits are immutable, so analysed once.
CREATE TABLE IF NOT EXISTS file_complexity (
  repo_id          TEXT    NOT NULL REFERENCES repositories(id),
  sha              TEXT    NOT NULL,
  path             TEXT    NOT NULL,
  language         TEXT    NOT NULL,
  loc              INTEGER NOT NULL,
  total_cyclomatic INTEGER NOT NULL,
  function_count   INTEGER NOT NULL,
  functions        TEXT    NOT NULL,
  computed_at      TEXT    NOT NULL,
  PRIMARY KEY (repo_id, sha, path)
);

CREATE INDEX IF NOT EXISTS idx_file_complexity_repo_sha ON file_complexity(repo_id, sha);

-- Each PR's base/head SHA (pull_requests stores only mutable branch names) so the
-- metric layer can pair base↔head file complexity for a PR's changed files.
CREATE TABLE IF NOT EXISTS pr_refs (
  pr_id      TEXT NOT NULL PRIMARY KEY REFERENCES pull_requests(id),
  repo_id    TEXT NOT NULL REFERENCES repositories(id),
  base_sha   TEXT,
  head_sha   TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_refs_repo ON pr_refs(repo_id);
`

export const MIGRATION_0001_DOWN = /* sql */ `
DROP TABLE IF EXISTS pr_refs;
DROP TABLE IF EXISTS file_complexity;
DROP TABLE IF EXISTS deploy_incident_links;
DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS status_category_history;
DROP TABLE IF EXISTS flow_state_models;
DROP TABLE IF EXISTS repo_ai_signals;
DROP TABLE IF EXISTS ai_authorship;
DROP TABLE IF EXISTS ai_verdicts;
DROP TABLE IF EXISTS metric_baselines;
DROP TABLE IF EXISTS metric_snapshots;
DROP TABLE IF EXISTS pr_issue_links;
DROP TABLE IF EXISTS survey_responses;
DROP TABLE IF EXISTS team_membership;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS workflow_scheme_mappings;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS board_columns;
DROP TABLE IF EXISTS board_configs;
DROP TABLE IF EXISTS sprint_membership_events;
DROP TABLE IF EXISTS sprints;
DROP TABLE IF EXISTS issue_transitions;
DROP TABLE IF EXISTS issue_keys;
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS jira_projects;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS check_runs;
DROP TABLE IF EXISTS review_comments;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS pr_files;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS commit_authors;
DROP TABLE IF EXISTS commits;
DROP TABLE IF EXISTS repositories;
DROP TABLE IF EXISTS candidate_matches;
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS organisations;
`
