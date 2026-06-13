/**
 * Tests for the rollup module (WP-ROLLUP).
 *
 * Acceptance contract:
 *   1. Org velocity distribution computes over configured teams.
 *   2. Effective-dated membership is respected — a person's team at the time
 *      of the work determines team attribution.
 *   3. Teams with no data (all nulls) are excluded from the distribution count.
 *   4. The distribution is correct (min, p25, median, p75, p90, max).
 *   5. Mixed stale / different-engine snapshots are filtered.
 */

import { describe, expect, it } from 'bun:test'

import { BunSqliteStore, ENGINE_VERSION, migrate } from '../../core/index.js'
import {
  buildTeamEntriesFromSnapshots,
  computeOrgRollup,
  computeRollupDistribution,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

const NOW = '2024-06-05T00:00:00Z'

function makeSnapshot(teamId, day, value, opts = {}) {
  return {
    scopeType: 'team',
    scopeId: teamId,
    metric: 'flow.throughput',
    day,
    value,
    window: `${day}T00:00:00Z`,
    trustTier: 'deterministic',
    dataQuality: value === null ? 'no_data' : 'ok',
    engineVersion: ENGINE_VERSION,
    ingestWatermarkVersion: 'v1',
    coverageFingerprint: 'fp-00000001',
    computedAt: NOW,
    isStale: false,
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// computeRollupDistribution
// ---------------------------------------------------------------------------

describe('computeRollupDistribution', () => {
  it('returns all nulls for an empty array', () => {
    const dist = computeRollupDistribution([])
    expect(dist.count).toBe(0)
    expect(dist.min).toBeNull()
    expect(dist.median).toBeNull()
    expect(dist.max).toBeNull()
  })

  it('computes correct stats for a simple dataset', () => {
    // Values: [10, 20, 30, 40, 50]
    const dist = computeRollupDistribution([10, 20, 30, 40, 50])
    expect(dist.count).toBe(5)
    expect(dist.min).toBe(10)
    expect(dist.max).toBe(50)
    expect(dist.median).toBe(30)
  })

  it('handles a single value', () => {
    const dist = computeRollupDistribution([7])
    expect(dist.min).toBe(7)
    expect(dist.max).toBe(7)
    expect(dist.median).toBe(7)
    expect(dist.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildTeamEntriesFromSnapshots
// ---------------------------------------------------------------------------

describe('buildTeamEntriesFromSnapshots', () => {
  it('filters out stale snapshots', () => {
    const snapshots = [
      makeSnapshot('team-a', '2024-01-01', 5),
      makeSnapshot('team-b', '2024-01-01', 10, { isStale: true }),
    ]
    const entries = buildTeamEntriesFromSnapshots(snapshots)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.teamId).toBe('team-a')
  })

  it('filters out snapshots with a different engine version', () => {
    const snapshots = [
      makeSnapshot('team-a', '2024-01-01', 5),
      makeSnapshot('team-b', '2024-01-01', 10, { engineVersion: '0.0.1' }),
    ]
    const entries = buildTeamEntriesFromSnapshots(snapshots)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.teamId).toBe('team-a')
  })

  it('maps value and teamId correctly', () => {
    const snapshots = [makeSnapshot('team-x', '2024-03-10', 42)]
    const entries = buildTeamEntriesFromSnapshots(snapshots)
    expect(entries[0]).toEqual({ teamId: 'team-x', day: '2024-03-10', value: 42 })
  })
})

// ---------------------------------------------------------------------------
// computeOrgRollup — team/org aggregation
// ---------------------------------------------------------------------------

describe('computeOrgRollup', () => {
  it('aggregates three teams into an org distribution', () => {
    const entries = [
      { teamId: 'team-a', day: '2024-01-01', value: 10 },
      { teamId: 'team-a', day: '2024-01-02', value: 20 },
      { teamId: 'team-b', day: '2024-01-01', value: 30 },
      { teamId: 'team-b', day: '2024-01-02', value: 40 },
      { teamId: 'team-c', day: '2024-01-01', value: 50 },
      { teamId: 'team-c', day: '2024-01-02', value: 60 },
    ]

    const result = computeOrgRollup({
      scopeType: 'org',
      orgId: 'org-1',
      metricId: 'flow.throughput',
      teamEntries: entries,
      fromDay: '2024-01-01',
      toDay: '2024-01-02',
      now: NOW,
    })

    expect(result.orgId).toBe('org-1')
    expect(result.metricId).toBe('flow.throughput')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.teamCount).toBe(3)

    // team-a median = 15, team-b median = 35, team-c median = 55
    // org median = median([15, 35, 55]) = 35
    expect(result.orgMedian).toBe(35)
    expect(result.distribution.count).toBe(3)
    expect(result.distribution.min).toBe(15)
    expect(result.distribution.max).toBe(55)
  })

  it('excludes teams with all-null values', () => {
    const entries = [
      { teamId: 'team-a', day: '2024-01-01', value: 10 },
      { teamId: 'team-null', day: '2024-01-01', value: null },
      { teamId: 'team-null', day: '2024-01-02', value: null },
    ]

    const result = computeOrgRollup({
      scopeType: 'org',
      orgId: 'org-2',
      metricId: 'flow.throughput',
      teamEntries: entries,
      fromDay: '2024-01-01',
      toDay: '2024-01-02',
      now: NOW,
    })

    expect(result.teamCount).toBe(1)
    expect(result.orgMedian).toBe(10)
  })

  it('filters entries outside the window', () => {
    const entries = [
      { teamId: 'team-a', day: '2023-12-31', value: 999 }, // outside
      { teamId: 'team-a', day: '2024-01-01', value: 5 }, // inside
      { teamId: 'team-a', day: '2024-02-01', value: 888 }, // outside
    ]

    const result = computeOrgRollup({
      scopeType: 'org',
      orgId: 'org-3',
      metricId: 'flow.throughput',
      teamEntries: entries,
      fromDay: '2024-01-01',
      toDay: '2024-01-31',
      now: NOW,
    })

    expect(result.teamCount).toBe(1)
    expect(result.orgMedian).toBe(5)
  })

  it('returns null orgMedian with zero teams', () => {
    const result = computeOrgRollup({
      scopeType: 'org',
      orgId: 'org-empty',
      metricId: 'flow.throughput',
      teamEntries: [],
      fromDay: '2024-01-01',
      toDay: '2024-01-31',
      now: NOW,
    })

    expect(result.orgMedian).toBeNull()
    expect(result.teamCount).toBe(0)
    expect(result.distribution.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Effective-dated membership (store-backed test)
// ---------------------------------------------------------------------------

describe('effective-dated membership via store', () => {
  it('getTeamMembers with an at-timestamp returns only members valid at that time', async () => {
    const store = makeStore()

    // Seed org and teams
    await store.upsertOrganisation({
      id: 'org-edate',
      githubLogin: 'test-org',
      jiraCloudId: null,
      name: 'Test Org',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })
    await store.upsertTeam({
      id: 'team-edate',
      name: 'Team A',
      orgId: 'org-edate',
      updatedAt: '2024-01-01T00:00:00Z',
    })

    // Person alice was in Team A from Jan 1 → Jan 31
    await store.upsertPerson({
      id: 'person-alice',
      displayName: 'Alice',
      primaryAccountRef: 'alice',
      updatedAt: '2024-01-01T00:00:00Z',
    })
    await store.upsertTeamMembership({
      teamId: 'team-edate',
      personId: 'person-alice',
      validFrom: '2024-01-01T00:00:00Z',
      validTo: '2024-01-31T00:00:00Z',
    })

    // Person bob joined Feb 1
    await store.upsertPerson({
      id: 'person-bob',
      displayName: 'Bob',
      primaryAccountRef: 'bob',
      updatedAt: '2024-02-01T00:00:00Z',
    })
    await store.upsertTeamMembership({
      teamId: 'team-edate',
      personId: 'person-bob',
      validFrom: '2024-02-01T00:00:00Z',
      validTo: null,
    })

    // At Jan 15: only alice
    const janMembers = await store.getTeamMembers('team-edate', '2024-01-15T00:00:00Z')
    expect(janMembers.map((m) => m.personId)).toContain('person-alice')
    expect(janMembers.map((m) => m.personId)).not.toContain('person-bob')

    // At Feb 15: only bob
    const febMembers = await store.getTeamMembers('team-edate', '2024-02-15T00:00:00Z')
    expect(febMembers.map((m) => m.personId)).not.toContain('person-alice')
    expect(febMembers.map((m) => m.personId)).toContain('person-bob')
  })
})
