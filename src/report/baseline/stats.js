/**
 * Baseline statistics — summary distribution, robust dispersion, and drift.
 * Percentiles come from core's pinned type-7 algorithm; mean/sd/MAD from
 * simple-statistics (no hand-rolled stats). Pure + deterministic.
 */

import { medianAbsoluteDeviation, sampleStandardDeviation, mean as ssMean } from 'simple-statistics'

import { meetsSampleFloor, percentile } from '../../core/index.js'

/** Below this baseline sample size, comparisons are suppressed (establishing). */
export const MIN_BASELINE_N = 5
/** Sprint-window equivalent floor. */
export const MIN_BASELINE_SPRINTS = 3
/** Bumps when this aggregation algorithm changes (distinct from ENGINE_VERSION). */
export const BASELINE_VERSION = '1'

const EPS = 1e-9

function clean(values) {
  return values.filter((v) => v !== null && Number.isFinite(v))
}

/** Summarise a set of metric values into a baseline distribution. */
export function summarize(values) {
  const xs = clean(values)
  const n = xs.length
  if (n === 0) {
    return { n: 0, p50: null, p75: null, p90: null, mean: null, sd: null, mad: null }
  }
  return {
    n,
    p50: percentile(xs, 0.5),
    p75: percentile(xs, 0.75),
    // p90 needs the sample floor (n >= 20) or it's not trustworthy.
    p90: meetsSampleFloor(n, 0.9) ? percentile(xs, 0.9) : null,
    mean: ssMean(xs),
    sd: n >= 2 ? sampleStandardDeviation(xs) : null,
    mad: medianAbsoluteDeviation(xs),
  }
}

/** Robust dispersion: max(sd, 1.4826·MAD, ε). Never zero (so z-scores are finite). */
export function robustSd(stats) {
  return Math.max(stats.sd ?? 0, 1.4826 * (stats.mad ?? 0), EPS)
}

/** Classify drift of a new p50 against the prior baseline (deterministic, no AI). */
export function classifyDrift(newP50, prev) {
  if (prev === null || prev.p50 === null || newP50 === null) {
    return { driftZ: null, driftStatus: 'cold_start' }
  }
  const z = (newP50 - prev.p50) / robustSd(prev)
  const a = Math.abs(z)
  const driftStatus = a < 1 ? 'stable' : a < 2 ? 'shifting' : 'regime_change'
  return { driftZ: z, driftStatus }
}

/** Empirical CDF: fraction of baseline values <= v, in [0,1]; null when no data. */
export function percentileRank(values, v) {
  const xs = clean(values)
  if (xs.length === 0) return null
  const le = xs.filter((x) => x <= v).length
  return le / xs.length
}
