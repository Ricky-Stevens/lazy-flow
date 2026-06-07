/**
 * Flow Efficiency — Flow Group B (SPEC §8.2)
 *
 * PINNED ESTIMATOR: per-issue active_i / (active_i + wait_i) — NOT the pooled
 * Σactive / Σtotal.  The pooled estimator is inflated to ~90% if one zombie
 * ticket with 10× more wait time is in the denominator.  Reporting the
 * distribution of per-issue efficiencies is honest and gaming-resistant.
 *
 * Active/wait classification: uses the EFFECTIVE-DATED flow_state_models table.
 * Each transition interval uses the flow state in effect at the INTERVAL START
 * (call `getFlowStateModel(workflowId, statusId, intervalStartAt)`).
 *
 * GitHub code-phase fusion hook: an optional `githubActiveWindowMs` can be
 * added per issue to represent time in open-PR (active) state.  This is
 * stubbed as a hook parameter — the full GitHub fusion is a later Wave-5 item.
 *
 * Age-outlier "zombie" tickets: issues with total open time > `zombieThresholdDays`
 * are flagged in `zombieIssueIds` (SPEC §8.2).
 *
 * formulaDoc:
 *   For each closed issue i: split intervals by flow_state (active | wait).
 *   efficiency_i = active_i / (active_i + wait_i)  [null when denominator=0]
 *   Report the distribution (p50/p75/p85/p90/p95) of efficiency_i values.
 *   Outliers: issues where total open time > zombieThresholdDays are flagged.
 *   Classification: effective-dated flow_state_models — each interval uses the
 *   classification in effect at that interval's start timestamp.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowIssueRecord, FlowState } from './types.js'

export interface FlowEfficiencyInputs {
  /**
   * Issues to analyse. Only issues that have reached Done are included
   * in the efficiency distribution.
   */
  issues: readonly FlowIssueRecord[]
  /**
   * Effective-dated flow-state resolver.
   * Called with (statusId: string, at: string) → FlowState | null.
   * `at` is the ISO-8601 interval start timestamp.
   * Return null when the workflow is unconfirmed → treated as 'wait' (conservative,
   * per the low-confidence fallback: over-counting active inflates efficiency).
   */
  resolveFlowState: (statusId: string, at: string) => FlowState | null
  /**
   * Set of done statusIds (from board_columns.isDoneCol=true).
   * Used to detect when an issue has first reached Done.
   */
  doneStatusIds: ReadonlySet<string>
  /**
   * Age-outlier threshold in days.  Issues still open (or with total
   * open time > this) are flagged as zombies.  Default: 90.
   */
  zombieThresholdDays?: number
  /** Reference "now" for zombie detection (ISO-8601). Injected, never Date.now(). */
  now: string
}

export interface PerIssueEfficiency {
  issueId: string
  issueType: string
  efficiency: number | null
  /** Total active seconds across all intervals. */
  activeSeconds: number
  /** Total wait seconds across all intervals. */
  waitSeconds: number
  /** True when this issue is an outlier (zombie). */
  isZombie: boolean
}

export interface FlowEfficiencyResult extends MetricResult {
  readonly perIssue: readonly PerIssueEfficiency[]
  readonly sampleSize: number
  readonly p50: number | null
  readonly p75: number | null
  readonly p85: number | null
  readonly p90: number | null
  readonly p95: number | null
  readonly zombieIssueIds: readonly string[]
}

const FORMULA_DOC =
  'Flow Efficiency (SPEC §8.2, §8.6): ' +
  'Per-issue estimator: efficiency_i = active_i / (active_i + wait_i). ' +
  'NOT pooled Σactive/Σtotal (zombie-resistant). ' +
  'Classification: effective-dated flow_state_models at each interval start. ' +
  'Distribution: p50/p75/p85/p90/p95 via R-7 linear interpolation. ' +
  'Zombie threshold: issues with total open time > zombieThresholdDays flagged. ' +
  'Sample floors: n≥20 for p90, n≥30 for p95.'

const DEFAULT_ZOMBIE_THRESHOLD_DAYS = 90

// ---------------------------------------------------------------------------
// Per-issue efficiency computation
// ---------------------------------------------------------------------------

/**
 * Build a timeline of (statusId, fromMs, toMs) intervals from an issue's
 * sorted transitions.  The first status is inferred from the first transition's
 * fromStatusId (i.e. what the issue was in before the first transition recorded).
 */
interface Interval {
  statusId: string
  fromMs: number
  toMs: number
}

