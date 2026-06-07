# lazy-flow — Product Specification

**Status:** Draft v2 (post-adversarial-review) · **Date:** 2026-06-06 · **Owner:** Ricky Stevens
**Companion docs:** [`research/RESEARCH.md`](./research/RESEARCH.md) (evidence base, 173 metrics, 157 sources) · [`research/ADVERSARIAL-REVIEW-v1.md`](./research/ADVERSARIAL-REVIEW-v1.md) (39 upheld findings) · [`WORKPLAN.md`](./WORKPLAN.md) (fan-out-ready build plan)

> **Revision log — v2** incorporates a 9-dimension adversarial review (12 critical + 27 high findings upheld). Material changes: packaging fixed (WASM SQLite, not the un-bundleable native `better-sqlite3`); the per-workflow Flow State Model, Jira workflow discovery, and board-config ingestion are now first-class (they were depended-upon but unbuilt); `metric_snapshots` are versioned, not immutable; the "identical data on every install" claim is qualified to credential-scoped reality; an **Engine Determinism & Reproducibility Contract** (§8.6) now pins percentile method, zero-denominator→null, minimum-sample floors, reopen/first-Done dedupe, squash-aware lead time, HALOC file-classification, a seeded PRNG, and reporting timezone; the AI layer is reframed as point-in-time (not bit-reproducible) with an Opus request-shape adapter and a built contestability surface; the false "ranking is architecturally impossible" claim is dropped. **Visibility decision resolved (owner):** since all metrics derive from data already accessible to anyone in the org via the GitHub/Jira APIs, visibility is a presentation choice (not a security control) — the shipped default is `public`/open-by-design, with `team`/`self` as optional switches and no acknowledgement gate (§11.1).

---

## 0. How to read this document

This is the **full-vision** specification (no MVP cuts — by explicit decision). Every metric, engine, and surface described here is in scope. Sequencing/parallelisation of the build lives in `WORKPLAN.md`, not here. Where a claim or formula needs justification, it is sourced in `RESEARCH.md` (referenced as *R§dimension*).

Conventions:
- **MUST / SHOULD / MAY** per RFC 2119.
- **Trust tier** on every metric: `deterministic` (pure computation), `hybrid` (deterministic features + LLM judgment), `probabilistic` (LLM-dominant, advisory).
- **Scope** on every metric: `team+` (team-or-higher aggregate) or `self` (private self-view) or `public` (visible to all — see §13 visibility model).

---

## 1. Vision & Thesis

**lazy-flow is an open-source, self-hostable software-delivery intelligence platform that matches Pluralsight Flow on the deterministic metric catalogue and beats it ~2× on insight, by owning three things incumbents structurally cannot:**

1. **Explainable, evidence-cited AI judgment** instead of black-box scores. Flow's headline "Impact" correlates only ~27% with real effort and its weighting is undisclosed (*R§churn-impact, R§pluralsight-flow*). We replace every black box with a transparent deterministic core **plus** an LLM layer that quotes the diff/signal it reasoned over.
2. **A unified GitHub + Jira value stream** instead of two silos. Flow's flow-efficiency is Jira-only and blind to the code phase. We fuse commit activity (active) and PR review round-trips (wait) into a true end-to-end value-stream view and detect *implicit* wait states.
3. **Radical transparency**, shipped where engineers already work: a **Claude Code plugin**. Every formula is published, every metric carries a trust badge, every AI verdict is auditable and contestable. The LLM that *narrates* the numbers lives in the same surface the engineer trusts — and only narrates numbers the engine computed exactly.

**Best-in-class here does not mean "more metrics." It means correct, defensible, gaming-resistant, ethically-bounded metrics.** Three correctness primitives separate credible products from dashboards, and lazy-flow MUST nail all three (*R§executiveSummary*):

- **C1 — Correct Jira changelog parsing.** Every flow metric reduces to one correct pass over the changelog. Three traps: (a) the initial status is **not** in the changelog — seed it from `fields.created` + first transition's `from`; (b) changelog histories are **not** ordered — sort by `created`; (c) status→category mapping must be fetched separately and keyed off **numeric status IDs**, never localized display strings.
- **C2 — HALOC, not raw LOC, as the universal change unit.** `HALOC = Σ_hunk max(insertions, deletions)`. Kills git's modify-line double-counting; language-agnostic; cheap; underpins every volume/churn/work-type metric.
- **C3 — Per-workflow Flow State Model.** The same status ("In UAT") is *active* for one team and *waiting* for another. A global active/wait map is wrong for most teams. The per-workflow map is AI-seeded, human-confirmed, confidence-scored — and flow-efficiency accuracy lives or dies here.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- G1. Ingest GitHub (commits, PRs, reviews, comments, deployments, releases, check runs) and Jira Cloud (issues, changelog/transitions, sprints, boards) into a local store.
- G2. Compute the full deterministic catalogue (DORA, Flow, PR/Review, Code, Agile) with published formulas.
- G3. Compute the hybrid/probabilistic catalogue with Claude: ticket-work alignment, effort proportionality, velocity anomaly explanation, velocity baselining, work-type classification, explainable code-change impact, PR quality.
- G4. Ship as a Claude Code plugin installable team-wide by committing a few lines to a repo; bundle a TypeScript stdio MCP server.
- G5. Be fully transparent: per-metric formulas, trust tiers, and AI audit trails surfaced in-product.
- G6. Be reusable and open source (MIT). Everything TypeScript, Biome-formatted, typechecked, tested, with mocked GitHub + Jira APIs producing assertable golden metrics.

### 2.2 Non-Goals (v1 scope boundaries)
- N1. No data sources beyond GitHub + Jira (no GitLab/Bitbucket/Azure/Linear yet — but ingestion is adapter-shaped so they can be added).
- N2. No individual stack-ranking, forced curves, or leaderboards — **ever** (architecturally impossible; see §13). This is a non-goal *by design*, not an omission.
- N3. No finance metrics (Revenue-per-Engineer etc.) — outside GitHub+Jira scope and layoff-incentivising.
- N4. No fabricated perceptual scores. DevEx/SPACE perceptual metrics (satisfaction, DXI) are **survey-only**; we ship an open survey module or omit them — we never derive a "DXI" from system data.
- N5. Not a CI/CD or incident-management tool; we read deploy/incident signals, we don't orchestrate them.

---

## 3. Personas & Primary Use Cases

| Persona | Needs | Primary surface |
|---|---|---|
| **Individual engineer** | "How am I trending? Where's my time going?" (growth, private) | `/lazy-flow:me` (self scope) |
| **Tech lead / EM** | Team flow health, bottlenecks, anomaly explanations, no surveillance | `/lazy-flow:team`, dashboards |
| **Delivery / agile lead** | Cycle time, WIP, predictability, say/do, CFD, forecasts | `/lazy-flow:flow`, `/lazy-flow:forecast` |
| **Eng org leader** | DORA posture, company-wide velocity distribution, investment balance | `/lazy-flow:dora`, `/lazy-flow:org` |
| **Adopter / OSS user** | Trivial install, swappable config, auditable formulas | plugin install + `config` |

**Hero use cases:**
1. *"Why did our cycle time spike in week 32?"* → deterministic anomaly detection + cited, ranked, contestable explanation (closed-menu causes with evidence pointers).
2. *"Did this PR actually deliver the ticket?"* → per-acceptance-criterion alignment with quoted diff evidence.
3. *"Is our review process the bottleneck?"* → 4-phase PR cycle-time decomposition (coding/pickup/review/deploy) fused across GitHub+Jira.
4. *"What's our DORA posture vs elite benchmarks?"* → four keys + bands, team-scope, with anti-gaming/data-quality flags.

---

## 4. Product Decisions (resolved)

These resolve the forks and the research's open questions. Decisions marked **[user]** were chosen by the product owner.

