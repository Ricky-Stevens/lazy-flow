/**
 * Performance budget benchmark (WP-PERF, SPEC §15).
 *
 * Budgets (SPEC §15 / WP-PERF):
 *   - Dashboard / snapshot read   < 1 000 ms  (SPEC §15 "< 1s from snapshots")
 *   - Incremental metric compute  < 5 000 ms  (generous ceiling; typical << 200 ms)
 *
 * Strategy:
 *   1. Build a scaled issue corpus by cloning the synthetic base-org dataset
 *      N=20 times (unique IDs per clone) so the engine walks a meaningful
 *      corpus without hitting the network.
 *   2. Time a representative deterministic metric compute (throughput, which
 *      iterates all issues and their transitions).
 *   3. Seed an in-memory BunSqliteStore with batch snapshot rows and time a
 *      getSnapshots read over a 90-day window — simulating a dashboard read.
 *
 * The budgets are deliberately generous so the test is not flaky on developer
 * hardware or under CI load. Deterministic: no wall-clock or RNG in metric paths.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { BunSqliteStore, migrate } from '../core/index.js'
import { baseOrg, IDS } from '../testkit/index.js'

import { throughput } from './flow/throughput.js'

// ---------------------------------------------------------------------------
// Budget constants (ms) — aligned with SPEC §15
// ---------------------------------------------------------------------------

/** Dashboard / snapshot read must return within this budget (SPEC §15). */
const SNAPSHOT_READ_BUDGET_MS = 1_000

/** Incremental metric compute must complete within this budget. */
const METRIC_COMPUTE_BUDGET_MS = 5_000

// ---------------------------------------------------------------------------
// Scale factor — clone the base dataset N times
// ---------------------------------------------------------------------------

const CLONE_N = 20 // 20× base org ≈ 20 teams worth of issues / transitions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

/**
 * Build a scaled FlowIssueRecord list for the throughput metric compute.
 * Clones each baseOrg Jira issue CLONE_N times with unique IDs, attaching
 * their transitions from the issueTransitions map.
 */
function buildScaledIssues(n) {
  const issues = []

  for (let clone = 0; clone < n; clone++) {
    for (const issue of baseOrg.jiraIssues) {
      // Collect transitions for this issue from the keyed map
      const rawTransitions = baseOrg.issueTransitions[issue.id] ?? []

      const transitions = rawTransitions.map((t) => ({
        id: `${t.id}-c${clone}`,
        issueId: `${t.issueId}-c${clone}`,
        fromStatusId: t.fromStatusId,
        toStatusId: t.toStatusId,
        transitionedAt: t.transitionedAt,
      }))

      issues.push({
        id: `${issue.id}-c${clone}`,
        type: issue.type,
        workflowId: null,
        currentStatusId: issue.statusId,
        createdAt: issue.createdAt,
        transitions,
      })
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('perf budgets (WP-PERF, SPEC §15)', () => {
  it(// SLOW: intentionally exercises a non-trivial corpus
  `metric compute: throughput over ${CLONE_N}× scaled dataset < ${METRIC_COMPUTE_BUDGET_MS}ms`, () => {
    const issues = buildScaledIssues(CLONE_N)

    const inputs = {
      issues,
      doneStatusIds: new Set([IDS.statusDone]),
      windowStart: '2024-01-01T00:00:00.000Z',
      windowEnd: '2025-12-31T23:59:59.000Z',
    }

    const t0 = performance.now()
    const result = throughput.compute(inputs, '2025-12-31T23:59:59.000Z')
    const elapsed = performance.now() - t0

    // Correctness: result is valid
    expect(result.id).toBe('flow.throughput')
    expect(typeof result.value === 'number' || result.value === null).toBe(true)

    // Budget
    expect(
      elapsed,
      `Throughput compute took ${elapsed.toFixed(1)}ms, budget ${METRIC_COMPUTE_BUDGET_MS}ms`,
    ).toBeLessThan(METRIC_COMPUTE_BUDGET_MS)
  })

  it(// SLOW: seeds the store then times a getSnapshots call
  `snapshot read: 90-day window over ${CLONE_N * 5} snapshot rows < ${SNAPSHOT_READ_BUDGET_MS}ms`, async () => {
    const store = freshStore()

    const METRIC = 'flow.throughput'
    const SCOPE_TYPE = 'team'
    const SCOPE_ID = IDS.org
    const ROW_COUNT = CLONE_N * 5 // 100 daily rows — generous dashboard-size corpus

    // Seed snapshot rows
    const baseDate = new Date('2025-01-01T00:00:00.000Z')
    for (let i = 0; i < ROW_COUNT; i++) {
      const day = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      await store.putSnapshot({
        scopeType: SCOPE_TYPE,
        scopeId: SCOPE_ID,
        metric: METRIC,
        day,
        value: i + 1,
        window: '28d',
        trustTier: 'deterministic',
        dataQuality: 'ok',
        engineVersion: '1.0.0',
        ingestWatermarkVersion: '1',
        coverageFingerprint: 'test-fp',
        computedAt: `${day}T00:00:00.000Z`,
        isStale: false,
      })
    }

    const from = '2025-01-01'
    const to = new Date(baseDate.getTime() + ROW_COUNT * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)

    const t0 = performance.now()
    const rows = await store.getSnapshots(SCOPE_TYPE, SCOPE_ID, METRIC, from, to)
    const elapsed = performance.now() - t0

    store.close()

    // Correctness: all rows returned
    expect(rows).toHaveLength(ROW_COUNT)

    // Budget
    expect(
      elapsed,
      `Snapshot read took ${elapsed.toFixed(1)}ms, budget ${SNAPSHOT_READ_BUDGET_MS}ms`,
    ).toBeLessThan(SNAPSHOT_READ_BUDGET_MS)
  })
})
