/**
 * Tests for WP-ANTIGAMING — gaming detection + data-quality flags (SPEC §10).
 *
 * Coverage:
 *   1. detectDeployInflation — non-prod and rapid-redeploy fixtures
 *   2. detectCfrSuppression  — hotfix/revert without incident ticket
 *   3. detectLeadTimeReset   — squash/rebase author-date rewrite
 *   4. detectStatusJuggling  — rapid back-and-forth transitions
 *   5. detectTrivialPrSplitting — many tiny PRs in a short window
 *   6. goodhartWarning       — pin-target warning for sensitive metrics
 *   7. assertNoCompositeProductivityNumber — composite score guard
 *   8. Clean fixtures         — no false-positive flags on clean data
 */

import { describe, expect, it } from 'bun:test'
import {
  assertNoCompositeProductivityNumber,
  detectCfrSuppression,
  detectDeployInflation,
  detectLeadTimeReset,
  detectStatusJuggling,
  detectTrivialPrSplitting,
  GOODHART_SENSITIVE_METRICS,
  goodhartWarning,
} from './index.js'

// ---------------------------------------------------------------------------
// 1. Deployment-frequency inflation
// ---------------------------------------------------------------------------

describe('detectDeployInflation — non-prod deployments', () => {
  it('flags when a non-production environment is included', () => {
    const deploys = [
      { id: 'd1', environment: 'production', createdAt: '2024-01-01T10:00:00Z' },
      { id: 'd2', environment: 'staging', createdAt: '2024-01-01T11:00:00Z' }, // non-prod
    ]
    const result = detectDeployInflation(deploys, { targetEnv: 'production' })
    expect(result.flag).toBe('deploy_frequency_inflated')
    expect(result.reason).toMatch(/Non-production/)
  })

  it('flags when consecutive prod deployments are too rapid', () => {
    const deploys = [
      { id: 'd1', environment: 'production', createdAt: '2024-01-01T10:00:00Z' },
      { id: 'd2', environment: 'production', createdAt: '2024-01-01T10:01:00Z' }, // 1 min gap
    ]
    const result = detectDeployInflation(deploys, {
      targetEnv: 'production',
      rapidRedeployWindowMs: 5 * 60 * 1000, // 5 min threshold
    })
    expect(result.flag).toBe('deploy_frequency_inflated')
    expect(result.reason).toMatch(/Rapid consecutive redeployments/)
    expect(result.reason).toMatch(/d2/)
  })
})

