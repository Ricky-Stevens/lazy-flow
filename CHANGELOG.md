# Changelog

All notable changes to lazy-flow are documented here. Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [0.1.0] — 2026-06-07

Initial build of lazy-flow: an open-source, self-hostable software-delivery intelligence platform sourced from GitHub + Jira, shipped as a Claude Code plugin. Spec-driven against [`docs/SPEC.md`](docs/SPEC.md) v2.1 (post-adversarial-review). 10 packages, 732 tests.

### Added — Foundation & data
- `@lazy-flow/core` — §8.6 determinism primitives (type-7 percentile, `safeRatio`→null, seeded PRNG, sample floors), 30-table SQLite schema, `NodeSqliteStore` over `node:sqlite` (no native deps), migration runner, identity stitching (verified-only auto-merge, bot exclusion, co-author trailers), GitHub↔Jira linking, per-workflow flow-state model, ingest-time secret scrubbing, GDPR scaffold (keyed-HMAC pseudonymization, subject erasure, org-bound DB, retention, DPIA/LIA/notice generators).
- `@lazy-flow/testkit` — MSW GitHub (REST+GraphQL) and Jira (v3 + bulk changelog + agile + board config) mocks over a deep-frozen synthetic org.

### Added — Ingestion
- `@lazy-flow/ingest-github` — octokit REST+GraphQL client (inner-connection pagination), 3-phase sync with tombstoning, deploy-signal priority chain.
- `@lazy-flow/ingest-jira` — Jira Cloud client, the C1 changelog parser (all four traps incl. pagination-to-exhaustion), workflow + board-config discovery.
- `@lazy-flow/orchestrator` — `runSync` (ingest → identities → linking) + freshness/`syncStatus`.

### Added — Analysis
- `@lazy-flow/code-analysis` — `web-tree-sitter` cyclomatic + SonarSource cognitive complexity (TS/JS/Python/Go), HALOC over normalized diff, blame-based work-type.
- `@lazy-flow/metrics` — DORA, Flow, PR/Review, Code, and Agile engines (39 metrics, each with a published `formulaDoc`); versioned snapshots, team/org rollup, engine-version re-derivation; visibility policy; anti-gaming detection.

### Added — AI
- `@lazy-flow/ai` — Claude harness (per-model request-shape adapter, enum-bounded structured outputs, `ai_verdicts` audit, verdict cache, deterministic-proxy ensemble gate, `correctVerdict`); six insights (ticket-work alignment, effort proportionality, velocity-anomaly explanation, work classification, PR quality, explainable impact); calibration harness (Cohen's κ / macro-F1 / Spearman / ECE, human-ceiling gate).

### Added — Surface & distribution
- `@lazy-flow/mcp-server` — 15 MCP tools (+ dashboard resources) with `outputSchema`/`structuredContent` carrying trust tier, `as_of`, `engine_version`, and data-quality/coverage; single-file bundled `server.js` (`node:sqlite` + bundled WASM tree-sitter grammars, no native build), validated by stdio boot e2e tests.
- Claude Code plugin — manifest, `.mcp.json`, 16 skills, `flow-analyst` narrating subagent, marketplace, team-wide install flow.

### Added — Survey & docs
- `@lazy-flow/survey` — optional, open, published-formula perceptual surveys (DevEx feedback/cognitive-load/flow, SPACE satisfaction); survey-sourced only, never derived from system data; minimum-N suppression.
- Docs: `FORMULAS.md` (generated, drift-guarded), `ARCHITECTURE.md`, `PERFORMANCE.md`, `CONTRIBUTING.md`, `SECURITY.md`, plus the research + adversarial-review record.

### Decisions of note
- **Local-first, per-user** SQLite (D1); **`public`/open-by-design** visibility default (D2 — presentation switch, not access control, since data is already org-accessible); **Claude** hardcoded with `claude-sonnet-4-6` default + `claude-opus-4-8` ensemble (D3/D8); **`node:sqlite`** + WASM tree-sitter so the bundle has no native dependencies (D5/D12).

### Known follow-ups (out-of-band — need real keys/corpus/counsel, not code)
- `WP-SPIKE-LLMCOST` (token-cost sizing), `WP-SPIKE-IDENTITY` (match-rate eval on a real corpus), `WP-SPIKE-SYNCLOAD` (N× rate-limit sizing): code hooks exist; measurements pending.
- `WP-LEGAL`: DPIA/legitimate-interest content needs qualified data-protection counsel before any EU/UK deployment claim.
- Flow-state model LLM-seed pass (deterministic seed + human-confirm shipped; LLM-assisted seeding deferred).
