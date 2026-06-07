/**
 * Survey scoring — aggregate survey responses into dimension scores and an
 * optional composite index.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  OPEN, PUBLISHED FORMULAS — the anti-black-box differentiator           │
 * │                                                                          │
 * │  All formulas are documented in `formulaDoc` strings so they can be     │
 * │  surfaced in-product. No part of any score is derived from system /     │
 * │  workflow data — SURVEY RESPONSES ONLY (SPEC §2.2 N4).                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Scoring pipeline:
 *   1. For each response, compute a per-respondent mean across the items
 *      belonging to each dimension (item scores 1–5, all positive-direction
 *      in v1 instruments — no reversal needed).
 *   2. Collect those per-respondent means into a distribution.
 *   3. Report: n, mean of means, and quantile distribution (p50/p75/p85/p90/p95).
 *   4. Minimum-N suppression: if n < MIN_RESPONSES_PER_DIMENSION, suppress
 *      the score (data_quality = 'insufficient_sample') — privacy + stat validity.
 *   5. Optional composite (LPI — LazyFlow Perceptual Index): unweighted mean
 *      of all four dimension means, only when all dimensions have sufficient N.
 *      NEVER labelled "DXI" (SPEC §2.2 N4 / RESEARCH.md §2.4).
 *
 * Percentile method: type-7 / R-7 linear interpolation, imported from
 * @lazy-flow/core (same pinned algorithm used by the deterministic engine,
 * SPEC §8.6).
 */

