import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Reliability Proxy (SPEC §8.1) — CAVEATED, NOT AUTHORITATIVE: ' +
  'score = 1 / (1 + incident_count / window_days), in (0, 1]. ' +
  'Non-saturating by design: a previous 1 − rate clamp pinned ANY window with ' +
  '≥ windowDays incidents to exactly 0, so 1/day and 100/day scored identically — ' +
  'the metric lost all signal precisely at the bad end. 1/(1+rate) keeps ranking ' +
  'worse-from-bad while staying bounded. Zero incidents over an observed (non-zero) ' +
  'window scores 1 (best case, ok). Trend proxy only, not an SLA/SLO/uptime ' +
  'measurement. Use dedicated incident tooling for authoritative reliability.'

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
    // Non-saturating bounded transform: 1/(1+rate) ∈ (0, 1]. Unlike the previous
    // 1 − rate clamp, this never floors at 0, so a 10× worse incident rate still
    // reports a distinctly lower (worse) score instead of an uninformative 0.
    const score = incidentRate !== null ? 1 / (1 + incidentRate) : null

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
