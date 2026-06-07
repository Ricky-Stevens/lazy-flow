# lazy-flow — Architecture overview

> Companion to [SPEC.md](./SPEC.md) §5 (system architecture) and §8 (metric engine).
> Read the SPEC for requirements; read this file for the code structure that implements them.

---

## Package graph

```
@lazy-flow/testkit        (dev only — fixtures, MSW mocks, synthetic dataset)
         │
         ▼
@lazy-flow/core           (domain types, Store interface, NodeSqliteStore, migrations,
         │                 identity stitching, flow-state model, scrub, GDPR scaffolding)
         │
    ┌────┴─────────────────────────────────────────────┐
    │                                                  │
@lazy-flow/ingest-github             @lazy-flow/ingest-jira
(octokit REST+GraphQL, 3-phase sync)  (Jira REST v3 + Agile + bulk changelog)
    │                                                  │
    └──────────────┬───────────────────────────────────┘
                   │
         @lazy-flow/orchestrator
         (sync orchestrator, freshness, issue linking)
                   │
         ┌─────────┴─────────────────────┐
         │                               │
@lazy-flow/code-analysis        @lazy-flow/metrics
(tree-sitter HALOC, complexity,  (Groups A–E deterministic engine,
 blame / work-type)               formulaDocs, golden tests, perf benchmarks)
         │                               │
         └─────────┬─────────────────────┘
                   │
            @lazy-flow/ai
            (Claude client, prompt registry,
             structured outputs, ai_verdicts, calibration)
                   │
         @lazy-flow/mcp-server
         (MCP stdio server, tools, resources,
          tsup bundle → server/dist/server.js)
```

**Dependency direction:** arrows point from consumer to provider. No package may
introduce a cycle. `testkit` is a dev-only dependency; it is never imported by
production code.

---

## Data flow

```
GitHub API          Jira Cloud API
     │                    │
     ▼                    ▼
 ingest-github       ingest-jira
 (3-phase sync:       (bulk changelog,
  backfill →          workflow discovery,
  polling →           board config,
  webhook)            sprint ingestion)
     │                    │
     └────────┬───────────┘
              │  WP-SCRUB (ingest-time scrubbing runs here — before persistence)
              ▼
         @lazy-flow/core
         NodeSqliteStore (node:sqlite, WAL mode, 0600 perms)
         ┌──────────────────────────────────────────────────────┐
         │  Layer 1 (raw):  commits, pull_requests, reviews,    │
         │                  deployments, issues, transitions,    │
         │                  sprints, board_configs, workflows,   │
         │                  flow_state_models, persons,          │
         │                  identities, sync_state              │
         │  Layer 2 (derived): metric_snapshots, ai_verdicts    │
         └──────────────────────────────────────────────────────┘
              │
     ┌────────┴─────────────────────┐
     │                              │
     ▼                              ▼
metrics engine                code-analysis
(pure functions,               (tree-sitter HALOC,
 injected clock,               complexity deltas,
 no I/O)                       blame/work-type)
     │                              │
     └────────┬─────────────────────┘
              │
              ▼
          AI engine (Wave 5)
          Claude structured outputs, enum-bounded,
          ai_verdicts audit table, verdict cache
              │
              ▼
         mcp-server
         MCP tools + resources exposed to Claude Code
         (outputSchema + structuredContent on every tool)
              │
              ▼
         Claude Code plugin
         /lazy-flow:* skills + flow-analyst subagent
```

---

## Key architectural decisions

These correspond to the product decisions in SPEC §4. Only the ones with the biggest
architectural impact are listed here; the full rationale lives in the SPEC.

### D1 — Local-first, per-user embedded SQLite

Each install computes from the *shared* GitHub/Jira source of truth, so every install
in the same org sees the same data. The database lives under `${CLAUDE_PLUGIN_DATA}` —
a per-user application-data directory managed by the Claude Code plugin host.

The `Store` interface (`packages/core/src/store/Store.ts`) is the only seam between the
data layer and everything above it. A shared-ingester Postgres backend can be plugged in
by implementing `Store` without touching any metric or MCP code.

### D3 — Claude (Anthropic) hardcoded

`@anthropic-ai/sdk` with `claude-sonnet-4-6` for high-volume hybrid metrics and
`claude-opus-4-8` for the low-confidence ensemble gate. Temperature and sampling params
are **never sent to Opus models** (they return 400) — the AI harness has a per-model
request-shape adapter that enforces this. See SPEC §9.1 and WP-AI-HARNESS.

### D5 — `node:sqlite` (built-in, no native addon)

`better-sqlite3` is a native node-gyp addon that breaks on ABI mismatches and cannot
be inlined into a single bundle. `node:sqlite` (available from Node ≥ 22) is ABI-free
and bundleable. The tradeoff is no transparent SQLCipher; this is documented explicitly
in `SECURITY.md`. See SPEC §5.4.

### D12 — Single-file bundle, no install step

`packages/mcp-server/` is compiled by tsup to `server/dist/server.js`. Users run
`node server.js` with no `npm install` or build step on their machine. WASM assets
(tree-sitter grammars) are co-located in `server/dist/grammars/` and resolved via
`import.meta.url`, never `cwd`. The WP-E2E cross-ABI smoke test gates every release.

---

## The metric engine (SPEC §8)

All deterministic metrics are **pure functions** with an injected clock (`asOf: string`)
and no I/O. Each metric module lives under `packages/metrics/src/<group>/` and exports
the `MetricModule<I, O>` contract (SPEC §8.6):

