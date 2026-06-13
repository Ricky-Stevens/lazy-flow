-- lazy-flow schema — SQLite dialect
-- TEXT for JSON (raw cols), INTEGER 0/1 for booleans, TEXT ISO-8601 for timestamps.
-- All tables use soft-delete (deleted_at) where entities can be tombstoned.
-- Append-only tables (issue_transitions, sprint_membership_events) never soft-delete rows.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Schema version (managed by the migration runner)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Layer 1: System-of-record tables
-- ---------------------------------------------------------------------------

-- GitHub / Jira organisations (root of the org hierarchy)
CREATE TABLE IF NOT EXISTS organisations (
  id             TEXT    NOT NULL PRIMARY KEY,
  github_login   TEXT,
  jira_cloud_id  TEXT,
  name           TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- GitHub repositories; keyed on node_id to survive renames/transfers
CREATE TABLE IF NOT EXISTS repositories (
  id              TEXT    NOT NULL PRIMARY KEY,
  github_node_id  TEXT    NOT NULL UNIQUE,
  org_id          TEXT    NOT NULL REFERENCES organisations(id),
  owner           TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL,
  is_archived     INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
  is_fork         INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1; forks excluded from aggregates by default
  deleted_at      TEXT,                        -- soft-delete: 404 on known node_id
  raw             TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repositories_org_id ON repositories(org_id);

-- Commits; composite PK (repo_id, sha) — git SHAs are unique only per repo
CREATE TABLE IF NOT EXISTS commits (
  repo_id             TEXT    NOT NULL REFERENCES repositories(id),
  sha                 TEXT    NOT NULL,
  author_identity_id  TEXT    NOT NULL REFERENCES identities(id),
  authored_at         TEXT    NOT NULL,
  committed_at        TEXT    NOT NULL,
  additions           INTEGER NOT NULL DEFAULT 0,
  deletions           INTEGER NOT NULL DEFAULT 0,
  haloc               INTEGER NOT NULL DEFAULT 0,  -- HALOC = Σ_hunk max(ins, del); SPEC C2
  raw                 TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_authored_at ON commits(authored_at);

-- Co-author and trailer roles on commits (v2); parses Co-authored-by/Signed-off-by
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

-- Pull requests with denormalized stage timestamps for 4-phase cycle time
CREATE TABLE IF NOT EXISTS pull_requests (
  id                    TEXT    NOT NULL PRIMARY KEY,
  repo_id               TEXT    NOT NULL REFERENCES repositories(id),
  number                INTEGER NOT NULL,
  author_identity_id    TEXT    NOT NULL REFERENCES identities(id),
  state                 TEXT    NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  head_ref              TEXT    NOT NULL,
  base_ref              TEXT    NOT NULL,
  is_draft              INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
  merged_via_queue      INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1; merge-queue-bot attribution
  created_at            TEXT    NOT NULL,
  ready_at              TEXT,                        -- draft→ready transition
  first_commit_at       TEXT,                        -- earliest authored_at of any commit in the PR
  first_review_at       TEXT,
  approved_at           TEXT,
  merged_at             TEXT,
  merged_by_identity_id TEXT    REFERENCES identities(id),
  deleted_at            TEXT,                        -- soft-delete
  raw                   TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_id ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_created_at ON pull_requests(created_at);

-- Reviews; keyed on GraphQL node_id (REST numeric id ≠ GraphQL id)
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
  in_reply_to        TEXT,   -- node_id of parent comment
  path               TEXT,   -- file path the comment is on
  raw                TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_comments_pr_id ON review_comments(pr_id);

-- Check runs for CI health metrics; keyed on GraphQL node_id
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

-- Deployments with source priority chain (SPEC D9)
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

-- Jira issues with hierarchy, story-point provenance, and subtask support (v2)
CREATE TABLE IF NOT EXISTS issues (
  id                     TEXT    NOT NULL PRIMARY KEY,
  project_id             TEXT    NOT NULL REFERENCES jira_projects(id),
  key                    TEXT    NOT NULL,
  type                   TEXT    NOT NULL,
  status_id              TEXT    NOT NULL,
  status_category        TEXT    NOT NULL CHECK (status_category IN ('new', 'indeterminate', 'done')),
  story_points           REAL,
  story_points_field_id  TEXT,   -- Jira custom field id (varies per project)
  story_points_raw       TEXT,   -- raw field value before normalisation
  parent_id              TEXT    REFERENCES issues(id),   -- subtask hierarchy
  epic_key               TEXT,
  is_subtask             INTEGER NOT NULL DEFAULT 0,      -- boolean 0/1
  hierarchy_level        INTEGER NOT NULL DEFAULT 1,      -- 0=epic, 1=story/task, 2=subtask
  assignee_identity_id   TEXT    REFERENCES identities(id),
  created_at             TEXT    NOT NULL,
  resolved_at            TEXT,
  deleted_at             TEXT,                            -- soft-delete
  raw                    TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status_id ON issues(status_id);

-- Issue key history for project moves (v2); enables correct regex link resolution
CREATE TABLE IF NOT EXISTS issue_keys (
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  key         TEXT NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,           -- NULL = currently active
  PRIMARY KEY (issue_id, key)
);

CREATE INDEX IF NOT EXISTS idx_issue_keys_key ON issue_keys(key);

-- Append-only changelog-derived transitions; keystone for all flow metrics (SPEC C1)
CREATE TABLE IF NOT EXISTS issue_transitions (
  id                      TEXT NOT NULL PRIMARY KEY,
  issue_id                TEXT NOT NULL REFERENCES issues(id),
  from_status_id          TEXT NOT NULL,
  to_status_id            TEXT NOT NULL,
  project_id_at_transition TEXT NOT NULL,  -- may differ from current project after a move
  transitioned_at         TEXT NOT NULL,
  actor_identity_id       TEXT REFERENCES identities(id)
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

-- Sprint membership events (v2); replaces the v1 boolean sprint_issues table
-- Represents the full history of issues added/removed and their point values
CREATE TABLE IF NOT EXISTS sprint_membership_events (
  sprint_id          TEXT    NOT NULL REFERENCES sprints(id),
  issue_id           TEXT    NOT NULL REFERENCES issues(id),
  change             TEXT    NOT NULL CHECK (change IN ('added', 'removed')),
  points_at_event    REAL,               -- story points at the time of the event
  transitioned_at    TEXT    NOT NULL,
  was_present_at_start INTEGER NOT NULL DEFAULT 0  -- boolean 0/1; true for committed-at-start
);

CREATE INDEX IF NOT EXISTS idx_sprint_membership_sprint ON sprint_membership_events(sprint_id);
CREATE INDEX IF NOT EXISTS idx_sprint_membership_issue ON sprint_membership_events(issue_id);

-- Board configuration (v2); defines cycle-time start boundary per board
CREATE TABLE IF NOT EXISTS board_configs (
  board_id   TEXT NOT NULL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('scrum', 'kanban')),
  updated_at TEXT NOT NULL
);

-- Board column definitions with started/done boundaries (v2)
CREATE TABLE IF NOT EXISTS board_columns (
  board_id      TEXT    NOT NULL REFERENCES board_configs(board_id),
  column_name   TEXT    NOT NULL,
  status_ids    TEXT    NOT NULL,  -- JSON array of numeric Jira status ids
  is_started_col INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
  is_done_col   INTEGER NOT NULL DEFAULT 0,   -- boolean 0/1
  PRIMARY KEY (board_id, column_name)
);

-- Jira workflows (v2); resolves the orphan FK on flow_state_models
CREATE TABLE IF NOT EXISTS workflows (
  workflow_id  TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Workflow scheme mappings (v2); issue→(project,issuetype)→workflow_id
CREATE TABLE IF NOT EXISTS workflow_scheme_mappings (
  project_id   TEXT NOT NULL REFERENCES jira_projects(id),
  issue_type   TEXT NOT NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(workflow_id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_type)
);

-- Teams and membership (v2); required for team/org scope rollups
CREATE TABLE IF NOT EXISTS teams (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organisations(id),
  updated_at TEXT NOT NULL
);

-- Effective-dated team membership (valid_from/valid_to for historical accuracy)
CREATE TABLE IF NOT EXISTS team_membership (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  person_id  TEXT NOT NULL REFERENCES persons(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT,           -- NULL = currently active
  PRIMARY KEY (team_id, person_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_team_membership_person ON team_membership(person_id);

-- GitHub↔Jira issue linkage with source and confidence
CREATE TABLE IF NOT EXISTS pr_issue_links (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id),
  issue_id     TEXT NOT NULL REFERENCES issues(id),
  link_source  TEXT NOT NULL CHECK (link_source IN ('regex', 'smartcommit', 'branch', 'llm')),
  confidence   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (pr_id, issue_id, link_source)
);

CREATE INDEX IF NOT EXISTS idx_pr_issue_links_issue ON pr_issue_links(issue_id);

-- Canonical persons, anchored on stable account ids (not email) per SPEC §6.3
CREATE TABLE IF NOT EXISTS persons (
  id                  TEXT NOT NULL PRIMARY KEY,
  display_name        TEXT NOT NULL,
  primary_account_ref TEXT NOT NULL,  -- GitHub user id, Jira accountId, etc.
  updated_at          TEXT NOT NULL
);

-- Identity records linking platform accounts to persons; schema-level is_bot
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT    NOT NULL PRIMARY KEY,
  person_id   TEXT    REFERENCES persons(id),  -- nullable; unmerged identities allowed
  kind        TEXT    NOT NULL CHECK (kind IN ('github_login', 'commit_email', 'jira_account')),
  external_id TEXT    NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1; GitHub type==Bot / [bot] suffix / App
  confidence  REAL    NOT NULL DEFAULT 1.0,
  raw         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identities_person_id ON identities(person_id);
CREATE INDEX IF NOT EXISTS idx_identities_external ON identities(kind, external_id);

-- ---------------------------------------------------------------------------
-- Layer 2: Derived / operational tables
-- ---------------------------------------------------------------------------

-- Per-resource sync state cursors and watermarks
CREATE TABLE IF NOT EXISTS sync_state (
  source       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  cursor       TEXT,
  watermark_at TEXT,
  last_run_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')) DEFAULT 'idle',
  error        TEXT,
  PRIMARY KEY (source, resource, scope_id)
);

-- Versioned daily metric snapshots (v2); keyed on (scope+metric+day+watermark_version)
-- Not immutable — marked stale and lazily recomputed on late/reconciled data
CREATE TABLE IF NOT EXISTS metric_snapshots (
  scope_type               TEXT NOT NULL CHECK (scope_type IN ('repo', 'team', 'org', 'person', 'self')),
  scope_id                 TEXT NOT NULL,
  metric                   TEXT NOT NULL,
  day                      TEXT NOT NULL,  -- YYYY-MM-DD
  value                    REAL,           -- nullable; null means no_data or insufficient_sample
  window                   TEXT NOT NULL,
  trust_tier               TEXT NOT NULL CHECK (trust_tier IN ('deterministic', 'hybrid', 'probabilistic')),
  data_quality             TEXT NOT NULL,
  engine_version           TEXT NOT NULL,
  ingest_watermark_version TEXT NOT NULL,
  coverage_fingerprint     TEXT NOT NULL,  -- hash of credential scope for cross-install comparison
  computed_at              TEXT NOT NULL,
  is_stale                 INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1; set by WP-REDERIVE trigger
  PRIMARY KEY (scope_type, scope_id, metric, day, ingest_watermark_version)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_scope ON metric_snapshots(scope_type, scope_id, metric);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_day ON metric_snapshots(day);

-- AI verdict audit trail with contestability surface (v2)
CREATE TABLE IF NOT EXISTS ai_verdicts (
  id                    TEXT NOT NULL PRIMARY KEY,
  subject_type          TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  metric                TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  model_snapshot        TEXT NOT NULL,   -- the model id/version actually used
  request_shape         TEXT NOT NULL,   -- JSON: actual params sent (Opus omits temperature/top_p)
  feature_vector_json   TEXT NOT NULL,   -- deterministic inputs passed to the model
  structured_verdict_json TEXT NOT NULL, -- constrained-decoded output
  evidence_json         TEXT NOT NULL,   -- quoted diff hunks / evidence pointers
  confidence            REAL NOT NULL,
  created_at            TEXT NOT NULL,
  corrected_by          TEXT,            -- identity id of the correcting human
  correction_json       TEXT             -- append-only correction payload
);

CREATE INDEX IF NOT EXISTS idx_ai_verdicts_subject ON ai_verdicts(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_ai_verdicts_metric ON ai_verdicts(metric, created_at);

-- Per-workflow active/wait/done map; effective-dated so admin recategorisations
-- don't retroactively rewrite old CFDs (v2; SPEC C3)
CREATE TABLE IF NOT EXISTS flow_state_models (
  workflow_id   TEXT NOT NULL REFERENCES workflows(workflow_id),
  status_id     TEXT NOT NULL,
  flow_state    TEXT NOT NULL CHECK (flow_state IN ('new', 'active', 'wait', 'done')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  confirmed_by  TEXT REFERENCES identities(id),
  confirmed_at  TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,           -- NULL = currently active
  PRIMARY KEY (workflow_id, status_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_flow_state_models_workflow ON flow_state_models(workflow_id, status_id);

-- Jira status/category history; snapshotted at ingest for effective-dated replay (v2)
CREATE TABLE IF NOT EXISTS status_category_history (
  status_id   TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('new', 'indeterminate', 'done')),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,           -- NULL = currently active
  PRIMARY KEY (status_id, valid_from)
);
