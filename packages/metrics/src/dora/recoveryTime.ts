/**
 * Failed-Deployment Recovery Time — DORA Group A (SPEC §8.1)
 *
 * Metric 1: recoveryTime — median(first_resolved − created) over incidents.
 *   Anchor: FIRST Done transition, not last (per SPEC §8.1 + §8.6 reopen policy).
 *   "A reopened incident is 1h-then-reopened, not 25h."
 *
 * Metric 2: reopenRate — separate counter (reopened incidents / total incidents).
 *   Reopens are tracked separately; they do NOT move the recovery anchor.
 *
 * Returns null when no incidents (no_data).
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, percentile, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { IncidentRecord } from './types.js'

// ---------------------------------------------------------------------------
// Recovery Time
// ---------------------------------------------------------------------------

export interface RecoveryTimeInputs {
  incidents: readonly IncidentRecord[]
}

export interface RecoveryTimeResult extends MetricResult {
  readonly p50Seconds: number | null
  readonly sampleSize: number
}

const RECOVERY_DOC =
  'Failed-Deployment Recovery Time (SPEC §8.1, §8.6): median(firstResolvedAt − createdAt) ' +
  'over incidents linked to failed deployments. Anchor = FIRST Done transition ' +
  '(reopens do not move the anchor — a 1h-resolved-then-reopened incident recovers in 1h, ' +
  'not 25h). Returns null on 0 incidents. Uses type-7 percentile.'

export const recoveryTime: MetricModule<RecoveryTimeInputs, RecoveryTimeResult> = {
  id: 'dora.recovery_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: RECOVERY_DOC,
  params: {},

  compute(inputs, asOf): RecoveryTimeResult {
    const resolved = inputs.incidents.filter((i) => i.firstResolvedAt !== null)

    if (resolved.length === 0) {
      return {
        id: 'dora.recovery_time',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'seconds',
        dataQuality: inputs.incidents.length === 0 ? 'no_data' : 'insufficient_sample',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: RECOVERY_DOC,
        p50Seconds: null,
        sampleSize: 0,
      }
    }

    const durations = resolved.map((i) => {
      const created = new Date(i.createdAt).getTime()
      // firstResolvedAt is guaranteed non-null by the filter above
      const firstResolved = new Date(i.firstResolvedAt as string).getTime()
      // Clamp at 0 — guard against clock skew (§8.6)
      return Math.max(0, (firstResolved - created) / 1000)
    })

    const p50 = percentile(durations, 0.5)

    return {
      id: 'dora.recovery_time',
      trustTier: 'deterministic',
      scope: 'team',
      value: p50,
      unit: 'seconds',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: RECOVERY_DOC,
      p50Seconds: p50,
      sampleSize: resolved.length,
    }
  },
}

// ---------------------------------------------------------------------------
// Reopen Rate (companion metric)
// ---------------------------------------------------------------------------

export interface ReopenRateInputs {
  incidents: readonly IncidentRecord[]
}

export interface ReopenRateResult extends MetricResult {
  readonly rate: number | null
  readonly reopenedCount: number
  readonly totalIncidents: number
}

const REOPEN_DOC =
  'Incident Reopen Rate (SPEC §8.1): reopened_incidents / total_incidents. ' +
  'A reopened incident = incident with reopenCount > 0 in the window. ' +
  'Tracked separately from recovery time (reopens do not move the MTTR anchor). ' +
  'Returns null on 0 incidents.'

export const incidentReopenRate: MetricModule<ReopenRateInputs, ReopenRateResult> = {
  id: 'dora.incident_reopen_rate',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: REOPEN_DOC,
  params: {},

  compute(inputs, asOf): ReopenRateResult {
    const total = inputs.incidents.length

    if (total === 0) {
      return {
        id: 'dora.incident_reopen_rate',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: REOPEN_DOC,
        rate: null,
        reopenedCount: 0,
        totalIncidents: 0,
      }
    }

    const reopened = inputs.incidents.filter((i) => i.reopenCount > 0).length
    const rate = safeRatio(reopened, total)

    return {
      id: 'dora.incident_reopen_rate',
      trustTier: 'deterministic',
      scope: 'team',
      value: rate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: REOPEN_DOC,
      rate,
      reopenedCount: reopened,
      totalIncidents: total,
    }
  },
}
