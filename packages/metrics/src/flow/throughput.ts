/**
 * Throughput (Flow Velocity) — Flow Group B (SPEC §8.2)
 *
 * Count of issues completed in a window.  Dedup: count once per issue per
 * window on the FIRST Done transition (SPEC §8.6).  An issue that is
 * resolved, reopened, and resolved again within the window counts ONCE.
 *
 * formulaDoc:
 *   throughput = count of distinct issues whose firstDoneAt falls within
 *   [windowStart, asOf]. First-Done dedup: only the first transition into
 *   a isDoneCol=true status counts; later re-completions in the same window
 *   do not add to the count.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowIssueRecord } from './types.js'

export interface ThroughputInputs {
  issues: readonly FlowIssueRecord[]
  /**
   * Set of done statusIds (from board_columns.isDoneCol=true).
   */
  doneStatusIds: ReadonlySet<string>
  /**
   * Start of the window (ISO-8601 inclusive).
   */
  windowStart: string
  /**
   * End of the window (ISO-8601 inclusive, typically asOf).
   */
  windowEnd: string
}

export interface ThroughputResult extends MetricResult {
  readonly count: number
  readonly completedIssueIds: readonly string[]
  /** Issues that were completed more than once in the window (reopen+redo). */
  readonly reopenedInWindowIds: readonly string[]
}

const FORMULA_DOC =
  'Throughput (SPEC §8.2, §8.6): count of issues whose first-Done transition ' +
  'falls within [windowStart, windowEnd]. First-Done dedup per issue per window: ' +
  'reopened-and-re-completed issues count once. ' +
  'Reopen-in-window issues are flagged in reopenedInWindowIds for transparency.'

export const throughput: MetricModule<ThroughputInputs, ThroughputResult> = {
  id: 'flow.throughput',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): ThroughputResult {
    const windowStartMs = new Date(inputs.windowStart).getTime()
    const windowEndMs = new Date(inputs.windowEnd).getTime()

    const completedIssueIds: string[] = []
    const reopenedInWindowIds: string[] = []

    for (const issue of inputs.issues) {
      const transitions = [...issue.transitions].sort(
        (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
      )

      // Find the FIRST Done transition within the window.
      let firstDoneInWindowAt: number | null = null
      let completionCountInWindow = 0
      let reopenCountInWindow = 0

      for (const t of transitions) {
        const tMs = new Date(t.transitionedAt).getTime()
        if (tMs < windowStartMs || tMs > windowEndMs) continue

        if (inputs.doneStatusIds.has(t.toStatusId)) {
          completionCountInWindow++
          if (firstDoneInWindowAt === null) {
            firstDoneInWindowAt = tMs
          }
        } else if (inputs.doneStatusIds.has(t.fromStatusId)) {
          // Transition FROM done = reopen
          reopenCountInWindow++
        }
      }

      if (firstDoneInWindowAt !== null) {
        // Count once (first Done dedup)
        completedIssueIds.push(issue.id)
        if (reopenCountInWindow > 0 && completionCountInWindow > 1) {
          reopenedInWindowIds.push(issue.id)
        }
      }
    }

    const count = completedIssueIds.length
    const dataQuality = count === 0 ? 'no_data' : 'ok'

    return {
      id: 'flow.throughput',
      trustTier: 'deterministic',
      scope: 'team',
      value: count,
      unit: 'issues',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      count,
      completedIssueIds,
      reopenedInWindowIds,
    }
  },
}
