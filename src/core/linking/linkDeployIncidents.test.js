import { describe, expect, it } from 'bun:test'
import { migrate } from '../migrate/runner.js'
import { BunSqliteStore } from '../store/BunSqliteStore.js'
import {
  INCIDENT_DEPLOY_PROXIMITY_MS,
  linkDeployIncidents,
  linkDeploysToIncidents,
} from './linkDeployIncidents.js'

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

describe('linkDeploysToIncidents (pure proximity linker)', () => {
  const deploys = [
    { id: 'd1', createdAt: '2024-03-01T10:00:00Z' },
    { id: 'd2', createdAt: '2024-03-05T10:00:00Z' },
  ]

  it('links an incident to the most recent preceding deploy within the window', () => {
    const incidents = [{ id: 'inc1', createdAt: '2024-03-05T12:00:00Z' }]
    const links = linkDeploysToIncidents(deploys, incidents)
    expect(links).toEqual([{ deployId: 'd2', incidentIssueId: 'inc1' }])
  })

  it('does not link an incident with no deploy inside the proximity window', () => {
    // 8 days after the only preceding deploy (> 7-day window).
    const incidents = [{ id: 'inc2', createdAt: '2024-03-13T11:00:00Z' }]
    const links = linkDeploysToIncidents([deploys[0]], incidents)
    expect(links).toEqual([])
  })

  it('does not link an incident that predates every deploy', () => {
    const incidents = [{ id: 'inc3', createdAt: '2024-02-01T00:00:00Z' }]
    const links = linkDeploysToIncidents(deploys, incidents)
    expect(links).toEqual([])
  })

  it('exposes the 7-day proximity window constant', () => {
    expect(INCIDENT_DEPLOY_PROXIMITY_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('linkDeployIncidents (persists to the store)', () => {
  // Seed only the rows the linker reads (a prod deployment + an incident issue),
  // bypassing parent FKs — this test targets the linker, not the full entity graph.
  function seedDeployAndIncident(store) {
    store.db.exec('PRAGMA foreign_keys = OFF')
    store.db
      .prepare(
        `INSERT INTO deployments (id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'd1',
        'repo-1',
        'abc',
        'production',
        'success',
        '2024-03-01T10:00:00Z',
        '2024-03-01T10:05:00Z',
        'deployments_api',
        '{}',
        '2024-03-01T10:05:00Z',
      )
    store.db
      .prepare(
        `INSERT INTO issues (id, project_id, key, type, status_id, status_category, created_at, raw, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'inc-1',
        'proj-1',
        'OPS-1',
        'Incident',
        's1',
        'done',
        '2024-03-01T12:00:00Z',
        '{}',
        '2024-03-01T12:00:00Z',
      )
  }

  it('writes proximity links and is idempotent across re-runs', async () => {
    const store = makeStore()
    seedDeployAndIncident(store)

    const r1 = await linkDeployIncidents(store, { now: '2024-03-02T00:00:00Z' })
    expect(r1.linksUpserted).toBe(1)

    const links = await store.getDeployIncidentLinks()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      deployId: 'd1',
      incidentIssueId: 'inc-1',
      linkType: 'proximity',
    })

    // Re-run: clears + rewrites, still exactly one link (no duplication).
    const r2 = await linkDeployIncidents(store, { now: '2024-03-03T00:00:00Z' })
    expect(r2.linksUpserted).toBe(1)
    expect(await store.getDeployIncidentLinks()).toHaveLength(1)
  })
})
