import {
  isDegenerateDispersion,
  MIN_BASELINE_N,
  percentileRank,
  robustSd,
  summarize,
} from './stats.js'

/** Half-a-robust-sd noise band: moves inside this are treated as steady. */
const NOISE_BAND = 0.5
/** Relative-change bands used when the baseline has zero dispersion (flat series). */
const FLAT_REL_NOISE = 0.1 // |Δ%| <= 10% from a flat baseline = in line
const FLAT_REL_WELL = 0.25 // |Δ%| >= 25% = well above/below

/** Compare a current value to a baseline computed from the given historical values. */
export function compareToBaseline(opts) {
  const stats = summarize(opts.baselineValues)
  return compareToStats(opts.value, stats, opts.baselineValues)
}

/** Compare against pre-computed stats (+ raw values for the empirical percentile). */
export function compareToStats(value, stats, rawValues) {
  if (stats.n < MIN_BASELINE_N || stats.p50 === null || value === null) {
    return {
      baselineP50: stats.p50,
      delta: null,
      deltaPct: null,
      band: 'unknown',
      trendArrow: 'steady',
      zScore: null,
      percentileWithin: null,
      n: stats.n,
      significant: false,
      note:
        stats.n === 0
          ? 'no baseline data'
          : value === null
            ? 'no current value'
            : `insufficient baseline (n=${stats.n})`,
    }
  }

  const p50 = stats.p50
  const delta = value - p50
  const deltaPct = p50 !== 0 ? delta / p50 : null

  let band
  let trendArrow
  let zScore = null

  if (isDegenerateDispersion(stats)) {
    // Flat baseline: dispersion is undefined and robustSd floors to EPS, so the
    // sd-ratio would flag any micro-move as 'well above baseline'. Judge by the
    // RELATIVE change instead (and treat a non-zero value over a zero baseline as
    // a genuine regime change). zScore stays null — there is no real spread.
    if (delta === 0) {
      band = 'in_line'
      trendArrow = 'steady'
    } else if (p50 === 0) {
      band = delta > 0 ? 'well_above' : 'well_below'
      trendArrow = delta > 0 ? 'up' : 'down'
    } else {
      const relAbs = Math.abs(delta / p50)
      trendArrow = relAbs <= FLAT_REL_NOISE ? 'steady' : delta > 0 ? 'up' : 'down'
      band =
        relAbs <= FLAT_REL_NOISE
          ? 'in_line'
          : relAbs >= FLAT_REL_WELL
            ? delta > 0
              ? 'well_above'
              : 'well_below'
            : delta > 0
              ? 'above'
              : 'below'
    }
  } else {
    const rs = robustSd(stats)
    const ratio = delta / rs
    const absRatio = Math.abs(ratio)
    zScore =
      stats.sd !== null && stats.sd > 0 && stats.mean !== null
        ? (value - stats.mean) / stats.sd
        : null

    trendArrow = absRatio <= NOISE_BAND ? 'steady' : ratio > 0 ? 'up' : 'down'
    band =
      ratio <= -1.5
        ? 'well_below'
        : ratio < -NOISE_BAND
          ? 'below'
          : absRatio <= NOISE_BAND
            ? 'in_line'
            : ratio < 1.5
              ? 'above'
              : 'well_above'
  }

  // Floor already met above; significance is purely "move exceeds the noise band".
  const significant = trendArrow !== 'steady'

  return {
    baselineP50: p50,
    delta,
    deltaPct,
    band,
    trendArrow,
    zScore,
    percentileWithin: percentileRank(rawValues, value),
    n: stats.n,
    significant,
    note: significant ? null : 'within normal variance',
  }
}
