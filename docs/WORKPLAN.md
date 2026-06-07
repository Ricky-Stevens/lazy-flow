# lazy-flow — Work Plan (fan-out ready)

**Status:** Draft v2 (post-adversarial-review) · **Date:** 2026-06-06 · **Companion:** [`SPEC.md`](./SPEC.md), [`research/RESEARCH.md`](./research/RESEARCH.md), [`research/ADVERSARIAL-REVIEW-v1.md`](./research/ADVERSARIAL-REVIEW-v1.md)

This plan is organised by **dependency layers and workstreams**, not MVP release tiers (per decision D4 — full vision, no tiering). Every work item is a self-contained unit a sub-agent can pick up cold, with: **Scope · Inputs · Deliverables · Acceptance · Tests/mocks · Depends-on**. The intent is that a workflow can fan these out in dependency waves.

> **Revision log — v2** resolves the adversarial review: **9 new work items** (WP-FLOWSTATE-MODEL, WP-JIRA-WORKFLOW, WP-JIRA-BOARDCONFIG, WP-REDERIVE, WP-SCRUB, WP-ROLLUP, WP-EXPORT, WP-SPIKE-SYNCLOAD, WP-E2E — §2a); **two backward DAG edges fixed** (Flow metrics depended on a Wave-5 AI-seeded model and on un-ingested board config); WP-TESTKIT split (no monolithic golden-expectations — fixtures co-locate with each engine); WP-STORE moved to WASM SQLite; WP-SNAPSHOTS acceptance changed to closed-window equivalence; all `≥ target` numbers pinned; degenerate-input + edge-case golden fixtures added across waves; a per-item **size** tag added so the orchestrator starts long-poles first.

---

## 0. How to fan this out with workflows

The dependency DAG (below) defines **waves**. Within a wave, items are independent and run in parallel; a wave starts only when its predecessors complete. Recommended orchestration:

- **Worktree isolation per coding item** (`isolation: 'worktree'`) — many items touch files concurrently.
- **Pipeline, not barrier**, where an item can be verified as soon as it's built: `build → typecheck/biome/test → adversarial review`.
- **Per-item acceptance is the gate**: an item is "done" only when Biome + `tsc --noEmit` + its Vitest suite (incl. golden assertions) are green, and an adversarial reviewer confirms scope.
- Each fan-out item below names its `package` so worktrees don't collide unnecessarily.

New/changed items from the adversarial review are in §2a. A reference orchestration sketch is in §12.

---

## 1. Dependency DAG (waves)

```
Wave 0  Foundations:        WP-REPO, WP-TOOLING, WP-TESTKIT-BASE, WP-E2E(scaffold)
Wave 1  Spikes (parallel):  WP-SPIKE-LLMCOST, WP-SPIKE-TREESITTER, WP-SPIKE-IDENTITY,
                            WP-SPIKE-SYNCLOAD   (+ WP-LEGAL flag)
Wave 2  Data core:          WP-DB-SCHEMA, WP-STORE, WP-MIGRATIONS, WP-IDENTITY
Wave 3  Ingestion:          WP-GH-CLIENT, WP-GH-SYNC, WP-JIRA-CLIENT, WP-JIRA-CHANGELOG,
                            WP-JIRA-WORKFLOW, WP-JIRA-BOARDCONFIG, WP-SYNC-ORCH, WP-LINKING
Wave 3.5 Flow prerequisites: WP-FLOWSTATE-MODEL (deterministic seed + human-confirm; gates Flow metrics)
Wave 4  Engines (parallel): WP-METRICS-DORA, WP-METRICS-FLOW, WP-METRICS-PR, WP-CODE-ANALYSIS,
                            WP-METRICS-CODE, WP-METRICS-AGILE, WP-ROLLUP, WP-SNAPSHOTS, WP-REDERIVE
Wave 5  AI engine:          WP-AI-HARNESS, WP-AI-ALIGNMENT, WP-AI-EFFORT, WP-AI-ANOMALY,
                            WP-AI-CLASSIFY, WP-AI-PRQUALITY, WP-AI-IMPACT, WP-AI-CALIBRATION,
                            WP-FLOWSTATE-MODEL(LLM-seed pass)
Wave 6  Surface:            WP-MCP-SERVER, WP-MCP-TOOLS (incl. correct_verdict, export),
                            WP-MCP-RESOURCES, WP-PLUGIN, WP-SKILLS (incl. /contest), WP-SUBAGENT
Wave 7  Cross-cutting:      WP-TRANSPARENCY, WP-ANTIGAMING, WP-VISIBILITY, WP-SCRUB,
                            WP-GDPR-SCAFFOLD, WP-DOCTOR
Wave 8  Polish/ship:        WP-SURVEY (optional), WP-EXPORT(polish), WP-DOCS, WP-PERF, WP-RELEASE
```

Critical path: `WP-DB-SCHEMA → WP-STORE → WP-GH/JIRA-SYNC + WP-JIRA-WORKFLOW/BOARDCONFIG → WP-FLOWSTATE-MODEL → WP-METRICS-* → WP-MCP-* → WP-PLUGIN`, with **WP-E2E (cross-ABI bundle boot)** gating Wave 0 and every release.

**Backward-edge fixes (v2):** WP-METRICS-FLOW now depends on WP-FLOWSTATE-MODEL (deterministic seed parts, Wave 3.5) **and** WP-JIRA-WORKFLOW **and** WP-JIRA-BOARDCONFIG — in v1 Flow metrics silently consumed an empty `flow_state_models` table seeded only in Wave 5 and a board-start boundary that was never ingested. WP-SCRUB runs at ingest, so its rules are wired into WP-GH-SYNC/WP-JIRA-* DoD even though the item lands in Wave 7. **Per-item `Depends-on` edges are the single source of truth** (the old "spikes gate only Wave-4/5" prose is removed — WP-IDENTITY legitimately depends on WP-SPIKE-IDENTITY in Wave 2).