| # | Decision | Choice | Rationale / divergence note |
|---|---|---|---|
| D1 | Deployment model | **[user] Local-first, per-user, embedded SQLite** | Each install computes from the *shared* GitHub/Jira source of truth → every install sees the whole team. Diverges from research's remote-server recommendation; the shared-Postgres remote model is documented as an optional scale-up (§5.4), not required. |
| D2 | Individual-data visibility | **[user, confirmed] `public` by default — open by design.** A single `visibility` switch (`public`/`team`/`self`). | Resolved: all metrics derive from data already org-accessible via the GitHub/Jira APIs, so visibility is a *presentation* choice, not a security control (anyone could compute the same numbers). No acknowledgement gate. `self`/`team` available for orgs wanting a softer presentation. Other guardrails (trust tiers, anti-gaming, published formulas, AI audit) retained; GDPR generators kept as optional adopter helpers. See §11.1. |
| D3 | AI provider | **[user] Claude (Anthropic) hardcoded** | Fits the Claude Code plugin. `@anthropic-ai/sdk`, structured outputs, temp 0. |
| D4 | Spec scope | **[user] Full vision, no tiering** | Spec covers everything; work plan sequences by dependency layers, not release tiers. |
| D5 | Default DB | **WASM SQLite (`@sqlite.org/sqlite-wasm`, or `node:sqlite` on Node ≥22), schema SQL-portable** | **Changed from `better-sqlite3` in v2:** a native node-gyp addon cannot be inlined into a single bundled `server.js` and bricks on a mismatched OS/arch/Node-ABI. A WASM (or built-in) driver is ABI-independent and truly bundleable, preserving the no-native-build / single-artifact promise (D12). JSON-as-TEXT shim so Postgres/DuckDB remain drop-in for the scale-up path. |
| D6 | Perceptual layer | **In scope as an *open* survey module**, clearly separated; never faked from system data | Turns Flow/DX's black-box criticism into our advantage; lowest-priority workstream. |
| D7 | Churn / work-type window | **Default 30 days (Flow parity), per-repo override** | Migration parity off Flow; configurable to 21d (Code Climate basis). |
| D8 | Claude model tiers | **Default `claude-sonnet-4-6` for high-volume hybrid metrics; escalate to `claude-opus-4-8` ensemble (majority vote) only on low confidence** | Cost/quality balance; ensemble doubles cost so it's gated. Token-cost spike (WP) validates the gate. |
| D9 | Deploy signal of record | **Per-repo priority chain:** GitHub Deployments API → release tags → named deploy workflow_run → merges-to-default-branch proxy | Many teams lack the Deployments API; proxy is last resort and flagged lower-confidence. |
| D10 | Benchmark pinning | **Default to latest DORA report bands (2025 percentile bands), user-switchable** | Pinned + documented per transparency principle. |
| D11 | AI-authored % | **Best-effort, low-confidence by default** (commit trailers + heuristics); higher accuracy gated behind optional IDE-telemetry integration | Most teams lack telemetry; we never overstate confidence. |
| D12 | Runtime | **Node.js (pinned range, ≥22 if using `node:sqlite`); MCP server bundled via tsup/esbuild to `server.js` + a copied WASM asset dir** | No install step on user machines. **All native deps eliminated:** WASM SQLite (D5) + WASM tree-sitter. The `.wasm` assets (SQLite, tree-sitter core, every grammar) are copied to `server/dist/grammars/` by the build and resolved at runtime via `import.meta.url` (`locateFile`), never `cwd`. A Wave-0 clean-machine cross-ABI boot smoke-test gates this (WP-E2E). |
| D13 | Dev toolchain | **TypeScript (strict) · Biome (format+lint) · `tsc --noEmit` typecheck · Vitest · MSW for API mocks** | Per user NFRs. |

---

## 5. System Architecture

### 5.1 Shape (local-first)

```
┌──────────────────────── Claude Code (each developer) ─────────────────────────┐
│                                                                                │
│  Plugin: lazy-flow                                                             │
│   ├── skills (/lazy-flow:dora, :flow, :pr, :me, :team, :explain, :sync …)      │
│   ├── subagent (flow-analyst — narrates tool outputs only)                     │
│   └── .mcp.json → spawns bundled stdio MCP server (node server.js)             │
│                                   │ stdio (MCP)                                │
│                                   ▼                                            │
│   ┌─────────────────────────  MCP server (TypeScript)  ───────────────────┐   │
│   │  tools (outputSchema+structuredContent) · resources (dashboards)       │   │
│   │  ┌──────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│   │  │ Ingestion │→ │ Local store   │→ │ Deterministic │→ │  AI engine    │  │   │
│   │  │ GH + Jira │  │ SQLite (+raw) │  │ metric engine │  │ (Claude)      │  │   │
│   │  └────┬──────┘  └──────┬────────┘  └──────┬───────┘  └──────┬───────┘   │   │
│   │       │ code-analysis worker (web-tree-sitter, git blame)   │           │   │
│   └───────┼──────────────────────────────────────────────────┼───────────┘   │
│           ▼                                                    ▼               │
└──────── GitHub API (App/PAT) ──── Jira Cloud API (OAuth 3LO) ── Anthropic API ─┘
```

The plugin is a **thin client**. All ingestion, storage, computation, and AI calls happen inside the bundled MCP server process. The SQLite DB and credentials live on the developer's machine (in `${CLAUDE_PLUGIN_DATA}` / OS keychain), never in the repo.

### 5.2 Layers
1. **Ingestion** — adapter per source (GitHub, Jira). Three-phase sync (§7).
2. **Local store** — SQLite with raw-payload retention (§6).
3. **Deterministic metric engine** — pure functions/SQL over the normalized store; computes any metric for any date range on demand and writes **versioned daily `metric_snapshots`** (stale-and-recompute on late data; §6.2).
4. **Code-analysis worker** — `web-tree-sitter` (WASM) on base/head SHA for complexity + per-function deltas; `git blame` for work-type/churn.
5. **AI engine** — builds deterministic feature/evidence packs, calls Claude (temp 0, constrained decoding), persists full audit records, runs the calibration harness.
6. **MCP/plugin surface** — tools, resources, skills, subagent (§14–15).

### 5.3 Local-first transparency — and its limits (v2, corrected)
GitHub and Jira are the shared source of truth, so two developers syncing the same org/projects derive **the same data and metrics — but only for resources both credentials can read, at an equal sync watermark and engine version.** The original unconditional "identical data on every install" claim was false and is withdrawn. Three real divergence sources, all now surfaced rather than hidden:
- **Credential scoping:** Jira 3LO consent is per-user and GitHub App repo-selection / PAT scope differs per principal. Two installs can compute the *same* team aggregate over *different* denominators. → Every aggregate output carries a **coverage flag** ("computed over 19/20 repos visible to your credential") and a `coverage_fingerprint` (§6.2); cross-install comparison is refused unless fingerprints + engine versions match.
- **Timing skew:** per-machine sync watermarks (§7.5) mean two installs legitimately disagree until both catch up — outputs carry `as_of` + watermark.
- **Engine skew:** a stale plugin (no `/reload-plugins`) runs an older engine version — outputs carry `engine_version` and tools refuse to plot across mixed versions.

Transparency = the tool is open and any member can compute and view any contributor's activity *they have access to* — not a guarantee of byte-identical dashboards. This is the honest framing of the explicit product decision (D1).

### 5.4 Recommended team path: shared read-only ingester (promoted in v2)
The adversarial review showed pure per-user local-first breaks down past a small team: N developers × full backfill = N× API rate-limit pressure (GitHub limits are **per-installation** — see §7.1), N× LLM cost (per-machine verdict cache), credential sprawl, and **no buildable cross-team org rollup** without a shared store. Therefore:
- **Solo / single small team (≤ ~10 people, single Jira project, all-public repos):** pure local-first per-user (D1) — zero infra.
- **Recommended for any larger team:** **one App-authenticated ingester** (a single GitHub App install + one Jira app) that syncs into a store and publishes a **signed, read-only snapshot** (SQLite file + `ai_verdicts`) plus a **content-addressed shared verdict cache**. Each member's plugin reads the shared snapshot read-only. This collapses ingestion + AI cost to 1×, gives a single canonical source (restoring contestability — you contest *the* number, not one of N copies), and is the only way to compute org-wide velocity coherently.

