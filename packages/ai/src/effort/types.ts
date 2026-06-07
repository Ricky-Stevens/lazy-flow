/**
 * Effort Proportionality types — SPEC §9.2.2, WP-AI-EFFORT
 *
 * Every bounded discrete value is a zod enum (never a numeric range).
 * log_ratio is computed deterministically; the LLM only provides the
 * ordinal band and reasoning.
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// Enums (§9.1.4)
// ---------------------------------------------------------------------------

/**
 * Effort proportionality ordinal band.
 * The LLM output is constrained to this enum; no raw magnitude.
 */
export const EffortBand = z.enum(['much_lower', 'lower', 'as_expected', 'higher', 'much_higher'])
export type EffortBand = z.infer<typeof EffortBand>

/**
 * Sentinel value returned when there is insufficient history to judge.
 * This is NOT an ordinal band — it bypasses the LLM entirely.
 */
export const INSUFFICIENT_HISTORY = 'insufficient_history' as const
export type InsufficientHistory = typeof INSUFFICIENT_HISTORY

// ---------------------------------------------------------------------------
// Effort vector
// ---------------------------------------------------------------------------

/**
 * Effort vector computed from the store (SPEC §9.2.2 inputs).
 * All values are deterministic counts/durations — never LLM-generated.
 */
export interface EffortVector {
  /** Σ_hunk max(insertions, deletions) — canonical change-unit (SPEC C2). */
  haloc: number
  /** Number of changed files. */
  files: number
  /** Number of commits in the PR. */
  commits: number
  /**
   * Cycle time in hours from first commit to merge
   * (or from ticket creation to resolution for the issue path).
   */
  cycleTime: number
  /** Number of review rounds (PRs where at least one comment was left then resolved). */
  reviewRounds: number
  /** Total review comments (line + general). */
  comments: number
  /** Number of commits that reverted or reworked a previous commit in this PR. */
  reworkCommits: number
}

// ---------------------------------------------------------------------------
// Historical distribution (team baseline)
// ---------------------------------------------------------------------------

/**
 * Team historical effort distribution for a comparable item window.
 * All fields are pre-computed deterministically from the store.
 */
export interface EffortDistribution {
  /** Number of closed comparable items in the window. */
  n: number
  /** Mean of log(haloc + 1) across the window. */
  logHalocMean: number
  /** Std-dev of log(haloc + 1) across the window. */
  logHalocStd: number
  /** Mean cycle time in hours. */
  cycleTimeMean: number
  /** Std-dev of cycle time in hours. */
  cycleTimeStd: number
}

// ---------------------------------------------------------------------------
// Baseline-readiness gate
// ---------------------------------------------------------------------------

/**
 * Minimum number of closed comparable items required to judge effort.
 * Below this threshold, return 'insufficient_history' instead of a band.
 * Mirrors the sample gate in §9.2.3.
 */
export const EFFORT_MIN_HISTORY_N = 10

// ---------------------------------------------------------------------------
// Issue types exempt from effort proportionality
// ---------------------------------------------------------------------------

/**
 * Issue type strings that are exempt from effort proportionality scoring.
 * Spike and research tasks are inherently exploratory — comparing them to
 * the historical distribution is misleading (SPEC §9.2.2).
 */
export const EXEMPT_ISSUE_TYPES = new Set([
  'spike',
  'research',
  'Spike',
  'Research',
  'SPIKE',
  'RESEARCH',
  'Spke', // common typo
  'investigation',
  'Investigation',
])

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

/** LLM output schema for effort proportionality. */
export const EffortLlmOutput = z.object({
  /** Ordinal band — enum, never a raw number. */
  band: EffortBand,
  /**
   * Free-text reasoning (short, one sentence).
   * Stored in the audit row; not surfaced to users.
   */
  reasoning: z.string(),
  /** Model self-reported confidence in [0, 1]. */
  confidence: z.number(),
})
export type EffortLlmOutput = z.infer<typeof EffortLlmOutput>

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------

export interface EffortResult {
  /**
   * The effort band, or 'insufficient_history' when the baseline gate fails
   * or the issue type is exempt.
   */
  band: EffortBand | InsufficientHistory
  /**
   * log(haloc+1) - logHalocMean, in units of logHalocStd.
   * Computed deterministically; null when history is insufficient.
   */
  logRatio: number | null
  /**
   * Cycle-time z-score computed deterministically.
   * When this disagrees with the LLM band, confidence is lowered.
   * Null when history is insufficient.
   */
  cycleTimeZScore: number | null
  /** Model confidence, potentially lowered by cross-check disagreement. */
  confidence: number
  /** Whether the issue type was exempt (spike/research). */
  exempt: boolean
}
