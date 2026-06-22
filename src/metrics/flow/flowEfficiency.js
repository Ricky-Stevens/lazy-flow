import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '../../core/index.js'

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

function buildIntervals(issue, nowMs) {
  const transitions = issue.transitions.toSorted(
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

  const intervals = []

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
  const lastT = transitions.at(-1)
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
  issue,
  resolveFlowState,
  doneStatusIds,
  nowMs,
  zombieThresholdMs,
) {
  const transitions = issue.transitions.toSorted(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  // Find first Done transition
  let firstDoneMs = null
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
    activeSeconds: safeRatio(activeMs, 1000) ?? 0,
    waitSeconds: safeRatio(waitMs, 1000) ?? 0,
    isZombie,
  }
}

// ---------------------------------------------------------------------------
// Metric module
// ---------------------------------------------------------------------------

export const flowEfficiency = {
  id: 'flow.flow_efficiency',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { zombieThresholdDays: DEFAULT_ZOMBIE_THRESHOLD_DAYS },

  compute(inputs, asOf) {
    const zombieThresholdDays = inputs.zombieThresholdDays ?? DEFAULT_ZOMBIE_THRESHOLD_DAYS
    const zombieThresholdMs = zombieThresholdDays * 24 * 60 * 60 * 1000
    const nowMs = new Date(inputs.now).getTime()

    const perIssue = []
    const zombieIssueIds = []

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
    const effValues = perIssue.filter((i) => i.efficiency !== null).map((i) => i.efficiency)

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
