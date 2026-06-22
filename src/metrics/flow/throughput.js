import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Throughput (SPEC §8.2, §8.6): count of issues whose first-Done transition ' +
  'falls within [windowStart, windowEnd]. First-Done dedup per issue per window: ' +
  'reopened-and-re-completed issues count once. ' +
  'Reopen-in-window issues are flagged in reopenedInWindowIds for transparency.'

export const throughput = {
  id: 'flow.throughput',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const windowStartMs = new Date(inputs.windowStart).getTime()
    const windowEndMs = new Date(inputs.windowEnd).getTime()

    const completedIssueIds = []
    const reopenedInWindowIds = []

    for (const issue of inputs.issues) {
      const transitions = issue.transitions.toSorted(
        (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
      )

      // Find the FIRST Done transition within the window.
      let firstDoneInWindowAt = null
      let reopenCountInWindow = 0

      for (const t of transitions) {
        const tMs = new Date(t.transitionedAt).getTime()
        if (tMs < windowStartMs || tMs > windowEndMs) continue

        if (inputs.doneStatusIds.has(t.toStatusId)) {
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
        // Transparency flag: this counted issue churned inside the window (it
        // left Done at least once after completing). The old guard also required
        // completionCountInWindow > 1, which silently dropped the common case of
        // an issue that completes once in-window, is reopened in-window, then
        // re-completes OUTSIDE the window — exactly the instability the flag
        // exists to surface. A reopen in-window on a counted issue is enough.
        if (reopenCountInWindow > 0) {
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
