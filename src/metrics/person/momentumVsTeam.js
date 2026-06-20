import { ENGINE_VERSION } from '../../core/index.js'

const DOC =
  'Momentum vs Team Drift (person scope, difference-in-differences): compares how a ' +
  "person's own trend is moving against how the team's trend is moving over the SAME " +
  'window — value = (personDriftZ - teamDriftZ) * polarity. Because both inputs are ' +
  'trend-to-trend (drift) z-scores, any org-wide swing that lifts or drops everyone ' +
  'cancels out, isolating the individual signal. polarity (+1 higher-better, -1 ' +
  'lower-better) orients the metric so a positive value always reads as moving the ' +
  'preferred direction faster than the cohort. This is explicitly NOT level-vs-peers: ' +
  'it never says someone is above or below the team, only whether their recent change ' +
  "is out-pacing, tracking, or lagging the team's recent change. interpretation bands " +
  'the value: outpacing team (>0.5), lagging team (<-0.5), tracking team otherwise. ' +
  'An evaluative signal about relative trajectory — being "in step with the team" is a ' +
  'healthy, normal reading, not a deficiency.'

/**
 * Person-scope difference-in-differences of self-baseline drift vs team drift. Inputs
 * are pre-aggregated drift z-scores supplied by the caller:
 *   personDriftZ — the person's own trend-to-trend drift z-score (null when unknown)
 *   teamDriftZ   — the team's trend-to-trend drift z-score over the same window (null)
 *   polarity     — +1 higher-better (default), -1 lower-better
 * Pure + deterministic: a single difference, oriented by polarity.
 */
export const momentumVsTeam = {
  id: 'person.momentum_vs_team',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const personDriftZ = inputs.personDriftZ ?? null
    const teamDriftZ = inputs.teamDriftZ ?? null
    const polarity = inputs.polarity ?? 1
    const base = {
      id: 'person.momentum_vs_team',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'zscore',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      personDriftZ,
      teamDriftZ,
    }

    // Either drift unknown → nothing to difference.
    if (personDriftZ === null || teamDriftZ === null) {
      return { ...base, value: null, dataQuality: 'no_data', interpretation: 'no_data' }
    }

    const value = (personDriftZ - teamDriftZ) * polarity
    const interpretation =
      value > 0.5 ? 'outpacing team' : value < -0.5 ? 'lagging team' : 'tracking team'
    return { ...base, value, dataQuality: 'ok', interpretation }
  },
}
