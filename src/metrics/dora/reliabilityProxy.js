import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Reliability Proxy (SPEC §8.1) — CAVEATED, NOT AUTHORITATIVE: ' +
  '1 − (incident_count / window_days), bounded to [0, 1]. ' +
  'Zero incidents over an observed (non-zero) window scores 1 (best case, ok) — ' +
  'absence of incidents is a real positive signal, not no_data. ' +
  'This is a trend proxy only, not an SLA/SLO/uptime measurement. ' +
  'Use dedicated incident management tooling for authoritative reliability metrics.'

const CAVEAT =
  'This is a proxy metric (SPEC §8.1). It measures incident frequency, not uptime, ' +
  'availability, or SLO compliance. Do not use as a reliability target.'

export const reliabilityProxy = {
  id: 'dora.reliability_proxy',
  trustTier: 'hybrid',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28 },

  compute(inputs, asOf) {
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

    // Zero incidents over a non-zero observed window is the BEST-CASE reliability
    // signal (score = 1), not an absence of data: we did observe the window and
    // saw no incidents. Reporting no_data here would suppress a legitimate
    // positive signal and break trend continuity, so it is 'ok'. (windowDays === 0
    // is the genuine no_data case, handled above.)
    return {
      id: 'dora.reliability_proxy',
      trustTier: 'hybrid',
      scope: 'team',
      value: score,
      unit: 'score',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      incidentRate,
      incidentCount: count,
      caveat: CAVEAT,
    }
  },
}