function buildIntervals(issue: FlowIssueRecord, nowMs: number): Interval[] {
  const transitions = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  if (transitions.length === 0) {
    // No transitions: the issue has been in its initial status since creation.
    return [
      {
        statusId: issue.currentStatusId,
        fromMs: new Date(issue.createdAt).getTime(),
        toMs: nowMs,
      },
    ]
  }

  const intervals: Interval[] = []

  // Interval from creation to first transition
  const firstT = transitions[0]
  if (firstT) {
    intervals.push({
      statusId: firstT.fromStatusId,
      fromMs: new Date(issue.createdAt).getTime(),
      toMs: new Date(firstT.transitionedAt).getTime(),
    })
  }

  // Intervals between consecutive transitions
  for (let i = 0; i < transitions.length - 1; i++) {
    const curr = transitions[i]
    const next = transitions[i + 1]
    if (curr && next) {
      intervals.push({
        statusId: curr.toStatusId,
        fromMs: new Date(curr.transitionedAt).getTime(),
        toMs: new Date(next.transitionedAt).getTime(),
      })
    }
  }

  // Interval from last transition to now (still open) or to final state
  const lastT = transitions[transitions.length - 1]
  if (lastT) {
    intervals.push({
      statusId: lastT.toStatusId,
      fromMs: new Date(lastT.transitionedAt).getTime(),
      toMs: nowMs,
    })
  }

  return intervals
}

/**
 * Compute per-issue flow efficiency.
 * Only counts time from creation to first Done entry.
 */
export function computePerIssueEfficiency(
  issue: FlowIssueRecord,
  resolveFlowState: (statusId: string, at: string) => FlowState | null,
  doneStatusIds: ReadonlySet<string>,
  nowMs: number,
  zombieThresholdMs: number,
): PerIssueEfficiency {
  const transitions = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  // Find first Done transition
  let firstDoneMs: number | null = null
  for (const t of transitions) {
    if (doneStatusIds.has(t.toStatusId)) {
      firstDoneMs = new Date(t.transitionedAt).getTime()
      break
    }
  }

  // Build intervals up to first Done (or nowMs if not yet done)
  const endMs = firstDoneMs ?? nowMs
  const allIntervals = buildIntervals(issue, endMs)

  let activeMs = 0
  let waitMs = 0

  for (const interval of allIntervals) {
    const durationMs = Math.max(0, interval.toMs - interval.fromMs)
    if (durationMs === 0) continue

    const at = new Date(interval.fromMs).toISOString()
    const state = resolveFlowState(interval.statusId, at)

    // Treat null (unconfirmed) as 'wait' — conservative default.
    if (state === 'active') {
      activeMs += durationMs
    } else {
      waitMs += durationMs
    }
  }

  const totalMs = new Date(endMs).getTime() - new Date(issue.createdAt).getTime()
  const isZombie = totalMs > zombieThresholdMs

  const efficiency = safeRatio(activeMs, activeMs + waitMs)

  return {
    issueId: issue.id,
    issueType: issue.type,
    efficiency,
    activeSeconds: activeMs / 1000,
    waitSeconds: waitMs / 1000,
    isZombie,
  }
}

// ---------------------------------------------------------------------------
// Metric module
// ---------------------------------------------------------------------------

export const flowEfficiency: MetricModule<FlowEfficiencyInputs, FlowEfficiencyResult> = {
  id: 'flow.flow_efficiency',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { zombieThresholdDays: DEFAULT_ZOMBIE_THRESHOLD_DAYS },

  compute(inputs, asOf): FlowEfficiencyResult {
    const zombieThresholdDays = inputs.zombieThresholdDays ?? DEFAULT_ZOMBIE_THRESHOLD_DAYS
    const zombieThresholdMs = zombieThresholdDays * 24 * 60 * 60 * 1000
    const nowMs = new Date(inputs.now).getTime()

    const perIssue: PerIssueEfficiency[] = []
    const zombieIssueIds: string[] = []

    for (const issue of inputs.issues) {
      const result = computePerIssueEfficiency(
        issue,
        inputs.resolveFlowState,
        inputs.doneStatusIds,
        nowMs,
        zombieThresholdMs,
      )
      perIssue.push(result)
      if (result.isZombie) {
        zombieIssueIds.push(issue.id)
      }
    }

    // Only include issues with non-null efficiency in the distribution.
    const effValues = perIssue
      .filter((i) => i.efficiency !== null)
      .map((i) => i.efficiency as number)

    const sampleSize = effValues.length

    if (sampleSize === 0) {
      return {
        id: 'flow.flow_efficiency',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        perIssue,
        sampleSize: 0,
        p50: null,
        p75: null,
        p85: null,
        p90: null,
        p95: null,
        zombieIssueIds,
      }
    }

    const qs = quantiles(effValues)
    const p90 = meetsSampleFloor(sampleSize, 0.9) ? (qs?.p90 ?? null) : null
    const p95 = meetsSampleFloor(sampleSize, 0.95) ? (qs?.p95 ?? null) : null

    const dataQuality =
      !meetsSampleFloor(sampleSize, 0.9) || !meetsSampleFloor(sampleSize, 0.95)
        ? 'insufficient_sample'
        : 'ok'

    return {
      id: 'flow.flow_efficiency',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'ratio',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      perIssue,
      sampleSize,
      p50: qs?.p50 ?? null,
      p75: qs?.p75 ?? null,
      p85: qs?.p85 ?? null,
      p90,
      p95,
      zombieIssueIds,
    }
  },
}