describe('detectDeployInflation — clean fixture (no false positive)', () => {
  it('returns ok when all prod deploys are spaced appropriately', () => {
    const deploys = [
      { id: 'd1', environment: 'production', createdAt: '2024-01-01T10:00:00Z' },
      { id: 'd2', environment: 'production', createdAt: '2024-01-01T16:00:00Z' }, // 6h gap
      { id: 'd3', environment: 'production', createdAt: '2024-01-02T10:00:00Z' },
    ]
    const result = detectDeployInflation(deploys, { targetEnv: 'production' })
    expect(result.flag).toBe('ok')
    expect(result.reason).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. CFR suppression
// ---------------------------------------------------------------------------

describe('detectCfrSuppression — hotfix without incident', () => {
  it('flags deploys that have a hotfix/revert but no linked incident', () => {
    const deploys = [
      {
        deployId: 'dep-1',
        deployCreatedAt: '2024-01-01T10:00:00Z',
        hotfixOrRevertAt: '2024-01-01T12:00:00Z', // hotfix present
        hasLinkedIncident: false, // no incident ticket — suppression
      },
    ]
    const result = detectCfrSuppression(deploys)
    expect(result.flag).toBe('cfr_suppressed')
    expect(result.reason).toMatch(/dep-1/)
    expect(result.reason).toMatch(/hotfix\/revert/)
  })

  it('does not flag when the hotfix deploy has a linked incident', () => {
    const deploys = [
      {
        deployId: 'dep-2',
        deployCreatedAt: '2024-01-01T10:00:00Z',
        hotfixOrRevertAt: '2024-01-01T12:00:00Z',
        hasLinkedIncident: true, // incident properly filed
      },
    ]
    const result = detectCfrSuppression(deploys)
    expect(result.flag).toBe('ok')
  })
})

describe('detectCfrSuppression — clean fixture (no false positive)', () => {
  it('returns ok when no hotfix/revert events are present', () => {
    const deploys = [
      {
        deployId: 'dep-clean',
        deployCreatedAt: '2024-01-01T10:00:00Z',
        hotfixOrRevertAt: null,
        hasLinkedIncident: false,
      },
    ]
    const result = detectCfrSuppression(deploys)
    expect(result.flag).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 3. Lead-time reset (squash/rebase)
// ---------------------------------------------------------------------------

describe('detectLeadTimeReset — squash/rebase author-date rewrite', () => {
  it('flags a PR where the merge commit is authored much later than the first commit', () => {
    const prs = [
      {
        prId: 'pr-1',
        // merge commit authored 3 days after the first commit (squash reset)
        mergeCommitAuthoredAt: '2024-01-04T10:00:00Z',
        firstCommitAuthoredAt: '2024-01-01T10:00:00Z', // 3 days earlier
      },
    ]
    const result = detectLeadTimeReset(prs, { thresholdMs: 60 * 60 * 1000 }) // 1h threshold
    expect(result.flag).toBe('lead_time_reset')
    expect(result.reason).toMatch(/pr-1/)
    expect(result.reason).toMatch(/squash\/rebase/)
  })

  it('does not flag a PR within the threshold (normal fast-forward merge)', () => {
    const prs = [
      {
        prId: 'pr-2',
        // merge commit authored only 5 minutes after the first commit (ok)
        mergeCommitAuthoredAt: '2024-01-01T10:05:00Z',
        firstCommitAuthoredAt: '2024-01-01T10:00:00Z',
      },
    ]
    const result = detectLeadTimeReset(prs, { thresholdMs: 60 * 60 * 1000 })
    expect(result.flag).toBe('ok')
  })
})

describe('detectLeadTimeReset — clean fixture (no false positive)', () => {
  it('returns ok when all PRs have honest authored timestamps', () => {
    const prs = [
      {
        prId: 'pr-clean-1',
        mergeCommitAuthoredAt: '2024-01-03T14:00:00Z',
        firstCommitAuthoredAt: '2024-01-03T10:00:00Z', // 4h gap — same day, no reset
      },
      {
        prId: 'pr-clean-2',
        mergeCommitAuthoredAt: '2024-01-05T09:00:00Z',
        firstCommitAuthoredAt: '2024-01-05T08:30:00Z', // 30 min gap
      },
    ]
    const result = detectLeadTimeReset(prs, { thresholdMs: 24 * 60 * 60 * 1000 }) // 24h threshold
    expect(result.flag).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 4. Status juggling
// ---------------------------------------------------------------------------

describe('detectStatusJuggling — rapid back-and-forth transitions', () => {
  it('flags an issue with repeated A→B→A round-trips within the window', () => {
    const BASE = '2024-01-01T10:00:00Z'
    const plusMin = (n) => new Date(new Date(BASE).getTime() + n * 60 * 1000).toISOString()

    const issues = [
      {
        issueId: 'ISSUE-1',
        transitions: [
          // Round-trip 1: active → wait → active within 10 minutes
          { fromStatusId: 'in-progress', toStatusId: 'blocked', transitionedAt: plusMin(0) },
          { fromStatusId: 'blocked', toStatusId: 'in-progress', transitionedAt: plusMin(5) },
          { fromStatusId: 'in-progress', toStatusId: 'done', transitionedAt: plusMin(6) },
          // Round-trip 2: another in same window
          { fromStatusId: 'done', toStatusId: 'in-progress', transitionedAt: plusMin(8) },
          { fromStatusId: 'in-progress', toStatusId: 'blocked', transitionedAt: plusMin(9) },
          { fromStatusId: 'blocked', toStatusId: 'in-progress', transitionedAt: plusMin(10) },
        ],
      },
    ]

    const result = detectStatusJuggling(issues, {
      windowMs: 20 * 60 * 1000, // 20 minute window
      minRoundTrips: 2,
    })
    expect(result.flag).toBe('status_juggling')
    expect(result.reason).toMatch(/ISSUE-1/)
    expect(result.reason).toMatch(/round-trips/)
  })

  it('flags rapid round-trips even when the NEXT unrelated transition is far away', () => {
    // Regression for antigaming-juggle-window-tc: the window must measure the
    // round-trip span (tB − tA), not tC − tA against the next transition. Both
    // round-trips complete in 2 min; the following transitions are +2h away.
    const issues = [
      {
        issueId: 'ISSUE-JUGGLE',
        transitions: [
          { fromStatusId: 'active', toStatusId: 'wait', transitionedAt: '2024-01-01T10:00:00Z' },
          { fromStatusId: 'wait', toStatusId: 'active', transitionedAt: '2024-01-01T10:02:00Z' },
          { fromStatusId: 'active', toStatusId: 'wait', transitionedAt: '2024-01-01T12:02:00Z' },
          { fromStatusId: 'wait', toStatusId: 'active', transitionedAt: '2024-01-01T12:04:00Z' },
          { fromStatusId: 'active', toStatusId: 'done', transitionedAt: '2024-01-01T14:04:00Z' },
        ],
      },
    ]
    const result = detectStatusJuggling(issues, { windowMs: 60 * 60 * 1000, minRoundTrips: 2 })
    expect(result.flag).toBe('status_juggling')
  })
})

describe('detectStatusJuggling — clean fixture (no false positive)', () => {
  it('returns ok for an issue with a normal linear transition path', () => {
    const issues = [
      {
        issueId: 'ISSUE-CLEAN',
        transitions: [
          {
            fromStatusId: 'todo',
            toStatusId: 'in-progress',
            transitionedAt: '2024-01-01T09:00:00Z',
          },
          {
            fromStatusId: 'in-progress',
            toStatusId: 'review',
            transitionedAt: '2024-01-02T14:00:00Z',
          },
          { fromStatusId: 'review', toStatusId: 'done', transitionedAt: '2024-01-03T11:00:00Z' },
        ],
      },
    ]
    const result = detectStatusJuggling(issues)
    expect(result.flag).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 5. Trivial PR splitting
// ---------------------------------------------------------------------------

describe('detectTrivialPrSplitting — many tiny PRs in a short window', () => {
  it('flags an author who submits many tiny PRs within a short window', () => {
    // 6 tiny PRs (size <= 5 HALOC) within 2 hours from one author
    const base = new Date('2024-01-01T10:00:00Z').getTime()
    const prs = Array.from({ length: 6 }, (_, i) => ({
      prId: `pr-tiny-${i}`,
      authorPersonId: 'person-alice',
      size: 3, // trivially small
      createdAt: new Date(base + i * 15 * 60 * 1000).toISOString(), // every 15 min
    }))

    const result = detectTrivialPrSplitting(prs, {
      windowMs: 4 * 60 * 60 * 1000, // 4h window
      minPrs: 5,
      maxSize: 10,
    })
    expect(result.flag).toBe('trivial_pr_splitting')
    expect(result.reason).toMatch(/person-alice/)
  })
})

describe('detectTrivialPrSplitting — clean fixture (no false positive)', () => {
  it('returns ok when tiny PRs are spread over multiple days', () => {
    const prs = [
      { prId: 'pr-a', authorPersonId: 'person-alice', size: 5, createdAt: '2024-01-01T10:00:00Z' },
      { prId: 'pr-b', authorPersonId: 'person-alice', size: 8, createdAt: '2024-01-02T10:00:00Z' },
      { prId: 'pr-c', authorPersonId: 'person-alice', size: 3, createdAt: '2024-01-03T10:00:00Z' },
    ]
    const result = detectTrivialPrSplitting(prs, { minPrs: 5, maxSize: 10 })
    expect(result.flag).toBe('ok')
  })

  it('returns ok when PRs are not trivially small even if many in a window', () => {
    const base = new Date('2024-01-01T10:00:00Z').getTime()
    const prs = Array.from({ length: 6 }, (_, i) => ({
      prId: `pr-normal-${i}`,
      authorPersonId: 'person-bob',
      size: 150, // large PRs — not trivial
      createdAt: new Date(base + i * 15 * 60 * 1000).toISOString(),
    }))
    const result = detectTrivialPrSplitting(prs, { minPrs: 5, maxSize: 10 })
    expect(result.flag).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 6. Goodhart warning
// ---------------------------------------------------------------------------

describe('goodhartWarning', () => {
  it('returns a warning for deployment_frequency (DORA Goodhart-sensitive metric)', () => {
    const w = goodhartWarning('dora.deployment_frequency')
    expect(w).not.toBeNull()
    expect(w?.metricId).toBe('dora.deployment_frequency')
    expect(w?.warning).toMatch(/Goodhart/)
    expect(w?.warning).toMatch(/target/)
  })

  it('returns a warning for lead_time', () => {
    const w = goodhartWarning('dora.lead_time')
    expect(w).not.toBeNull()
    expect(w?.warning).toMatch(/Goodhart/)
  })

  it('returns a warning for change_failure_rate', () => {
    const w = goodhartWarning('dora.change_failure_rate')
    expect(w).not.toBeNull()
  })

  it('returns null for a metric that is not Goodhart-sensitive', () => {
    expect(goodhartWarning('pr.size')).toBeNull()
    expect(goodhartWarning('agile.estimation_accuracy')).toBeNull()
    expect(goodhartWarning('code.rework_churn')).toBeNull()
  })

  it('the GOODHART_SENSITIVE_METRICS set covers all four DORA key metrics', () => {
    expect(GOODHART_SENSITIVE_METRICS.has('dora.deployment_frequency')).toBe(true)
    expect(GOODHART_SENSITIVE_METRICS.has('dora.lead_time')).toBe(true)
    expect(GOODHART_SENSITIVE_METRICS.has('dora.change_failure_rate')).toBe(true)
    expect(GOODHART_SENSITIVE_METRICS.has('dora.recovery_time')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. assertNoCompositeProductivityNumber
// ---------------------------------------------------------------------------

describe('assertNoCompositeProductivityNumber', () => {
  it('throws in non-production when called with a "score" function name', () => {
    expect(() => assertNoCompositeProductivityNumber('computeProductivityScore')).toThrow(
      /composite productivity number/,
    )
  })

  it('throws for names containing "leaderboard"', () => {
    expect(() => assertNoCompositeProductivityNumber('buildLeaderboard')).toThrow(
      /composite productivity number/,
    )
  })

  it('throws for names containing "composite"', () => {
    expect(() => assertNoCompositeProductivityNumber('computeCompositeMetric')).toThrow(
      /composite productivity number/,
    )
  })

  it('does not throw for a legitimate metric function name', () => {
    expect(() => assertNoCompositeProductivityNumber('computeDeploymentFrequency')).not.toThrow()
    expect(() => assertNoCompositeProductivityNumber('buildFlowEfficiencyResult')).not.toThrow()
    expect(() => assertNoCompositeProductivityNumber('getLeadTime')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 8. No-ranking guard — code path that emits an individual ranking list
// ---------------------------------------------------------------------------

describe('no stack-rank / leaderboard code path (SPEC §2.2 N2, §11.1)', () => {
  it('does not exist in detectDeployInflation output — result has no ranking list', () => {
    // The detector returns a single GamingDetectionResult, never a sorted individual list
    const result = detectDeployInflation([], { targetEnv: 'production' })
    // Result is a scalar flag, not an array of individuals
    expect(result).toHaveProperty('flag')
    expect(result).toHaveProperty('reason')
    expect(Array.isArray(result)).toBe(false)
  })

  it('does not exist in detectTrivialPrSplitting output — result has no ranking list', () => {
    const result = detectTrivialPrSplitting([])
    expect(result).toHaveProperty('flag')
    expect(Array.isArray(result)).toBe(false)
  })

  it('goodhartWarning is not a ranking list', () => {
    const result = goodhartWarning('dora.deployment_frequency')
    // Returns a single warning object per metric, not a sorted list of individuals
    expect(result).not.toBeNull()
    expect(Array.isArray(result)).toBe(false)
  })
})
