-- lazy-flow schema — SQLite dialect
--
-- GENERATED REFERENCE: this file is regenerated from the migration in
-- src/core/migrate/migrations/ and is NOT executed at runtime. The
-- migration runner is the source of truth; the live DDL is also exposed
-- via the lazy-flow://schema MCP resource (read from sqlite_master).
-- Conventions: TEXT for JSON (raw cols), INTEGER 0/1 for booleans,
-- TEXT ISO-8601 for timestamps, soft-delete (deleted_at) where tombstonable.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE ai_verdicts (
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

CREATE TABLE board_columns (
  board_id       TEXT    NOT NULL REFERENCES board_configs(board_id),
  column_name    TEXT    NOT NULL,
  status_ids     TEXT    NOT NULL,
  is_started_col INTEGER NOT NULL DEFAULT 0,
  is_done_col    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, column_name)
);

CREATE TABLE board_configs (
  board_id   TEXT NOT NULL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('scrum', 'kanban')),
  updated_at TEXT NOT NULL
);

CREATE TABLE candidate_matches (
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

CREATE TABLE check_runs (
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

CREATE TABLE commit_authors (
  repo_id      TEXT NOT NULL,
  sha          TEXT NOT NULL,
  identity_id  TEXT NOT NULL REFERENCES identities(id),
  role         TEXT NOT NULL CHECK (role IN ('author', 'committer', 'co_author')),
  source       TEXT NOT NULL CHECK (source IN ('api', 'trailer')),
  PRIMARY KEY (repo_id, sha, identity_id, role),
  FOREIGN KEY (repo_id, sha) REFERENCES commits(repo_id, sha)
);

CREATE TABLE commits (
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

CREATE TABLE deployments (
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

CREATE TABLE flow_state_models (
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

CREATE TABLE identities (
  id          TEXT    NOT NULL PRIMARY KEY,
  person_id   TEXT    REFERENCES persons(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('github_login', 'commit_email', 'jira_account')),
  external_id TEXT    NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  confidence  REAL    NOT NULL DEFAULT 1.0,
  raw         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE issue_keys (
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  key         TEXT NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (issue_id, key)
);

CREATE TABLE issue_transitions (
  id                       TEXT NOT NULL PRIMARY KEY,
  issue_id                 TEXT NOT NULL REFERENCES issues(id),
  from_status_id           TEXT NOT NULL,
  to_status_id             TEXT NOT NULL,
  project_id_at_transition TEXT NOT NULL,
  transitioned_at          TEXT NOT NULL,
  actor_identity_id        TEXT REFERENCES identities(id)
);

CREATE TABLE issues (
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

CREATE TABLE jira_projects (
  id             TEXT NOT NULL PRIMARY KEY,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  jira_cloud_id  TEXT NOT NULL,
  raw            TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE metric_baselines (
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

CREATE TABLE metric_snapshots (
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

CREATE TABLE organisations (
  id             TEXT NOT NULL PRIMARY KEY,
  github_login   TEXT,
  jira_cloud_id  TEXT,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE persons (
  id                  TEXT NOT NULL PRIMARY KEY,
  display_name        TEXT NOT NULL,
  primary_account_ref TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE pr_files (
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

CREATE TABLE pr_issue_links (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id),
  issue_id     TEXT NOT NULL REFERENCES issues(id),
  link_source  TEXT NOT NULL CHECK (link_source IN ('regex', 'smartcommit', 'branch', 'llm')),
  confidence   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (pr_id, issue_id, link_source)
);

CREATE TABLE pull_requests (
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

CREATE TABLE repositories (
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

CREATE TABLE review_comments (
  node_id            TEXT NOT NULL PRIMARY KEY,
  pr_id              TEXT NOT NULL REFERENCES pull_requests(id),
  author_identity_id TEXT NOT NULL REFERENCES identities(id),
  created_at         TEXT NOT NULL,
  in_reply_to        TEXT,
  path               TEXT,
  raw                TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE reviews (
  node_id              TEXT NOT NULL PRIMARY KEY,
  pr_id                TEXT NOT NULL REFERENCES pull_requests(id),
  reviewer_identity_id TEXT NOT NULL REFERENCES identities(id),
  state                TEXT NOT NULL CHECK (state IN ('approved', 'changes_requested', 'commented', 'dismissed', 'pending')),
  submitted_at         TEXT NOT NULL,
  raw                  TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL,
      description TEXT    NOT NULL
    );

CREATE TABLE sprint_membership_events (
  sprint_id           TEXT    NOT NULL REFERENCES sprints(id),
  issue_id            TEXT    NOT NULL REFERENCES issues(id),
  change              TEXT    NOT NULL CHECK (change IN ('added', 'removed')),
  points_at_event     REAL,
  transitioned_at     TEXT    NOT NULL,
  was_present_at_start INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sprints (
  id           TEXT NOT NULL PRIMARY KEY,
  board_id     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'closed', 'future')),
  start_at     TEXT,
  end_at       TEXT,
  complete_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE status_category_history (
  status_id   TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('new', 'indeterminate', 'done')),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (status_id, valid_from)
);

CREATE TABLE survey_responses (
  id                   TEXT NOT NULL PRIMARY KEY,
  person_id            TEXT REFERENCES persons(id),
  team_id              TEXT NOT NULL REFERENCES teams(id),
  instrument_id        TEXT NOT NULL,
  instrument_version   TEXT NOT NULL,
  -- Per-question scores stored as a JSON object: { [questionId]: 1-5 }
  scores_json          TEXT NOT NULL,
  submitted_at         TEXT NOT NULL
);

CREATE TABLE sync_state (
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

CREATE TABLE team_membership (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  person_id  TEXT NOT NULL REFERENCES persons(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  PRIMARY KEY (team_id, person_id, valid_from)
);

CREATE TABLE teams (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organisations(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_scheme_mappings (
  project_id   TEXT NOT NULL REFERENCES jira_projects(id),
  issue_type   TEXT NOT NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(workflow_id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_type)
);

CREATE TABLE workflows (
  workflow_id  TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idx_ai_verdicts_created_at ON ai_verdicts(created_at);
CREATE INDEX idx_ai_verdicts_metric ON ai_verdicts(metric, created_at);
CREATE INDEX idx_ai_verdicts_subject ON ai_verdicts(subject_type, subject_id);
CREATE INDEX idx_candidate_matches_pair ON candidate_matches(identity_id_a, identity_id_b);
CREATE INDEX idx_candidate_matches_status ON candidate_matches(status);
CREATE INDEX idx_check_runs_repo_head ON check_runs(repo_id, head_sha);
CREATE INDEX idx_commit_authors_identity ON commit_authors(identity_id);
CREATE INDEX idx_commits_authored_at ON commits(authored_at);
CREATE INDEX idx_deployments_repo_created ON deployments(repo_id, created_at);
CREATE INDEX idx_flow_state_models_workflow ON flow_state_models(workflow_id, status_id);
CREATE INDEX idx_identities_external ON identities(kind, external_id);
CREATE INDEX idx_identities_person_id ON identities(person_id);
CREATE INDEX idx_issue_keys_key ON issue_keys(key);
CREATE INDEX idx_issue_transitions_issue_id ON issue_transitions(issue_id);
CREATE INDEX idx_issue_transitions_transitioned_at ON issue_transitions(transitioned_at);
CREATE INDEX idx_issues_created_at ON issues(created_at);
CREATE INDEX idx_issues_project_id ON issues(project_id);
CREATE INDEX idx_issues_status_id ON issues(status_id);
CREATE INDEX idx_metric_baselines_anchor
  ON metric_baselines(as_of_day);
CREATE INDEX idx_metric_baselines_scope
  ON metric_baselines(scope_type, scope_id, metric, baseline_kind);
CREATE INDEX idx_metric_snapshots_computed_at ON metric_snapshots(computed_at);
CREATE INDEX idx_metric_snapshots_day ON metric_snapshots(day);
CREATE INDEX idx_metric_snapshots_scope ON metric_snapshots(scope_type, scope_id, metric);
CREATE INDEX idx_pr_files_pr   ON pr_files(pr_id);
CREATE INDEX idx_pr_files_repo ON pr_files(repo_id);
CREATE INDEX idx_pr_issue_links_issue ON pr_issue_links(issue_id);
CREATE INDEX idx_pull_requests_created_at ON pull_requests(created_at);
CREATE INDEX idx_pull_requests_repo_id ON pull_requests(repo_id);
CREATE INDEX idx_repositories_org_id ON repositories(org_id);
CREATE INDEX idx_review_comments_pr_id ON review_comments(pr_id);
CREATE INDEX idx_reviews_pr_id ON reviews(pr_id);
CREATE INDEX idx_sprint_membership_issue ON sprint_membership_events(issue_id);
CREATE INDEX idx_sprint_membership_sprint ON sprint_membership_events(sprint_id);
CREATE INDEX idx_sprints_board_id ON sprints(board_id);
CREATE INDEX idx_survey_responses_instrument
  ON survey_responses(instrument_id, instrument_version);
CREATE INDEX idx_survey_responses_person
  ON survey_responses(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_survey_responses_team
  ON survey_responses(team_id, submitted_at);
CREATE INDEX idx_team_membership_person ON team_membership(person_id);
CREATE UNIQUE INDEX uq_sprint_membership_event
  ON sprint_membership_events(sprint_id, issue_id, change, transitioned_at);
