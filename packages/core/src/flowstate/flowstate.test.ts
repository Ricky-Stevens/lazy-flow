/**
 * Flow State Model tests — WP-FLOWSTATE-MODEL (deterministic seed + confirm +
 * fallback).
 *
 * All tests run against an in-memory NodeSqliteStore seeded from the
 * @lazy-flow/testkit baseOrg dataset.
 *
 * Coverage:
 *   1. "In Progress" (indeterminate + active name) → active
 *   2. "Selected for Dev" (queue column only) → NOT active (new)
 *   3. "Done" category → done
 *   4. "Backlog" / "To Do" category new → new
 *   5. Ambiguous status (no strong name match) → low confidence + confirm queue
 *   6. confirmFlowState → records confirmedBy/confirmedAt; no new row
 *   7. overrideFlowState → supersedes via effective-dating; old row keeps valid_to;
 *      history preserved; new row is active
 *   8. ensureFallbackMapping → non-empty mapping for unconfirmed workflow
 *   9. listPendingConfirmations → only low-confidence unconfirmed rows appear
 *  10. classifyStatus unit tests (category precedence, pattern matching)
 *  11. applyBoardColumnAdjustment unit tests (queue demotes active; started promotes)
 */

import { DatabaseSync } from 'node:sqlite'
import { baseOrg, IDS } from '@lazy-flow/testkit'
import { describe, expect, it } from 'vitest'
import { migrate } from '../migrate/runner.js'
import { NodeSqliteStore } from '../store/NodeSqliteStore.js'
import {
  applyBoardColumnAdjustment,
  classifyStatus,
  confirmFlowState,
  ensureFallbackMapping,
  HIGH_CONFIDENCE_THRESHOLD,
  listPendingConfirmations,
  overrideFlowState,
  seedFlowStateModel,
} from './index.js'

// ---------------------------------------------------------------------------
// Store + seed helpers
// ---------------------------------------------------------------------------

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as { db: DatabaseSync }).db = db
  return store
}

const NOW = '2024-06-01T00:00:00.000Z'
const LATER = '2024-07-01T00:00:00.000Z'

/**
 * Seed the store with workflows, status_category_history, board_configs and
 * board_columns from the baseOrg dataset.
 *
 * Parent rows (board_configs) are inserted before their children (board_columns)
 * and workflows before flow_state_models (FK constraints).
 */
async function seedBaseOrg(store: NodeSqliteStore): Promise<void> {
  // Workflows — required parent for flow_state_models FK
  for (const wf of baseOrg.workflows) {
    await store.upsertWorkflow({ ...wf, updatedAt: NOW })
  }

  // Status category history (so getStatusCategory works in tests)
  for (const status of baseOrg.jiraStatuses) {
    await store.upsertStatusCategoryHistory({
      statusId: status.id,
      category: status.category,
      validFrom: NOW,
      validTo: null,
    })
  }

  // board_configs must be inserted before board_columns (FK)
  for (const cfg of baseOrg.boardConfigs) {
    await store.upsertBoardConfig({ ...cfg, updatedAt: NOW })
  }

  // Board columns
  for (const col of baseOrg.boardColumns) {
    await store.upsertBoardColumn({
      ...col,
      statusIds: JSON.stringify(col.statusIds),
    })
  }
}

/**
 * Insert a minimal workflow row for a custom workflow id.
 * Required before inserting flow_state_models for that workflow (FK).
 */
async function ensureWorkflow(store: NodeSqliteStore, workflowId: string): Promise<void> {
  await store.upsertWorkflow({ workflowId, name: workflowId, updatedAt: NOW })
}

/** Build StatusInput from baseOrg jiraStatuses. */
function getBaseOrgStatuses() {
  return baseOrg.jiraStatuses.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category as 'new' | 'indeterminate' | 'done' | null,
  }))
}

/**
 * Find an identity from baseOrg by id, throwing if not found (test helper).
 * Avoids non-null assertions which Biome's noNonNullAssertion rule flags.
 */
function findIdentity(id: string) {
  const identity = baseOrg.identities.find((i) => i.id === id)
  if (!identity) throw new Error(`Identity ${id} not found in baseOrg`)
  return identity
}

