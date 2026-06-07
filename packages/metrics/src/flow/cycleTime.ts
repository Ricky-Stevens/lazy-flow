/**
 * Flow Time / Cycle Time — Flow Group B (SPEC §8.2)
 *
 * Cycle Time start = first entry into a status mapped to a *started* board column
 * per `board_columns` (NOT status_category alone — SPEC §8.2, WP-JIRA-BOARDCONFIG).
 *
 * Cycle Time stop = first transition into a Done column/status.
 *
 * Reopen policy (SPEC §8.6):
 *   - Flow Time stops at the FIRST Done entry; reopens are a separate counter-metric.
 *   - We report `reopenCount` per issue but do not move the Done anchor.
 *
 * Outputs: per-issue cycle times + distribution (p50/p75/p85/p90/p95).
 * Sample floors per SPEC §8.6: p90 requires n≥20, p95 requires n≥30.
 *
 * formulaDoc: cycleTime_i = firstDoneAt_i − firstStartedAt_i (seconds).
 * Start = first entry into a status in a board `isStartedCol=true` column.
 * Stop  = first entry into a status in a board `isDoneCol=true` column.
 * Distribution: p50/p75/p85/p90/p95 using type-7 linear interpolation (R-7).
 * Sample floor: p90 requires n≥20; p95 requires n≥30 (SPEC §8.6).
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowBoardColumn, FlowIssueRecord, FlowState } from './types.js'

export interface CycleTimeInputs {
  issues: readonly FlowIssueRecord[]
  /**
   * Board columns defining the start/done boundaries.
   * Cycle time start = first entry into a `isStartedCol=true` status.
   * Cycle time stop  = first entry into a `isDoneCol=true` status.
   */
  boardColumns: readonly FlowBoardColumn[]
  /**
   * Effective-dated flow-state resolver.
   * Called with (statusId, at ISO-8601) → FlowState.
   * Pass `store.getFlowStateModel(workflowId, statusId, at)` in production;
   * pass a synchronous lookup closure in tests.
   */
  resolveFlowState: (statusId: string, at: string) => FlowState | null
  /** ISO-8601 reference "now" for age calculations. Injected, never Date.now(). */
  now: string
}

export interface PerIssueCycleTime {
  issueId: string
  issueType: string
  cycleTimeSeconds: number
  startedAt: string
  firstDoneAt: string
  reopenCount: number
}

export interface CycleTimeResult extends MetricResult {
  readonly perIssue: readonly PerIssueCycleTime[]
  readonly sampleSize: number
  readonly p50Seconds: number | null
  readonly p75Seconds: number | null
  readonly p85Seconds: number | null
  readonly p90Seconds: number | null
  readonly p95Seconds: number | null
}

const FORMULA_DOC =
  'Cycle Time (SPEC §8.2, §8.6): ' +
  'cycleTime_i = firstDoneAt_i − firstStartedAt_i (seconds). ' +
  'Start = first entry into a status in a board isStartedCol=true column (NOT status_category). ' +
  'Stop  = first entry into a status in a board isDoneCol=true column. ' +
  'Reopen policy: stop at first Done; reopens tracked as a counter (SPEC §8.6). ' +
  'Distribution: p50/p75/p85/p90/p95 via type-7 R-7 linear interpolation. ' +
  'Sample floors: n≥20 for p90, n≥30 for p95; below floor → data_quality=insufficient_sample.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a set of started-column status IDs from board columns. */
function startedStatusIds(boardColumns: readonly FlowBoardColumn[]): Set<string> {
  const s = new Set<string>()
  for (const col of boardColumns) {
    if (col.isStartedCol) {
      for (const id of col.statusIds) {
        s.add(id)
      }
    }
  }
  return s
}

/** Build a set of done-column status IDs from board columns. */
function doneStatusIds(boardColumns: readonly FlowBoardColumn[]): Set<string> {
  const s = new Set<string>()
  for (const col of boardColumns) {
    if (col.isDoneCol) {
      for (const id of col.statusIds) {
        s.add(id)
      }
    }
  }
  return s
}

/**
 * Compute per-issue cycle time from the transitions + board column boundaries.
 * Returns null if the issue lacks a valid start or first-done transition.
 */
export function computePerIssueCycleTime(
  issue: FlowIssueRecord,
  startedIds: ReadonlySet<string>,
  doneIds: ReadonlySet<string>,
): PerIssueCycleTime | null {
  // Transitions must already be sorted ascending (SPEC C1 — sort on ingest).
  const transitions = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  // Find the first transition INTO a started status.
  let startedAt: string | null = null
  for (const t of transitions) {
    if (startedIds.has(t.toStatusId)) {
      startedAt = t.transitionedAt
      break
    }
  }

  if (!startedAt) return null

  // Find the first transition INTO a done status AFTER startedAt.
  let firstDoneAt: string | null = null
  const startMs = new Date(startedAt).getTime()
  for (const t of transitions) {
    if (doneIds.has(t.toStatusId) && new Date(t.transitionedAt).getTime() >= startMs) {
      firstDoneAt = t.transitionedAt
      break
    }
  }

  if (!firstDoneAt) return null

  // Count reopens: transitions FROM a done status back to any non-done status.
  let reopenCount = 0
  for (const t of transitions) {
    if (doneIds.has(t.fromStatusId) && !doneIds.has(t.toStatusId)) {
      reopenCount++
    }
  }

  const cycleTimeSeconds = safeRatio(
    new Date(firstDoneAt).getTime() - new Date(startedAt).getTime(),
    1000,
  ) as number // denominator is always 1000

  return {
    issueId: issue.id,
    issueType: issue.type,
    cycleTimeSeconds,
    startedAt,
    firstDoneAt,
    reopenCount,
  }
}

// ---------------------------------------------------------------------------
// Metric module
// ---------------------------------------------------------------------------

export const cycleTime: MetricModule<CycleTimeInputs, CycleTimeResult> = {
  id: 'flow.cycle_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): CycleTimeResult {
    const startedIds = startedStatusIds(inputs.boardColumns)
    const doneIds = doneStatusIds(inputs.boardColumns)

    const perIssue: PerIssueCycleTime[] = []

    for (const issue of inputs.issues) {
      const result = computePerIssueCycleTime(issue, startedIds, doneIds)
      if (result !== null) {
        perIssue.push(result)
      }
    }

    const sampleSize = perIssue.length

    if (sampleSize === 0) {
      return {
        id: 'flow.cycle_time',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'seconds',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        perIssue: [],
        sampleSize: 0,
        p50Seconds: null,
        p75Seconds: null,
        p85Seconds: null,
        p90Seconds: null,
        p95Seconds: null,
      }
    }

    const values = perIssue.map((i) => i.cycleTimeSeconds)
    const qs = quantiles(values)

    // Apply sample floors
    const p90 = meetsSampleFloor(sampleSize, 0.9) ? (qs?.p90 ?? null) : null
    const p95 = meetsSampleFloor(sampleSize, 0.95) ? (qs?.p95 ?? null) : null

    const dataQuality =
      !meetsSampleFloor(sampleSize, 0.9) || !meetsSampleFloor(sampleSize, 0.95)
        ? 'insufficient_sample'
        : 'ok'

    return {
      id: 'flow.cycle_time',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'seconds',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      perIssue,
      sampleSize,
      p50Seconds: qs?.p50 ?? null,
      p75Seconds: qs?.p75 ?? null,
      p85Seconds: qs?.p85 ?? null,
      p90Seconds: p90,
      p95Seconds: p95,
    }
  },
}
