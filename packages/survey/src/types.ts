/**
 * Domain types for the survey module.
 *
 * Privacy posture (SPEC §6.5 / §11.1):
 *   - Per-person responses belong to the respondent.
 *   - Aggregate outputs are team-scoped; individual breakdown is only surfaced
 *     under the self-scope (the respondent's own data).
 *   - Minimum-N suppression prevents publishing a dimension score when fewer
 *     than MIN_RESPONSES_PER_DIMENSION responses are available (both privacy
 *     and statistical validity).
 */

import type { SurveyDimension } from './instruments.js'

// ---------------------------------------------------------------------------
// Survey response (storage row)
// ---------------------------------------------------------------------------

/**
 * A single survey submission from one respondent.
 *
 * The `personId` field links to the `persons` table in the core store.
 * Per the privacy posture, this is the respondent's own identifier —
 * team aggregates are produced from the collection of responses without
 * exposing individual scores.
 */
export interface SurveyResponse {
  /** UUID for this submission. */
  readonly id: string
  /**
   * The respondent's person id (FK → persons.id in the core store).
   * Nullable to support anonymous responses (eNPS-style).
   */
  readonly personId: string | null
  /** Team scope (FK → teams.id in the core store). */
  readonly teamId: string
  /** The instrument that was answered (matches SurveyInstrument.id). */
  readonly instrumentId: string
  /** The instrument version at the time of submission. */
  readonly instrumentVersion: string
  /**
   * Per-question scores as a JSON object: { [questionId]: 1-5 }.
   * All question ids in the instrument must be present.
   */
  readonly scores: Record<string, number>
  /** ISO-8601 timestamp when the response was submitted. */
  readonly submittedAt: string
}

// ---------------------------------------------------------------------------
// Dimension score (computed aggregate)
// ---------------------------------------------------------------------------

/**
 * Aggregate perceptual score for one dimension, computed from a collection
 * of survey responses.
 *
 * NEVER produced from system/workflow data — only from survey responses.
 * NEVER labelled "DXI" unless explicitly computed from an open survey module.
 */
export interface DimensionScore {
  readonly dimension: SurveyDimension
  /**
   * Mean score across all respondents and items in this dimension (1–5 scale).
   * null when suppressed by minimum-N (see data_quality).
   */
  readonly mean: number | null
  /**
   * Percentile distribution of per-respondent mean scores.
   * null when suppressed.
   */
  readonly distribution: {
    readonly p50: number
    readonly p75: number
    readonly p85: number
    readonly p90: number
    readonly p95: number
  } | null
  /** Number of responses included in this score. */
  readonly n: number
  readonly dataQuality: 'ok' | 'insufficient_sample' | 'no_data'
  /**
   * Published formula description — documents exactly how the score was
   * computed (the open-formula anti-black-box differentiator).
   */
  readonly formulaDoc: string
}

// ---------------------------------------------------------------------------
// Team aggregate result
// ---------------------------------------------------------------------------

/** Aggregate perceptual scores for a team across all surveyed dimensions. */
export interface TeamSurveyAggregate {
  readonly teamId: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly dimensions: Partial<Record<SurveyDimension, DimensionScore>>
  /**
   * Optional composite index — ONLY present when survey data for all four
   * dimensions is available AND the minimum-N floor is met for each.
   * Computed as the unweighted mean of the four dimension means (1–5 scale).
   * Never labelled "DXI" — this is an open, named composite with a published
   * formula.
   */
  readonly compositeScore: CompositeScore | null
}

/**
 * An open composite perceptual index, computed purely from survey responses.
 *
 * SPEC §2.2 N4: labelled "LazyFlow Perceptual Index (LPI)", never "DXI".
 * Formula is published in formulaDoc.
 */
export interface CompositeScore {
  /**
   * Unweighted mean of the four dimension means. Null when any dimension is
   * suppressed (minimum-N not met).
   */
  readonly value: number | null
  readonly n: number
  readonly dataQuality: 'ok' | 'insufficient_sample' | 'no_data'
  readonly formulaDoc: string
}