import { percentile, quantiles } from '@lazy-flow/core'
import type { SurveyDimension, SurveyInstrument } from './instruments.js'
import { ALL_INSTRUMENTS } from './instruments.js'
import type {
  CompositeScore,
  DimensionScore,
  SurveyResponse,
  TeamSurveyAggregate,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum number of survey responses required before a dimension score is
 * published. Below this floor, data_quality = 'insufficient_sample'.
 *
 * Rationale: team sizes vary widely; a floor of 3 allows very small teams
 * (≤5 members) to see some signal while preventing a single outlier from
 * dominating. Operators may raise this threshold.
 */
export const MIN_RESPONSES_PER_DIMENSION = 3

// ---------------------------------------------------------------------------
// Published formula strings
// ---------------------------------------------------------------------------

const DIMENSION_FORMULA_DOC =
  'Per-respondent mean: for each response, compute the mean of scores for ' +
  'all items in the dimension (scale 1–5). Collect per-respondent means into ' +
  'a distribution. Report: n (response count), mean of per-respondent means, ' +
  'and type-7 / R-7 linear-interpolation percentiles (p50/p75/p85/p90/p95) ' +
  'over the per-respondent means. Minimum n = ' +
  String(MIN_RESPONSES_PER_DIMENSION) +
  ' to publish; below that, score is suppressed (data_quality=insufficient_sample). ' +
  'SOURCE: survey responses only — never from system / workflow data (SPEC §2.2 N4). ' +
  'Items are all positive-direction (higher = better) in v1 instruments.'

const COMPOSITE_FORMULA_DOC =
  'LazyFlow Perceptual Index (LPI): unweighted mean of four dimension means — ' +
  'DevEx Feedback Loops, DevEx Cognitive Load, DevEx Flow State, SPACE Satisfaction. ' +
  'All dimensions must meet the minimum-N floor; otherwise composite is suppressed. ' +
  'Formula: LPI = (mean_feedback_loops + mean_cognitive_load + mean_flow_state + ' +
  'mean_satisfaction) / 4. Scale 1–5. NEVER labelled "DXI" — this is an open index ' +
  'with a published formula (SPEC §2.2 N4 / RESEARCH.md §2.4). ' +
  'SOURCE: survey responses only.'

// ---------------------------------------------------------------------------
// Core scoring helpers
// ---------------------------------------------------------------------------

/**
 * Given a list of per-respondent scores for a single dimension, compute the
 * DimensionScore. `respondentMeans` may be empty (suppressed to 'no_data').
 */
export function scoreDimension(
  dimension: SurveyDimension,
  respondentMeans: readonly number[],
  minN: number = MIN_RESPONSES_PER_DIMENSION,
): DimensionScore {
  const n = respondentMeans.length

  if (n === 0) {
    return {
      dimension,
      mean: null,
      distribution: null,
      n: 0,
      dataQuality: 'no_data',
      formulaDoc: DIMENSION_FORMULA_DOC,
    }
  }

  if (n < minN) {
    return {
      dimension,
      mean: null,
      distribution: null,
      n,
      dataQuality: 'insufficient_sample',
      formulaDoc: DIMENSION_FORMULA_DOC,
    }
  }

  // Mean of per-respondent means
  const sum = respondentMeans.reduce((acc, v) => acc + v, 0)
  const mean = sum / n

  // Percentile distribution over per-respondent means
  const q = quantiles(respondentMeans)

  return {
    dimension,
    mean,
    distribution: q ?? null,
    n,
    dataQuality: 'ok',
    formulaDoc: DIMENSION_FORMULA_DOC,
  }
}

/**
 * For a single SurveyResponse, extract the per-respondent mean score for a
 * given dimension. Returns null if no items in the response match the
 * dimension.
 *
 * Looks up items from the instrument registry to determine which question ids
 * belong to each dimension.
 */
export function respondentMeanForDimension(
  response: SurveyResponse,
  dimension: SurveyDimension,
  instruments: readonly SurveyInstrument[] = ALL_INSTRUMENTS,
): number | null {
  // Find the instrument for this response
  const instrument = instruments.find(
    (i) => i.id === response.instrumentId && i.version === response.instrumentVersion,
  )
  if (instrument === undefined) return null

  // Find items for this dimension
  const dimensionItems = instrument.items.filter((item) => item.dimension === dimension)
  if (dimensionItems.length === 0) return null

  // Collect scores for those items, reverse-scoring flagged items so a high raw
  // answer on a negatively-worded item doesn't inflate the dimension mean.
  // On the 1–5 Likert scale the reverse of `s` is `6 - s`.
  const scores: number[] = []
  for (const item of dimensionItems) {
    const score = response.scores[item.id]
    if (typeof score === 'number' && score >= 1 && score <= 5) {
      scores.push(item.reversed ? 6 - score : score)
    }
  }

  if (scores.length === 0) return null

  return scores.reduce((acc, v) => acc + v, 0) / scores.length
}

// ---------------------------------------------------------------------------
// Team aggregate
// ---------------------------------------------------------------------------

const ALL_DIMENSIONS: readonly SurveyDimension[] = [
  'devex_feedback_loops',
  'devex_cognitive_load',
  'devex_flow_state',
  'space_satisfaction',
]

/**
 * Compute team-aggregate perceptual scores from a list of survey responses.
 *
 * @param responses - All responses for the team in the window (from SurveyStore.listTeamResponses).
 * @param teamId    - The team this aggregate is for.
 * @param windowStart / windowEnd - ISO-8601 window boundaries (inclusive).
 * @param minN      - Override the minimum-N floor (default: MIN_RESPONSES_PER_DIMENSION).
 * @param instruments - Override the instrument registry (for testing).
 */
export function computeTeamAggregate(opts: {
  responses: readonly SurveyResponse[]
  teamId: string
  windowStart: string
  windowEnd: string
  minN?: number
  instruments?: readonly SurveyInstrument[]
}): TeamSurveyAggregate {
  const {
    responses,
    teamId,
    windowStart,
    windowEnd,
    minN = MIN_RESPONSES_PER_DIMENSION,
    instruments = ALL_INSTRUMENTS,
  } = opts

  const dimensionScores: Partial<Record<SurveyDimension, DimensionScore>> = {}

  for (const dimension of ALL_DIMENSIONS) {
    // Collect per-respondent means for this dimension
    const respondentMeans: number[] = []
    for (const response of responses) {
      const mean = respondentMeanForDimension(response, dimension, instruments)
      if (mean !== null) {
        respondentMeans.push(mean)
      }
    }
    dimensionScores[dimension] = scoreDimension(dimension, respondentMeans, minN)
  }

  // Composite (LPI) — only when all four dimensions are 'ok'
  const compositeScore = computeComposite(dimensionScores, minN)

  return {
    teamId,
    windowStart,
    windowEnd,
    dimensions: dimensionScores,
    compositeScore,
  }
}

// ---------------------------------------------------------------------------
// Composite score (LPI)
// ---------------------------------------------------------------------------

/**
 * Compute the LazyFlow Perceptual Index from four dimension scores.
 * Returns null when any dimension is suppressed (minimum-N not met).
 *
 * NEVER labelled "DXI" — this is an open composite with a published formula.
 */
export function computeComposite(
  dimensions: Partial<Record<SurveyDimension, DimensionScore>>,
  // _minN is reserved for future use; suppression is already encoded in each
  // dimension's dataQuality field (set by scoreDimension).
  _minN: number = MIN_RESPONSES_PER_DIMENSION,
): CompositeScore | null {
  const requiredDimensions: SurveyDimension[] = [
    'devex_feedback_loops',
    'devex_cognitive_load',
    'devex_flow_state',
    'space_satisfaction',
  ]

  // All four must be present and 'ok'
  const means: number[] = []
  let totalN = 0
  for (const dim of requiredDimensions) {
    const score = dimensions[dim]
    if (score === undefined || score.dataQuality !== 'ok' || score.mean === null) {
      // At least one dimension suppressed — composite is suppressed
      const anyDimensionExists = requiredDimensions.some((d) => {
        const s = dimensions[d]
        return s !== undefined && s.n > 0
      })
      const dataQuality = anyDimensionExists ? 'insufficient_sample' : 'no_data'
      return {
        value: null,
        n: 0,
        dataQuality,
        formulaDoc: COMPOSITE_FORMULA_DOC,
      }
    }
    means.push(score.mean)
    totalN += score.n
  }

  // Unweighted mean of the four dimension means
  const sum = means.reduce((acc, v) => acc + v, 0)
  const value = sum / means.length

  return {
    value,
    n: totalN,
    dataQuality: 'ok',
    formulaDoc: COMPOSITE_FORMULA_DOC,
  }
}

// ---------------------------------------------------------------------------
// Guard: no perceptual score from system data
// ---------------------------------------------------------------------------

/**
 * SPEC §2.2 N4 invariant guard.
 *
 * Every function in this module that produces a perceptual score takes survey
 * responses (SurveyResponse[]) as input — never raw system/workflow data
 * (commit counts, PR timings, etc.). This function is a runtime assertion of
 * that invariant.
 *
 * It checks that each response has a non-empty `scores` record (Likert data)
 * and an `instrumentId` from the known instrument registry, confirming that
 * the input came from a survey rather than being synthetically generated from
 * system data.
 *
 * Throws if any response fails the check.
 */
export function assertSurveySourced(
  responses: readonly SurveyResponse[],
  instruments: readonly SurveyInstrument[] = ALL_INSTRUMENTS,
): void {
  const knownIds = new Set(instruments.map((i) => i.id))
  for (const response of responses) {
    if (!knownIds.has(response.instrumentId)) {
      throw new Error(
        `SurveyResponse ${response.id} has instrumentId "${response.instrumentId}" which is not ` +
          `in the known instrument registry. Perceptual scores must come from a registered survey ` +
          `instrument — they must never be derived from system/workflow data (SPEC §2.2 N4).`,
      )
    }
    if (Object.keys(response.scores).length === 0) {
      throw new Error(
        `SurveyResponse ${response.id} has an empty scores record. ` +
          `A valid survey response must contain at least one scored item (SPEC §2.2 N4).`,
      )
    }
    // Verify every score is a valid Likert value (1–5)
    for (const [qid, score] of Object.entries(response.scores)) {
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        throw new Error(
          `SurveyResponse ${response.id} item "${qid}" has an invalid score ${String(score)}. ` +
            `Scores must be integers in [1, 5] (Likert scale). ` +
            `This check prevents system-derived values from being passed as survey data.`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exported percentile re-export for convenience
// ---------------------------------------------------------------------------

// Re-export so callers don't need to depend on @lazy-flow/core directly
export { percentile }