/** Build BoardColumnInput from baseOrg boardColumns. */
function getBaseOrgBoardColumns() {
  return baseOrg.boardColumns.map((col) => ({
    statusIds: [...col.statusIds],
    isStartedCol: col.isStartedCol,
    isDoneCol: col.isDoneCol,
  }))
}

// ---------------------------------------------------------------------------
// Effective-dating regression: out-of-order / backfill seeds
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — out-of-order validFrom', () => {
  const statuses = [{ id: 's-ooo', name: 'In Progress', category: 'indeterminate' as const }]

  it('never produces an inverted interval (valid_to < valid_from) when re-seeded earlier', async () => {
    const store = freshStore()
    await ensureWorkflow(store, 'wf-ooo')
    // Seed at LATER first, then re-seed at the EARLIER timestamp (backfill).
    await seedFlowStateModel(store, 'wf-ooo', statuses, { validFrom: LATER })
    await seedFlowStateModel(store, 'wf-ooo', statuses, { validFrom: NOW })

    const rows = await store.getFlowStateModelsByWorkflow('wf-ooo')
    for (const r of rows) {
      if (r.validTo !== null) {
        expect(r.validFrom <= r.validTo).toBe(true)
      }
    }
    // The earlier (NOW) row must close where the later (LATER) row begins — no overlap.
    const nowRow = rows.find((r) => r.validFrom === NOW)
    expect(nowRow?.validTo).toBe(LATER)
  })
})

// ---------------------------------------------------------------------------
// 1. "In Progress" → active
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — In Progress', () => {
  it('maps "In Progress" (indeterminate category) → active via name pattern', async () => {
    const store = freshStore()
    await seedBaseOrg(store)

    await seedFlowStateModel(store, IDS.workflowId, getBaseOrgStatuses(), {
      validFrom: NOW,
      boardColumns: getBaseOrgBoardColumns(),
    })

    const model = await store.getFlowStateModel(IDS.workflowId, IDS.statusInProgress, NOW)
    expect(model).not.toBeNull()
    expect(model?.flowState).toBe('active')
    expect(model?.confidence).toBeGreaterThanOrEqual(0.7)
    expect(model?.confirmedBy).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. "Selected for Dev" (queue column) → NOT active
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — Selected for Dev (queue column)', () => {
  it('maps "Selected for Dev" → new (category-driven), NOT active', async () => {
    const store = freshStore()
    await seedBaseOrg(store)

    await seedFlowStateModel(store, IDS.workflowId, getBaseOrgStatuses(), {
      validFrom: NOW,
      boardColumns: getBaseOrgBoardColumns(),
    })

    const model = await store.getFlowStateModel(IDS.workflowId, IDS.statusSelected, NOW)
    expect(model).not.toBeNull()
    // In baseOrg, "Selected for Dev" has category 'new' → maps to 'new' (not active)
    expect(model?.flowState).not.toBe('active')
    expect(model?.flowState).toBe('new')
  })

  it('board-column adjustment demotes "active" to "wait" when status is only in queue column', () => {
    const boardColumns = getBaseOrgBoardColumns()
    // Simulate an indeterminate status whose name passes the active pattern
    // but whose only board placement is in the "Selected for Dev" queue column.
    const result = applyBoardColumnAdjustment(
      IDS.statusSelected,
      { flowState: 'active', confidence: 0.8 },
      boardColumns,
    )
    expect(result.flowState).toBe('wait')
    expect(result.confidence).toBe(0.7)
  })
})