---

## 2a. New work items (v2 — from the adversarial review)

These are first-class, fan-outable items. Each carries a **size** (S/M/L) so the orchestrator starts long-poles first.

### WP-FLOWSTATE-MODEL — per-workflow active/wait map (size L) — **NEW, resolves the critical orphan/backward-edge**
- **Package:** `core` + `ai`. **Depends-on:** WP-JIRA-WORKFLOW, WP-STORE (deterministic + human-confirm parts, Wave 3.5); LLM-seed pass in Wave 5.
- **Scope:** build the C3 model the product markets as its moat (in v1 it had a table but no producer). Deterministic seeding heuristic (status name/category → new/active/wait/done) → optional LLM seed → **human-confirm queue** → confidence scoring → effective-dated config persistence (`flow_state_models` with `valid_from/valid_to`) → a `/lazy-flow:flowstate` review skill. A **deterministic implicit-wait fallback** (assignee gaps, blocked-flag, no-activity windows), flagged low-confidence, covers unconfirmed workflows so Flow metrics never read an empty table.
- **Acceptance:** every in-scope workflow resolves to a flow-state map; Flow Efficiency golden expectations are parameterised on the confirmed model; unconfirmed workflows yield low-confidence (not wrong-confident) output.

### WP-JIRA-WORKFLOW — workflow & scheme discovery (size M) — **NEW**
- **Package:** `ingest-jira`. **Depends-on:** WP-JIRA-CLIENT. **Gates:** WP-FLOWSTATE-MODEL, WP-METRICS-FLOW.
- **Scope:** discover workflows + workflow schemes; resolve issue→(project,issuetype)→`workflow_id`; populate `workflows`/`workflow_scheme_mappings` (fixes the orphan FK).
- **Acceptance:** every in-scope issue resolves to a workflow; golden fixture with two issue types on different workflows.

### WP-JIRA-BOARDCONFIG — board column boundaries (size M) — **NEW, resolves a critical**
- **Package:** `ingest-jira`. **Depends-on:** WP-JIRA-CLIENT. **Gates:** WP-METRICS-FLOW.
- **Scope:** ingest `/rest/agile/1.0/board/{id}/configuration` → `board_configs`/`board_columns` (`status_ids[]`, `is_started_col`, `is_done_col`, board type). Define cycle-time **start** = first entry into a status mapped to a *started* column (per board).
- **Acceptance:** golden fixtures distinguishing a queue column ("Selected for Dev") from a started column ("In Dev"); cycle-time start differs accordingly. Kanban boards flagged for graceful degradation.

### WP-REDERIVE — engine-version re-derivation (size M) — **NEW, resolves a critical**
- **Package:** `metrics`. **Depends-on:** WP-SNAPSHOTS.
- **Scope:** on an `engine_version`/formula change or reconciliation that mutates raw rows for day D, mark affected `metric_snapshots` **stale** and recompute over retained raw; stamp `engine_version`/`ingest_watermark_version`. Tools refuse to plot across mixed engine versions without an explicit flag.
- **Acceptance:** a version-boundary continuity test; late-arriving event for a closed day triggers recompute and the two surfaces (snapshot vs `explain`) reconverge.

