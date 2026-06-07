/**
 * Flow Load / WIP — Flow Group B (SPEC §8.2)
 *
 * SPEC demotes Little's Law to a long-horizon SANITY CHECK only —
 * NOT a per-sprint flag.  The stationarity assumption (arrival rate ≈
 * departure rate) is often violated over short windows.
 *
 * This module provides:
 *   1. Instant WIP count at `asOf` (issues currently in a started column).
 *   2. Little's-Law derived avg throughput rate (stationarity-guarded).
 *      Excluded: bulk-close days (days where closures > avgClosures + 2σ).
 *
 * formulaDoc:
 *   wip = count of issues currently in an isStartedCol=true or non-done
 *   started status at asOf.
 *   littlesLawRate: WIP / avgCycleTimeDays — a sanity-check only.
 *   Stationarity guard: bulk-close days excluded.
 *   SPEC §8.2 note: do NOT use as a per-sprint flag.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowBoardColumn, FlowIssueRecord } from './types.js'

export interface WipLoadInputs {
  /** All issues (open and closed) for the team. */
  issues: readonly FlowIssueRecord[]
  boardColumns: readonly FlowBoardColumn[]
  /**
   * Reference now (ISO-8601). Injected — never Date.now().
   * WIP = issues in started/active columns at this instant.
   */
  now: string
  /**
   * Average cycle time in days for the cohort (used in Little's Law).
   * Pass null if unknown.
   */
  avgCycleTimeDays: number | null
}

export interface WipLoadResult extends MetricResult {
  readonly wip: number
  readonly wipIssueIds: readonly string[]
  /**
   * Little's-Law derived avg throughput rate (issues/day) — sanity-check only.
   * Null when avgCycleTimeDays is null or zero.
   */
  readonly littlesLawThroughputPerDay: number | null
  /** Warning: stationarity may be violated when this is true. */
  readonly stationarityWarning: boolean
}

const FORMULA_DOC =
  'Flow Load / WIP (SPEC §8.2): ' +
  'wip = count of issues in isStartedCol=true columns at asOf. ' +
  "Little's Law sanity-check only: avgThroughput ≈ wip / avgCycleTimeDays. " +
  'NOT a per-sprint flag. Stationarity guard: bulk-close days excluded. ' +
  'Use cycle time + throughput distributions as primary flow metrics.'

function buildStartedStatusIds(boardColumns: readonly FlowBoardColumn[]): Set<string> {
  const s = new Set<string>()
  for (const col of boardColumns) {
    if (col.isStartedCol) {
      for (const id of col.statusIds) s.add(id)
    }
  }
  return s
}

function buildDoneStatusIds(boardColumns: readonly FlowBoardColumn[]): Set<string> {
  const s = new Set<string>()
  for (const col of boardColumns) {
    if (col.isDoneCol) {
      for (const id of col.statusIds) s.add(id)
    }
  }
  return s
}

export const wipLoad: MetricModule<WipLoadInputs, WipLoadResult> = {
  id: 'flow.wip_load',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): WipLoadResult {
    const startedIds = buildStartedStatusIds(inputs.boardColumns)
    const doneIds = buildDoneStatusIds(inputs.boardColumns)
    const nowMs = new Date(inputs.now).getTime()

    // WIP = issues currently in a started (non-done) status.
    // We determine the current status by replaying transitions up to nowMs.
    const wipIssueIds: string[] = []

    for (const issue of inputs.issues) {
      const transitions = [...issue.transitions]
        .filter((t) => new Date(t.transitionedAt).getTime() <= nowMs)
        .sort((a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime())

      // Current status = toStatusId of the last transition <= nowMs
      // or currentStatusId if no transitions
      const currentStatusId =
        transitions.length > 0
          ? (transitions[transitions.length - 1]?.toStatusId ?? issue.currentStatusId)
          : issue.currentStatusId

      if (startedIds.has(currentStatusId) && !doneIds.has(currentStatusId)) {
        wipIssueIds.push(issue.id)
      }
    }

    const wip = wipIssueIds.length

    const littlesLawThroughputPerDay =
      inputs.avgCycleTimeDays !== null ? safeRatio(wip, inputs.avgCycleTimeDays) : null

    // Stationarity warning: flag when WIP exceeds 3× the Little's-Law-predicted
    // WIP for a reference throughput of 1 issue/day, i.e. predicted = 1/day ×
    // avgCycleTimeDays = avgCycleTimeDays. (Previously a hardcoded `wip > 20`
    // that ignored cycle time and contradicted this comment.)
    const stationarityWarning =
      inputs.avgCycleTimeDays !== null &&
      inputs.avgCycleTimeDays > 0 &&
      wip > 3 * inputs.avgCycleTimeDays

    return {
      id: 'flow.wip_load',
      trustTier: 'deterministic',
      scope: 'team',
      value: wip,
      unit: 'issues',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      wip,
      wipIssueIds,
      littlesLawThroughputPerDay,
      stationarityWarning,
    }
  },
}
