import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Aging WIP (SPEC §8.2): For each issue currently in WIP (isStartedCol=true column), ' +
  'ageSeconds = now − createdAt. ' +
  'Distribution: p50/p75/p85/p90/p95 via R-7. ' +
  'Issues above p85 flagged as aging alerts. ' +
  'Sample floors: n≥20 for p90, n≥30 for p95.'

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

export const agingWip = {
  id: 'flow.aging_wip',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const startedIds = buildStartedStatusIds(inputs.boardColumns)
    const doneIds = buildDoneStatusIds(inputs.boardColumns)
    const nowMs = new Date(inputs.now).getTime()

    const wipItems = []

    for (const issue of inputs.issues) {
      // Determine current status at nowMs
      const transitions = [...issue.transitions]
        .filter((t) => new Date(t.transitionedAt).getTime() <= nowMs)
        .sort((a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime())

      const currentStatusId =
        transitions.length > 0
          ? (transitions[transitions.length - 1]?.toStatusId ?? issue.currentStatusId)
          : issue.currentStatusId

      // Only include issues in WIP (started, not done)
      if (!startedIds.has(currentStatusId) || doneIds.has(currentStatusId)) continue

      const ageMs = Math.max(0, nowMs - new Date(issue.createdAt).getTime())
      const ageSeconds = safeRatio(ageMs, 1000)

      wipItems.push({
        issueId: issue.id,
        issueType: issue.type,
        ageSeconds,
        currentStatusId,
        isAgingAlert: false, // will be set after computing p85
      })
    }

    const wipCount = wipItems.length

    if (wipCount === 0) {
      return {
        id: 'flow.aging_wip',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'seconds',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        wipItems: [],
        wipCount: 0,
        p50Seconds: null,
        p75Seconds: null,
        p85Seconds: null,
        p90Seconds: null,
        p95Seconds: null,
        alertThresholdSeconds: null,
      }
    }

    const ages = wipItems.map((i) => i.ageSeconds)
    const qs = quantiles(ages)

    const p90 = meetsSampleFloor(wipCount, 0.9) ? (qs?.p90 ?? null) : null
    const p95 = meetsSampleFloor(wipCount, 0.95) ? (qs?.p95 ?? null) : null

    const alertThreshold = qs?.p85 ?? null

    // Flag aging alerts
    const flaggedItems = wipItems.map((item) => ({
      ...item,
      isAgingAlert: alertThreshold !== null && item.ageSeconds > alertThreshold,
    }))

    const dataQuality =
      !meetsSampleFloor(wipCount, 0.9) || !meetsSampleFloor(wipCount, 0.95)
        ? 'insufficient_sample'
        : 'ok'

    return {
      id: 'flow.aging_wip',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'seconds',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      wipItems: flaggedItems,
      wipCount,
      p50Seconds: qs?.p50 ?? null,
      p75Seconds: qs?.p75 ?? null,
      p85Seconds: qs?.p85 ?? null,
      p90Seconds: p90,
      p95Seconds: p95,
      alertThresholdSeconds: alertThreshold,
    }
  },
}
