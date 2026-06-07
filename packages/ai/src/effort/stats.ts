/**
 * Deterministic effort statistics — SPEC §9.2.2, WP-AI-EFFORT
 *
 * All computations here are purely deterministic — no LLM involvement.
 * The LLM receives the log_ratio and cycle-time z-score as evidence,
 * and returns only an ordinal band (never a raw magnitude).
 */

import type { EffortBand, EffortDistribution, EffortVector } from './types.js'
import { EffortBand as EffortBandEnum } from './types.js'

// ---------------------------------------------------------------------------
// Log-ratio computation
// ---------------------------------------------------------------------------

/**
 * Computes log(haloc+1) - mean, in std-dev units (z-score in log space).
 * Returns null when std is 0 (degenerate distribution — all items identical).
 */
export function computeLogRatio(vector: EffortVector, dist: EffortDistribution): number | null {
  if (dist.logHalocStd === 0) return null
  const logHaloc = Math.log(vector.haloc + 1)
  return (logHaloc - dist.logHalocMean) / dist.logHalocStd
}

/**
 * Computes cycle-time z-score: (cycleTime - mean) / std.
 * Returns null when std is 0.
 */
export function computeCycleTimeZScore(
  vector: EffortVector,
  dist: EffortDistribution,
): number | null {
  if (dist.cycleTimeStd === 0) return null
  return (vector.cycleTime - dist.cycleTimeMean) / dist.cycleTimeStd
}

// ---------------------------------------------------------------------------
// Band mapping for cross-check
// ---------------------------------------------------------------------------

/**
 * Maps a z-score to an effort band for cross-checking.
 * Uses symmetric thresholds: |z|<0.5 → as_expected, etc.
 */
export function zScoreToEffortBand(z: number): EffortBand {
  if (z < -2) return 'much_lower'
  if (z < -0.5) return 'lower'
  if (z <= 0.5) return 'as_expected'
  if (z <= 2) return 'higher'
  return 'much_higher'
}

/**
 * Maps a log-ratio to an effort band.
 * Same thresholds as zScoreToEffortBand.
 */
export function logRatioToEffortBand(logRatio: number): EffortBand {
  return zScoreToEffortBand(logRatio)
}

// ---------------------------------------------------------------------------
// Cross-check: disagrement detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the LLM band and the deterministic cycle-time band
 * differ by more than one step.  Disagreement lowers confidence.
 */
export function detectDisagreement(llmBand: EffortBand, deterministicBand: EffortBand): boolean {
  const values = EffortBandEnum.options
  const llmIdx = values.indexOf(llmBand)
  const detIdx = values.indexOf(deterministicBand)
  return Math.abs(llmIdx - detIdx) > 1
}

/**
 * Lowers confidence when the LLM band disagrees with the deterministic
 * cycle-time z-score band (§9.2.2 cross-check).
 * Returns the adjusted confidence value.
 */
export function adjustConfidenceForDisagreement(
  baseConfidence: number,
  llmBand: EffortBand,
  cycleTimeZScore: number | null,
): number {
  if (cycleTimeZScore === null) return baseConfidence
  const deterministicBand = zScoreToEffortBand(cycleTimeZScore)
  if (detectDisagreement(llmBand, deterministicBand)) {
    // Penalise by 0.2 — meaningful but not catastrophic
    return Math.max(0, baseConfidence - 0.2)
  }
  return baseConfidence
}
