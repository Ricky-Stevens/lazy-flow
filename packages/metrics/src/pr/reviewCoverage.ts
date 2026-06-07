/**
 * Review Coverage, Reviewers-per-PR, Reviewer Load (Gini), Comments-per-PR,
 * Review Iterations, Merge-Without-Review Rate — PR/Review Group C (SPEC §8.3)
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { PrInput, ReviewCommentInput, ReviewInput } from './types.js'

// ---------------------------------------------------------------------------
// Shared input
// ---------------------------------------------------------------------------

export interface ReviewCoverageInputs {
  prs: readonly PrInput[]
  reviews: readonly ReviewInput[]
  reviewComments: readonly ReviewCommentInput[]
  /** Bot identity ids to exclude from reviewer counts. */
  botIdentityIds?: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// Review Coverage
// ---------------------------------------------------------------------------

export interface ReviewCoverageResult extends MetricResult {
  readonly prsWithReview: number
  readonly totalMergedPrs: number
  readonly coverageRate: number | null
}

const COVERAGE_DOC =
  'Review Coverage (SPEC §8.3): merged PRs with at least one non-author review / total merged PRs. ' +
  'Bots excluded from reviewer counts.'

export const reviewCoverage: MetricModule<ReviewCoverageInputs, ReviewCoverageResult> = {
  id: 'pr.review_coverage',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: COVERAGE_DOC,
  params: {},

  compute(inputs, asOf): ReviewCoverageResult {
    const bots = inputs.botIdentityIds ?? new Set<string>()
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')
    const total = mergedPrs.length

    if (total === 0) {
      return {
        id: 'pr.review_coverage',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: COVERAGE_DOC,
        prsWithReview: 0,
        totalMergedPrs: 0,
        coverageRate: null,
      }
    }

    // Build review set
    const reviewsByPr = new Map<string, ReviewInput[]>()
    for (const rev of inputs.reviews) {
      if (!reviewsByPr.has(rev.prId)) reviewsByPr.set(rev.prId, [])
      reviewsByPr.get(rev.prId)?.push(rev)
    }

    let withReview = 0
    for (const pr of mergedPrs) {
      const revs = reviewsByPr.get(pr.id) ?? []
      const nonAuthorHumanReviews = revs.filter(
        (r) => r.reviewerIdentityId !== pr.authorIdentityId && !bots.has(r.reviewerIdentityId),
      )
      if (nonAuthorHumanReviews.length > 0) withReview++
    }

    const rate = safeRatio(withReview, total)

    return {
      id: 'pr.review_coverage',
      trustTier: 'deterministic',
      scope: 'team',
      value: rate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: COVERAGE_DOC,
      prsWithReview: withReview,
      totalMergedPrs: total,
      coverageRate: rate,
    }
  },
}

// ---------------------------------------------------------------------------
// Reviewers-per-PR
// ---------------------------------------------------------------------------

export interface ReviewersPerPrResult extends MetricResult {
  readonly averageReviewers: number | null
  readonly sampleSize: number
}

const REVIEWERS_DOC =
  'Reviewers-per-PR (SPEC §8.3): mean unique non-author reviewers per merged PR. ' +
  'Bots excluded.'

export const reviewersPerPr: MetricModule<ReviewCoverageInputs, ReviewersPerPrResult> = {
  id: 'pr.reviewers_per_pr',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: REVIEWERS_DOC,
  params: {},

  compute(inputs, asOf): ReviewersPerPrResult {
    const bots = inputs.botIdentityIds ?? new Set<string>()
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')

    const reviewsByPr = new Map<string, Set<string>>()
    for (const rev of inputs.reviews) {
      if (!reviewsByPr.has(rev.prId)) reviewsByPr.set(rev.prId, new Set())
      reviewsByPr.get(rev.prId)?.add(rev.reviewerIdentityId)
    }

    if (mergedPrs.length === 0) {
      return {
        id: 'pr.reviewers_per_pr',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'count',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: REVIEWERS_DOC,
        averageReviewers: null,
        sampleSize: 0,
      }
    }

    let totalReviewers = 0
    for (const pr of mergedPrs) {
      const reviewerIds = reviewsByPr.get(pr.id) ?? new Set<string>()
      const humanNonAuthor = [...reviewerIds].filter(
        (id) => id !== pr.authorIdentityId && !bots.has(id),
      )
      totalReviewers += humanNonAuthor.length
    }

    const avg = safeRatio(totalReviewers, mergedPrs.length)

    return {
      id: 'pr.reviewers_per_pr',
      trustTier: 'deterministic',
      scope: 'team',
      value: avg,
      unit: 'count',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: REVIEWERS_DOC,
      averageReviewers: avg,
      sampleSize: mergedPrs.length,
    }
  },
}

