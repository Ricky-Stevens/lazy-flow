/**
 * Deterministic EWMA / control-chart anomaly detector — SPEC §9.2.3
 *
 * Computes an exponentially-weighted moving average (EWMA) z-score over a
 * throughput or cycle-time series.  A window is flagged anomalous when |z| > 2.
 *
 * Minimum sample requirement (SPEC §9.1 + WP-AI-ANOMALY):
 *   - < MIN_SAMPLE_SIZE data points  → suppress; return null z-scores.
 */

import type { AnomalyDetectionResult, CycleTimePoint, ThroughputPoint } from './types.js'

/** Minimum number of data points required before flagging. */
export const MIN_SAMPLE_SIZE = 8

/** EWMA smoothing factor α — higher = more weight on recent observations. */
const EWMA_ALPHA = 0.3

/**
 * Compute EWMA mean and variance for a numeric series.
 * Returns the z-score of the LAST value.
 */
export function computeEwmaZScore(series: number[]): number | null {
  if (series.length < MIN_SAMPLE_SIZE) return null

  let ewmaMean = series[0] ?? 0
  let ewmaVar = 0

  // Run EWMA up to (but NOT including) the last point.
  // We score the last observation against the already-established baseline so
  // that the anomaly itself does not inflate the variance estimate.
  for (let i = 1; i < series.length - 1; i++) {
    const x = series[i] ?? 0
    const delta = x - ewmaMean
    ewmaMean = ewmaMean + EWMA_ALPHA * delta
    // EWMA variance (running estimate)
    ewmaVar = (1 - EWMA_ALPHA) * (ewmaVar + EWMA_ALPHA * delta * delta)
  }

  const ewmaStd = Math.sqrt(ewmaVar)
  // If std is 0 (perfectly flat history), treat as no anomaly rather than ÷0.
  if (ewmaStd === 0) return 0

  const last = series[series.length - 1] ?? 0
  return (last - ewmaMean) / ewmaStd
}

/**
 * Detect anomalies in throughput and/or cycle-time series.
 *
 * At least one series must be provided.  If both are provided, either
 * crossing the |z| > 2 threshold flags an anomaly.
 */
export function detectAnomaly(opts: {
  throughputSeries?: ThroughputPoint[]
  cycleTimeSeries?: CycleTimePoint[]
}): AnomalyDetectionResult {
  const { throughputSeries = [], cycleTimeSeries = [] } = opts

  const tValues = throughputSeries.map((p) => p.throughput)
  const ctValues = cycleTimeSeries.map((p) => p.cycleTimeMedianSeconds)

  const hasEnoughThroughput = tValues.length >= MIN_SAMPLE_SIZE
  const hasEnoughCycleTime = ctValues.length >= MIN_SAMPLE_SIZE

  if (!hasEnoughThroughput && !hasEnoughCycleTime) {
    return {
      throughputZScore: null,
      cycleTimeZScore: null,
      isAnomaly: false,
      suppressedReason:
        `Insufficient sample: throughput n=${tValues.length}, ` +
        `cycle-time n=${ctValues.length}; minimum is ${MIN_SAMPLE_SIZE} each.`,
    }
  }

  const throughputZScore = hasEnoughThroughput ? computeEwmaZScore(tValues) : null
  const cycleTimeZScore = hasEnoughCycleTime ? computeEwmaZScore(ctValues) : null

  const tAnomalous = throughputZScore !== null && Math.abs(throughputZScore) > 2
  const ctAnomalous = cycleTimeZScore !== null && Math.abs(cycleTimeZScore) > 2
  const isAnomaly = tAnomalous || ctAnomalous

  return {
    throughputZScore,
    cycleTimeZScore,
    isAnomaly,
  }
}
