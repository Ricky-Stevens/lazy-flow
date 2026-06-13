/**
 * Org-bound DB guard tests (SPEC §6.5).
 *
 * assertOrgBound is a tenant-isolation control: it hard-errors when the store
 * already holds a different org's data, preventing one install from mixing two
 * clients' repositories.
 */

import { describe, expect, it } from 'bun:test'
import { BunSqliteStore, migrate } from '../index.js'
import { assertOrgBound } from './orgBound.js'

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

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
