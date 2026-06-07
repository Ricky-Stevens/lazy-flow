/**
 * Time-in-Status — Flow Group B (SPEC §8.2)
 *
 * For each issue, accumulate the total time spent in each status.
 * Re-entries accumulate (an issue that bounces back to In Progress twice
 * counts both intervals, per SPEC §8.2).
 *
 * formulaDoc:
 *   For each issue, sum the duration of all intervals where the issue
 *   was in statusId S.  Re-entries accumulate.
 *   Distribution: p50/p75/p85/p90/p95 per status across all issues.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, quantiles, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowIssueRecord } from './types.js'

export interface TimeInStatusInputs {
  issues: readonly FlowIssueRecord[]
  /** Reference now (ISO-8601). Injected. */
  now: string
}

export interface TimeInStatusPerIssue {
  issueId: string
  /** Seconds spent in each status. Re-entries accumulate. */
  byStatus: Record<string, number>
}

export interface TimeInStatusDistribution {
  statusId: string
  p50Seconds: number | null
  p75Seconds: number | null
  p85Seconds: number | null
  p90Seconds: number | null
  p95Seconds: number | null
  sampleSize: number
}

export interface TimeInStatusResult extends MetricResult {
  readonly perIssue: readonly TimeInStatusPerIssue[]
  readonly distribution: readonly TimeInStatusDistribution[]
}

const FORMULA_DOC =
  'Time-in-Status (SPEC §8.2): ' +
  'For each issue, sum the duration of all intervals in each status. ' +
  'Re-entries accumulate (multiple bounces to the same status all counted). ' +
  'Distribution: p50/p75/p85/p90/p95 per status across issues.'

export const timeInStatus: MetricModule<TimeInStatusInputs, TimeInStatusResult> = {
  id: 'flow.time_in_status',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): TimeInStatusResult {
    const nowMs = new Date(inputs.now).getTime()

    // Per-issue accumulation
    const perIssue: TimeInStatusPerIssue[] = []
    // statusId → list of durations (one per issue)
    const statusDurations = new Map<string, number[]>()

    for (const issue of inputs.issues) {
      const transitions = [...issue.transitions].sort(
        (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
      )

      const byStatus: Record<string, number> = {}

      const recordInterval = (statusId: string, fromMs: number, toMs: number): void => {
        const durationMs = Math.max(0, toMs - fromMs)
        const durationSec = safeRatio(durationMs, 1000) as number
        byStatus[statusId] = (byStatus[statusId] ?? 0) + durationSec
      }

      if (transitions.length === 0) {
        // No transitions: in initial status from creation to now
        recordInterval(issue.currentStatusId, new Date(issue.createdAt).getTime(), nowMs)
      } else {
        // Creation → first transition
        const firstT = transitions[0]
        if (firstT) {
          recordInterval(
            firstT.fromStatusId,
            new Date(issue.createdAt).getTime(),
            new Date(firstT.transitionedAt).getTime(),
          )
        }

        // Between consecutive transitions
        for (let i = 0; i < transitions.length - 1; i++) {
          const curr = transitions[i]
          const next = transitions[i + 1]
          if (curr && next) {
            recordInterval(
              curr.toStatusId,
              new Date(curr.transitionedAt).getTime(),
              new Date(next.transitionedAt).getTime(),
            )
          }
        }

        // Last transition → now
        const lastT = transitions[transitions.length - 1]
        if (lastT) {
          recordInterval(lastT.toStatusId, new Date(lastT.transitionedAt).getTime(), nowMs)
        }
      }

      perIssue.push({ issueId: issue.id, byStatus })

      // Accumulate for distribution
      for (const [statusId, seconds] of Object.entries(byStatus)) {
        const arr = statusDurations.get(statusId) ?? []
        arr.push(seconds)
        statusDurations.set(statusId, arr)
      }
    }

    // Build distribution per status
    const distribution: TimeInStatusDistribution[] = []
    for (const [statusId, durations] of statusDurations.entries()) {
      const qs = quantiles(durations)
      distribution.push({
        statusId,
        p50Seconds: qs?.p50 ?? null,
        p75Seconds: qs?.p75 ?? null,
        p85Seconds: qs?.p85 ?? null,
        p90Seconds: qs?.p90 ?? null,
        p95Seconds: qs?.p95 ?? null,
        sampleSize: durations.length,
      })
    }

    return {
      id: 'flow.time_in_status',
      trustTier: 'deterministic',
      scope: 'team',
      value: perIssue.length,
      unit: 'issues',
      dataQuality: perIssue.length === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      perIssue,
      distribution,
    }
  },
}
