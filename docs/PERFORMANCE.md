# lazy-flow — Performance budgets

> WP-PERF documentation. For the SPEC §15 non-functional requirements see
> [SPEC.md §15](./SPEC.md).

---

## Budgets

These are the documented and tested performance budgets for lazy-flow. They are
enforced by the benchmark in `packages/metrics/src/perf.test.ts` which runs as
part of the normal `npm test` suite.

| Operation | Budget | Rationale |
|---|---|---|
| **Dashboard / snapshot read** | < 1 000 ms | SPEC §15: "dashboard tool calls return < 1s from snapshots" |
| **Incremental metric compute** | < 5 000 ms | SPEC §15: "incremental sync is sub-minute"; 5s is a generous ceiling for a single metric over a large corpus |
| **Initial backfill** | _documented, not automated_ | SPEC §15: "within a documented budget" for mid-size org (≈20 repos / 50 contributors / 2 yrs) |

---

## Measured numbers

Benchmarks run on a synthetic corpus scaled to 20× the base-org dataset
(approximately 100 issues with full transition histories). Hardware: WSL2 on
Windows, Node.js v25, `node:sqlite` in-memory database.

| Benchmark | Corpus | Measured (typical) | Budget | Margin |
|---|---|---|---|---|
| Throughput metric compute | 20× baseOrg (~100 issues, ~260 transitions) | **~2 ms** | 5 000 ms | ~2500× |
| Snapshot read (90-day window) | 100 snapshot rows, in-memory SQLite | **~5 ms** | 1 000 ms | ~200× |

The margins are intentionally very large: the metric engine is a tight in-memory loop
with no I/O, and SQLite reads from an already-open in-memory database are fast.
The budgets are set at the SPEC §15 targets, not tightened to the measured values,
so the test remains green under CI load and slower hardware without being flaky.

---

## Benchmark methodology

**File:** `packages/metrics/src/perf.test.ts`

**Metric compute benchmark:**

1. Clones the `@lazy-flow/testkit` `baseOrg` dataset 20 times (unique IDs per clone)
   to produce ~100 `FlowIssueRecord` objects, each with their full transition history.
2. Calls `throughput.compute(inputs, asOf)` — a representative deterministic metric
   that iterates all issues and their transitions.
3. Asserts the elapsed time (via `performance.now()`) is below budget.
4. Also asserts the result is valid (correct `id`, non-null value).

**Snapshot read benchmark:**

1. Initialises an in-memory `NodeSqliteStore` with a migrated schema.
2. Writes 100 daily `metric_snapshots` rows via `store.putSnapshot()`.
3. Times a single `store.getSnapshots()` call over the full 100-day range.
4. Asserts elapsed time is below budget and all 100 rows are returned.

The benchmarks are deterministic: no wall-clock in metric paths, no network calls,
fixed corpus size. They will not flake due to external factors.

---

## Initial backfill — sizing (WP-SPIKE-SYNCLOAD)

The initial backfill budget ("mid-size org, ≈20 repos / 50 contributors / 2 yrs
of history completes within a documented budget") is not yet benchmarked as an
automated test. This is gated on WP-SPIKE-SYNCLOAD (WORKPLAN §2a), which sizes
the GitHub and Jira API rate pressure under N concurrent local-first installs.

Current estimate (from SPEC §15 + API rate-limit analysis):

- GitHub REST API: 5 000 requests/hour (App). 20 repos × 2 years of PRs ~= 20k
  requests → ~4 hours at full-rate (no concurrency throttling).
- Incremental sync after backfill: typically < 60 seconds (only new/modified
  resources fetched, paginated changelog bulk-fetched).

These numbers will be validated and tightened by WP-SPIKE-SYNCLOAD before the
first public release.

---

## Running the benchmarks

```sh
# Run the perf benchmarks (part of the normal test suite)
npm test -- packages/metrics/src/perf.test.ts

# Run with verbose output to see timing
npm test -- --reporter=verbose packages/metrics/src/perf.test.ts
```

The benchmarks run as part of `npm test` on every CI run.