```ts
interface MetricModule<I, O extends MetricResult> {
  id: string          // 'group.metric_name'
  trustTier: TrustTier
  scope: MetricScope
  formulaDoc: string  // published "how computed" string → docs/FORMULAS.md
  params: Record<string, unknown>
  compute(inputs: I, asOf: string, params?: Record<string, unknown>): O
}
```

### Groups

| Group | SPEC | Package subdirectory | Metrics |
|---|---|---|---|
| A — DORA | §8.1 | `dora/` | Deployment Frequency, Lead Time, Change Failure Rate, Recovery Time, Incident Reopen Rate, Deployment Rework Rate, Reliability Proxy |
| B — Flow | §8.2 | `flow/` | Cycle Time, Flow Efficiency, Throughput, WIP Load, Flow Distribution, CFD, Aging WIP, Time-in-Status, Monte Carlo Forecast |
| C — PR / Review | §8.3 | `pr/` | PR Cycle Time (4-phase), PR Size, Review Coverage, Reviewers/PR, Reviewer Load (Gini), Comments/PR, Review Iterations, Merge-Without-Review Rate, Review Latency, Time-to-First-Review, Time-to-Merge, Stale PR, CI Health |
| D — Code | §8.4 | `code/` | HALOC Aggregate, Rework/Churn %, Nagappan-Ball M1/M2/M3, Complexity Deltas, Maintainability Index, Code-Change Impact |
| E — Agile | §8.5 | `agile/` | Sprint Velocity, Say/Do, Sprint Predictability, Estimation Accuracy |

The full published formula for each metric is in [`FORMULAS.md`](./FORMULAS.md).

### Determinism contract (SPEC §8.6)

- **No `Date.now()` or `Math.random()`** in any metric path. Clock injected as `asOf`;
  simulations use the vendored mulberry32 PRNG seeded from `engine_version`.
- **Single pinned percentile method:** type-7 R-7 linear interpolation throughout.
- **Zero denominator → `null`** (never `NaN`/`Infinity`). Rendered as "N/A" in the UI.
- **Sample floors:** p90 requires n ≥ 20; p95 requires n ≥ 30. Below floor →
  `data_quality: 'insufficient_sample'`.
- **First-Done dedup:** throughput and recovery-time anchor on the first Done
  transition; reopens do not move the anchor.
- **`engine_version`** stamped on every result and snapshot. Tools refuse to plot across
  mixed engine versions without an explicit flag (WP-REDERIVE).

---

## The AI engine (SPEC §9)

Hybrid and probabilistic metrics delegate to `packages/ai/`. The harness:

1. Builds a **feature pack** (structured inputs — diffs, transitions, linked tickets).
2. Calls `claude-sonnet-4-6` (or the Opus ensemble gate) via `@anthropic-ai/sdk` with
   structured outputs (all values enum-bounded; ranges client-validated).
3. Writes an `ai_verdict` audit record including `model_snapshot`, `request_shape`, and
   the full feature pack.
4. Returns the result with `trust_tier: 'hybrid'` or `'probabilistic'`.

AI outputs are **point-in-time, not bit-reproducible** (temperature 0 is a hint, not a
guarantee; models are deprecated). The `engine_version` reproducibility guarantee covers
the deterministic layer only. See SPEC §9.1.

---

## MCP surface (SPEC §12–13)

`packages/mcp-server/` implements an MCP stdio server using `@modelcontextprotocol/sdk`.
Every tool output carries `outputSchema` + `structuredContent` so hosts can
machine-check the response. Fields present on every tool output:

- `trust_tier` — deterministic / hybrid / probabilistic
- `as_of` — ISO-8601 timestamp of the computation
- `data_quality` — ok / insufficient_sample / no_data / stale / low_confidence
- `formula_doc` — the published `formulaDoc` string for the metric
- `engine_version` — version of the metric engine that produced the result

### Skills and subagent

Skills (`/lazy-flow:*`) are SKILL.md definitions in the `skills/` directory. Each skill
calls one or more MCP tools and renders structured output with trust badges.

The `flow-analyst` subagent (`agents/`) is a narrating agent (`claude-opus-4-8`) that
summarises tool outputs. It never computes numbers and never emits a value not present
in a prior tool output. No individual rankings.

---

## Transparency and anti-gaming (SPEC §10, §11)

- Every metric carries a `formulaDoc` and a `trust_tier` badge in every tool response.
- The `explain_metric` tool renders the full formula and engine version for any metric.
- AI verdicts are contestable via `correct_verdict` — corrections feed the calibration
  harness (WP-AI-CALIBRATION) and improve future κ.
- Five gaming patterns are detected and flagged per metric output: deploy-frequency
  inflation, CFR suppression, lead-time resets, status juggling, trivial PR splitting.
- A Goodhart warning is emitted if a metric is detected to be used as a management
  target (§10.3).

---

## Further reading

| Document | Contents |
|---|---|
| [`SPEC.md`](./SPEC.md) | Full product specification — all requirements, formulas, decisions |
| [`WORKPLAN.md`](./WORKPLAN.md) | Wave-by-wave build plan, dependency DAG, per-item acceptance criteria |
| [`FORMULAS.md`](./FORMULAS.md) | Generated formula reference — all 39 metric formulaDocs |
| [`PERFORMANCE.md`](./PERFORMANCE.md) | Perf budgets and measured numbers (WP-PERF) |
| [`research/RESEARCH.md`](./research/RESEARCH.md) | Evidence base, 173 metrics, 157 sources |
| [`research/ADVERSARIAL-REVIEW-v1.md`](./research/ADVERSARIAL-REVIEW-v1.md) | 39 upheld findings from adversarial review |
