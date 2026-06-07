/**
 * Deterministic evidence-relevance guard — SPEC §9.1.5, WP-AI-ALIGNMENT
 *
 * A criterion may only be 'yes' if:
 *   1. A non-empty diff quote is supplied in the evidence field.
 *   2. The quoted hunk comes from a file/symbol the criterion plausibly
 *      touches — i.e. the hunk's relevance score meets a minimum threshold.
 *
 * If either condition fails, the covered status is demoted to 'unclear'.
 * This prevents a real-but-irrelevant quote (e.g. a logging line for an
 * expiry criterion) from counting as covered.
 */

import { scoreHunkRelevance } from './featurePack.js'
import type { AcceptanceCriterion, CriterionCoverage, DiffHunk } from './types.js'

/**
 * Minimum relevance score for a hunk to be considered relevant evidence
 * for a criterion.  Below this threshold the quote is rejected and the
 * coverage status is demoted to 'unclear'.
 */
export const RELEVANCE_THRESHOLD = 0.05

/**
 * Applies the evidence-relevance guard to an array of per-criterion results.
 *
 * For each criterion:
 *   - If covered === 'yes' and evidence is non-empty, the evidence text is
 *     checked against the criterion using the hunk-relevance scorer.
 *   - If the score is below RELEVANCE_THRESHOLD the status is demoted to
 *     'unclear' (the evidence is real but not relevant).
 *   - 'no' and 'unclear' statuses pass through unchanged.
 *
 * Returns a new array; does not mutate the input.
 */
export function applyEvidenceGuard(
  criteriaResults: CriterionCoverage[],
  allCriteria: AcceptanceCriterion[],
  diffHunks: DiffHunk[],
): CriterionCoverage[] {
  return criteriaResults.map((result) => {
    if (result.covered !== 'yes') return result

    // 'yes' requires a non-empty evidence quote
    if (!result.evidence.trim()) {
      return { ...result, covered: 'unclear' }
    }

    // Find the criterion text for this index
    const criterion = allCriteria.find((c) => c.index === result.index)
    if (!criterion) {
      // Unknown criterion index — demote to unclear
      return { ...result, covered: 'unclear' }
    }

    // Score the evidence text as if it were a hunk against this criterion
    const score = scoreHunkRelevance(result.evidence, [criterion])

    if (score < RELEVANCE_THRESHOLD) {
      // Evidence is real but not relevant to this criterion
      return { ...result, covered: 'unclear' }
    }

    // Also check whether the evidence matches at least one ranked hunk
    // (the quoted text should come from an actual diff hunk)
    const matchesHunk = diffHunks.some(
      (h) =>
        h.relevanceScore >= RELEVANCE_THRESHOLD &&
        (h.content.includes(result.evidence.trim()) ||
          result.evidence.trim().includes(h.content.trim().slice(0, 40))),
    )

    if (diffHunks.length > 0 && !matchesHunk) {
      // Evidence doesn't correspond to any ranked hunk — demote
      return { ...result, covered: 'unclear' }
    }

    return result
  })
}

/**
 * Computes coverage_ratio deterministically from the guarded criteria array.
 * This is always computed in code, never by the LLM (§9.1.4).
 */
export function computeCoverageRatio(guardedCriteria: CriterionCoverage[]): number {
  if (guardedCriteria.length === 0) return 0
  const covered = guardedCriteria.filter((c) => c.covered === 'yes').length
  return covered / guardedCriteria.length
}

/**
 * Maps a coverage_ratio to an ordinal band (0–4).
 * Bands: 0=0%, 1=1–24%, 2=25–49%, 3=50–74%, 4=75–100%.
 */
export function coverageRatioToOrdinal(ratio: number): '0' | '1' | '2' | '3' | '4' {
  if (ratio <= 0) return '0'
  if (ratio < 0.25) return '1'
  if (ratio < 0.5) return '2'
  if (ratio < 0.75) return '3'
  return '4'
}

/**
 * Applies the min-rule: final ordinal = min(llmOrdinal, coverageOrdinal).
 * Both are enum strings '0'–'4'; lower ordinal wins.
 */
export function applyMinRule(
  llmOrdinal: '0' | '1' | '2' | '3' | '4',
  coverageOrdinal: '0' | '1' | '2' | '3' | '4',
): '0' | '1' | '2' | '3' | '4' {
  const n = Math.min(Number(llmOrdinal), Number(coverageOrdinal))
  return String(n) as '0' | '1' | '2' | '3' | '4'
}
