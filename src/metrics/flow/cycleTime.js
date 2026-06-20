import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '../../core/index.js'

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
function startedStatusIds(boardColumns) {
  const s = new Set()
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
function doneStatusIds(boardColumns) {
  const s = new Set()
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
export function computePerIssueCycleTime(issue, startedIds, doneIds) {
  // Transitions must already be sorted ascending (SPEC C1 — sort on ingest).
  const transitions = [...issue.transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )

  // Find the first transition INTO a started status.
  let startedAt = null
  for (const t of transitions) {
    if (startedIds.has(t.toStatusId)) {
      startedAt = t.transitionedAt
      break
    }
  }

  if (!startedAt) return null

  // Find the first transition INTO a done status AFTER startedAt.
  let firstDoneAt = null
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
  ) // denominator is always 1000

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

export const cycleTime = {
  id: 'flow.cycle_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const startedIds = startedStatusIds(inputs.boardColumns)
    const doneIds = doneStatusIds(inputs.boardColumns)

    // Optional completion window: only issues whose FIRST Done falls in
    // [windowStart, windowEnd] count toward this period's cycle time. Without it
    // every issue ever completed would contribute, so each daily backfill
    // snapshot would carry the all-time p50 instead of the window's (SPEC §8.2 —
    // cycle time is reported per delivery period).
    const fromMs = inputs.windowStart != null ? new Date(inputs.windowStart).getTime() : -Infinity
    const toMs =
      inputs.windowEnd != null ? new Date(inputs.windowEnd).getTime() : Number.POSITIVE_INFINITY

    const perIssue = []

    for (const issue of inputs.issues) {
      const result = computePerIssueCycleTime(issue, startedIds, doneIds)
      if (result === null) continue
      // Defensive: a non-finite cycle time (should be impossible given the
      // start/done selection guards in computePerIssueCycleTime, but cheap to
      // assert) must not be counted in sampleSize while quantiles() silently
      // excludes it — that would over-count the sample and could falsely clear
      // the p90/p95 floors.
      if (!Number.isFinite(result.cycleTimeSeconds)) continue
      const doneMs = new Date(result.firstDoneAt).getTime()
      if (doneMs < fromMs || doneMs > toMs) continue
      perIssue.push(result)
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