The store interface (§6.4) is the seam: the shared ingester writes, clients read. A later **Postgres** (multi-writer, concurrent dashboards) or **Docker/Streamable-HTTP** deployment is the same seam; DuckDB attaches for heavy scans. The shared-ingester path is **in scope** (it is the recommended path); the hosted Postgres/SaaS variant remains out of v1 build scope.

---

## 6. Data Model

Two layers (*R§dataModel*): a faithful system-of-record mirror (with raw payloads retained), and a derived/operational layer.

### 6.1 Layer 1 — System of record (raw retained)
Every row keeps the full upstream JSON in a `raw` column (TEXT on SQLite / JSONB on Postgres) so metric *definitions* can change without re-fetching from rate-limited APIs — re-derivation is just re-running SQL. This is a decisive advantage over tools that discard raw data.

Core tables (column lists abbreviated; see WORKPLAN WP-DB for full DDL):
- `organisations(id, github_login, jira_cloud_id, …)`
- `repositories(id, github_node_id UNIQUE, org_id, default_branch, …, raw)`
- `jira_projects(id, key, name, jira_cloud_id, …, raw)`
- `repositories(id, github_node_id UNIQUE, org_id, owner, name, default_branch, is_archived, is_fork, deleted_at, …, raw)` — keyed on `node_id`; renames/transfers tracked via `node_id` (a 404 on a known `node_id` ⇒ re-resolve, not data loss). Forks excluded from human-work aggregates by default.
- `commits(repo_id, sha, author_identity_id, authored_at, committed_at, additions, deletions, haloc, raw, PRIMARY KEY(repo_id, sha))` — **composite PK**: git SHAs are unique only per repo, so a global `sha` PK collides across mirrors/forks and corrupts the Lead-Time SHA-join.
- `commit_authors(repo_id, sha, identity_id, role ENUM(author|committer|co_author), source ENUM(api|trailer))` — **new in v2.** Parses `Co-authored-by:` / `Signed-off-by:` trailers and prefers pre-squash PR commits, so squash-merged pair/mob work doesn't lose contributors.
- `pull_requests(id PK, repo_id, number, author_identity_id, state, head_ref, base_ref, is_draft, merged_via_queue BOOL, created_at, ready_at, first_commit_at, first_review_at, approved_at, merged_at, merged_by_identity_id, deleted_at, raw)` — **stage timestamps denormalized**; `head_ref`/`base_ref` feed linking + stacked-PR handling; `merged_via_queue` so merge-queue-bot merges are attributed to the approving reviewers, not the queue.
- `reviews(node_id PK, pr_id, reviewer_identity_id, state, submitted_at, raw)` / `review_comments(node_id PK, pr_id, author_identity_id, created_at, in_reply_to, path, raw)` — keyed on GraphQL `node_id` (REST numeric id ≠ GraphQL id → dedupe), `raw` retained per the invariant.
- `check_runs(node_id PK, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw)`
- `deployments(id, repo_id, sha, environment, status, created_at, finished_at, source ENUM(deployments_api|release|workflow|merge_proxy), raw)`
- `issues(id PK, project_id, key, type, status_id, status_category, story_points, story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask, hierarchy_level, assignee_identity_id, created_at, resolved_at, raw)` — **v2 adds** issue hierarchy (so pointed subtasks sharing a sprint with a pointed parent don't double-count velocity; points roll to one configurable level) and story-point **provenance** (field id varies per project; multi-field instances leave half the org NULL silently otherwise).
- `issue_keys(issue_id, key, valid_from, valid_to)` — **new in v2.** Reconstructed from the changelog so a project move (`PROJ-123`→`NEW-45`) doesn't drop regex commit links or misattribute pre-move history.
- `issue_transitions(id, issue_id, from_status_id, to_status_id, project_id_at_transition, transitioned_at, actor_identity_id)` — **append-only, rebuilt from changelog, sorted by timestamp on ingest, paginated to exhaustion** (C1). Keystone for all flow metrics.
- `sprints(id, board_id, state, start_at, end_at, complete_at)`
- `sprint_membership_events(sprint_id, issue_id, change ENUM(added|removed), points_at_event, transitioned_at, was_present_at_start BOOL)` — **replaces the v1 `sprint_issues` boolean**, which couldn't represent removal / add-then-remove / mid-sprint re-point. Derived from the Sprint-field changelog.
- `board_configs(board_id, type ENUM(scrum|kanban))` / `board_columns(board_id, column_name, status_ids JSON, is_started_col, is_done_col)` — **new in v2.** Ingested from `/rest/agile/1.0/board/{id}/configuration`. Defines the **cycle-time start boundary** (`status_category` alone is too coarse — it lumps queue columns like "Selected for Dev" with active columns).
- `workflows(workflow_id, name)` / `workflow_scheme_mappings(project_id, issue_type, workflow_id)` — **new in v2.** Resolves issue→(project,issuetype)→workflow so `flow_state_models.workflow_id` is populated (was an orphan FK).
- `teams(id, name)` / `team_membership(team_id, person_id, valid_from, valid_to)` — **new in v2.** Without a membership model, `scope_type=team|org` rollups (incl. company-wide velocity) cannot be computed.
- `issue_links`, `pr_issue_links(pr_id, issue_id, link_source ENUM(regex|smartcommit|branch|llm), confidence)` — GitHub↔Jira linkage (regex resolved against `issue_keys` history).

### 6.2 Layer 2 — Derived / operational
- `sync_state(source, resource, scope_id, cursor, watermark_at, last_run_at, status, error)` — per-resource high-water marks; powers idempotent incremental sync and the Sync-Freshness health metric.
- `metric_snapshots(scope_type, scope_id, metric, day, value, window, trust_tier, data_quality, engine_version, ingest_watermark_version, coverage_fingerprint, computed_at)` — **versioned, not immutable (v2).** Keyed on `(scope, metric, day, watermark_version)`. A frozen "immutable" snapshot permanently disagrees with recompute once late/reconciled data for that day lands (§7.3) — so on any reconciliation that mutates a raw row for day D, day-D snapshots are marked **stale and lazily recomputed**. `engine_version` lets tools refuse to plot across mixed engine versions (false-trend guard). `coverage_fingerprint` carries credential scope (§5.3). `scope_type` ∈ {repo, team, org}; `person` only under the §11 gate.
- `ai_verdicts(id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot, request_shape, feature_vector_json, structured_verdict_json, evidence_json, confidence, created_at, corrected_by, correction_json)` — full audit + correction trail. **`request_shape`** records params actually sent (Opus calls send no `temperature`/`top_p` — §9.3); verdicts are **point-in-time, not bit-reproducible** (§9.1). Corrections written via the `correct_verdict` tool (§13.1).
- `flow_state_models(workflow_id, status_id, flow_state ENUM(new|active|wait|done), confidence, confirmed_by, confirmed_at, valid_from, valid_to)` — the per-workflow active/wait map (C3). **Effective-dated (v2)** so an admin recategorising "In UAT" doesn't retroactively rewrite old CFDs; replay uses the classification in effect at each interval. Populated by **WP-FLOWSTATE-MODEL**; never read empty (a deterministic implicit-wait fallback, flagged low-confidence, covers unconfirmed workflows).
- `status_category_history(status_id, category, valid_from, valid_to)` — **new in v2.** Jira status/workflow config snapshotted at ingest and effective-dated for the same reason.
- `config` / `feature_flags` — see §16.

### 6.3 Identity stitching (foundational — wrong stitches produce defamatory stats)
Three-tier, deterministic-first, reversible (*R§dataModel*). **v2 hardening** after the review found false-merge and bot-pollution risks:
- `persons(id PK, display_name, primary_account_ref)` — canonical human, **anchored on a stable account id (GitHub user id / Jira accountId), not an email hash** — an email rebrand otherwise fragments one human into thirds.
- `identities(id PK, person_id FK NULLABLE, kind ENUM(github_login|commit_email|jira_account), external_id, is_bot, confidence, raw)`. **`is_bot`** (GitHub `type==Bot`, `[bot]` suffix, App author, configurable allowlist) is now schema-level so the ~15 metrics that require "non-bot" filtering share one source of truth and don't re-detect ad hoc; bot identities are excluded from person creation and aggregates by default.
- Match ladder (tightened): **auto-merge only** on verified full-email or GitHub-verified email↔login. The **0.8 local-part+name tier is demoted to the human-confirm queue** (never auto) — otherwise `john.smith@acme.com` and `john.smith@vendor.com` silently become one person. A per-org domain allowlist + split-detector guard. Fuzzy name (0.5) is also queued. GitHub `noreply` / squash-bot emails un-matchable. `person_id` nullable so unmerges are trivial; never hard-delete; every merge audited.
- **WP-SPIKE-IDENTITY** must validate-or-demote the auto-merge gate on a real corpus before per-person metrics ship.

### 6.4 Storage interface
A `Store` interface abstracts all reads/writes. Default impl: `SqliteStore` over **WASM SQLite** (D5) with WAL + `busy_timeout` and sync run on a worker thread (for the <1s dashboard NFR). The interface is the only seam the shared-ingester / Postgres / DuckDB paths touch (§5.4). Migrations: plain checked-in up/down SQL + an in-DB `schema_version` table; forward-only in prod; one migration set with a thin dialect shim (TEXT-vs-JSONB, `INSERT OR REPLACE` vs `ON CONFLICT`).

### 6.5 Privacy at rest (v2, corrected — no overclaim)
A plain hash of a low-entropy corporate email is **reversed by dictionary attack in milliseconds**, so it is **not** anonymisation and remains personal data under GDPR (Recital 26). v2 therefore:
- **Stops presenting a hashed email as a privacy control.** If pseudonymisation is wanted, use a **keyed HMAC** whose key lives only in the OS keychain.
- **Mandates at-rest DB encryption** (SQLCipher or OS-level full-disk + restrictive file perms) with a keychain-resident DB key — the DB lives on every developer's laptop.
- **Adds payload scrubbing (WP-SCRUB):** a sanitiser with a field allowlist + entropy/regex secret detection runs over free-text bodies (`review_comments.raw`, `issues.raw`) **at ingest, before persistence**, so pasted tokens/keys/PII never hit disk. Golden tests prove known secret/email patterns are removed.
- Per-person deletion (subject erasure) via `person_id` cascade. Replaces vacuous "per-tenant isolation" with an **enforceable** control: a DB is **bound to one `org_id`** and hard-errors on cross-org config (prevents one install mixing two clients' repos). Credentials never stored in the DB or repo (OS keychain / env only).

---

## 7. Ingestion & Sync

### 7.1 GitHub
- **Auth:** GitHub App (preferred — org install once, fine-grained least-privilege, 12,500 req/hr/installation, built-in webhooks, short-lived installation tokens) **or** PAT (fallback for solo/local). The plugin's `userConfig` accepts either; App is documented as the team-scale option.
- **REST + GraphQL hybrid:** REST for bulk single-type discovery (commits via `since`, deployments, releases); GraphQL to hydrate the per-PR object graph (reviews + comments + timeline + commits). **Inner connections MUST be cursor-paginated** (`first:100` + `after`) — a fat PR (>1k comments) otherwise exceeds the 500k-node ceiling (partial/error) or silently caps at the first page, corrupting Comments-per-PR / Review Coverage. Embed `rateLimit{cost,remaining}`; stay under the 2,000 points/min secondary limit; detect partial-data GraphQL errors.
- **Conditional requests:** ETags on list polls reduce payload, but note this is a bandwidth optimisation, **not** a rate-limit exemption on all endpoints.
- **Rate limits are PER-INSTALLATION (critical for local-first):** GitHub gives 12,500 req/hr per App installation (5,000/hr per PAT), 900–2,000 points/min, ~100 concurrent secondary. **In pure local-first, aggregate org load = per-install load × N developers sharing one bucket** → 30+ machines trip 403/429 and most installs go stale (breaking §5.3). This is the primary reason the **shared-ingester path (§5.4) is recommended for teams > ~10**; WP-SPIKE-SYNCLOAD sizes the N× pressure.

### 7.2 Jira Cloud
- **Auth:** OAuth 2.0 (3LO), **read-only scopes only** (`read:jira-work`, `read:board-scope.admin`/`read:sprint`, `offline_access`). Per-user API tokens are **not** used (violates Atlassian distribution policy). API token fallback allowed only for single-user local use.
- **Changelog:** fetch via `/search/jql` cursor + the **bulk changelog** endpoint. **Never** rely on inline `expand=changelog` (truncates at 100 histories — C1 trap 4a). **The bulk endpoint is itself paginated — follow `nextPageToken`/`startAt` to exhaustion and assert `fetched == reported total`** (C1 trap 4b — switching endpoints relocates truncation unless followed through; v1 missed this).
- **Status→category:** fetch `/status` (and project/workflow status config) separately; key off **numeric status IDs**; snapshot the config at ingest into `status_category_history` (effective-dated, §6.2).
- **Workflows & boards:** discover Jira **workflows + workflow schemes** (→ `workflows`/`workflow_scheme_mappings`, WP-JIRA-WORKFLOW) and ingest **board configuration** (`/rest/agile/1.0/board/{id}/configuration` → `board_configs`/`board_columns`, WP-JIRA-BOARDCONFIG) — the started/done column boundary is the *required* source for cycle-time start, WIP and aging (`status_category` is too coarse). Agile API for boards/sprints/sprint reports; discover the story-point field **per project** (multi-field instances differ) and store its id.
- **Tenant throttling:** Jira Cloud applies **tenant-level** cost throttling, so N concurrent local backfills 429 the whole tenant — another driver for the shared-ingester path (§5.4).

### 7.3 Three-phase sync (both sources)
1. **Backfill (once):** paginate history with cursor checkpoints persisted to `sync_state` (resumable mid-page after a crash).
2. **Webhooks (accelerators):** at-least-once and lossy → treated as *triggers, not truth*. Dedupe GitHub on `X-GitHub-Delivery`; Jira dynamic webhooks expire in 30 days → cron refresh. (Local-first note: webhooks require a reachable endpoint; pure-local installs **default to polling**; webhooks are for the shared-ingester/Docker path.)
3. **Reconciliation sweep (authoritative backstop):** conditional GitHub polls + Jira `updated >= lastSync - overlap` JQL — the completeness guarantee. **Includes tombstoning (v2):** periodically full-enumerate the authoritative set per resource and **soft-delete absent rows** (`deleted_at`, excluded from metrics) — otherwise deleted PRs/issues/comments and force-pushed/dropped commits linger and their HALOC is counted forever. Force-push handled via PR before/after SHA.

### 7.4 Idempotency
Upsert keyed on GraphQL `node_id` / Jira `issue.id`; last-writer-wins gated by `updated_at` (with field-level-merge tie-breaks) so out-of-order webhook+poll deliveries converge. All ingest is re-runnable without duplication.

### 7.5 Sync freshness & scheduling (v2)
A surfaced **Sync Freshness / watermark-lag** health value (per source/resource) tells users whether a dashboard is current *before* they act; tools **warn or refuse** when lag exceeds a threshold. Because a stdio MCP server is torn down at session end, the reconciliation "guarantee" needs a real trigger: a **Claude Code session-start hook** (catch-up on open) **and/or an OS-scheduled job** (launchd / systemd / Task Scheduler) for unattended sync. The shared-ingester path (§5.4) runs its own scheduler centrally.

---

## 8. Deterministic Metric Engine

The bulk of the catalogue. Rule (*R§deterministicVsProbabilistic*): **if it's a timestamp subtraction, a count, an AST walk, a blame-age comparison, or a statistical simulation, it is deterministic — no LLM, publish the formula.** Aggregations report **median + p75/p85/p90/p95**, never mean (skew), using the **single pinned percentile method** in §8.6 and only **above the minimum-sample floor** (else `data_quality='insufficient_sample'`). **Every ratio returns `null` (rendered "N/A"), never `NaN`/`Infinity`, on a zero denominator** (§8.6). The full catalogue with formulas is in `RESEARCH.md §1.2`; the implementable subset and its grouping:

### 8.1 Group A — DORA / Delivery (`team+`)
| Metric | Formula | Sources | Tier |
|---|---|---|---|
| Deployment Frequency | count(prod deploys, status=success)/window; DORA band by median deploy-days/week | Deployments API / releases / deploy workflow / merge proxy (D9) | deterministic |
| Lead Time for Changes | **commit set = compare-API enumeration between the previous deploy SHA and this deploy SHA**; per-commit (deploy.finished − `pull_requests.first_commit_at`); report median p50/p75/p90. Detect merge strategy → flag squash/rebase author-date resets (§10). | commits + PRs + deployments + compare API | deterministic |
| Change Failure Rate | deploys-with-linked-incident / total prod deploys; **`null` if 0 deploys** | deployments (denom) + Jira Incident issues / GH `incident` label / revert-hotfix detect | hybrid (linkage) |
| Failed Deployment Recovery Time | median(**first** resolved − created) over incidents; **reopens tracked as a separate reopen-rate metric, not by moving the anchor** (a reopened incident is 1h-then-reopened, not 25h) | Jira incident changelog + deploy timeline | deterministic |
| Deployment Rework Rate | unplanned/hotfix deploys / total | hotfix label/branch prefix + incident linkage + LLM fallback | hybrid |
| Reliability (proxy, caveated) | inverse incident rate/severity — explicitly a proxy, not authoritative | Jira/GH incident volume | hybrid |

### 8.2 Group B — Flow (value stream, `team+`)
Flow Time / Cycle Time (**start = first entry into a status mapped to a *started* board column** per `board_columns`, not a `status_category` heuristic; reopen anchor per §8.6), Flow Efficiency (**pinned estimator: per-issue `active_i/(active_i+wait_i)`, report the distribution** — *not* the pooled `Σactive/Σtotal`, which one forgotten zombie ticket inflates to 90%; age-outliers flagged per §10; active/wait classification from the effective-dated `flow_state_models`, fused with GitHub code-phase), Flow Load (WIP; **Little's-Law demoted to a long-horizon sanity-check with a stationarity guard** that excludes bulk-close days, not a per-sprint flag), Flow Velocity/Throughput (**count**, not points; dedup per issue per window, count on **first** Done), Flow Distribution, CFD (replay changelog per-day per-status, using the classification *in effect at each interval*), Aging WIP / Work-Item-Age, Time-in-Status (re-entries accumulate), Monte Carlo forecast (**vendored seeded PRNG + canonical sample order** per §8.6 → reproducible per engine-version+seed). All from the Jira changelog (C1) + board config + GitHub for the code phase.

### 8.3 Group C — PR / Review (`team+`)
4-phase **PR Cycle Time** (Coding = open − first_commit; Pickup = first non-author review − ready; Review = merged − first_review; Deploy = release − merged); review-latency decomposition (First-Response / Rework / Idle); Time-to-First-Review; Time-to-Merge; PR Size (HALOC-weighted XS–XL); Review Coverage (commented hunks / total hunks); Reviewers-per-PR; Reviewer Load Distribution (Gini, anonymized); Comments-per-PR; Review Iterations; Merge-Without-Review Rate; Stale PR detection (last *meaningful* activity); CI/Check-Run health (pass-rate, latency, flakiness via reruns/SHA).

### 8.4 Group D — Code (`team+`, descriptive only, gaming-prone)
**HALOC** (base unit, C2) — computed over a **normalised diff**: pinned git rename-detection threshold (recorded in the engine version, renames-with-edits count as edit hunks only); **binary + generated/vendored paths classified and bucketed-or-excluded** (gitattributes `linguist-generated` + configurable globs like `*-lock.json`, `dist/**`) with excluded volume surfaced as a separate "generated/binary" figure (never silently zeroed — a 2MB binary swap is not 0 effort, a 50k-line regenerated client is not real work); optional whitespace-insensitive mode (`git diff -w`) so a formatter run doesn't spike rework. Work-type split (New / Legacy-Refactor / Help-Others / Rework via blame line-age + author vs configurable N-day window, D7); Rework/Churn % (`Efficiency = 100 − Rework%`); Nagappan-Ball M1/M2/M3; **Cyclomatic Complexity** (1 + decision points, +1 per `case`); **Cognitive Complexity** — full SonarSource rule set restated in `formulaDoc`: **+1 per maximal like-operator boolean sequence** (`a&&b||c` = +2), **single +1 per `switch`** regardless of cases, **+1 per recursive call** (direct & indirect), plus nesting increments; Max Nesting / function-file length / param count; Maintainability Index (trend only); explainable Code-Change Impact (deterministic blend + **LLM rationale string**, §9). **Never** ship raw LOC or commit-count as productivity.

### 8.5 Group E — Agile / Jira (`team+`)
Sprint Velocity (committed snapshot at sprint start from `sprint_membership_events` vs completed; **counted at one configurable hierarchy level — subtask points roll up to the parent, never double-counted**; `null` velocity flagged, not shown as 0, when the project's story-point field is unmapped); Say/Do ratio (**`null` on 0 committed**); Sprint Predictability (**bounded to [0,1]** — prefer share-of-sprints-within-±X% or P(throughput ≥ commitment); the raw 1−CV is unbounded-below and renders negative %; requires n≥2, mean>0); Estimation Accuracy (**tie-corrected Spearman with minimum-n and a significance guard — suppressed when not significant**; excludes reopened/0-point items; Fibonacci points are heavily tied at small n). **Kanban boards degrade gracefully** to throughput/cycle-time only (no velocity/say-do).

### 8.6 Engine Determinism & Reproducibility Contract
This is the single highest-leverage section: the golden "exact match" test gate is only as good as what this contract pins. v1 pinned three things; the review showed that left the gate testing under-specified targets and let two installs legitimately disagree. The engine MUST pin **all** of the following, version them together as `engine_version`, and surface that version on every output:

- **Purity:** `(normalizedInputs, params) → MetricResult`, same input ⇒ same output; **no `Date.now()`/`Math.random()` in metric paths** (lint-enforced) — clock and seed are injected.
- **Module exports:** `id`, `trustTier`, `scope`, `formulaDoc` (the published "how computed" string), `params`, `compute()`, and **co-located per-metric golden fixtures** (not a shared monolith — see WP-TESTKIT split).
- **Percentile method:** ONE pinned algorithm (recommend type-7 / linear interpolation, documented in `formulaDoc`) — two installs using nearest-rank vs R-7 otherwise report different p75/p90 from identical data.
- **Minimum-sample floors:** n≥20 for p90, n≥30 for p95, a numeric minimum-n for the anomaly detector (§9.2.3) and for Spearman/CV; below floor → `data_quality='insufficient_sample'`, no number.
- **Zero / empty-input semantics:** every ratio returns `null` ("N/A", `data_quality='no_data'`) on a zero denominator — **never `NaN`/`Infinity`**; `outputSchema` is nullable; the subagent is forbidden from narrating `null` as a number. CV/predictability need n≥2 and mean>0; estimation bias excludes 0-point estimates.
- **Reopen / Done policy:** Throughput & Velocity count once per window on **first** Done (dedup per issue per window); Flow Time stops at first Done with reopens as a separate rework counter-metric; Recovery Time = created→first-resolve. **Clock-skew guards:** clamp `now − t_k ≥ 0` and flag future-dated transitions.
- **Lead Time anchoring:** commit set via compare-API enumeration between consecutive deploy SHAs; per-commit median; anchor on `pull_requests.first_commit_at`; merge-strategy detection wires the §10 squash/rebase flag.
- **HALOC normalisation:** pinned rename-detection threshold; binary/generated/vendored classification rules; whitespace mode.
- **Complexity counting:** full SonarSource cognitive rules + cyclomatic rules as restated in §8.4 `formulaDoc`.
- **Randomness:** a **vendored pure-TS seeded PRNG** (xorshift128+/PCG) and a **canonical (sorted) sample iteration order** for Monte Carlo, so two installs on different Node/arch forecast identically per engine-version+seed.
- **Reporting timezone:** ONE configurable timezone (default UTC) for all day/week bucketing (CFD, deploy-days/week, daily snapshots, aging bands); durations computed as **DST-safe elapsed UTC-instant differences**.
- **Re-derivation:** an `engine_version` bump triggers WP-REDERIVE (recompute over retained raw, stamp the version); tools refuse to plot across mixed engine versions without an explicit flag.

"Reproducible/auditable" is scoped to **this deterministic engine**; the AI layer is point-in-time (§9.1).

---

## 9. AI / Probabilistic Engine

**The ruling (mandatory):** default to deterministic; use Claude only where a number genuinely cannot be counted/diffed — and **never let the LLM produce the number directly.** Every "probabilistic" metric is actually **hybrid**: deterministic features are computed first and handed to Claude as *evidence to reason over*. Claude does rubric-bounded judgment + attribution with cited evidence; it never invents a magnitude it could hallucinate (*R§deterministicVsProbabilistic, R§aiInsightDesigns*).

**AI verdicts are point-in-time, not bit-reproducible (v2).** Even at temperature 0 Anthropic does not guarantee identical outputs, and models get deprecated — so `engine_version` "reproducibility" (§8.6) scopes to the deterministic engine only. Each verdict persists its `model_snapshot` + `request_shape`; a model-deprecation runbook re-calibrates κ against successors when an id retires (404).

### 9.1 Six mandatory constraints for every hybrid metric
1. **Deterministic features first**, passed as evidence; LLM never computes magnitude.
2. **Pointwise rubric scoring** (avoids pairwise position bias, which swings 0.23–0.82); **low-precision scales** (binary or 0–4, never 1–10).
3. **Per-model request shape (v2):** **temperature 0 on Sonnet-tier only.** Opus 4.x **rejects** `temperature`/`top_p`/`top_k` (HTTP 400) — Opus calls (the D8 ensemble, the `flow-analyst` subagent) MUST send **no sampling params** and use adaptive thinking / low effort instead; a request-shape adapter enforces this and a harness test asserts no sampling param ever reaches an Opus id.
4. **Constrained decoding** (Anthropic structured outputs — schema → grammar). Note the grammar enforces **shape + enums** but **not numeric min/max** (the SDK strips those to client-side validation). Therefore **encode every bounded discrete value as an enum** (`ordinal: enum[0..4]`, per-dimension `enum[0..2]`) and **derive `coverage_ratio` deterministically in code**, so an out-of-range value can't slip through and break the `min(ordinal, coverage)` rule. Handle refusals/cutoffs.
5. **Every claim cites *relevant* evidence** or returns "insufficient information." Quote-**existence** is not enough — a real-but-irrelevant hunk (a logging line for an expiry criterion) must not count as covered; a **deterministic relevance guard** requires the quoted hunk to come from a file/symbol the criterion plausibly touches (reusing the hunk relevance-ranking score) and rejects below threshold. Generative attribution is a **closed menu** of causes, never free-form.
6. **Effort/ordering, not absolute numbers**, AND **calibrate against a human-labelled gold set** — target **κ ≥ 0.6 OR the documented human-human ceiling, whichever is lower** (the alignment task is subjective; a fixed 0.6 can be physically unreachable, so report human-human agreement first). macro-F1 ≥ 0.7 for classification; significance-guarded Spearman for effort. **Validate self-reported confidence before trusting it:** until confidence is shown calibrated (reliability/ECE bound), the D8 ensemble gates on a **deterministic proxy** (cross-check disagreement, evidence-relevance, small-sample flags), not on raw model confidence.

### 9.2 The insights

**9.2.1 Ticket-Work Alignment** (`hybrid`, `team+`)
Inputs: Jira description + parsed acceptance criteria, issue type/summary; PR title/body + commit messages; **relevance-ranked** diff hunks (never silent truncation); the deterministic Jira↔PR link. Prompt: pointwise per criterion → `{covered: yes/no/unclear, evidence: <quoted diff hunk>}`; a criterion may be "covered" **only** if a diff quote is supplied. Output: `{ordinal 0–4, criteria[], coverage_ratio, confidence}`; final = min(ordinal band, coverage ratio). Use: flags silent scope drift and under-specified tickets — process insight, never an individual cudgel.

**9.2.2 Effort Proportionality** (`hybrid`, `team+`)
Inputs: effort vector {HALOC, files, #commits, cycle time, review rounds, #comments, rework commits}; ticket scope text; team historical effort distribution; story points as *one* signal. **Baseline-readiness gate (v2):** below a minimum N of closed items in a time window, return "insufficient history" rather than judging a normal large ticket "much higher than expected" against n=3 and torching day-one trust (mirrors §9.2.3's sample gate; §9.2.4 baselining shares it). Prompt: ordinal `{much_lower … much_higher}` + log-ratio (never a raw point prediction). Cross-checked against the deterministic cycle-time z-score; disagreement lowers confidence. Exempts research/spike types. **Never per-developer for evaluation.**

**9.2.3 Velocity Anomaly Explanation** (`hybrid`, `team+`)
Detection (deterministic): control-chart/EWMA z-score on throughput/cycle-time, flag |z|>2 with a minimum sample size. Signal pack (deterministic): WIP, reviewer latency, #blocked, ticket churn (re-opens/AC edits), PTO/holidays, team-size delta, large-PR share, incident volume, dependency wait. Prompt: rank a **closed menu** of candidate causes; each requires an evidence pointer; model MUST pick "insufficient signal" rather than invent. Output phrased "consistent with," never "caused by." Attribute to systemic signals, never individuals.

**9.2.4 Velocity Baselining** (`deterministic` core + narration; `self` private + `team+` aggregate)
Per-person baseline = own throughput/cycle-time trend vs own history (no cross-person percentile). Company-wide = aggregate distribution across teams. AI layer only narrates the deterministic trend.

**9.2.5 Work-type Classification** (`hybrid`, `team+`) — conventional-commit/path prior (deterministic) + LLM on diff for Flow Distribution & investment balance; git-blame work-type split as fallback when issue links are missing.

**9.2.6 PR Quality Score** (`hybrid`, `team+`) — deterministic checks (has-desc / linked-issue / has-tests / atomicity) + LLM (does the body explain *why*, does it match the diff, risk flags) with quoted evidence, 0–2 per dimension. Rubric about substance, not eloquence (avoid Anglophone-prose bias).

**9.2.7 Explainable Code-Change Impact** — deterministic blend (§8.4) + LLM rationale string ("touched auth middleware + a migration; high blast radius"). Every factor/weight visible and configurable.

### 9.3 Engineering harness
- One **prompt registry** (versioned prompts; `prompt_version` persisted with every verdict).
- **Per-model request-shape adapter** (v2): never sends `temperature`/`top_p`/`top_k`/`budget_tokens` to a `claude-opus-*` id; stores the actual `request_shape`. Plus a **model-deprecation runbook** (retired ids 404 → re-calibrate against the successor).
- **Constrained decoding** via Anthropic structured outputs; bounded values enum-encoded (§9.1.4).
- **Ensemble (majority vote across model families)** — **gated on a deterministic low-confidence proxy until model confidence is proven calibrated** (§9.1.6), and confidence-calibration is sequenced **before** the ensemble is enabled (D8). Doubles cost, so gated.
- **Calibration harness as a first-class feature:** per-team gold set with a documented **annotation protocol** (who labels, item count, inter-rater target, report human-human agreement first); report κ/macro-F1/Spearman; iterate the rubric until agreement closes.
- **Built contestability surface (v2):** a `correct_verdict` MCP tool + `/lazy-flow:contest` skill write (append-only) `corrected_by`/`correction_json`; **WP-AI-CALIBRATION ingests corrections as gold labels and re-reports κ** — without this write path, AC7 ("verdicts contestable; corrections feed calibration") cannot pass. Full audit record per verdict → `ai_verdicts`.
- **Cost controls:** verdict cache keyed on (subject, content-hash, prompt_version, model); re-run only on content change. The shared-ingester path (§5.4) uses a **content-addressed *shared* cache** so N developers don't each pay for byte-identical verdicts. Token-cost sizing with the corrected denominator (distinct subjects × active installs × per-verdict cost) is a required spike (WP-SPIKE-LLMCOST).

---

## 10. Transparency, Trust Tiers & Anti-Gaming

- **Trust badge on every metric** (`deterministic`/`hybrid`/`probabilistic`) + an in-product "how is this computed?" link rendering `formulaDoc`.
- **Engine/version pinning published** (counting rules, churn window, benchmark report version).
- **Active gaming detection** (not just computation): flag deployment-frequency inflation (non-prod/rapid redeploys), CFR suppression (deploys with later hotfixes but no incident), lead-time resets from squash/rebase, status-juggling that inflates flow efficiency, trivial-PR-splitting. Report the number **plus** a data-quality/confidence indicator.
- **Balanced multi-metric views by default** (SPACE-style: pair speed with a quality/experience counter-metric). **No single composite "productivity number."**
- Effort/PR-size are **descriptive context, flagged not hard-penalised** (large refactors are legitimate).
- Surface DORA's own Goodhart warning in-product when a user tries to pin a metric as a target.

---

## 11. Privacy, Visibility & Compliance

### 11.1 Visibility model (v2.1 — owner decision: open by design)
**Resolved (owner):** lazy-flow derives every metric from data **already accessible to anyone in the org** via the GitHub + Jira APIs (commits, PRs, reviews, ticket transitions, complexity). It computes no secret. Gating *who may view the derived metrics* is therefore a **presentation choice, not a security control** — any member could compute the same numbers from the source APIs themselves. So the product is **open by design** and the shipped default is `public`.

A single `visibility` policy with three values (a switch the installing team sets; it changes presentation, not what's computable):
- **`public` — shipped default.** All individual metrics visible to all members. Per-person `metric_snapshots` persisted under `scope_type=person`. Honest, and matches the reality that the underlying data is org-visible.
- `team` — surfaces only team/org aggregates; person scope computed on demand. For orgs that prefer a softer presentation.
- `self` — each member sees only their own data + team aggregates. For orgs that want it.

**The v1 claim that individual ranking is "architecturally impossible" was false and is withdrawn** — since per-person data is openly viewable (and derivable from already-open sources), ranking is trivially constructible and we don't pretend otherwise. The product **does not ship a stack-rank/forced-curve UI by default** (an editorial choice to keep the framing growth-oriented, not a security boundary); whether to add explicit ranking/leaderboard views is a later product decision, not a constraint. **No LIA/DPIA acknowledgement gate** is imposed on storing person snapshots — gating already-accessible derived data adds friction for no protection.

### 11.2 GDPR / compliance scaffolding (for adopters, not enforcement)
For *this* org the data is already accessible, so per-person metrics are an open, derived view of open data. The remaining relevance is **open-source adopters**: a company that forks lazy-flow may operate where *systematic aggregation/profiling* of individual performance carries obligations even when the raw events are individually visible. So we ship — as **optional documentation helpers, not gates** — a **DPIA template**, a legitimate-interest-assessment generator, and a transparency-notice generator, plus data-minimisation/retention config, subject-erasure, and an `org_id`-bound DB. Note for adopters: **employee consent is generally not a valid legal basis** (power imbalance); regulated forks should route their own legal-basis determination through qualified data-protection counsel (WP-LEGAL). *This is product scaffolding, not legal advice.*

---

## 12. Plugin & Distribution

(Verified against Claude Code plugin docs, v2.1.145, June 2026.)

### 12.1 Layout
```
lazy-flow/                         # repo root
├── .claude-plugin/plugin.json     # manifest ONLY
├── .mcp.json                      # bundled stdio MCP server wiring
├── skills/<name>/SKILL.md         # slash commands
├── agents/flow-analyst.md         # narrating subagent
├── hooks/hooks.json               # optional (e.g. post-sync)
├── server/dist/server.js          # bundled MCP server (tsup output)
└── marketplace/.claude-plugin/marketplace.json   # (or a separate marketplace repo)
```
Only `plugin.json` lives in `.claude-plugin/`; everything else at root (top cause of load failure if violated).

### 12.2 Manifest essentials
`plugin.json` declares `name`, `displayName`, `version` (omit to auto-update per git SHA), `mcpServers` (→ `.mcp.json`), and a `userConfig` block:
- **Secrets** (`github_token`, `jira_oauth_token`) → `sensitive: true` → stored in OS keychain (fallback `~/.claude/.credentials.json`), available only in MCP `env`, never in prompt content.
- **Shared, non-sensitive config** (`repos`, `jira_projects`, `visibility`, churn window) → committed `.claude/settings.json` `pluginConfigs`.

### 12.3 Bundled MCP server wiring (`.mcp.json`)
```jsonc
{ "mcpServers": { "lazy-flow": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/server.js"],
  "env": {
    "LAZYFLOW_GITHUB_TOKEN": "${user_config.github_token}",
    "LAZYFLOW_JIRA_TOKEN":   "${user_config.jira_oauth_token}",
    "LAZYFLOW_DB_PATH":      "${CLAUDE_PLUGIN_DATA}/lazy-flow.db",
    "LAZYFLOW_REPOS":        "${user_config.repos}",
    "LAZYFLOW_JIRA_PROJECTS":"${user_config.jira_projects}",
    "ANTHROPIC_API_KEY":     "${user_config.anthropic_api_key}"
  } } } }
```
- `${CLAUDE_PLUGIN_ROOT}` = install dir (changes on update — never write state here; the WASM assets are read-only here and located via `import.meta.url`, not `cwd`).
- `${CLAUDE_PLUGIN_DATA}` = persistent dir (survives updates) → the SQLite DB file + caches live here.
- **No runtime npm install / no native build (v2, now actually true):** the v1 plan was self-contradictory — it bundled to one `server.js` while depending on `better-sqlite3`, a node-gyp **native C++ addon that bundlers cannot inline** into a `.js` text artifact; the first teammate on a different OS/arch/Node-ABI would crash with `NODE_MODULE_VERSION` mismatch or a missing `.node`. v2 eliminates **all** native deps: **WASM SQLite** (`@sqlite.org/sqlite-wasm` or built-in `node:sqlite` on Node ≥22, D5) + **WASM tree-sitter**. The build copies `sqlite3.wasm`, `tree-sitter.wasm`, and every grammar `.wasm` into `server/dist/grammars/`; the server resolves them relative to its own module URL. Pin an exact Node version range; the only host requirement is Node on `PATH`. A **Wave-0 clean-machine, cross-ABI boot + MCP-handshake + tool-call smoke test** (WP-E2E) gates every release so this never silently regresses.

### 12.4 Team-wide install (the "commit and the team gets it" flow)
1. Host a marketplace (this repo or a dedicated one) with `marketplace.json` listing the `lazy-flow` plugin.
2. Commit to the consuming repo's `.claude/settings.json`:
```jsonc
{ "extraKnownMarketplaces": { "lazy-flow": { "source": { "source": "github", "repo": "ORG/lazy-flow" } } },
  "enabledPlugins": { "lazy-flow@lazy-flow": true },
  "pluginConfigs": { "lazy-flow": { "options": { "repos": ["ORG/app"], "jira_projects": ["ENG"], "visibility": "public" } } } }
```
3. On clone + trust, Claude Code registers the marketplace, installs the plugin, and prompts each member once for secrets (keychain). MCP server starts next session. Metrics available via `/lazy-flow:*`.
- Org enforcement: managed/admin settings + `strictKnownMarketplaces` allowlisting only the lazy-flow repo.
- **Known edges:** plugin updates need `/reload-plugins` mid-session; URL-based (non-git) marketplaces don't resolve relative plugin paths → always host as a git repo.

---

## 13. MCP Surface, Skills & Subagent

### 13.1 Tools (with `outputSchema` + `structuredContent` — values exact & machine-checkable)
Representative set (full list in WORKPLAN WP-MCP):
- `sync_status` → freshness/watermark per source.
- `run_sync` → trigger backfill/incremental sync.
- `get_dora` / `get_flow` / `get_pr_metrics` / `get_code_metrics` / `get_agile_metrics` → deterministic metric bundles for a scope + window, each row carrying `value`, `trust_tier`, `data_quality`, `formula_doc`.
- `explain_metric` → returns the published formula + inputs for a metric.
- `ticket_work_alignment` / `effort_proportionality` / `explain_anomaly` / `pr_quality` → AI verdicts with evidence + audit id.
- `correct_verdict` → append-only correction to an AI verdict (feeds calibration; §9.3) — the write-surface AC7 needs.
- `export` → structured CSV/JSON for a metric + scope + window (for leader personas who must share results outside the IDE).
- `list_dashboards` / `get_dashboard` → Resources.
Every tool output includes `trust_tier`, `as_of`, `engine_version`, and a **coverage/data-quality flag** (§5.3) so the model cannot present stale, mis-tiered, or partial-coverage numbers as fact. Per-person scope is surfaced per the `visibility` switch (§11.1; `public` by default).

### 13.2 Resources
Saved dashboards exposed as MCP Resources (`lazy-flow://dashboard/<id>`) for @-mention.

### 13.3 Skills (slash commands)
`/lazy-flow:sync`, `:dora`, `:flow`, `:pr`, `:code`, `:agile`, `:forecast`, `:me` (self), `:team`, `:org`, `:explain`, `:anomaly`, `:align` (ticket-work alignment), `:config`, `:identities` (review/confirm fuzzy matches). Each SKILL.md instructs the model to call the corresponding tool(s) and render the structured output.

### 13.4 Subagent `flow-analyst`
**Narrates only the deterministic tool outputs** — it never computes a metric itself. Given a tool's `structuredContent`, it produces an executive summary, flags trends/regressions against baselines, and proposes systemic (never individual) next steps. Model: `claude-opus-4-8` for analysis depth. This keeps insight conversational without sacrificing accuracy.

---

## 14. Configuration

Resolved config (precedence: committed `pluginConfigs` → env → defaults):
- `repos: string[]`, `jira_projects: string[]`, `jira_base_url`.
- `visibility: public|team|self` (default `public`, D2).
- `churn_window_days` (default 30, D7), `deploy_signal_priority` (D9), `benchmark_report` (default latest, D10).
- `claude_model` (default `claude-sonnet-4-6`), `claude_ensemble_model` (`claude-opus-4-8`), `ensemble_confidence_threshold`.
- `business_hours` / working-calendar (for business-hours-aware latency; default off until verified — WP gap).
- Secrets via keychain only: `github_token`, `jira_oauth_token`, `anthropic_api_key`.

---

## 15. Non-Functional Requirements

- **Language:** TypeScript, `strict: true`. Explicit return types on exported functions. No `any` without a justifying comment.
- **Format/lint:** Biome (format + lint) — CI fails on diff.
- **Typecheck:** `tsc --noEmit` clean in CI.
- **Tests:** Vitest. **Behaviour, not implementation.** Coverage gates on the metric engine (the correctness core) — every deterministic metric has golden tests.
- **Mocks (explicit requirement):** MSW handlers for GitHub (REST + GraphQL) and Jira (REST v3 + Agile + bulk changelog), backed by **fixture corpora**. A **synthetic golden dataset** (a fabricated org/repo/project with hand-computed expected metric values) lets tests assert `engine.compute(...) === expectedGolden`. Fixtures use obviously-fake identifiers (no real PII).
- **Determinism in tests:** inject clock + seed; no wall-clock or RNG in metric code paths.
- **Performance:** initial backfill of a mid-size org (≈20 repos / 50 contributors / 2 yrs) completes within a documented budget; incremental sync is sub-minute; dashboard tool calls return < 1s from snapshots.
- **Security:** least-privilege scopes; secrets never in DB/repo/logs; raw payloads scrubbed of tokens; SQL via parameterized statements only.
- **Observability:** structured logs, a `doctor` tool (checks auth, rate-limit headroom, sync freshness, DB integrity).
- **Licensing:** MIT; third-party licenses audited (tree-sitter grammars, octokit, etc.).

---

## 16. Repository Layout (proposed)

```
lazy-flow/
├── .claude-plugin/plugin.json
├── .mcp.json
├── skills/  agents/  hooks/
├── packages/
│   ├── core/            # domain types, Store interface, SqliteStore, migrations, identity stitching
│   ├── ingest-github/   # octokit REST+GraphQL adapter, 3-phase sync
│   ├── ingest-jira/     # Jira REST v3 + Agile + bulk changelog adapter
│   ├── metrics/         # deterministic engine (Groups A–E), formulaDocs, golden tests
│   ├── code-analysis/   # web-tree-sitter complexity, HALOC, blame churn/work-type
│   ├── ai/              # prompt registry, feature packs, Claude client, calibration harness, ai_verdicts
│   ├── mcp-server/      # MCP tools/resources, bundled via tsup → server/dist/server.js
│   └── testkit/         # MSW handlers, fixture corpora, synthetic golden dataset
├── docs/                # this spec, research, workplan
└── package.json         # pnpm workspaces; Biome, Vitest, tsc, tsup at root
```

---

## 17. Acceptance Criteria (product-level)

1. A developer can install the plugin team-wide via committed settings and a one-time secret prompt; the **bundled `server.js` boots with no build/install/native-compile step on a clean machine of a different OS/arch/Node-ABI** (WP-E2E cross-ABI smoke test passes).
2. `run_sync` backfills then incrementally syncs GitHub + Jira idempotently, **paginating changelog and GraphQL inner connections to exhaustion and tombstoning deleted entities**; `sync_status` reports freshness and refuses stale-beyond-threshold reads.
3. Every Group A–E deterministic metric matches its co-located golden fixtures exactly **including degenerate inputs (zero-denominator→null, empty window, n below sample floor) and reopen/squash/rename/timezone edge cases**, and carries `trust_tier`, `formula_doc`, `data_quality`, and `engine_version`.
4. The AI insights return schema-valid (enum-bounded), **relevance-checked** evidence-cited verdicts with audit records and correct request shape per model; the calibration harness reports κ (vs the human-human ceiling) / macro-F1 / Spearman, and `correct_verdict` corrections feed it.
5. The `visibility` switch (`public` default) governs presentation of per-person metrics; the product ships no stack-rank/forced-curve UI by default (editorial, not a security boundary — the data is org-accessible regardless). *(The false "ranking architecturally impossible" claim is withdrawn — §11.1.)*
6. Biome, `tsc --noEmit`, and Vitest all green in CI; metric-engine coverage gate met; **no `Date.now()`/`Math.random()` in metric paths** (lint-enforced); cross-Node percentile/forecast equivalence test passes.
7. Every metric is explainable in-product ("how is this computed?") with its `engine_version`; AI verdicts are contestable via a built write-surface. *("Reproducible" is scoped to the deterministic engine; AI verdicts are point-in-time — §9.1.)*

---

## 18. Risks & Open Items

- **R1 (RESOLVED):** the `public`/open-by-design default (D2) is confirmed — all metrics derive from data already org-accessible via the GitHub/Jira APIs, so visibility is a presentation choice, not a security control, and no acknowledgement gate is imposed. Residual risk is for **open-source adopters** in stricter jurisdictions (aggregated profiling can carry obligations even over individually-visible raw events); mitigated by optional DPIA/LIA/notice generators + a documented note to route their own legal-basis call through counsel (§11.2, WP-LEGAL). `team`/`self` switches available for orgs wanting a softer presentation.
- **R2 (cost):** hybrid LLM metrics at per-PR/per-ticket scale — token cost unproven → **WP-SPIKE-LLMCOST** sizes it and validates the ensemble gate before broad rollout.
- **R3 (accuracy):** tree-sitter cognitive-complexity conformance to the SonarSource spec across non-JS grammars is untested → **WP-SPIKE-TREESITTER** conformance suite.
- **R4 (accuracy):** identity-stitching match rates on real multi-org data unquantified → **WP-SPIKE-IDENTITY** real-corpus eval before per-person metrics ship.
- **R5 (legal):** DPIA / legitimate-interest content needs qualified counsel review → **WP-LEGAL** (flag, not engineering).
- **R6 (parity):** Flow's business-hours handling unconfirmed → verify before claiming business-hours-aware latency as a differentiator (config default off).
- **R7 (local-first):** webhooks need a reachable endpoint → local installs default to polling; webhooks documented for the scale-up path.

---

*End of specification. Build sequencing in [`WORKPLAN.md`](./WORKPLAN.md).*
