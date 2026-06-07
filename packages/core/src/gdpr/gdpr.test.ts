/**
 * WP-GDPR-SCAFFOLD tests (SPEC §11.2 acceptance criteria).
 *
 * Covers:
 *   - pseudonymize: deterministic per key; key-dependent
 *   - erasePerson: removes person + identities; leaves team aggregates intact
 *   - assertOrgBound: hard-errors on cross-org config
 *   - pruneOlderThan: drops old rows
 *   - doc generators: return non-empty markdown
 */

import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { describe, expect, it } from 'vitest'
import { erasePerson } from './erasure.js'
import { assertOrgBound } from './orgBound.js'
import { pseudonymize } from './pseudonymize.js'
import { pruneOlderThan } from './retention.js'
import {
  generateDpiaTemplate,
  generateLiaTemplate,
  generateTransparencyNotice,
} from './templates.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): NodeSqliteStore {
  const store = new NodeSqliteStore(':memory:')
  migrate(store.db)
  return store
}

// ---------------------------------------------------------------------------
// pseudonymize
// ---------------------------------------------------------------------------

describe('pseudonymize', () => {
  it('is deterministic for the same value + key', () => {
    const key = 'test-secret-key-for-hmac'
    expect(pseudonymize('alice@example.com', key)).toBe(pseudonymize('alice@example.com', key))
  })

  it('produces different output for a different key', () => {
    const val = 'alice@example.com'
    const h1 = pseudonymize(val, 'key-one')
    const h2 = pseudonymize(val, 'key-two')
    expect(h1).not.toBe(h2)
  })

  it('produces different output for different values with the same key', () => {
    const key = 'shared-key'
    expect(pseudonymize('alice@example.com', key)).not.toBe(pseudonymize('bob@example.com', key))
  })

  it('returns a 64-character hex string (HMAC-SHA256)', () => {
    const out = pseudonymize('test@test.com', 'k')
    expect(out).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a Buffer key', () => {
    const key = Buffer.from('buffer-key-bytes')
    const out = pseudonymize('user@org.com', key)
    expect(out).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// erasePerson
// ---------------------------------------------------------------------------

describe('erasePerson', () => {
  it('removes the person record and severs identity links', async () => {
    const store = makeStore()
    const now = new Date().toISOString()

    // Insert a person.
    await store.upsertPerson({
      id: 'person-alice',
      displayName: 'Alice',
      primaryAccountRef: 'alice-gh-id',
      updatedAt: now,
    })

    // Insert two identities linked to the person.
    await store.upsertIdentity({
      id: 'identity-alice-gh',
      personId: 'person-alice',
      kind: 'github_login',
      externalId: 'alice',
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: now,
    })
    await store.upsertIdentity({
      id: 'identity-alice-email',
      personId: 'person-alice',
      kind: 'commit_email',
      externalId: 'alice@example.com',
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: now,
    })

    // Erase the person.
    const result = await erasePerson(store, 'person-alice')

    // Person should be gone.
    const person = await store.getPerson('person-alice')
    expect(person).toBeNull()

    // Identity IDs should be returned.
    expect(result.erasedIdentityIds.sort()).toEqual(
      ['identity-alice-gh', 'identity-alice-email'].sort(),
    )

    // Identities should still exist (for FK integrity) but person_id severed.
    const identities = await store.getIdentitiesByPerson('person-alice')
    expect(identities).toHaveLength(0)
  })

  it('leaves team aggregate snapshots intact after erasure', async () => {
    const store = makeStore()
    const now = new Date().toISOString()

    // Set up an org, team, and person.
    await store.upsertOrganisation({
      id: 'org-test',
      githubLogin: 'test-org',
      jiraCloudId: null,
      name: 'Test Org',
      createdAt: now,
      updatedAt: now,
    })
    await store.upsertPerson({
      id: 'person-bob',
      displayName: 'Bob',
      primaryAccountRef: 'bob-id',
      updatedAt: now,
    })
    await store.upsertTeam({
      id: 'team-eng',
      name: 'Engineering',
      orgId: 'org-test',
      updatedAt: now,
    })

    // Insert a team-scope metric snapshot (aggregate — no individual attribution).
    await store.putSnapshot({
      scopeType: 'team',
      scopeId: 'team-eng',
      metric: 'deployment_frequency',
      day: '2026-01-01',
      value: 3.5,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '1.0.0',
      ingestWatermarkVersion: 'wm1',
      coverageFingerprint: 'fp1',
      computedAt: now,
      isStale: false,
    })

    // Erase the person.
    await erasePerson(store, 'person-bob')

    // Team snapshot must still exist.
    const snaps = await store.getSnapshots(
      'team',
      'team-eng',
      'deployment_frequency',
      '2026-01-01',
      '2026-01-01',
    )
    expect(snaps).toHaveLength(1)
    expect(snaps[0]?.value).toBe(3.5)
  })
})

// ---------------------------------------------------------------------------
// assertOrgBound
// ---------------------------------------------------------------------------

describe('assertOrgBound', () => {
  it('does not throw when the store is empty', async () => {
    const store = makeStore()
    await expect(assertOrgBound(store, 'org-alpha')).resolves.toBeUndefined()
  })

  it('does not throw when the store contains only the given org', async () => {
    const store = makeStore()
    const now = new Date().toISOString()
    await store.upsertOrganisation({
      id: 'org-alpha',
      githubLogin: 'alpha',
      jiraCloudId: null,
      name: 'Alpha',
      createdAt: now,
      updatedAt: now,
    })
    await expect(assertOrgBound(store, 'org-alpha')).resolves.toBeUndefined()
  })

  it('hard-errors when the store contains a different org', async () => {
    const store = makeStore()
    const now = new Date().toISOString()
    await store.upsertOrganisation({
      id: 'org-alpha',
      githubLogin: 'alpha',
      jiraCloudId: null,
      name: 'Alpha',
      createdAt: now,
      updatedAt: now,
    })
    // Attempt to bind to a different org — must throw.
    await expect(assertOrgBound(store, 'org-beta')).rejects.toThrow(/cross-org/i)
  })
})

// ---------------------------------------------------------------------------
// pruneOlderThan
// ---------------------------------------------------------------------------

describe('pruneOlderThan', () => {
  it('removes metric_snapshots older than the cutoff', async () => {
    const store = makeStore()

    // Insert two snapshots: one old, one recent.
    const old = '2020-01-01T00:00:00.000Z'
    const recent = '2026-06-01T00:00:00.000Z'
    const cutoff = '2024-01-01T00:00:00.000Z'

    await store.upsertOrganisation({
      id: 'org-x',
      githubLogin: null,
      jiraCloudId: null,
      name: 'X',
      createdAt: old,
      updatedAt: old,
    })

    await store.putSnapshot({
      scopeType: 'org',
      scopeId: 'org-x',
      metric: 'dora_df',
      day: '2020-01-01',
      value: 1,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '1.0.0',
      ingestWatermarkVersion: 'wm1',
      coverageFingerprint: 'fp1',
      computedAt: old,
      isStale: false,
    })

    await store.putSnapshot({
      scopeType: 'org',
      scopeId: 'org-x',
      metric: 'dora_df',
      day: '2026-06-01',
      value: 2,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: '1.0.0',
      ingestWatermarkVersion: 'wm2',
      coverageFingerprint: 'fp2',
      computedAt: recent,
      isStale: false,
    })

    const counts = await pruneOlderThan(store, cutoff)
    expect(counts.metric_snapshots).toBeGreaterThanOrEqual(1)

    // Only the recent snapshot should survive.
    const remaining = await store.getSnapshots(
      'org',
      'org-x',
      'dora_df',
      '2020-01-01',
      '2026-12-31',
    )
    expect(remaining.every((s) => s.computedAt >= cutoff)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Doc generators
// ---------------------------------------------------------------------------

describe('doc generators', () => {
  it('generateDpiaTemplate returns non-empty markdown', () => {
    const doc = generateDpiaTemplate({ orgName: 'ACME Corp', assessmentDate: '2026-06-07' })
    expect(doc.length).toBeGreaterThan(100)
    expect(doc).toContain('ACME Corp')
    expect(doc).toContain('DPIA')
    // Must mention the at-rest encryption limitation honestly.
    expect(doc).toContain('node:sqlite')
  })

  it('generateLiaTemplate returns non-empty markdown', () => {
    const doc = generateLiaTemplate({ orgName: 'ACME Corp' })
    expect(doc.length).toBeGreaterThan(100)
    expect(doc).toContain('Legitimate Interest')
  })

  it('generateTransparencyNotice returns non-empty markdown', () => {
    const doc = generateTransparencyNotice({ orgName: 'ACME Corp' })
    expect(doc.length).toBeGreaterThan(100)
    expect(doc).toContain('Transparency Notice')
    // Must mention the at-rest encryption limitation honestly.
    expect(doc).toContain('node:sqlite')
  })
})
