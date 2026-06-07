/**
 * Aging WIP / Work-Item-Age — Flow Group B (SPEC §8.2)
 *
 * For each issue currently in progress (WIP), report how long it has
 * been open (age = now − createdAt).  Highlight issues above configurable
 * age percentile thresholds.
 *
 * formulaDoc:
 *   For each issue in WIP (currently in a started column at asOf),
 *   ageSeconds = now − createdAt.
 *   Distribution: p50/p75/p85/p90/p95 over open issues' ages.
 *   Issues above p85 are flagged as aging alerts.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowBoardColumn, FlowIssueRecord } from './types.js'

export interface AgingWipInputs {
  issues: readonly FlowIssueRecord[]
  boardColumns: readonly FlowBoardColumn[]
  now: string
}

export interface AgingWipItem {
  issueId: string
  issueType: string
  ageSeconds: number
  currentStatusId: string
  isAgingAlert: boolean
}

export interface AgingWipResult extends MetricResult {
  readonly wipItems: readonly AgingWipItem[]
  readonly wipCount: number
  readonly p50Seconds: number | null
  readonly p75Seconds: number | null
  readonly p85Seconds: number | null
  readonly p90Seconds: number | null
  readonly p95Seconds: number | null
  /** Threshold in seconds above which items are flagged (= p85 or 0 if no data). */
  readonly alertThresholdSeconds: number | null
}

const FORMULA_DOC =
  'Aging WIP (SPEC §8.2): For each issue currently in WIP (isStartedCol=true column), ' +
  'ageSeconds = now − createdAt. ' +
  'Distribution: p50/p75/p85/p90/p95 via R-7. ' +
  'Issues above p85 flagged as aging alerts. ' +
  'Sample floors: n≥20 for p90, n≥30 for p95.'

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

export const agingWip: MetricModule<AgingWipInputs, AgingWipResult> = {
  id: 'flow.aging_wip',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): AgingWipResult {
    const startedIds = buildStartedStatusIds(inputs.boardColumns)
    const doneIds = buildDoneStatusIds(inputs.boardColumns)
    const nowMs = new Date(inputs.now).getTime()

    const wipItems: AgingWipItem[] = []

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
      const ageSeconds = safeRatio(ageMs, 1000) as number

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
