/**
 * Golden tests for DORA / Delivery metrics (Group A).
 *
 * Uses the baseOrg dataset and seeds an in-memory BunSqliteStore
 * via runSync, then builds metric inputs from the store data.
 *
 * Degenerate-input goldens per SPEC WP-METRICS-DORA DoD:
 *   - Zero deploys → CFR null (not NaN)
 *   - Zero incidents → recovery time null
 *   - Reopened incident → recovery uses first-resolve (not last)
 *   - Reopen-rate counts the reopen
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { setupServer } from 'msw/node'
import { BunSqliteStore, ENGINE_VERSION, migrate } from '../../core/index.js'
import { GitHubClient } from '../../ingest-github/index.js'
import { JiraClient } from '../../ingest-jira/index.js'
import { runSync } from '../../orchestrator/index.js'
import { baseOrg, IDS, mockGitHub, mockJira } from '../../testkit/index.js'
import {
  changeFailureRate,
  deploymentFrequency,
  doraBandFromRate,
  incidentReopenRate,
  leadTime,
  recoveryTime,
} from './index.js'

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const server = setupServer(...mockGitHub(), ...mockJira())
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// ---------------------------------------------------------------------------
// Store setup
// ---------------------------------------------------------------------------

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

async function seedStore() {
  const store = makeStore()
  await runSync(
    store,
    new GitHubClient({ token: 'test-token', baseUrl: 'https://api.github.com' }),
    { org: 'octo-acme' },
    'backfill',
    new JiraClient({ baseUrl: 'https://acme.atlassian.net', token: 'test-token' }),
    { jiraCloudId: baseOrg.org.jiraCloudId, projectKeys: [baseOrg.jiraProject.key] },
    'backfill',
    { now: '2024-06-01T12:00:00Z' },
  )
  return store
}

const AS_OF = '2024-06-01T12:00:00Z'

// ---------------------------------------------------------------------------
// Build metric inputs from baseOrg (deterministic, no store needed for unit tests)
// ---------------------------------------------------------------------------

const deploys = baseOrg.deployments.map((d) => ({
  id: d.id,
  repoId: d.repoId,
  sha: d.sha,
  environment: d.environment,
  status: d.status,
  createdAt: d.createdAt,
  finishedAt: d.finishedAt,
  source: d.source,
}))

const deployIncidentLinks = baseOrg.deployIncidentLinks.map((l) => ({
  deployId: l.deployId,
  incidentIssueId: l.incidentIssueId,
}))

const prs = baseOrg.pullRequests.map((pr) => ({
  id: pr.id,
  repoId: pr.repoId,
  firstCommitAt: pr.firstCommitAt,
  mergedAt: pr.mergedAt,
}))

// Build incident records from baseOrg transitions
function buildIncidentRecords() {
  const incidents = []

  for (const issue of baseOrg.jiraIssues) {
    if (issue.type !== 'Incident') continue
    const transitions = baseOrg.issueTransitions[issue.id] ?? []
    const sorted = [...transitions].sort(
      (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
    )

    const doneTransitions = sorted.filter((t) => t.toStatusId === IDS.statusDone)
    const reopenTransitions = sorted.filter((t) => t.fromStatusId === IDS.statusDone)

    const firstResolvedAt = doneTransitions[0]?.transitionedAt ?? null
    const finalResolvedAt = doneTransitions[doneTransitions.length - 1]?.transitionedAt ?? null
    const reopenCount = reopenTransitions.length

    const link = baseOrg.deployIncidentLinks.find((l) => l.incidentIssueId === issue.id)

    incidents.push({
      id: issue.id,
      linkedDeployId: link?.deployId ?? null,
      createdAt: issue.createdAt,
      firstResolvedAt,
      finalResolvedAt,
      reopenCount,
    })
  }

  return incidents
}

const incidents = buildIncidentRecords()

// ---------------------------------------------------------------------------
// Deployment Frequency
// ---------------------------------------------------------------------------

describe('deploymentFrequency', () => {
  it('counts only success deploys and returns correct rate', () => {
    // baseOrg: deploy-1 (success), deploy-2 (success), deploy-3 (failure)
    // 2 success in 28 days
    const result = deploymentFrequency.compute({ deploys, windowDays: 28 }, AS_OF)

    expect(result.id).toBe('dora.deployment_frequency')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.trustTier).toBe('deterministic')
    expect(result.totalSuccessDeploys).toBe(2)
    expect(result.deploysPerDay).toBeCloseTo(2 / 28, 5)
    expect(result.doraBand).toBe('medium') // 2/28 ≈ 0.071/day < 1/week threshold
    expect(result.dataQuality).toBe('ok')
  })

  it('zero deploys → value null, doraBand null, dataQuality no_data', () => {
    const result = deploymentFrequency.compute({ deploys: [], windowDays: 28 }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.deploysPerDay).toBeNull()
    expect(result.doraBand).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  it('filters by environment — staging deploys not counted for production', () => {
    const stagingDeploy = {
      id: 'staging-1',
      repoId: IDS.repoAlpha,
      sha: 'abc123',
      environment: 'staging',
      status: 'success',
      createdAt: '2024-03-01T12:00:00Z',
      finishedAt: '2024-03-01T12:10:00Z',
      source: 'deployments_api',
    }
    const result = deploymentFrequency.compute(
      { deploys: [stagingDeploy], windowDays: 28, environment: 'production' },
      AS_OF,
    )
    expect(result.totalSuccessDeploys).toBe(0)
    expect(result.value).toBeNull()
  })

  it('doraBandFromRate — elite band at ≥ 1/day', () => {
    expect(doraBandFromRate(1)).toBe('elite')
    expect(doraBandFromRate(3)).toBe('elite')
    expect(doraBandFromRate(1 / 7)).toBe('high')
    expect(doraBandFromRate(1 / 30)).toBe('medium')
    expect(doraBandFromRate(1 / 200)).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// Lead Time
// ---------------------------------------------------------------------------

describe('leadTime', () => {
  it('computes lead time from firstCommitAt to deploy.finishedAt', () => {
    const result = leadTime.compute({ deploys, prs, commits: [], windowDays: 28 }, AS_OF)
    // deploy-1 finishedAt 2024-03-02T10:45:00Z; pr-1 firstCommitAt 2024-03-01T07:30:00Z
    // lead time ≈ 27h 15m = 98100s
    // deploy-2 finishedAt 2024-04-01T11:45:00Z; pr-4 firstCommitAt 2024-04-01T08:00:00Z
    // lead time ≈ 3h 45m = 13500s
    expect(result.id).toBe('dora.lead_time')
    expect(result.sampleSize).toBeGreaterThan(0)
    expect(result.p50Seconds).not.toBeNull()
    expect(result.dataQuality).toBe('ok')
  })

  it('zero deploys → value null, dataQuality no_data', () => {
    const result = leadTime.compute({ deploys: [], prs, commits: [], windowDays: 28 }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    expect(result.sampleSize).toBe(0)
  })

  it('counts each PR once against the first deploy after merge (no per-deploy double-count)', () => {
    // Regression for leadtime-pr-linking-double-count: PR-A merged before both
    // deploys must NOT be re-counted for deploy-2.
    const repo = 'repo-x'
    const prA = {
      id: 'pr-a',
      repoId: repo,
      firstCommitAt: '2024-01-01T00:00:00Z',
      mergedAt: '2024-01-02T00:00:00Z',
    }
    const prB = {
      id: 'pr-b',
      repoId: repo,
      firstCommitAt: '2024-03-01T00:00:00Z',
      mergedAt: '2024-03-02T00:00:00Z',
    }
    const deploy1 = {
      id: 'd1',
      repoId: repo,
      sha: 's1',
      environment: 'production',
      status: 'success',
      createdAt: '2024-01-03T00:00:00Z',
      finishedAt: '2024-01-03T00:00:00Z',
      source: 'deployments_api',
    }
    const deploy2 = {
      ...deploy1,
      id: 'd2',
      sha: 's2',
      createdAt: '2024-03-03T00:00:00Z',
      finishedAt: '2024-03-03T00:00:00Z',
    }
    const result = leadTime.compute(
      { deploys: [deploy1, deploy2], prs: [prA, prB], commits: [], windowDays: 400 },
      AS_OF,
    )
    // Exactly two samples: PR-A→deploy-1 (~2d), PR-B→deploy-2 (~2d). NOT three.
    expect(result.sampleSize).toBe(2)
    // p50 of two ~2-day samples must be ~2 days, not inflated by a bogus ~61-day sample.
    expect(result.p50Seconds).toBeLessThan(3 * 86_400)
  })
})

// ---------------------------------------------------------------------------
// Change Failure Rate
// ---------------------------------------------------------------------------

describe('changeFailureRate', () => {
  it('computes CFR from deploy-incident links', () => {
    // 3 prod deploys; 2 linked to incidents
    const result = changeFailureRate.compute({ deploys, deployIncidentLinks }, AS_OF)
    expect(result.id).toBe('dora.change_failure_rate')
    expect(result.totalDeploys).toBe(3)
    expect(result.deploysWithIncident).toBe(2)
    expect(result.rate).toBeCloseTo(2 / 3, 5)
    expect(result.dataQuality).toBe('ok')
  })

  it('zero deploys → rate null (not NaN), dataQuality no_data', () => {
    const result = changeFailureRate.compute({ deploys: [], deployIncidentLinks: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.rate).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    // Critical: must never be NaN
    expect(Number.isNaN(result.rate)).toBe(false)
  })

  it('deploys with no linked incidents → rate 0', () => {
    const noLink = []
    const result = changeFailureRate.compute({ deploys, deployIncidentLinks: noLink }, AS_OF)
    expect(result.deploysWithIncident).toBe(0)
    expect(result.rate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Recovery Time
// ---------------------------------------------------------------------------

describe('recoveryTime', () => {
  it('uses first-resolve anchor (not final), so reopened incident has short MTTR', () => {
    // incident-1: created 2024-03-02T11:00:00Z, first Done 2024-03-02T12:00:00Z → 1h = 3600s
    // incident-2: created 2024-04-01T12:00:00Z, first Done 2024-04-01T14:00:00Z → 2h = 7200s
    const result = recoveryTime.compute({ incidents }, AS_OF)

    expect(result.id).toBe('dora.recovery_time')
    expect(result.sampleSize).toBe(2)
    expect(result.p50Seconds).toBeCloseTo((3600 + 7200) / 2, 0) // median of 2 values = average
    expect(result.dataQuality).toBe('ok')
  })

  it('reopened incident: MTTR anchored on FIRST Done (1h), not final Done (22h later)', () => {
    // incident-1 was resolved at 12:00 (1h after creation), reopened at 14:00, final Done at 09:00 next day
    const incident1 = incidents.find((i) => i.id === IDS.issueIncident1)
    expect(incident1).toBeDefined()
    if (!incident1) throw new Error('incident1 not found')
    expect(incident1.reopenCount).toBe(1)
    // First resolved should be 1h after creation
    const createdMs = new Date(incident1.createdAt).getTime()
    const firstResolvedMs = new Date(incident1.firstResolvedAt).getTime()
    const firstResolveDuration = (firstResolvedMs - createdMs) / 1000
    expect(firstResolveDuration).toBeCloseTo(3600, 0) // 1h
  })

  it('zero incidents → value null, dataQuality no_data', () => {
    const result = recoveryTime.compute({ incidents: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    // Must not be NaN
    expect(Number.isNaN(result.value)).toBe(false)
  })

  it('prefers REAL deployment recovery (failed→next-success) when deploy statuses exist', () => {
    // A failed prod deploy recovered by the next successful prod deploy 1h later.
    // A second failed deploy is recovered 2h later. Median = 1.5h.
    const deploys = [
      { id: 'd1', environment: 'production', status: 'failure', createdAt: '2024-03-01T10:00:00Z' },
      { id: 'd2', environment: 'production', status: 'success', createdAt: '2024-03-01T11:00:00Z' },
      { id: 'd3', environment: 'production', status: 'error', createdAt: '2024-03-02T10:00:00Z' },
      { id: 'd4', environment: 'production', status: 'success', createdAt: '2024-03-02T12:00:00Z' },
    ]
    // Incidents present too, but the deployment signal takes precedence.
    const result = recoveryTime.compute({ deploys, incidents }, AS_OF)
    expect(result.recoverySource).toBe('deployment')
    expect(result.sampleSize).toBe(2)
    expect(result.p50Seconds).toBeCloseTo((3600 + 7200) / 2, 0)
    expect(result.deployRecoveryP50Seconds).toBeCloseTo((3600 + 7200) / 2, 0)
  })

  it('falls back to incident recovery when no failed deployment is observed', () => {
    // All deploys succeeded → no deployment-recovery sample → incident signal used.
    const deploys = [
      { id: 'd1', environment: 'production', status: 'success', createdAt: '2024-03-01T10:00:00Z' },
    ]
    const result = recoveryTime.compute({ deploys, incidents }, AS_OF)
    expect(result.recoverySource).toBe('incident')
    expect(result.p50Seconds).toBeCloseTo((3600 + 7200) / 2, 0)
  })
})

// ---------------------------------------------------------------------------
// Reopen Rate
// ---------------------------------------------------------------------------

describe('incidentReopenRate', () => {
  it('counts reopened incidents correctly', () => {
    // incident-1 has reopenCount=1; incident-2 has reopenCount=0
    const result = incidentReopenRate.compute({ incidents }, AS_OF)
    expect(result.id).toBe('dora.incident_reopen_rate')
    expect(result.totalIncidents).toBe(2)
    expect(result.reopenedCount).toBe(1)
    expect(result.rate).toBeCloseTo(0.5, 5)
  })

  it('zero incidents → rate null (not NaN)', () => {
    const result = incidentReopenRate.compute({ incidents: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.rate).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    expect(Number.isNaN(result.rate)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Seeded-store golden (integration test)
// ---------------------------------------------------------------------------

describe('DORA integration — seeded store', () => {
  it('runSync seeds store; deployment frequency computable from synced data', async () => {
    const store = await seedStore()
    // After sync, repo ID is derived from full_name: "octo-acme/alpha-service" → "octo-acme-alpha-service"
    const alphaRepo = baseOrg.repositories.find((r) => r.id === IDS.repoAlpha)
    if (!alphaRepo) throw new Error('alpha repo missing from baseOrg')
    const syncedRepoId = `${alphaRepo.owner}-${alphaRepo.name}`
    const syncedDeploys = await store.getDeploymentsByRepo(syncedRepoId)
    expect(syncedDeploys.length).toBeGreaterThan(0)

    const inputs = syncedDeploys.map((d) => ({
      id: d.id,
      repoId: d.repoId,
      sha: d.sha,
      environment: d.environment,
      status: d.status,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      source: d.source,
    }))

    const result = deploymentFrequency.compute({ deploys: inputs, windowDays: 28 }, AS_OF)
    expect(result.dataQuality).toBe('ok')
    expect(result.totalSuccessDeploys).toBeGreaterThan(0)
  })
})
