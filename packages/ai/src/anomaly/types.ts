/**
 * Velocity Anomaly Explanation types — SPEC §9.2.3, WP-AI-ANOMALY
 *
 * Every bounded discrete value is a zod enum (§9.1.4).
 * Cause attribution is systemic only — never individual.
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// Deterministic detection
// ---------------------------------------------------------------------------

export interface ThroughputPoint {
  /** ISO date string for the window start (e.g. start of sprint/week). */
  windowStart: string
  /** Number of items completed in this window. */
  throughput: number
}

export interface CycleTimePoint {
  /** ISO date string for the window start. */
  windowStart: string
  /** Median cycle time in seconds for this window. */
  cycleTimeMedianSeconds: number
}

export interface AnomalyDetectionResult {
  /** EWMA-based z-score for throughput (may be null if sample too small). */
  throughputZScore: number | null
  /** EWMA-based z-score for cycle-time (may be null if sample too small). */
  cycleTimeZScore: number | null
  /** Whether an anomaly was detected: |z| > 2 on either series. */
  isAnomaly: boolean
  /** Reason not flagged: sample too small, no series data, etc. */
  suppressedReason?: string
}

// ---------------------------------------------------------------------------
// Signal pack (deterministic inputs for LLM cause ranking)
// ---------------------------------------------------------------------------

export interface AnomalySignalPack {
  /** Average WIP items in the anomaly window. */
  avgWip: number
  /** Median reviewer latency in hours. */
  reviewerLatencyHours: number
  /** Count of issues in BLOCKED status during the window. */
  blockedCount: number
  /** Count of ticket re-opens + acceptance-criteria edits in the window. */
  ticketChurnCount: number
  /** Net change in team head-count during the window (positive = growth). */
  teamSizeDelta: number
  /** Fraction of PRs with haloc > 400 (large-PR proxy). */
  largePrShare: number
  /** Count of incidents opened in the window. */
  incidentCount: number
  /** Sum of external-dependency blocked hours in the window. */
  dependencyWaitHours: number
  /** Throughput z-score (from detection). */
  throughputZScore: number | null
  /** Cycle-time z-score (from detection). */
  cycleTimeZScore: number | null
}

// ---------------------------------------------------------------------------
// Closed-menu cause enum (SPEC §9.2.3)
// ---------------------------------------------------------------------------

export const AnomalyCause = z.enum([
  'high_wip',
  'reviewer_latency',
  'blocked_issues',
  'ticket_churn',
  'team_size_change',
  'large_pr_overhead',
  'incident_response',
  'dependency_wait',
  'insufficient_signal',
])
export type AnomalyCause = z.infer<typeof AnomalyCause>

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

/**
 * A single ranked cause with its evidence pointer.
 * Phrasing must be "consistent with", never "caused by".
 */
export const RankedCause = z.object({
  cause: AnomalyCause,
  /**
   * Self-reported likelihood in [0, 1].
   * Required even for 'insufficient_signal' (set to 0).
   */
  confidence: z.number().min(0).max(1),
  /**
   * Which signal-pack field this cause is grounded in.
   * MUST name a key from AnomalySignalPack.
   * Required per SPEC — prevents invention.
   */
  evidence_pointer: z.string(),
})
export type RankedCause = z.infer<typeof RankedCause>

export const AnomalyLlmOutput = z.object({
  /**
   * Causes ranked from most-likely to least-likely.
   * When the model cannot rank due to weak signals, emit a single entry
   * with cause='insufficient_signal'.
   */
  ranked_causes: z.array(RankedCause).min(1),
  /** Free-form explanation phrased "consistent with", never "caused by". */
  summary: z.string(),
})
export type AnomalyLlmOutput = z.infer<typeof AnomalyLlmOutput>

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface AnomalyResult {
  /** Deterministic detection result. */
  detection: AnomalyDetectionResult
  /**
   * Ranked causes — undefined if detection did not flag an anomaly
   * or the sample was too small.
   */
  rankedCauses?: RankedCause[]
  /** Human-readable summary (phrased "consistent with"). */
  summary?: string
}
