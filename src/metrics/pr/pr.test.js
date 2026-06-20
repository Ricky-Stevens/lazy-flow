/**
 * Golden tests for PR / Review metrics (Group C).
 *
 * Uses baseOrg dataset directly (no store seeding needed for most tests).
 * Degenerate-input goldens per SPEC WP-METRICS-PR DoD.
 */

import { describe, expect, it } from 'bun:test'
import { ENGINE_VERSION } from '../../core/index.js'
import { baseOrg, IDS } from '../../testkit/index.js'
import {
  ciHealth,
  commentsPerPr,
  giniCoefficient,
  mergeWithoutReviewRate,
  prCycleTime,
  prSize,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
  reviewLatency,
  stalePr,
  timeToFirstReview,
  timeToMerge,
} from './index.js'

const AS_OF = '2024-06-01T12:00:00Z'

// ---------------------------------------------------------------------------
// Build inputs from baseOrg
// ---------------------------------------------------------------------------

const prs = baseOrg.pullRequests.map((pr) => ({
  id: pr.id,
  repoId: pr.repoId,
  authorIdentityId: pr.authorIdentityId,
  state: pr.state,
  isDraft: pr.isDraft,
  firstCommitAt: pr.firstCommitAt,
  createdAt: pr.createdAt,
  readyAt: pr.readyAt,
  firstReviewAt: pr.firstReviewAt,
  approvedAt: pr.approvedAt,
  mergedAt: pr.mergedAt,
  updatedAt: pr.updatedAt,
  additions: 100,
  deletions: 30,
  haloc: null, // use additions+deletions fallback
}))

const reviews = baseOrg.reviews.map((r) => ({
  nodeId: r.nodeId,
  prId: r.prId,
  reviewerIdentityId: r.reviewerIdentityId,
  state: r.state,
  submittedAt: r.submittedAt,
}))

const reviewComments = baseOrg.reviewComments.map((c) => ({
  nodeId: c.nodeId,
  prId: c.prId,
  authorIdentityId: c.authorIdentityId,
  createdAt: c.createdAt,
}))

const deploys = baseOrg.deployments.map((d) => ({
  id: d.id,
  repoId: d.repoId,
  sha: d.sha,
  environment: d.environment,
  status: d.status,
  createdAt: d.createdAt,
  finishedAt: d.finishedAt,
}))

// Only bot: dependabot
const botIds = new Set([IDS.identityDependabot])

// ---------------------------------------------------------------------------
// 4-phase PR Cycle Time
// ---------------------------------------------------------------------------