// ---------------------------------------------------------------------------
// 3. "Done" category → done
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — Done', () => {
  it('maps "Done" (done category) → done at high confidence', async () => {
    const store = freshStore()
    await seedBaseOrg(store)

    await seedFlowStateModel(store, IDS.workflowId, getBaseOrgStatuses(), {
      validFrom: NOW,
    })

    const model = await store.getFlowStateModel(IDS.workflowId, IDS.statusDone, NOW)
    expect(model?.flowState).toBe('done')
    expect(model?.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// 4. "Backlog" / new category → new
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — Backlog', () => {
  it('maps "Backlog" (new category) → new at high confidence', async () => {
    const store = freshStore()
    await seedBaseOrg(store)

    await seedFlowStateModel(store, IDS.workflowId, getBaseOrgStatuses(), {
      validFrom: NOW,
    })

    const model = await store.getFlowStateModel(IDS.workflowId, IDS.statusBacklog, NOW)
    expect(model?.flowState).toBe('new')
    expect(model?.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// 5. Ambiguous status → low confidence + confirm queue
// ---------------------------------------------------------------------------

describe('seedFlowStateModel — ambiguous status', () => {
  it('maps an ambiguous status name to a low-confidence default', async () => {
    const store = freshStore()
    const wfId = 'workflow-ambiguous'
    await ensureWorkflow(store, wfId)

    const ambiguousStatuses = [
      {
        id: 'status-ambiguous-1',
        name: 'Engineering Slot', // neither active nor wait pattern
        category: 'indeterminate' as const,
      },
    ]

    await seedFlowStateModel(store, wfId, ambiguousStatuses, { validFrom: NOW })

    const model = await store.getFlowStateModel(wfId, 'status-ambiguous-1', NOW)
    expect(model).not.toBeNull()
    expect(model?.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD)

    // Should appear in the confirm queue
    const queue = await listPendingConfirmations(store, wfId)
    expect(queue.length).toBeGreaterThanOrEqual(1)
    const entry = queue.find((q) => q.statusId === 'status-ambiguous-1')
    expect(entry).toBeDefined()
    expect(entry?.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// 6. confirmFlowState → records confirmedBy/confirmedAt; no new row inserted
// ---------------------------------------------------------------------------

describe('confirmFlowState', () => {
  it('records confirmedBy and confirmedAt on the existing row without inserting a new row', async () => {
    const store = freshStore()
    const wfId = 'workflow-confirm-test'
    await ensureWorkflow(store, wfId)

    // Seed identities so the confirmed_by FK is satisfiable
    await store.upsertPerson({
      id: IDS.personAlice,
      displayName: 'Alice',
      primaryAccountRef: IDS.identityAliceGh,
      updatedAt: NOW,
    })
    await store.upsertIdentity(findIdentity(IDS.identityAliceGh))

    const stId = 'status-confirm-1'
    await seedFlowStateModel(
      store,
      wfId,
      [{ id: stId, name: 'In Progress', category: 'indeterminate' }],
      { validFrom: NOW },
    )

    await confirmFlowState(store, {
      workflowId: wfId,
      statusId: stId,
      confirmedBy: IDS.identityAliceGh,
      confirmedAt: LATER,
    })

    const model = await store.getFlowStateModel(wfId, stId)
    expect(model?.confirmedBy).toBe(IDS.identityAliceGh)
    expect(model?.confirmedAt).toBe(LATER)
    // The valid_from should be unchanged (same row, not a new one)
    expect(model?.validFrom).toBe(NOW)
    // Still no valid_to (row is still open)
    expect(model?.validTo).toBeNull()

    // Only one row should exist for this status
    const all = await store.getFlowStateModelsByWorkflow(wfId)
    const forStatus = all.filter((m) => m.statusId === stId)
    expect(forStatus).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 7. overrideFlowState → effective-dating; history preserved
// ---------------------------------------------------------------------------

describe('overrideFlowState — effective-dating', () => {
  it('supersedes via effective-dating: old row keeps valid_to, new row is active', async () => {
    const store = freshStore()
    const wfId = 'workflow-override-test'
    await ensureWorkflow(store, wfId)

    // Seed identity for confirmed_by FK
    await store.upsertPerson({
      id: IDS.personBob,
      displayName: 'Bob',
      primaryAccountRef: IDS.identityBobGh,
      updatedAt: NOW,
    })
    await store.upsertIdentity(findIdentity(IDS.identityBobGh))

    const stId = 'status-override-1'

    // Initial seed
    await seedFlowStateModel(
      store,
      wfId,
      [{ id: stId, name: 'Selected for Dev', category: 'indeterminate' }],
      { validFrom: NOW },
    )

    const before = await store.getFlowStateModel(wfId, stId, NOW)
    expect(before?.validTo).toBeNull()

    // Override at a later date
    await overrideFlowState(store, {
      workflowId: wfId,
      statusId: stId,
      flowState: 'active',
      confirmedBy: IDS.identityBobGh,
      validFrom: LATER,
    })

    // Old row should now have valid_to = LATER
    const allRows = await store.getFlowStateModelsByWorkflow(wfId)
    const forStatus = allRows.filter((m) => m.statusId === stId)
    expect(forStatus).toHaveLength(2)

    const oldRow = forStatus.find((m) => m.validFrom === NOW)
    expect(oldRow?.validTo).toBe(LATER)

    const newRow = forStatus.find((m) => m.validFrom === LATER)
    expect(newRow?.flowState).toBe('active')
    expect(newRow?.validTo).toBeNull()
    expect(newRow?.confirmedBy).toBe(IDS.identityBobGh)
    expect(newRow?.confidence).toBe(1.0)
  })

  it('point-in-time query returns the classification in effect at each interval', async () => {
    const store = freshStore()
    const wfId = 'workflow-temporal-test'
    await ensureWorkflow(store, wfId)

    // Seed identity for confirmed_by FK
    await store.upsertPerson({
      id: IDS.personCarol,
      displayName: 'Carol',
      primaryAccountRef: IDS.identityCarolGh,
      updatedAt: NOW,
    })
    await store.upsertIdentity(findIdentity(IDS.identityCarolGh))

    const stId = 'status-temporal-1'

    // Seed at NOW: wait (the name matches wait pattern)
    await seedFlowStateModel(
      store,
      wfId,
      [{ id: stId, name: 'Selected for Dev', category: 'indeterminate' }],
      { validFrom: NOW },
    )

    // Override at LATER: active
    await overrideFlowState(store, {
      workflowId: wfId,
      statusId: stId,
      flowState: 'active',
      confirmedBy: IDS.identityCarolGh,
      validFrom: LATER,
    })

    // Query at NOW → original classification (wait)
    const atNow = await store.getFlowStateModel(wfId, stId, NOW)
    expect(atNow?.flowState).toBe('wait')

    // Query at LATER → new classification (active)
    const atLater = await store.getFlowStateModel(wfId, stId, LATER)
    expect(atLater?.flowState).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// 8. ensureFallbackMapping → non-empty mapping for unconfirmed workflow
// ---------------------------------------------------------------------------

describe('ensureFallbackMapping', () => {
  it('inserts low-confidence rows for a workflow that has never been seeded', async () => {
    const store = freshStore()
    const wfId = 'workflow-fallback-test'
    await ensureWorkflow(store, wfId)

    const statuses = [
      { id: 'status-fb-1', name: 'To Do', category: 'new' as const },
      { id: 'status-fb-2', name: 'In Progress', category: 'indeterminate' as const },
      { id: 'status-fb-3', name: 'Done', category: 'done' as const },
    ]

    const result = await ensureFallbackMapping(store, wfId, statuses, { validFrom: NOW })

    expect(result.total).toBe(3)
    expect(result.inserted).toBe(3)

    // All rows should be present and low-confidence
    for (const status of statuses) {
      const model = await store.getFlowStateModel(wfId, status.id, NOW)
      expect(model).not.toBeNull()
      expect(model?.confidence).toBeLessThanOrEqual(0.45)
      expect(model?.confirmedBy).toBeNull()
    }
  })

  it('does not overwrite existing rows', async () => {
    const store = freshStore()
    const wfId = 'workflow-fallback-existing'
    await ensureWorkflow(store, wfId)

    const stId = 'status-fb-existing'

    // Seed first (should produce higher confidence for active name)
    await seedFlowStateModel(
      store,
      wfId,
      [{ id: stId, name: 'In Progress', category: 'indeterminate' }],
      { validFrom: NOW },
    )

    const beforeConfidence = (await store.getFlowStateModel(wfId, stId, NOW))?.confidence
    expect(beforeConfidence).toBeGreaterThan(0.45)

    // Fallback should be a no-op for this status
    const result = await ensureFallbackMapping(
      store,
      wfId,
      [{ id: stId, name: 'In Progress', category: 'indeterminate' }],
      { validFrom: NOW },
    )
    expect(result.inserted).toBe(0)

    // Confidence unchanged
    const after = await store.getFlowStateModel(wfId, stId, NOW)
    expect(after?.confidence).toBe(beforeConfidence)
  })

  it('provides a non-empty mapping even for a completely unconfirmed workflow', async () => {
    const store = freshStore()
    const wfId = 'workflow-never-seeded'
    await ensureWorkflow(store, wfId)

    const statuses = getBaseOrgStatuses()
    await ensureFallbackMapping(store, wfId, statuses, { validFrom: NOW })

    // Every status now has a row
    for (const status of statuses) {
      const model = await store.getFlowStateModel(wfId, status.id, NOW)
      expect(model).not.toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. listPendingConfirmations — only low-confidence unconfirmed rows
// ---------------------------------------------------------------------------

describe('listPendingConfirmations', () => {
  it('excludes high-confidence rows from the queue', async () => {
    const store = freshStore()
    await seedBaseOrg(store)

    await seedFlowStateModel(store, IDS.workflowId, getBaseOrgStatuses(), {
      validFrom: NOW,
    })

    const queue = await listPendingConfirmations(store, IDS.workflowId)

    // High-confidence rows (done, new from category) must not appear
    for (const entry of queue) {
      expect(entry.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD)
    }
  })

  it('excludes already-confirmed rows from the queue', async () => {
    const store = freshStore()
    const wfId = 'workflow-confirm-queue'
    await ensureWorkflow(store, wfId)

    // Seed identity for confirmed_by FK
    await store.upsertPerson({
      id: IDS.personAlice,
      displayName: 'Alice',
      primaryAccountRef: IDS.identityAliceGh,
      updatedAt: NOW,
    })
    await store.upsertIdentity(findIdentity(IDS.identityAliceGh))

    const stId = 'status-low-conf'

    await seedFlowStateModel(
      store,
      wfId,
      [{ id: stId, name: 'Engineering Slot', category: 'indeterminate' }],
      { validFrom: NOW },
    )

    // Appears in queue before confirmation
    const before = await listPendingConfirmations(store, wfId)
    expect(before.some((e) => e.statusId === stId)).toBe(true)

    // Confirm it
    await confirmFlowState(store, {
      workflowId: wfId,
      statusId: stId,
      confirmedBy: IDS.identityAliceGh,
    })

    // No longer in queue
    const after = await listPendingConfirmations(store, wfId)
    expect(after.some((e) => e.statusId === stId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 10. classifyStatus unit tests
// ---------------------------------------------------------------------------

describe('classifyStatus', () => {
  it('new category → new at high confidence', () => {
    const r = classifyStatus({ id: 'x', name: 'Backlog', category: 'new' })
    expect(r.flowState).toBe('new')
    expect(r.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD)
  })

  it('done category → done at high confidence', () => {
    const r = classifyStatus({ id: 'x', name: 'Done', category: 'done' })
    expect(r.flowState).toBe('done')
    expect(r.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD)
  })

  it('indeterminate + "In Progress" → active', () => {
    const r = classifyStatus({ id: 'x', name: 'In Progress', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
  })

  it('indeterminate + "In Development" → active', () => {
    const r = classifyStatus({ id: 'x', name: 'In Development', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
  })

  it('indeterminate + "In Review" → active', () => {
    const r = classifyStatus({ id: 'x', name: 'In Review', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
  })

  it('indeterminate + "Code Review" → active', () => {
    const r = classifyStatus({ id: 'x', name: 'Code Review', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
  })

  it('indeterminate + "QA Testing" → active (qa without queue suffix)', () => {
    const r = classifyStatus({ id: 'x', name: 'QA Testing', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
  })

  it('indeterminate + "QA Queue" → wait (qa with queue suffix)', () => {
    const r = classifyStatus({ id: 'x', name: 'QA Queue', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + bare "Testing" → active (regression: test\\w* must match)', () => {
    const r = classifyStatus({ id: 'x', name: 'Testing', category: 'indeterminate' })
    expect(r.flowState).toBe('active')
    expect(r.confidence).toBe(0.8)
  })

  it('indeterminate + "Awaiting Review" → wait (regression: await\\w* beats review)', () => {
    const r = classifyStatus({ id: 'x', name: 'Awaiting Review', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "Awaiting QA" → wait', () => {
    const r = classifyStatus({ id: 'x', name: 'Awaiting QA', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "Blocked" → wait', () => {
    const r = classifyStatus({ id: 'x', name: 'Blocked', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "On Hold" → wait', () => {
    const r = classifyStatus({ id: 'x', name: 'On Hold', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "Selected for Dev" → wait (selected for pattern takes priority over dev)', () => {
    const r = classifyStatus({ id: 'x', name: 'Selected for Dev', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "UAT" → wait', () => {
    const r = classifyStatus({ id: 'x', name: 'UAT', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + "Ready for Deployment" → wait', () => {
    const r = classifyStatus({ id: 'x', name: 'Ready for Deployment', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
  })

  it('indeterminate + ambiguous name → low confidence default (wait)', () => {
    const r = classifyStatus({ id: 'x', name: 'Engineering Slot', category: 'indeterminate' })
    expect(r.flowState).toBe('wait')
    expect(r.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD)
  })

  it('null category → falls through to name pattern matching', () => {
    const r = classifyStatus({ id: 'x', name: 'In Progress', category: null })
    expect(r.flowState).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// 11. applyBoardColumnAdjustment unit tests
// ---------------------------------------------------------------------------

describe('applyBoardColumnAdjustment', () => {
  const queueOnlyColumns = [{ statusIds: ['s1'], isStartedCol: false, isDoneCol: false }]
  const startedColumns = [{ statusIds: ['s1'], isStartedCol: true, isDoneCol: false }]
  const mixedColumns = [
    { statusIds: ['s1'], isStartedCol: false, isDoneCol: false },
    { statusIds: ['s1'], isStartedCol: true, isDoneCol: false },
  ]

  it('demotes active → wait when status is ONLY in queue columns', () => {
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'active', confidence: 0.8 },
      queueOnlyColumns,
    )
    expect(result.flowState).toBe('wait')
    expect(result.confidence).toBe(0.7)
  })

  it('does not demote when status also appears in a started column', () => {
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'active', confidence: 0.8 },
      mixedColumns,
    )
    expect(result.flowState).toBe('active')
  })

  it('promotes an indeterminate-named status to done when the board places it in a done column', () => {
    const doneColumns = [{ statusIds: ['s1'], isStartedCol: false, isDoneCol: true }]
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'active', confidence: 0.8 },
      doneColumns,
    )
    expect(result.flowState).toBe('done')
  })

  it('the done column is authoritative: in both a done AND a queue column (no started) → done', () => {
    // Intentional: SPEC §8.2 treats the board done column as the done boundary,
    // so presence in it wins over a concurrent queue-column membership.
    const doneAndQueue = [
      { statusIds: ['s1'], isStartedCol: false, isDoneCol: true },
      { statusIds: ['s1'], isStartedCol: false, isDoneCol: false },
    ]
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'wait', confidence: 0.45 },
      doneAndQueue,
    )
    expect(result.flowState).toBe('done')
  })

  it('does NOT promote to done when the status is also in a started column', () => {
    const doneAndStarted = [
      { statusIds: ['s1'], isStartedCol: false, isDoneCol: true },
      { statusIds: ['s1'], isStartedCol: true, isDoneCol: false },
    ]
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'active', confidence: 0.8 },
      doneAndStarted,
    )
    expect(result.flowState).not.toBe('done')
  })

  it('promotes low-confidence wait → active when status is in a started column', () => {
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'wait', confidence: 0.45 },
      startedColumns,
    )
    expect(result.flowState).toBe('active')
    expect(result.confidence).toBe(0.75)
  })

  it('does NOT promote higher-confidence wait (explicit wait pattern)', () => {
    // confidence 0.8 means the name matched a wait pattern — board should not override it
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'wait', confidence: 0.8 },
      startedColumns,
    )
    expect(result.flowState).toBe('wait')
  })

  it('never overrides new (category-derived) regardless of board columns', () => {
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'new', confidence: 0.95 },
      startedColumns,
    )
    expect(result.flowState).toBe('new')
  })

  it('never overrides done (category-derived) regardless of board columns', () => {
    const result = applyBoardColumnAdjustment(
      's1',
      { flowState: 'done', confidence: 0.95 },
      queueOnlyColumns,
    )
    expect(result.flowState).toBe('done')
  })

  it('returns initial unchanged when status does not appear in any column', () => {
    // s-unknown is not in queueOnlyColumns, so inNonStartedOnly is false → no change
    const result = applyBoardColumnAdjustment(
      's-unknown',
      { flowState: 'active', confidence: 0.8 },
      queueOnlyColumns,
    )
    expect(result.flowState).toBe('active')
  })
})
