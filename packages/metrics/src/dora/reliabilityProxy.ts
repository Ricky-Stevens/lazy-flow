/**
 * Reliability Proxy — DORA Group A (SPEC §8.1)
 *
 * Inverse incident rate/severity — explicitly a proxy, NOT authoritative.
 * Computed as: 1 − (incidents / windowDays) normalised to [0, 1].
 *
 * This is caveated in the output: it is a signal for trend-watching, not an
 * SLA or reliability SLO. The formulaDoc makes this explicit.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { IncidentRecord } from './types.js'

export interface ReliabilityProxyInputs {
  incidents: readonly IncidentRecord[]
  windowDays: number
}

export interface ReliabilityProxyResult extends MetricResult {
  readonly incidentRate: number | null
  readonly incidentCount: number
  readonly caveat: string
}

const FORMULA_DOC =
  'Reliability Proxy (SPEC §8.1) — CAVEATED, NOT AUTHORITATIVE: ' +
  '1 − (incident_count / window_days), bounded to [0, 1]. ' +
  'This is a trend proxy only, not an SLA/SLO/uptime measurement. ' +
  'Use dedicated incident management tooling for authoritative reliability metrics.'

const CAVEAT =
  'This is a proxy metric (SPEC §8.1). It measures incident frequency, not uptime, ' +
  'availability, or SLO compliance. Do not use as a reliability target.'

export const reliabilityProxy: MetricModule<ReliabilityProxyInputs, ReliabilityProxyResult> = {
  id: 'dora.reliability_proxy',
  trustTier: 'hybrid',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28 },

  compute(inputs, asOf): ReliabilityProxyResult {
    const { incidents, windowDays } = inputs
    const count = incidents.length

    if (windowDays === 0) {
      return {
        id: 'dora.reliability_proxy',
        trustTier: 'hybrid',
        scope: 'team',
        value: null,
        unit: 'score',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        incidentRate: null,
        incidentCount: count,
        caveat: CAVEAT,
      }
    }

    const incidentRate = safeRatio(count, windowDays)
    // Clamp to [0, 1]
    const score = incidentRate !== null ? Math.max(0, Math.min(1, 1 - incidentRate)) : null

    return {
      id: 'dora.reliability_proxy',
      trustTier: 'hybrid',
      scope: 'team',
      value: score,
      unit: 'score',
      dataQuality: count === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      incidentRate,
      incidentCount: count,
      caveat: CAVEAT,
    }
  },
}