describe('prCycleTime', () => {
  it('computes all 4 phases for pr-1 (full lifecycle)', () => {
    // pr-1: firstCommitAt 07:30, readyAt 08:00, firstReviewAt 12:00, mergedAt next day 10:00
    // deploy-1 finishedAt 2024-03-02T10:45:00Z
    const result = prCycleTime.compute({ prs, deploys }, AS_OF)

    expect(result.id).toBe('pr.cycle_time')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.dataQuality).toBe('ok')
    expect(result.coding.sampleSize).toBeGreaterThan(0)
    // coding = readyAt − firstCommitAt = 08:00 − 07:30 = 30min = 1800s
    expect(result.coding.p50).toBeDefined()
  })

  it('no merged PRs → value null, dataQuality no_data', () => {
    const openPrs = prs.map((pr) => ({ ...pr, state: 'open', mergedAt: null }))
    const result = prCycleTime.compute({ prs: openPrs, deploys }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  // REGRESSION: merged PRs but NO deploy feed (this tool's common case). The
  // 4-phase total needs a post-merge deploy, so the headline is null — but the
  // module used to report dataQuality 'ok' alongside a null value (an internal
  // lie) and never surfaced the headline's sample size.
  it('merged PRs but no deploys → null headline is insufficient_sample, not ok; phases still populated', () => {
    const result = prCycleTime.compute({ prs, deploys: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.totalSampleSize).toBe(0)
    expect(result.dataQuality).toBe('insufficient_sample')
    // Per-phase signals that don't need a deploy remain available.
    expect(result.coding.sampleSize).toBeGreaterThan(0)
    expect(result.review.sampleSize).toBeGreaterThan(0)
  })

  it('full-lifecycle PR exposes totalSampleSize alongside the headline p50', () => {
    const result = prCycleTime.compute({ prs, deploys }, AS_OF)
    expect(result.totalSampleSize).toBeGreaterThan(0)
    expect(result.totalSampleSize).toBe(result.deploy.sampleSize > 0 ? result.totalSampleSize : 0)
    expect(result.value).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Review Latency
// ---------------------------------------------------------------------------

describe('reviewLatency', () => {
  it('computes first-response latency for pr-1', () => {
    // pr-1: readyAt 08:00, firstReviewAt 12:00 → 4h = 14400s
    const result = reviewLatency.compute({ prs, reviews }, AS_OF)
    expect(result.id).toBe('pr.review_latency')
    expect(result.firstResponseP50Seconds).not.toBeNull()
    expect(result.sampleSize).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Time-to-First-Review
// ---------------------------------------------------------------------------

describe('timeToFirstReview', () => {
  it('computes time from readyAt to firstReviewAt', () => {
    const result = timeToFirstReview.compute({ prs }, AS_OF)
    expect(result.p50Seconds).not.toBeNull()
    expect(result.sampleSize).toBeGreaterThan(0)
  })

  it('no PRs with reviews → value null', () => {
    const basePr = prs[0]
    if (!basePr) throw new Error('prs[0] missing in test data')
    const noPrs = [{ ...basePr, firstReviewAt: null, state: 'merged' }]
    const result = timeToFirstReview.compute({ prs: noPrs }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// Time-to-Merge
// ---------------------------------------------------------------------------

describe('timeToMerge', () => {
  it('computes time from readyAt to mergedAt for merged PRs', () => {
    const result = timeToMerge.compute({ prs }, AS_OF)
    expect(result.p50Seconds).not.toBeNull()
    expect(result.sampleSize).toBeGreaterThan(0)
    expect(result.dataQuality).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// PR Size
// ---------------------------------------------------------------------------

describe('prSize', () => {
  it('falls back to additions+deletions when haloc is null', () => {
    // additions=100, deletions=30 → total=130 → bucket M (51–200)
    const result = prSize.compute({ prs }, AS_OF)
    expect(result.id).toBe('pr.size')
    expect(result.bucketCounts.M).toBeGreaterThan(0)
    expect(result.sampleSize).toBeGreaterThan(0)
  })

  it('uses haloc when provided', () => {
    const halocPrs = prs.map((pr) => ({
      ...pr,
      state: 'merged',
      mergedAt: pr.mergedAt ?? '2024-03-02T10:00:00Z',
      haloc: 8, // XS bucket
    }))
    const result = prSize.compute({ prs: halocPrs }, AS_OF)
    const totalMerged = halocPrs.length
    expect(result.bucketCounts.XS).toBe(totalMerged)
    expect(result.medianHaloc).toBe(8)
  })

  it('no merged PRs → value null', () => {
    const result = prSize.compute({ prs: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  it('falls back to additions+deletions when haloc is undefined (field absent)', () => {
    // Regression: a projection that omits haloc entirely supplies `undefined`.
    // `pr.haloc !== null` would let undefined through → NaN median + everything
    // bucketed XL. With `??` it falls back to additions+deletions (130 → M).
    const undefPrs = prs.map((pr) => {
      const { haloc, ...rest } = pr
      return { ...rest, state: 'merged', mergedAt: pr.mergedAt ?? '2024-03-02T10:00:00Z' }
    })
    const result = prSize.compute({ prs: undefPrs }, AS_OF)
    expect(result.medianHaloc).toBe(130)
    expect(Number.isFinite(result.medianHaloc)).toBe(true)
    expect(result.bucketCounts.M).toBe(undefPrs.length)
    expect(result.bucketCounts.XL).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Review Coverage
// ---------------------------------------------------------------------------

describe('reviewCoverage', () => {
  it('counts merged PRs with at least one non-author review', () => {
    // pr-1: merged, bob reviewed (non-author ✓)
    // pr-2: merged, no review
    // pr-4: merged, bob reviewed (non-author ✓) — pr-4 has firstReviewAt set
    const result = reviewCoverage.compute(
      { prs, reviews, reviewComments, botIdentityIds: botIds },
      AS_OF,
    )
    expect(result.id).toBe('pr.review_coverage')
    // 3 merged PRs (pr-1, pr-2, pr-4); pr-1 and pr-4 have reviews
    expect(result.totalMergedPrs).toBe(3)
    expect(result.prsWithReview).toBeGreaterThan(0)
    expect(result.coverageRate).not.toBeNull()
  })

  it('no merged PRs → coverageRate null', () => {
    const result = reviewCoverage.compute({ prs: [], reviews: [], reviewComments: [] }, AS_OF)
    expect(result.coverageRate).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// Reviewers-per-PR
// ---------------------------------------------------------------------------

describe('reviewersPerPr', () => {
  it('computes average non-author reviewers per merged PR', () => {
    const result = reviewersPerPr.compute({ prs, reviews, reviewComments }, AS_OF)
    expect(result.averageReviewers).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reviewer Load Gini
// ---------------------------------------------------------------------------

describe('reviewerLoad — Gini', () => {
  it('returns a gini coefficient [0, 1]', () => {
    const result = reviewerLoad.compute(
      { prs, reviews, reviewComments, botIdentityIds: botIds },
      AS_OF,
    )
    if (result.gini !== null) {
      expect(result.gini).toBeGreaterThanOrEqual(0)
      expect(result.gini).toBeLessThanOrEqual(1)
    }
  })

  it('giniCoefficient — equal distribution gives 0', () => {
    const g = giniCoefficient([5, 5, 5, 5])
    expect(g).toBeCloseTo(0, 5)
  })

  it('giniCoefficient — single reviewer gets null (need ≥ 2)', () => {
    expect(giniCoefficient([10])).toBeNull()
  })

  it('giniCoefficient — all reviews by one person gives 1', () => {
    // [0, 0, 0, 10] → all work by one; non-zero count = 1 → null (need ≥2 non-zero)
    expect(giniCoefficient([0, 0, 0, 10])).toBeNull()
    // [1, 9] → Gini = (2*(1*1 + 2*9))/(2*10) − 3/2 = (2*19)/20 − 1.5 = 1.9 − 1.5 = 0.4
    const g = giniCoefficient([1, 9])
    expect(g).not.toBeNull()
    expect(g).toBeGreaterThan(0)
    expect(g).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------
// Comments-per-PR
// ---------------------------------------------------------------------------

describe('commentsPerPr', () => {
  it('computes average comments per merged PR', () => {
    // pr-1 has 1 review comment; pr-2 and pr-4 have none
    const result = commentsPerPr.compute({ prs, reviews, reviewComments }, AS_OF)
    expect(result.averageComments).not.toBeNull()
    // 1 comment / 3 merged PRs ≈ 0.333
    expect(result.averageComments).toBeCloseTo(1 / 3, 3)
  })
})

// ---------------------------------------------------------------------------
// Review Iterations
// ---------------------------------------------------------------------------

describe('reviewIterations', () => {
  it('counts changes_requested rounds per PR', () => {
    // pr-1: round 1 = CHANGES_REQUESTED, round 2 = APPROVED → 1 iteration
    const result = reviewIterations.compute({ prs, reviews, reviewComments }, AS_OF)
    expect(result.averageIterations).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Merge-Without-Review Rate
// ---------------------------------------------------------------------------

describe('mergeWithoutReviewRate', () => {
  it('pr-2 is merged without review — should be counted', () => {
    const result = mergeWithoutReviewRate.compute(
      { prs, reviews, reviewComments, botIdentityIds: botIds },
      AS_OF,
    )
    expect(result.id).toBe('pr.merge_without_review_rate')
    // pr-2 has no reviews
    expect(result.mergedWithoutReview).toBeGreaterThanOrEqual(1)
    expect(result.rate).not.toBeNull()
    expect(result.dataQuality).toBe('ok')
  })

  it('no merged PRs → rate null', () => {
    const result = mergeWithoutReviewRate.compute(
      { prs: [], reviews: [], reviewComments: [] },
      AS_OF,
    )
    expect(result.rate).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// Stale PR detection
// ---------------------------------------------------------------------------

describe('stalePr', () => {
  it('open PRs with no recent activity are flagged stale', () => {
    // pr-3 is open, draft, updated 2024-03-10 — by 2024-06-01 that's ~83 days > 14
    // But pr-3 is a draft, so should be excluded from stale check
    const result = stalePr.compute({ prs, reviews, reviewComments, thresholdDays: 14 }, AS_OF)
    expect(result.id).toBe('pr.stale')
    // pr-3 is draft → not counted as open non-draft
    expect(result.openPrCount).toBe(0)
  })

  it('open non-draft PR inactive > threshold → stale', () => {
    const openPr = {
      id: 'pr-stale-test',
      state: 'open',
      isDraft: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z', // very old
    }
    const result = stalePr.compute(
      { prs: [openPr], reviews: [], reviewComments: [], thresholdDays: 14 },
      AS_OF,
    )
    expect(result.stalePrCount).toBe(1)
    expect(result.stalePrIds).toContain('pr-stale-test')
  })

  it('no open non-draft PRs → staleRate null', () => {
    const result = stalePr.compute({ prs: [], reviews: [], reviewComments: [] }, AS_OF)
    expect(result.staleRate).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// CI Health
// ---------------------------------------------------------------------------

describe('ciHealth', () => {
  it('computes pass rate from check runs', () => {
    const checkRuns = [
      {
        nodeId: 'cr-1',
        repoId: IDS.repoAlpha,
        headSha: IDS.commitA1,
        name: 'ci/test',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2024-03-01T09:00:00Z',
        completedAt: '2024-03-01T09:05:00Z',
      },
      {
        nodeId: 'cr-2',
        repoId: IDS.repoAlpha,
        headSha: IDS.commitA2,
        name: 'ci/test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2024-03-02T10:00:00Z',
        completedAt: '2024-03-02T10:03:00Z',
      },
    ]
    const result = ciHealth.compute({ checkRuns }, AS_OF)
    expect(result.id).toBe('pr.ci_health')
    expect(result.passRate).toBeCloseTo(0.5, 5)
    expect(result.successCount).toBe(1)
    expect(result.totalCompleted).toBe(2)
    expect(result.p50LatencySeconds).not.toBeNull()
  })

  it('no completed check runs → value null', () => {
    const result = ciHealth.compute({ checkRuns: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  it('flakiness detected when same SHA+name has multiple runs', () => {
    const checkRuns = [
      {
        nodeId: 'cr-3',
        repoId: IDS.repoAlpha,
        headSha: 'sha-abc',
        name: 'ci/test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
      },
      {
        nodeId: 'cr-4',
        repoId: IDS.repoAlpha,
        headSha: 'sha-abc',
        name: 'ci/test',
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
      },
    ]
    const result = ciHealth.compute({ checkRuns }, AS_OF)
    expect(result.flakinessRate).toBe(1) // 1/1 pair is flaky
  })

  it('deterministic re-runs (identical conclusions) are NOT flaky', () => {
    // Same check, same SHA, re-run three times — all success. This is a manual
    // "Re-run all jobs", not flakiness: no conclusion ever flipped.
    const checkRuns = ['cr-a', 'cr-b', 'cr-c'].map((nodeId) => ({
      nodeId,
      repoId: IDS.repoAlpha,
      headSha: 'sha-stable',
      name: 'ci/test',
      status: 'completed',
      conclusion: 'success',
      startedAt: null,
      completedAt: null,
    }))
    const result = ciHealth.compute({ checkRuns }, AS_OF)
    expect(result.flakinessRate).toBe(0)
  })
})