// ---------------------------------------------------------------------------
// Reviewer Load Distribution (Gini coefficient, anonymized)
// ---------------------------------------------------------------------------

export interface ReviewerLoadResult extends MetricResult {
  /** Gini coefficient of review load distribution [0, 1]. 0 = perfectly equal. */
  readonly gini: number | null
  readonly reviewerCount: number
}

const GINI_DOC =
  'Reviewer Load Distribution (SPEC §8.3): Gini coefficient of non-author review counts. ' +
  'Gini = 0: perfectly equal load. Gini = 1: all reviews by one reviewer. ' +
  'Reviewer identities are anonymized in display (team-aggregate only). ' +
  'Formula: G = (2 * Σ(rank_i * x_i) / (n * Σx_i)) − (n+1)/n.'

/**
 * Compute the Gini coefficient for an array of non-negative counts.
 * Returns null for empty or single-reviewer input.
 */
export function giniCoefficient(counts: readonly number[]): number | null {
  const nonZero = counts.filter((c) => c > 0)
  if (nonZero.length < 2) return null

  const sorted = [...nonZero].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  if (sum === 0) return null

  let numerator = 0
  for (let i = 0; i < n; i++) {
    numerator += (i + 1) * (sorted[i] ?? 0)
  }

  return (2 * numerator) / (n * sum) - (n + 1) / n
}

export const reviewerLoad: MetricModule<ReviewCoverageInputs, ReviewerLoadResult> = {
  id: 'pr.reviewer_load_gini',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: GINI_DOC,
  params: {},

  compute(inputs, asOf): ReviewerLoadResult {
    const bots = inputs.botIdentityIds ?? new Set<string>()
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')

    // Count reviews per reviewer (non-author, non-bot)
    const reviewerCounts = new Map<string, number>()
    for (const rev of inputs.reviews) {
      const pr = mergedPrs.find((p) => p.id === rev.prId)
      if (!pr) continue
      if (rev.reviewerIdentityId === pr.authorIdentityId) continue
      if (bots.has(rev.reviewerIdentityId)) continue
      reviewerCounts.set(
        rev.reviewerIdentityId,
        (reviewerCounts.get(rev.reviewerIdentityId) ?? 0) + 1,
      )
    }

    const counts = [...reviewerCounts.values()]
    const gini = giniCoefficient(counts)

    return {
      id: 'pr.reviewer_load_gini',
      trustTier: 'deterministic',
      scope: 'team',
      value: gini,
      unit: 'gini',
      dataQuality: counts.length === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: GINI_DOC,
      gini,
      reviewerCount: counts.length,
    }
  },
}

// ---------------------------------------------------------------------------
// Comments-per-PR
// ---------------------------------------------------------------------------

export interface CommentsPerPrResult extends MetricResult {
  readonly averageComments: number | null
  readonly sampleSize: number
}

const COMMENTS_DOC = 'Comments-per-PR (SPEC §8.3): mean review comments per merged PR.'

export const commentsPerPr: MetricModule<ReviewCoverageInputs, CommentsPerPrResult> = {
  id: 'pr.comments_per_pr',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: COMMENTS_DOC,
  params: {},

  compute(inputs, asOf): CommentsPerPrResult {
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')

    if (mergedPrs.length === 0) {
      return {
        id: 'pr.comments_per_pr',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'count',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: COMMENTS_DOC,
        averageComments: null,
        sampleSize: 0,
      }
    }

    const mergedPrIds = new Set(mergedPrs.map((pr) => pr.id))
    const commentsByPr = new Map<string, number>()
    for (const c of inputs.reviewComments) {
      if (!mergedPrIds.has(c.prId)) continue
      commentsByPr.set(c.prId, (commentsByPr.get(c.prId) ?? 0) + 1)
    }

    let totalComments = 0
    for (const pr of mergedPrs) {
      totalComments += commentsByPr.get(pr.id) ?? 0
    }

    const avg = safeRatio(totalComments, mergedPrs.length)

    return {
      id: 'pr.comments_per_pr',
      trustTier: 'deterministic',
      scope: 'team',
      value: avg,
      unit: 'count',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: COMMENTS_DOC,
      averageComments: avg,
      sampleSize: mergedPrs.length,
    }
  },
}

