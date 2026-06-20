/**
 * Peer-baseline normalization (PREREQ-2) — the FAIR way to place a person's
 * metric against their team. Compares a person to the cohort DISTRIBUTION via a
 * robust z-score (median + MAD, resistant to one dominant author) and an
 * empirical percentile — never a sorted rank. Below a cohort-size floor the
 * comparison is SUPPRESSED (returns band 'insufficient_cohort') rather than
 * emitting an authoritative-looking band on noise.
 *
 * Pure + deterministic. Reuses the pinned stats primitives in report/baseline.
 */

import { percentileRank, robustSd, summarize } from '../../report/baseline/stats.js'

/** Below this many human peers, peer comparison is statistically meaningless. */
export const MIN_COHORT = 8

/** Keep only human persons (drop bot-only persons) for a peer cohort. */
export function selectHumanCohort(persons) {
  return (persons ?? []).filter((p) => !p.isBot)
}

/**
 * Place `personValue` within the cohort distribution.
 * @param personValue  the person's metric value (may be null)
 * @param cohortValues the SAME metric across the human cohort (incl. the person)
 * @param opts.polarity +1 if higher is better, -1 if lower is better (default +1)
 * @param opts.minCohort cohort-size floor (default MIN_COHORT)
 * Returns { value, percentile, robustZ, band, cohortN, suppressed, direction }.
 *  band: 'typical' (|z|<1) | 'notable' (1<=|z|<2) | 'outlier' (|z|>=2) | 'insufficient_cohort'.
 *  direction: 'above' | 'below' | 'at' the cohort median (polarity-agnostic), or null.
 */
export function comparePersonToCohort(personValue, cohortValues, opts = {}) {
  const minCohort = opts.minCohort ?? MIN_COHORT
  const polarity = opts.polarity ?? 1
  const clean = (cohortValues ?? []).filter((v) => v !== null && Number.isFinite(v))
  const cohortN = clean.length

  if (personValue === null || !Number.isFinite(personValue) || cohortN < minCohort) {
    return {
      value: Number.isFinite(personValue) ? personValue : null,
      percentile: null,
      robustZ: null,
      band: 'insufficient_cohort',
      cohortN,
      suppressed: true,
      direction: null,
    }
  }

  const stats = summarize(clean)
  const rawZ = (personValue - stats.p50) / robustSd(stats)
  // polarity orients the z so a positive value always means "better than typical".
  const robustZ = rawZ * polarity
  const percentile = percentileRank(clean, personValue)
  const a = Math.abs(rawZ)
  const band = a < 1 ? 'typical' : a < 2 ? 'notable' : 'outlier'
  const direction = rawZ > 0 ? 'above' : rawZ < 0 ? 'below' : 'at'

  return { value: personValue, percentile, robustZ, band, cohortN, suppressed: false, direction }
}
