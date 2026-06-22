import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Flow Load / WIP (SPEC §8.2): ' +
  'wip = count of issues in isStartedCol=true columns at asOf. ' +
  "Little's Law sanity-check only: avgThroughput ≈ wip / avgCycleTimeDays. " +
  'NOT a per-sprint flag. Stationarity guard: bulk-close days excluded. ' +
  'Use cycle time + throughput distributions as primary flow metrics.'

function buildStartedStatusIds(boardColumns) {
  const s = new Set()
  for (const col of boardColumns) {
    if (col.isStartedCol) {
      for (const id of col.statusIds) s.add(id)
    }
  }
  return s
}

function buildDoneStatusIds(boardColumns) {
  const s = new Set()
  for (const col of boardColumns) {
    if (col.isDoneCol) {
      for (const id of col.statusIds) s.add(id)
    }
  }
  return s
}

export const wipLoad = {
  id: 'flow.wip_load',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const startedIds = buildStartedStatusIds(inputs.boardColumns)
    const doneIds = buildDoneStatusIds(inputs.boardColumns)
    const nowMs = new Date(inputs.now).getTime()

    // WIP = issues currently in a started (non-done) status.
    // We determine the current status by replaying transitions up to nowMs.
    const wipIssueIds = []

    for (const issue of inputs.issues) {
      const transitions = [...issue.transitions]
        .filter((t) => new Date(t.transitionedAt).getTime() <= nowMs)
        .sort((a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime())

      // Current status = toStatusId of the last transition <= nowMs
      // or currentStatusId if no transitions
      const currentStatusId =
        transitions.length > 0
          ? (transitions.at(-1)?.toStatusId ?? issue.currentStatusId)
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