// ---------------------------------------------------------------------------
// Review Iterations
// ---------------------------------------------------------------------------

export interface ReviewIterationsResult extends MetricResult {
  readonly averageIterations: number | null
  readonly sampleSize: number
}

const ITERATIONS_DOC =
  'Review Iterations (SPEC §8.3): mean number of changes_requested rounds per merged PR. ' +
  'A round = a changes_requested review followed by at least one more review event.'

export const reviewIterations: MetricModule<ReviewCoverageInputs, ReviewIterationsResult> = {
  id: 'pr.review_iterations',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: ITERATIONS_DOC,
  params: {},

  compute(inputs, asOf): ReviewIterationsResult {
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')

    if (mergedPrs.length === 0) {
      return {
        id: 'pr.review_iterations',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'count',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: ITERATIONS_DOC,
        averageIterations: null,
        sampleSize: 0,
      }
    }

    const reviewsByPr = new Map<string, ReviewInput[]>()
    for (const rev of inputs.reviews) {
      if (!reviewsByPr.has(rev.prId)) reviewsByPr.set(rev.prId, [])
      reviewsByPr.get(rev.prId)?.push(rev)
    }

    let totalIterations = 0
    for (const pr of mergedPrs) {
      const revs = (reviewsByPr.get(pr.id) ?? []).sort(
        (a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
      )
      // A round is a changes_requested review FOLLOWED BY at least one more
      // review event (per ITERATIONS_DOC). A trailing changes_requested with no
      // subsequent review is not a completed iteration and must not be counted.
      let crRounds = 0
      for (let i = 0; i < revs.length - 1; i++) {
        if (revs[i]?.state === 'changes_requested') crRounds++
      }
      totalIterations += crRounds
    }

    const avg = safeRatio(totalIterations, mergedPrs.length)

    return {
      id: 'pr.review_iterations',
      trustTier: 'deterministic',
      scope: 'team',
      value: avg,
      unit: 'count',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: ITERATIONS_DOC,
      averageIterations: avg,
      sampleSize: mergedPrs.length,
    }
  },
}

// ---------------------------------------------------------------------------
// Merge-Without-Review Rate
// ---------------------------------------------------------------------------

export interface MergeWithoutReviewResult extends MetricResult {
  readonly rate: number | null
  readonly mergedWithoutReview: number
  readonly totalMerged: number
}

const MWR_DOC =
  'Merge-Without-Review Rate (SPEC §8.3): ' +
  'merged PRs with no non-author review / total merged PRs. ' +
  'Returns null on 0 merged PRs.'

export const mergeWithoutReviewRate: MetricModule<ReviewCoverageInputs, MergeWithoutReviewResult> =
  {
    id: 'pr.merge_without_review_rate',
    trustTier: 'deterministic',
    scope: 'team',
    formulaDoc: MWR_DOC,
    params: {},

    compute(inputs, asOf): MergeWithoutReviewResult {
      const bots = inputs.botIdentityIds ?? new Set<string>()
      const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')
      const total = mergedPrs.length

      if (total === 0) {
        return {
          id: 'pr.merge_without_review_rate',
          trustTier: 'deterministic',
          scope: 'team',
          value: null,
          unit: 'ratio',
          dataQuality: 'no_data',
          engineVersion: ENGINE_VERSION,
          asOf,
          formulaDoc: MWR_DOC,
          rate: null,
          mergedWithoutReview: 0,
          totalMerged: 0,
        }
      }

      const reviewsByPr = new Map<string, ReviewInput[]>()
      for (const rev of inputs.reviews) {
        if (!reviewsByPr.has(rev.prId)) reviewsByPr.set(rev.prId, [])
        reviewsByPr.get(rev.prId)?.push(rev)
      }

      let withoutReview = 0
      for (const pr of mergedPrs) {
        const revs = reviewsByPr.get(pr.id) ?? []
        const hasNonAuthorReview = revs.some(
          (r) => r.reviewerIdentityId !== pr.authorIdentityId && !bots.has(r.reviewerIdentityId),
        )
        if (!hasNonAuthorReview) withoutReview++
      }

      const rate = safeRatio(withoutReview, total)

      return {
        id: 'pr.merge_without_review_rate',
        trustTier: 'deterministic',
        scope: 'team',
        value: rate,
        unit: 'ratio',
        dataQuality: 'ok',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: MWR_DOC,
        rate,
        mergedWithoutReview: withoutReview,
        totalMerged: total,
      }
    },
  }