### WP-SCRUB — ingest-time payload sanitiser (size M) — **NEW**
- **Package:** `core` (+ wired into both ingest packages' DoD). **Depends-on:** WP-STORE.
- **Scope:** field allowlist + entropy/regex secret detection over free-text bodies (`review_comments.raw`, `issues.raw`), run **before persistence**; reconcile the raw-email retention rule (§6.5).
- **Acceptance:** golden tests prove known secret/email/token patterns are removed before they hit disk.

### WP-ROLLUP — team/org aggregation (size M) — **NEW**
- **Package:** `metrics` + `core`. **Depends-on:** WP-DB-SCHEMA (teams/team_membership), WP-IDENTITY.
- **Scope:** `teams`/`team_membership` config + compute team→org aggregate distributions ("company-wide velocity") — impossible without a membership model.
- **Acceptance:** org velocity distribution computes over configured teams; effective-dated membership respected.

### WP-EXPORT — export surface (size S) — **NEW**
- **Package:** `mcp-server`. **Depends-on:** WP-MCP-TOOLS.
- **Scope:** `export` MCP tool (structured CSV/JSON per metric+scope+window) + optional markdown/PDF board pack for leader personas. Carries `engine_version` + coverage flag.
- **Acceptance:** round-trips a metric bundle to CSV/JSON with provenance columns.

### WP-SPIKE-SYNCLOAD — N× sync-load sizing (size S) — **NEW**
- **Depends-on:** WP-TESTKIT-BASE.
- **Scope:** size GitHub per-installation rate pressure and Jira tenant-level throttling under **N concurrent local-first installs**; validate the §5.4 shared-ingester team-size boundary. The missing N× counterpart to WP-SPIKE-LLMCOST.
- **Acceptance:** a documented team-size threshold above which the shared ingester is required.

### WP-E2E — cross-ABI bundle boot smoke gate (size M) — **NEW, gates Wave 0 + releases**
- **Package:** root/CI. **Depends-on:** WP-TOOLING (scaffold in Wave 0, full once WP-MCP-SERVER exists).
- **Scope:** on a clean machine with no `node_modules`, build the tsup bundle, run `node server.js` with `.mcp.json` env wiring (incl. the plugin-data dir), complete the MCP handshake, open the WASM SQLite DB, construct Octokit + Anthropic clients, and assert a tool call returns schema-valid `structuredContent` — across OS/arch/Node-ABI in the CI matrix.
- **Acceptance:** green on Linux/macOS/Windows × supported Node versions; **this is the gate that makes "no install step" true** (AC#1).

---

## 2. Wave 0 — Foundations

### WP-REPO — Monorepo scaffold
- **Package:** root. **Depends-on:** —
- **Scope:** pnpm workspaces; `packages/{core,ingest-github,ingest-jira,metrics,code-analysis,ai,mcp-server,testkit}`; plugin dirs (`.claude-plugin/`, `.mcp.json`, `skills/`, `agents/`, `hooks/`); `docs/` already populated.
- **Deliverables:** workspace `package.json`, `tsconfig` base + per-package, `.gitignore`, MIT `LICENSE`, top-level `README` stub.
- **Acceptance:** `pnpm install` clean; empty packages build; `tsc -b` passes.
- **Tests:** n/a (smoke).

### WP-TOOLING — Biome, typecheck, test, build, CI
- **Package:** root. **Depends-on:** WP-REPO
- **Scope:** Biome config (format+lint); root scripts `lint`, `typecheck` (`tsc --noEmit`), `test` (Vitest), `build` (tsup for `mcp-server` → single `server/dist/server.js`); GitHub Actions running all four.
- **Deliverables:** `biome.json`, `vitest.config.ts`, `tsup.config.ts`, `.github/workflows/ci.yml`.
- **Acceptance:** all four scripts run green on the empty scaffold; CI gate fails on Biome diff / type error / test failure.
- **Tests:** a trivial passing test proves the harness.

### WP-TESTKIT-BASE — Mock + base-dataset framework (size M) — **split in v2**
- **Package:** `testkit`. **Depends-on:** WP-REPO
- **Scope:** MSW server setup with handler registries for GitHub (REST + GraphQL) and Jira (REST v3 + Agile + bulk changelog); fixture-loading utilities; a **stable synthetic base-org dataset** generator (a deterministic fabricated org: repos, PRs, reviews, commits, issues, changelog, workflows, board config, sprints). Clock + seed injectors. **No monolithic `golden-expectations.ts`** — that was a Wave-0/Wave-4 circular dependency (you can't hand-compute cognitive complexity or Flow Efficiency before the formula/oracle is pinned) and a shared-mutable-fixture collision risk across parallel worktrees. **Per-metric golden expectations are co-located with each metric WP** (per SPEC §8.6 `goldenFixtures`), authored and **frozen in the same wave the engine is built**, parameterised on the pinned decision (complexity rules, Flow State Model, DORA bands).
- **Deliverables:** `testkit` exports: `mockGitHub()`, `mockJira()`, `baseOrgDataset`, `fakeClock`, `seed`; a fixture-immutability lint (no in-place mutation of shared fixtures).
- **Acceptance:** a sample test boots MSW, hits a mocked GitHub endpoint, reads fixture data; base dataset loads. Obviously-fake identifiers (no real PII).
- **Tests:** self-tests for the mock layer.

---

## 3. Wave 1 — De-risking spikes (parallel)

### WP-SPIKE-LLMCOST — Token cost + ensemble-gate sizing
- **Depends-on:** WP-TESTKIT-BASE
- **Scope:** estimate token cost/latency of the hybrid metrics per-PR/per-ticket at `claude-sonnet-4-6`; model the cost with the **corrected denominator: distinct AI subjects × active installs × per-verdict cost** (local-first means N installs each pay unless the §5.4 shared content-addressed cache is used); validate the low-confidence ensemble gate (D8) is affordable. Output a recommendation + caching strategy parameters.
- **Deliverables:** `docs/spikes/llm-cost.md` with numbers + recommended defaults.
- **Acceptance:** decision on default model + ensemble threshold + cache TTL justified with data; shared-cache requirement above a team-size threshold stated.

### WP-SPIKE-TREESITTER — Cognitive-complexity conformance
- **Depends-on:** WP-TESTKIT-BASE
- **Scope:** prove `web-tree-sitter` (WASM) computes SonarSource cognitive complexity to spec across ≥3 languages (TS, Python, Go) using the white-paper worked examples; document divergences. Also confirm the WASM-asset resolution path (grammars loaded via `import.meta.url`, not `cwd`) used by WP-CODE-ANALYSIS.
- **Deliverables:** conformance test suite + `docs/spikes/treesitter-ccog.md`.
- **Acceptance:** parity (or documented, bounded divergence) confirmed before WP-METRICS-CODE claims Sonar-parity. **Conformance suite MUST include:** maximal-like-operator boolean sequences (`a&&b||c`=+2), single-+1-per-`switch`, direct **and** indirect recursion, and per-language node-type maps (Go has no ternary; Python `a if c else b` differs).

### WP-SPIKE-IDENTITY — Identity-stitching accuracy
- **Depends-on:** WP-TESTKIT-BASE
- **Scope:** evaluate the deterministic→fuzzy match ladder on a realistic corpus (noreply emails, shared bots, pairing on one account, squash-merge author loss); quantify precision/recall; tune thresholds + the human-confirm queue policy.
- **Deliverables:** `docs/spikes/identity-eval.md` with match-rate numbers + tuned thresholds.
- **Acceptance:** thresholds set with evidence before per-person metrics ship.

### WP-LEGAL — DPIA / legitimate-interest counsel review (flag, non-engineering)
- **Scope:** route the DPIA template + legitimate-interest content (from WP-GDPR-SCAFFOLD) through qualified data-protection counsel before any EU/UK deployment claim.
- **Acceptance:** counsel sign-off recorded. **Owner: human, not an agent.**

---

## 4. Wave 2 — Data core

### WP-DB-SCHEMA — Full DDL (system-of-record + derived)
- **Package:** `core`. **Depends-on:** WP-TOOLING
- **Scope:** author the complete schema from SPEC §6 (all Layer-1 + Layer-2 tables, including `issue_transitions`, `sprint_issues`, `pr_issue_links`, `metric_snapshots`, `ai_verdicts`, `flow_state_models`, `persons`/`identities`). SQL-portable (TEXT-for-JSON, dialect shim).
- **Deliverables:** `core/sql/schema.sql` + typed row models.
- **Acceptance:** schema applies to a fresh SQLite DB; raw columns present; PII columns hashed-by-design.
- **Tests:** schema-apply test; round-trip insert/select per table.

### WP-STORE — `Store` interface + `SqliteStore`
- **Package:** `core`. **Depends-on:** WP-DB-SCHEMA
- **Scope:** `Store` interface (all reads/writes used by ingestion + engines); `SqliteStore` impl on **WASM SQLite** (`@sqlite.org/sqlite-wasm`, or `node:sqlite` on Node ≥22 — **not** `better-sqlite3`, which is an un-bundleable native addon, see SPEC D5/§12.3) with parameterized statements only, WAL + `busy_timeout`, sync on a worker thread; upsert helpers (last-writer-wins gated by `updated_at`, field-level-merge tie-breaks); soft-delete (`deleted_at`) support for tombstoning.
- **Deliverables:** `core/store/{Store.ts, SqliteStore.ts}`.
- **Acceptance:** idempotent upsert proven; soft-delete excluded from reads; bundles into `server.js` with no native build (verified by WP-E2E); interface is the only seam the shared-ingester/Postgres path touches.
- **Tests:** upsert idempotency, out-of-order convergence, query correctness against fixtures.

### WP-MIGRATIONS — Migration runner
- **Package:** `core`. **Depends-on:** WP-DB-SCHEMA
- **Scope:** in-DB `schema_version` table; up/down SQL runner; forward-only-in-prod guard; dialect shim hook.
- **Deliverables:** `core/migrate/*`, first migration = full schema.
- **Acceptance:** migrate up/down on SQLite clean; version table tracks state.
- **Tests:** up→down→up round-trip.

### WP-IDENTITY — Identity stitching
- **Package:** `core`. **Depends-on:** WP-STORE, WP-SPIKE-IDENTITY
- **Scope:** the **v2 tightened** match ladder — **auto-merge ONLY on verified full-email / GitHub-verified email↔login**; the 0.8 local-part+name tier is **demoted to the human-confirm queue** (never auto), with a per-org domain allowlist + split-detector; fuzzy 0.5 queued. Schema-level `is_bot` (GitHub `type==Bot`/`[bot]`/App) with default exclusion. Persons anchored on **stable account ids** (GitHub user id, Jira accountId), email as an attribute. Reversible `person_id`; merge audit; `commit_authors` + `Co-authored-by`/`Signed-off-by` trailer parsing (prefer pre-squash PR commits).
- **Deliverables:** `core/identity/*`.
- **Acceptance:** match rates meet WP-SPIKE-IDENTITY thresholds; `john.smith@acme` vs `@vendor` do NOT auto-merge; bots excluded from persons/aggregates; co-authored squash work attributes all authors; unmerge non-destructive.
- **Tests:** golden identity corpus (incl. distinct-humans-same-name, one-human-many-emails, shared bot, pair-on-one-account) → expected clusters; unmerge round-trip.

---

## 5. Wave 3 — Ingestion

### WP-GH-CLIENT — GitHub REST+GraphQL client
- **Package:** `ingest-github`. **Depends-on:** WP-STORE
- **Scope:** octokit wrapper; App + PAT auth; REST for bulk discovery, GraphQL to hydrate the per-PR graph (reviews+comments+timeline+commits) with **per-connection cursor pagination (`first:100`+`after`) to exhaustion** and a node-cost budget — a >1k-comment PR otherwise hits the 500k-node ceiling or silently caps at the first page; detect partial-data GraphQL errors. Rate-limit accounting (`rateLimit{cost,remaining}`, secondary-limit backoff); records per-credential **access scope** for the coverage fingerprint (SPEC §5.3).
- **Deliverables:** typed client + raw-payload capture (incl. `raw` on reviews/check_runs).
- **Acceptance:** against MSW fixtures, fetches commits/PRs/reviews/deployments/releases/check-runs; respects rate-limit headers; **a >1k-comment large-PR fixture paginates fully (no silent cap)**.
- **Tests:** MSW-driven; inner-connection pagination + backoff; large-PR fixture.

### WP-GH-SYNC — GitHub 3-phase sync
- **Package:** `ingest-github`. **Depends-on:** WP-GH-CLIENT, WP-IDENTITY
- **Scope:** backfill (resumable mid-page cursor checkpoints in `sync_state`) → polling reconciliation → optional webhook trigger handler (dedupe on `X-GitHub-Delivery`); upsert into store with denormalized PR stage timestamps; deploy-signal priority chain (D9). **Tombstoning (v2):** periodic full-enumeration of the authoritative set per resource → soft-delete absent rows; force-push handled via PR before/after SHA. Repo rename/transfer tracked via `node_id` (404-on-known-node_id ⇒ re-resolve). WP-SCRUB runs before persistence. Forks excluded from human-work aggregates by default.
- **Deliverables:** `syncGitHub(scope, mode)`.
- **Acceptance:** full backfill then incremental against fixtures is idempotent; **a deleted PR / force-pushed commit is tombstoned and drops out of metrics**; PR stage timestamps populated; deploy source recorded.
- **Tests:** backfill + re-run = no dupes; out-of-order webhook+poll convergence; deletion/force-push tombstoning; rename re-resolution; stage-timestamp correctness.

### WP-JIRA-CLIENT — Jira Cloud client
- **Package:** `ingest-jira`. **Depends-on:** WP-STORE
- **Scope:** OAuth 3LO (read-only scopes) + API-token fallback; `/search/jql` cursor; Agile API (boards/sprints/sprint reports); dynamic story-point field discovery; rate-limit handling.
- **Deliverables:** typed client + raw capture.
- **Acceptance:** fetches issues, sprints, boards, status config against MSW fixtures.
- **Tests:** MSW-driven incl. pagination + field discovery.

### WP-JIRA-CHANGELOG — Changelog parser (keystone, C1)
- **Package:** `ingest-jira`. **Depends-on:** WP-JIRA-CLIENT
- **Scope:** **bulk** changelog fetch **paginated to exhaustion** (follow `nextPageToken`/`startAt`, assert `fetched == reported total` — the bulk endpoint is *itself* paginated, so switching off inline `expand=changelog` only relocates truncation otherwise: this is C1 trap 4); **seed initial status** from `fields.created` + first transition `from`; **sort histories by `created`**; map status→category via separate `/status` fetch keyed on **numeric IDs**, snapshotted effective-dated into `status_category_history`; reconstruct `issue_keys` history (project moves); build append-only sorted `issue_transitions` with `project_id_at_transition`.
- **Deliverables:** `parseChangelog()` → transitions; status/category resolver; key-history reconstructor.
- **Acceptance:** on the golden Jira fixture (re-entries, renamed statuses, missing initial, **>1-page / 250-transition changelog**, project move), produces exactly the expected transition timeline. Correctness moat — test hard.
- **Tests:** golden changelog → expected transitions; **all four** C1 traps each have a dedicated failing-without-fix test (incl. the multi-page exhaustion trap).

### WP-SYNC-ORCH — Sync orchestrator + freshness
- **Package:** `core`. **Depends-on:** WP-GH-SYNC, WP-JIRA-CHANGELOG
- **Scope:** schedule/trigger both sources; maintain `sync_state` watermarks; expose sync-freshness/watermark-lag; resumable on crash.
- **Deliverables:** `runSync()`, `syncStatus()`.
- **Acceptance:** orchestrates a full + incremental cycle; freshness reported per resource.
- **Tests:** crash-resume; freshness computation.

### WP-LINKING — GitHub↔Jira issue linking
- **Package:** `core`. **Depends-on:** WP-GH-SYNC, WP-JIRA-CHANGELOG
- **Scope:** populate `pr_issue_links` via regex (issue keys), smart-commit, branch-name; record `link_source` + confidence; expose linkage rate (input to LLM-fallback linking later).
- **Deliverables:** `linkIssues()`.
- **Acceptance:** correct links on golden dataset; linkage-rate metric available.
- **Tests:** key/branch/smart-commit extraction; false-positive guards.

---

## 6. Wave 4 — Deterministic engines (parallel)

> Shared contract (from SPEC §8.6): each metric module exports `id, trustTier, scope, formulaDoc, params, compute(), goldenFixtures`. Pure functions, injected clock/seed, pinned percentile method + sample floors, zero-denominator→null, `engine_version`, no LLM. **Every metric MUST assert against its co-located golden fixtures, including the degenerate-input + edge cases in the DoD.**

### WP-METRICS-DORA — Group A (size M)
- **Package:** `metrics`. **Depends-on:** WP-SYNC-ORCH, WP-LINKING, **WP-JIRA-CHANGELOG** (Recovery Time uses the first-Done transition)
- **Scope:** Deployment Frequency (+DORA bands), Lead Time (compare-API commit-set enumeration + `first_commit_at` anchor + squash/rebase flag, per §8.6), Change Failure Rate (det. denom, `null` on 0 deploys; LLM linkage fallback in Wave 5), Failed-Deployment Recovery Time (first-resolve anchor + reopen-rate counter-metric), Deployment Rework Rate, Reliability proxy (caveated).
- **Acceptance:** exact match vs golden incl. **zero-deploy/zero-incident → null (not NaN)**, **reopened-incident MTTR (first vs last)**, multi-PR deploy, squash/rebase reset; bands pinned to configured benchmark (D10).
- **Tests:** golden per metric; degenerate-input + reopen + squash fixtures.

### WP-METRICS-FLOW — Group B (size L, long-pole)
- **Package:** `metrics`. **Depends-on:** **WP-FLOWSTATE-MODEL, WP-JIRA-WORKFLOW, WP-JIRA-BOARDCONFIG**, WP-JIRA-CHANGELOG, WP-METRICS-DORA(shared utils) *(v2: the first three were the missing backward edges)*
- **Scope:** Flow Time/Cycle Time (start = first *started*-column entry per board), Flow Efficiency (**pinned per-issue estimator + distribution**, fuse GitHub code-phase + effective-dated Flow State Model C3), Flow Load/WIP (Little's-Law as stationarity-guarded sanity-check only), Throughput (first-Done dedup), Flow Distribution (det. prior; LLM classify in Wave 5), CFD (replay with classification in effect at each interval), Aging WIP, Time-in-Status, Monte Carlo forecast (vendored seeded PRNG + canonical order).
- **Acceptance:** exact match vs golden incl. re-entry accumulation, implicit-wait detection, **queue-vs-started column**, zombie-ticket (per-issue ≠ pooled), admin-recategorization/DST/week-boundary; forecast reproducible per engine-version+seed.
- **Tests:** golden timelines; flow-state-model variants (same status active vs wait); board-column start variants.

### WP-METRICS-PR — Group C
- **Package:** `metrics`. **Depends-on:** WP-GH-SYNC
- **Scope:** 4-phase PR cycle time; review-latency decomposition; time-to-first-review; time-to-merge; PR size (HALOC); review coverage; reviewers/PR; reviewer load (Gini, anonymized); comments/PR; review iterations; merge-without-review; stale PR; CI/check-run health.
- **Acceptance:** exact match vs golden; business-hours toggle plumbed (default off, R6).
- **Tests:** golden PR fixtures incl. multi-round reviews, bot filtering.

### WP-CODE-ANALYSIS — tree-sitter + blame engine
- **Package:** `code-analysis`. **Depends-on:** WP-GH-SYNC, WP-SPIKE-TREESITTER
- **Scope:** `web-tree-sitter` (WASM grammars) on base/head SHA → cyclomatic + cognitive (SonarSource 3-rule) complexity + per-function deltas, nesting, lengths, param counts; `git blame` for line-age; HALOC (C2) hunk computation.
- **Acceptance:** complexity matches WP-SPIKE-TREESITTER conformance; HALOC kills modify double-count; no native build (WASM only).
- **Tests:** conformance suite; HALOC edge cases (pure-delete, pure-add, modify).

### WP-METRICS-CODE — Group D
- **Package:** `metrics`. **Depends-on:** WP-CODE-ANALYSIS
- **Scope:** work-type split (New/Legacy-Refactor/Help-Others/Rework via blame age + author vs window D7); Rework/Churn % + Efficiency; Nagappan-Ball M1/M2/M3; complexity deltas surfaced; Maintainability Index (trend); deterministic Impact blend (edit-locations, HALOC, files, change-entropy, old-code%) — rationale string added in Wave 5.
- **Acceptance:** exact match vs golden; all flagged descriptive-only; no raw-LOC-as-productivity anywhere.
- **Tests:** golden blame fixtures; churn-window boundary tests.

### WP-METRICS-AGILE — Group E
- **Package:** `metrics`. **Depends-on:** WP-JIRA-CLIENT, WP-JIRA-CHANGELOG
- **Scope:** Sprint Velocity (committed snapshot at start via Sprint-field changelog vs completed); Say/Do; Sprint Predictability (CV); Estimation Accuracy (bias + Spearman).
- **Acceptance:** exact match vs golden incl. mid-sprint scope-add handling (`added_after_start`).
- **Tests:** golden sprint fixtures.

### WP-SNAPSHOTS — Versioned snapshot writer + on-the-fly compute (size M)
- **Package:** `metrics`. **Depends-on:** all WP-METRICS-*, WP-ROLLUP
- **Scope:** **versioned (not immutable)** daily `metric_snapshots` keyed on `(scope, metric, day, watermark_version)` carrying `engine_version`, `ingest_watermark_version`, `coverage_fingerprint`; on-demand recompute for arbitrary ranges; a window-closing/grace-period rule. Hands stale-marking to WP-REDERIVE on reconciliation.
- **Acceptance:** **recompute of a CLOSED window (stable watermark) equals the snapshot** (v2 — the v1 "snapshot==recompute always" was impossible under late-arriving reconciliation); a late event for a closed day marks it stale and the two surfaces reconverge; person-scope rows only under the §11.1 gate.
- **Tests:** closed-window equivalence; late-arrival stale-and-recompute; visibility gating.

---

## 7. Wave 5 — AI engine

### WP-AI-HARNESS — Claude client + prompt registry + audit
- **Package:** `ai`. **Depends-on:** WP-SNAPSHOTS, WP-SPIKE-LLMCOST
- **Scope:** `@anthropic-ai/sdk`; constrained decoding (structured outputs; **bounded values enum-encoded**, ranges client-validated); **per-model request-shape adapter (no `temperature`/`top_p`/`top_k` to `claude-opus-*` — they 400)** + a harness test asserting it + a model-deprecation runbook; versioned prompt registry; feature-pack builders; `ai_verdicts` audit writer (incl. `model_snapshot`, `request_shape`); verdict cache (subject+content-hash+prompt_version+model), content-addressed for the shared path; **ensemble gated on a deterministic low-confidence proxy until confidence is shown calibrated** (D8); `correct_verdict` write path; refusal/cutoff handling.
- **Acceptance:** **shape + enum valid by construction** (ranges via enums + client-side validation); no sampling param ever sent to an Opus id; full audit persisted; cache prevents re-run on unchanged content.
- **Tests:** schema/enum-validity (mocked Anthropic), no-sampling-param-to-Opus, cache hit/miss, ensemble-gate trigger.

### WP-AI-ALIGNMENT — Ticket-Work Alignment (SPEC §9.2.1)
- **Depends-on:** WP-AI-HARNESS, WP-LINKING
- **Scope:** parse acceptance criteria; relevance-rank diff hunks (no silent truncation); pointwise per-criterion coverage with **mandatory diff-quote evidence + a deterministic relevance guard** (the quoted hunk must come from a file/symbol the criterion plausibly touches — quote *existence* alone allowed false positives in v1); ordinal as `enum[0..4]`; coverage_ratio derived in code; min-rule final.
- **Acceptance:** schema/enum-valid; "covered" requires a *relevant* quote (an irrelevant logging-line quote is rejected); vague criteria → low confidence, not a guess. κ target = **0.6 OR the documented human-human ceiling, whichever is lower**.
- **Tests:** golden tickets/PRs with known alignment; **irrelevant-but-real-quote negative test**; out-of-range-ordinal rejection.

### WP-AI-EFFORT — Effort Proportionality (§9.2.2)
- **Depends-on:** WP-AI-HARNESS
- **Scope:** effort vector; **baseline-readiness gate** (below a minimum N of closed items in a window → "insufficient history", not a judgment — mirrors WP-AI-ANOMALY's sample gate); ordinal band + log-ratio (never raw points); cross-check vs cycle-time z-score; exempt spike/research types.
- **Acceptance:** ordinal output only; **cold-start install returns "insufficient history", not "much higher than expected"**; disagreement lowers confidence; never per-developer-evaluative.
- **Tests:** golden effort cases; **cold-start (n=3) → insufficient-history**; spike-exemption; z-score disagreement path.

### WP-AI-ANOMALY — Velocity Anomaly Explanation (§9.2.3)
- **Depends-on:** WP-AI-HARNESS, WP-METRICS-FLOW
- **Scope:** deterministic EWMA/control-chart detection (|z|>2, min sample); signal pack; **closed-menu** cause ranking with mandatory evidence pointers; "insufficient signal" allowed; "consistent with" phrasing; systemic-only attribution.
- **Acceptance:** no free-form attribution; every cause has an evidence pointer; never names individuals.
- **Tests:** golden anomaly series; closed-menu enforcement; small-sample suppression.

### WP-AI-CLASSIFY — Work-type classification (§9.2.5)
- **Depends-on:** WP-AI-HARNESS, WP-METRICS-CODE
- **Scope:** conventional-commit/path prior + LLM on diff for Flow Distribution + investment balance; blame fallback when unlinked.
- **Acceptance:** **macro-F1 ≥ 0.7** vs gold set (pinned, v2); deterministic prior applied first.
- **Tests:** golden classification set.

### WP-AI-PRQUALITY — PR Quality Score (§9.2.6)
- **Depends-on:** WP-AI-HARNESS, WP-METRICS-PR
- **Scope:** deterministic checks (desc/linked-issue/tests/atomicity) + LLM (why/matches-diff/risk) 0–2 each with quoted evidence; rubric about substance not eloquence.
- **Acceptance:** schema-valid + evidence-cited; no prose-length bias.
- **Tests:** golden PRs; eloquence-bias negative test.

### WP-AI-IMPACT — Explainable Impact rationale (§9.2.7)
- **Depends-on:** WP-AI-HARNESS, WP-METRICS-CODE
- **Scope:** attach LLM rationale string to the deterministic Impact blend; factors/weights visible + configurable.
- **Acceptance:** rationale references actual changed paths; weights surfaced.
- **Tests:** golden change-sets.

### WP-AI-CALIBRATION — Calibration harness
- **Package:** `ai`. **Depends-on:** all WP-AI-*
- **Scope:** per-team gold-set ingestion (**incl. `correct_verdict` corrections as gold labels**); report κ / macro-F1 / Spearman **and report human-human agreement first** (the κ≥0.6 gate is min(0.6, human ceiling)); **confidence-calibration (reliability/ECE) sequenced BEFORE the D8 ensemble is enabled** — until then the ensemble gates on the deterministic proxy (WP-AI-HARNESS); rubric-iteration loop. **Gold-set annotation protocol** (who labels, item count, inter-rater target) documented.
- **Acceptance:** harness reports the agreement stats + human-human ceiling; corrections re-feed κ; confidence shown calibrated before ensemble enablement; annotation protocol documented.
- **Tests:** harness on a fixture gold set with known κ; correction-ingestion path; ECE computation.

---

## 8. Wave 6 — MCP surface & plugin

### WP-MCP-SERVER — Server bootstrap
- **Package:** `mcp-server`. **Depends-on:** WP-SNAPSHOTS, WP-AI-HARNESS
- **Scope:** `@modelcontextprotocol/sdk` stdio server; config/secret loading from env (§14); tsup bundle → single `server/dist/server.js`; `doctor` self-check.
- **Acceptance:** boots from `node server.js` with no install/build on the host; reads keychain-provided secrets via env.
- **Tests:** boot + handshake; config resolution precedence.

### WP-MCP-TOOLS — Tools with outputSchema
- **Package:** `mcp-server`. **Depends-on:** WP-MCP-SERVER, all engines
- **Scope:** `sync_status`, `run_sync`, `get_dora|get_flow|get_pr_metrics|get_code_metrics|get_agile_metrics`, `explain_metric`, `ticket_work_alignment`, `effort_proportionality`, `explain_anomaly`, `pr_quality`. Every output carries `trust_tier`, `as_of`, `data_quality`, `formula_doc` via `outputSchema`+`structuredContent`.
- **Acceptance:** outputs schema-valid & machine-checkable; stale/mis-tiered values impossible to present as fact.
- **Tests:** schema conformance per tool; trust-tier presence.

### WP-MCP-RESOURCES — Dashboards as resources
- **Package:** `mcp-server`. **Depends-on:** WP-MCP-SERVER
- **Scope:** `list_dashboards`/`get_dashboard`; `lazy-flow://dashboard/<id>` resources for @-mention; dashboard persistence.
- **Acceptance:** resources resolvable & @-mentionable.
- **Tests:** resource read; persistence round-trip.

### WP-PLUGIN — Plugin manifest + distribution
- **Package:** root plugin dirs. **Depends-on:** WP-MCP-SERVER
- **Scope:** `.claude-plugin/plugin.json` (name/displayName, `userConfig` with sensitive secrets + shared config, mcpServers→`.mcp.json`); `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` wiring; `marketplace.json`; sample consuming-repo `.claude/settings.json`.
- **Acceptance:** team-wide install flow (SPEC §12.4) works end-to-end against a local marketplace; secrets land in keychain; DB under `${CLAUDE_PLUGIN_DATA}`.
- **Tests:** manifest schema validation; install dry-run.

### WP-SKILLS — Slash commands
- **Package:** `skills/`. **Depends-on:** WP-MCP-TOOLS
- **Scope:** SKILL.md per command (SPEC §13.3): `sync, dora, flow, pr, code, agile, forecast, me, team, org, explain, anomaly, align, config, identities`.
- **Acceptance:** each skill calls the right tool(s) and renders structured output with trust badges.
- **Tests:** skill-to-tool mapping smoke.

### WP-SUBAGENT — `flow-analyst`
- **Package:** `agents/`. **Depends-on:** WP-MCP-TOOLS
- **Scope:** narrating subagent (model `claude-opus-4-8`) that summarises/contextualises **only tool outputs**, never computes; systemic (never individual) recommendations.
- **Acceptance:** never emits a number not present in a tool output; no individual ranking.
- **Tests:** prompt-contract review (adversarial).

---

## 9. Wave 7 — Cross-cutting

### WP-TRANSPARENCY — Trust badges + "how computed"
- **Depends-on:** WP-MCP-TOOLS. **Scope:** surface `trust_tier` + `formulaDoc` + engine-version pin on every metric output and skill render. **Acceptance:** every metric is explainable in-session. **Tests:** presence assertions.

### WP-ANTIGAMING — Gaming detection + data-quality flags
- **Depends-on:** all engines. **Scope:** deploy-freq inflation, CFR suppression, lead-time resets, status-juggling, trivial-PR-splitting; emit data-quality/confidence per metric; balanced-view default (no single composite); Goodhart warning on goal-pinning. **Acceptance:** each gaming pattern flagged on a crafted fixture. **Tests:** one fixture per pattern.

### WP-VISIBILITY — Visibility policy (presentation switch)
- **Depends-on:** WP-SNAPSHOTS, WP-MCP-TOOLS. **Scope:** `visibility: public|team|self` (default **`public`**, open-by-design per §11.1 — the data is already org-accessible, so this is a *presentation* switch, not a security control). `team`/`self` shape what the tools surface and whether person snapshots persist. No stack-rank/forced-curve UI shipped by default (editorial). **No LIA-acknowledgement write-gate** (gating already-accessible derived data adds friction for no protection). **Acceptance:** `public` surfaces per-person metrics; `team`/`self` correctly hide/scope person data; switch is respected at tool-read and snapshot-write. **Tests:** policy matrix across the three modes.

### WP-GDPR-SCAFFOLD — adopter helpers + erasure + at-rest hardening
- **Depends-on:** WP-STORE. **Scope:** DPIA template, legitimate-interest-assessment generator, transparency-notice generator (**optional adopter documentation helpers, not gates** — for forks in stricter jurisdictions); at-rest DB encryption (SQLCipher/OS) + keychain-resident key; **keyed-HMAC pseudonymisation where pseudonymisation is wanted (a plain reversible email hash is NOT a privacy control)**; subject-erasure (`person_id` cascade); `org_id`-bound DB (hard-error on cross-org config); retention config. **Feeds WP-LEGAL.** **Acceptance:** generators produce documents; erasure removes a person's data; DB encrypted at rest; cross-org config hard-errors. **Tests:** erasure completeness; encryption; cross-org rejection.

### WP-DOCTOR — Health/diagnostics tool
- **Depends-on:** WP-MCP-SERVER. **Scope:** checks auth validity + **Jira OAuth refresh-token state / re-consent on `invalid_grant`**, rate-limit headroom, sync freshness/watermark-lag, DB integrity + size, **Node-presence/version/ABI preflight**, config sanity. **Acceptance:** reports actionable status. **Tests:** each check on healthy + broken fixtures.

---

## 10. Wave 8 — Polish & ship

- **WP-SURVEY (optional, D6):** open, published-formula survey module for the perceptual half of DevEx/SPACE; never labelled "DXI" unless survey-sourced. *Lowest priority; clearly separated.*
- **WP-DOCS:** README, install guide, formula reference (generated from `formulaDoc`), CONTRIBUTING, security policy, the "how we count" engine-pinning doc.
- **WP-PERF:** backfill/incremental/dashboard perf budgets (SPEC §15); profile + tune; document budgets.
- **WP-RELEASE:** versioning, changelog, marketplace publish, license/third-party audit (tree-sitter grammars etc.), first tagged release.

---

## 11. Definition of Done (every coding work item)

1. Biome clean · `tsc --noEmit` clean · Vitest green (incl. golden assertions where applicable).
2. Behaviour-level tests against MSW mocks / the base-org dataset — not implementation tests. **Degenerate-input + edge-case fixtures required** where applicable: zero-denominator/empty-window per ratio; reopened-incident MTTR; subtask-dedup + scope-removal + dual-story-point-field; >1-page (250-transition) changelog; >1k-comment PR; binary/generated/rename/whitespace HALOC; queue-vs-started board columns; admin-recategorization/DST/week-boundary; tied/tiny/non-stationary samples; secret/email scrubbing.
3. Public exported functions have explicit return types; no unjustified `any`. **No `Date.now()`/`Math.random()` in metric paths** (lint-enforced).
4. Deterministic metric items match their **co-located** per-metric golden fixtures exactly (no shared monolith); AI items are schema/enum-valid + relevance-checked evidence-cited + audited with correct per-model request shape.
5. Trust tier + formulaDoc + `engine_version` present where the item produces a metric.
6. Adversarial review confirms scope against a short scope-only rubric: (a) only the named deliverables touched; (b) out-of-scope issues filed as notes, not fixed; (c) acceptance criteria demonstrably met. *(This is an orchestration-time process gate, like WP-LEGAL — not a product feature.)*
7. Boy-Scout: touched files left cleaner.

---

## 12. Reference fan-out orchestration (sketch)

```
Wave 0 → sequential (scaffold must exist first); WP-E2E smoke gate wired here
Waves 1,3,4,5,6 → parallel within wave, worktree-isolated per `package`
Per item: pipeline(build → [biome, typecheck, vitest] → adversarial-review)
Gate each wave on all items' DoD before starting the next.
Per-item `Depends-on` edges are the single source of truth (a spike may legitimately gate a Wave-2 item, e.g. WP-IDENTITY ← WP-SPIKE-IDENTITY).
Start long-poles first (size L): WP-CODE-ANALYSIS, WP-JIRA-CHANGELOG, WP-METRICS-FLOW, WP-FLOWSTATE-MODEL, WP-AI-HARNESS.
```

> When ready to build, hand this file to a workflow that maps each WP-* to a coding sub-agent, fans out by wave, and verifies against the DoD. Build only after the spec + this plan are approved.
