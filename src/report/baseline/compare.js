import { MIN_BASELINE_N, percentileRank, robustSd, summarize } from './stats.js'

/** Half-a-robust-sd noise band: moves inside this are treated as steady. */
const NOISE_BAND = 0.5

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
  const rs = robustSd(stats)
  const ratio = delta / rs
  const absRatio = Math.abs(ratio)
  const zScore =
    stats.sd !== null && stats.sd > 0 && stats.mean !== null
      ? (value - stats.mean) / stats.sd
      : null

  const trendArrow = absRatio <= NOISE_BAND ? 'steady' : ratio > 0 ? 'up' : 'down'
  const band =
    ratio <= -1.5
      ? 'well_below'
      : ratio < -NOISE_BAND
        ? 'below'
        : absRatio <= NOISE_BAND
          ? 'in_line'
          : ratio < 1.5
            ? 'above'
            : 'well_above'

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
