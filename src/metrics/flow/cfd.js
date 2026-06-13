import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'CFD (SPEC §8.2): Replay issue_transitions day-by-day. ' +
  'At end of each UTC day, count issues per status and per flow_state. ' +
  'Flow state classification uses the effective-dated flow_state_models ' +
  '(classification in effect at each transition interval). ' +
  'This ensures admin recategorisation does not retroactively rewrite history.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcDateStr(ts) {
  return ts.slice(0, 10)
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function daysBetween(start, end) {
  const startMs = new Date(`${start}T00:00:00Z`).getTime()
  const endMs = new Date(`${end}T00:00:00Z`).getTime()
  return Math.max(0, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)))
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const cfd = {
  id: 'flow.cfd',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const windowStartDay = utcDateStr(inputs.windowStart)
    const windowEndDay = utcDateStr(inputs.windowEnd)
    const numDays = daysBetween(windowStartDay, windowEndDay) + 1

    // Build sorted list of days
    const days = []
    for (let i = 0; i < numDays; i++) {
      days.push(addDays(windowStartDay, i))
    }

    // Collect all status IDs seen
    const allStatusIds = new Set()
    for (const issue of inputs.issues) {
      allStatusIds.add(issue.currentStatusId)
      for (const t of issue.transitions) {
        allStatusIds.add(t.fromStatusId)
        allStatusIds.add(t.toStatusId)
      }
    }

    // For each issue, determine what status it was in at end of each day.
    // We do this by finding the latest transition <= end-of-day.
    const cfdEntries = []

    for (const day of days) {
      const endOfDayMs = new Date(`${day}T23:59:59.999Z`).getTime()
      const byStatus = {}
      const byFlowState = { new: 0, active: 0, wait: 0, done: 0 }

      for (const issue of inputs.issues) {
        // Find the most recent transition <= end-of-day
        const applicableTransitions = issue.transitions
          .filter((t) => new Date(t.transitionedAt).getTime() <= endOfDayMs)
          .sort(
            (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
          )

        // Only count issues that existed by end of day
        if (new Date(issue.createdAt).getTime() > endOfDayMs) continue

        const statusId =
          applicableTransitions.length > 0
            ? (applicableTransitions[applicableTransitions.length - 1]?.toStatusId ??
              issue.currentStatusId)
            : // Issue existed but no transitions yet → use first transition's fromStatusId
              // or currentStatusId as initial
              issue.transitions.length > 0
              ? (issue.transitions
                  .slice()
                  .sort(
                    (a, b) =>
                      new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
                  )[0]?.fromStatusId ?? issue.currentStatusId)
              : issue.currentStatusId

        byStatus[statusId] = (byStatus[statusId] ?? 0) + 1

        // Resolve flow state at end of day
        const flowState = inputs.resolveFlowState(statusId, `${day}T23:59:59.999Z`) ?? 'wait'
        byFlowState[flowState]++
      }

      cfdEntries.push({ day, byStatus, byFlowState })
    }

    return {
      id: 'flow.cfd',
      trustTier: 'deterministic',
      scope: 'team',
      value: numDays,
      unit: 'days',
      dataQuality: inputs.issues.length === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      days: cfdEntries,
      statusIds: [...allStatusIds],
    }
  },
}
