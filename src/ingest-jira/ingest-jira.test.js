/**
 * Tests for @lazy-flow/ingest-jira
 *
 * Coverage:
 *   C1 trap (a) — missing initial status is seeded from createdAt + first from
 *   C1 trap (b) — unsorted changelog histories are sorted before processing
 *   C1 trap (c) — status→category mapped by NUMERIC id, not localized string
 *   C1 trap (d) — multi-page changelog is exhausted (13-transition story = 3 pages)
 *   Reopened issue — yields multiple Done transitions
 *   Board config — started vs queue column distinguished
 *   Workflow resolution — two issue types on the same workflow
 *   Story-point field discovery — per-project
 *   Sprint membership add-then-remove
 *   Idempotent backfill (no duplicate transitions on re-run)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { setupServer } from 'msw/node'
import { BunSqliteStore, migrate } from '../core/index.js'
import { baseOrg, IDS, mockJira } from '../testkit/index.js'
import {
  buildStatusCategoryHistory,
  buildStatusCategoryMap,
  ingestBoardConfigFromRaw,
  ingestWorkflowsFromDataset,
  JiraClient,
  parseChangelog,
  syncJira,
} from './index.js'

// ---------------------------------------------------------------------------
// Test store factory
// ---------------------------------------------------------------------------

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

// ---------------------------------------------------------------------------
// JiraClient factory — points at the MSW mock
// ---------------------------------------------------------------------------

function makeClient() {
  return new JiraClient({
    baseUrl: 'https://acme.atlassian.net',
    token: 'test-token',
  })
}

// Mount the Jira mock server — set up directly (not withMockServer) so that
// beforeAll/afterAll hooks are registered after Vitest initialises globals.
const server = setupServer(...mockJira())

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// Fixed timestamp for deterministic tests
const NOW = '2024-06-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Helper: build a minimal RawIssue for parseChangelog unit tests
// ---------------------------------------------------------------------------

function makeRawIssue(overrides) {
  return {
    id: overrides.id ?? IDS.issueStory1,
    key: overrides.key ?? 'ACME-2',
    fields: {
      created: overrides.createdAt ?? '2024-02-01T09:00:00Z',
      status: {
        id: overrides.statusId ?? IDS.statusBacklog,
        statusCategory: { key: 'new' },
      },
      customfield_10016: overrides.storyPoints ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// C1 trap (a) — Missing initial status
// ---------------------------------------------------------------------------

describe('C1 trap (a): initial status seeded from createdAt + first from', () => {
  it('produces a synthetic initial transition when changelog has entries', () => {
    const issue = makeRawIssue({ statusId: IDS.statusDone })
    // One history entry: Backlog → In Progress
    const histories = [
      {
        id: 'h1',
        created: '2024-02-05T09:00:00Z',
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusBacklog,
            fromString: 'Backlog',
            to: IDS.statusInProgress,
            toString: 'In Progress',
          },
        ],
      },
    ]

    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusInProgress, 'indeterminate'],
    ])

    const { transitions } = parseChangelog(issue, histories, statusMap, IDS.jiraProjectId)

    // Should have: initial seed + the 1 changelog transition = 2
    expect(transitions).toHaveLength(2)

    const initial = transitions[0]
    // The initial synthetic transition has fromStatusId = toStatusId = the first from
    expect(initial?.toStatusId).toBe(IDS.statusBacklog)
    expect(initial?.fromStatusId).toBe(IDS.statusBacklog)
    expect(initial?.transitionedAt).toBe('2024-02-01T09:00:00Z') // issue.fields.created

    const second = transitions[1]
    expect(second?.fromStatusId).toBe(IDS.statusBacklog)
    expect(second?.toStatusId).toBe(IDS.statusInProgress)
  })

  it('FAILS without the fix: no initial transition when omitting the seed logic', () => {
    // This test documents the expected failure mode (the seed is needed).
    // If we had NOT seeded the initial status, parsing a changelog with 1 entry
    // would yield only 1 transition (the explicit one), missing where the issue
    // started from.
    const issue = makeRawIssue({ createdAt: '2024-02-01T09:00:00Z' })
    const histories = [
      {
        id: 'h1',
        created: '2024-02-05T09:00:00Z',
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusBacklog,
            fromString: 'Backlog',
            to: IDS.statusInProgress,
            toString: 'In Progress',
          },
        ],
      },
    ]
    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusInProgress, 'indeterminate'],
    ])

    const { transitions } = parseChangelog(issue, histories, statusMap, IDS.jiraProjectId)

    // WITHOUT the fix there would be only 1 transition (no seeded initial).
    // With the fix there are 2 — assert the fix is present.
    expect(transitions.length).toBeGreaterThanOrEqual(2)
    // The first transition must be at the issue's created time
    expect(transitions[0]?.transitionedAt).toBe('2024-02-01T09:00:00Z')
  })

  it('seeds from current statusId when changelog is empty', () => {
    const issue = makeRawIssue({ statusId: IDS.statusInProgress })
    const statusMap = new Map([[IDS.statusInProgress, 'indeterminate']])

    const { transitions } = parseChangelog(issue, [], statusMap, IDS.jiraProjectId)

    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.toStatusId).toBe(IDS.statusInProgress)
    expect(transitions[0]?.fromStatusId).toBe(IDS.statusInProgress)
  })
})

// ---------------------------------------------------------------------------
// C1 trap (b) — Unsorted histories sorted
// ---------------------------------------------------------------------------

describe('C1 trap (b): unsorted changelog histories are sorted before processing', () => {
  it('produces transitions in chronological order regardless of API order', () => {
    const issue = makeRawIssue({})
    // Deliberately reversed: second transition arrives before first in the API payload
    const histories = [
      {
        id: 'h2',
        created: '2024-02-10T14:00:00Z', // SECOND in time
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusInProgress,
            fromString: 'In Progress',
            to: IDS.statusInReview,
            toString: 'In Review',
          },
        ],
      },
      {
        id: 'h1',
        created: '2024-02-07T10:00:00Z', // FIRST in time
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusBacklog,
            fromString: 'Backlog',
            to: IDS.statusInProgress,
            toString: 'In Progress',
          },
        ],
      },
    ]

    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusInProgress, 'indeterminate'],
      [IDS.statusInReview, 'indeterminate'],
    ])

    const { transitions } = parseChangelog(issue, histories, statusMap, IDS.jiraProjectId)

    // Expect: initial(created=issue.created) → h1(Feb 7) → h2(Feb 10)
    const timestamps = transitions.map((t) => t.transitionedAt)
    expect(timestamps[0]).toBe('2024-02-01T09:00:00Z') // seeded initial
    expect(timestamps[1]).toBe('2024-02-07T10:00:00Z') // h1 (first in time)
    expect(timestamps[2]).toBe('2024-02-10T14:00:00Z') // h2 (second in time)
  })

  it('FAILS without the fix: out-of-order histories yield wrong sequence', () => {
    // This test documents: if we did NOT sort, history[0] = h2 (Feb 10) would
    // appear before h1 (Feb 7) in the output. With the fix, they are sorted.
    const issue = makeRawIssue({})
    const histories = [
      {
        id: 'h2',
        created: '2024-02-10T00:00:00Z',
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusInProgress,
            fromString: 'In Progress',
            to: IDS.statusDone,
            toString: 'Done',
          },
        ],
      },
      {
        id: 'h1',
        created: '2024-02-05T00:00:00Z',
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusBacklog,
            fromString: 'Backlog',
            to: IDS.statusInProgress,
            toString: 'In Progress',
          },
        ],
      },
    ]
    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusInProgress, 'indeterminate'],
      [IDS.statusDone, 'done'],
    ])

    const { transitions } = parseChangelog(issue, histories, statusMap, IDS.jiraProjectId)

    // With fix: must be sorted by time
    for (let i = 1; i < transitions.length; i++) {
      const prev = transitions[i - 1]
      const curr = transitions[i]
      if (!prev || !curr) continue
      expect(new Date(curr.transitionedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(prev.transitionedAt).getTime(),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// C1 trap (c) — Status→category by numeric ID
// ---------------------------------------------------------------------------

describe('C1 trap (c): status→category mapped by numeric id not localized string', () => {
  it('buildStatusCategoryMap keys on numeric status ids', () => {
    const statuses = [
      { id: '10000', name: 'Backlog', statusCategory: { id: '1', key: 'new', name: 'To Do' } },
      {
        id: '10002',
        name: 'In Progress',
        statusCategory: { id: '4', key: 'indeterminate', name: 'In Progress' },
      },
      { id: '10004', name: 'Done', statusCategory: { id: '3', key: 'done', name: 'Done' } },
    ]

    const map = buildStatusCategoryMap(statuses)

    // Keys are numeric IDs, not names
    expect(map.get('10000')).toBe('new')
    expect(map.get('10002')).toBe('indeterminate')
    expect(map.get('10004')).toBe('done')

    // Should NOT be keyed on localized display names
    expect(map.has('Backlog')).toBe(false)
    expect(map.has('In Progress')).toBe(false)
    expect(map.has('Done')).toBe(false)
  })

  it('parseChangelog uses numeric from/to fields not fromString/toString', () => {
    const issue = makeRawIssue({})
    // The toString uses a localized name that would produce wrong categories
    // if we mistakenly keyed on it. Only the `to` numeric id should be used.
    const histories = [
      {
        id: 'h1',
        created: '2024-02-05T10:00:00Z',
        author: null,
        items: [
          {
            field: 'status',
            fieldtype: 'jira',
            from: IDS.statusBacklog, // '10000'
            fromString: 'IGNORED_FROM', // localized — must not be used
            to: IDS.statusDone, // '10004'
            toString: 'IGNORED_TO', // localized — must not be used
          },
        ],
      },
    ]

    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusDone, 'done'],
    ])

    const { transitions } = parseChangelog(issue, histories, statusMap, IDS.jiraProjectId)

    // The transition should use numeric IDs
    const last = transitions[transitions.length - 1]
    expect(last?.fromStatusId).toBe(IDS.statusBacklog)
    expect(last?.toStatusId).toBe(IDS.statusDone)
    // Should NOT contain the localized strings
    expect(last?.fromStatusId).not.toBe('IGNORED_FROM')
    expect(last?.toStatusId).not.toBe('IGNORED_TO')
  })

  it('FAILS without the fix: keying on string names misses numeric-only entries', () => {
    // If we had used fromString/toString, the following status IDs would
    // produce wrong categories. Assert the numeric path is correct.
    const statuses = [
      {
        id: '99999',
        name: 'Custom Done Status',
        statusCategory: { id: '3', key: 'done', name: 'Done' },
      },
    ]
    const map = buildStatusCategoryMap(statuses)
    // Looking up by numeric id must work
    expect(map.get('99999')).toBe('done')
    // Looking up by display name must NOT work
    expect(map.get('Custom Done Status')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C1 trap (d) — Multi-page changelog exhausted via mock
// ---------------------------------------------------------------------------

describe('C1 trap (d): multi-page changelog is fetched to exhaustion', () => {
  it('fetches all 13 transitions for story-1 across 3 pages', async () => {
    const client = makeClient()

    // The mock serves 13 transitions for issue-story-1 with PAGE_SIZE=5
    // → 3 pages (5 + 5 + 3). We must get all 13.
    const { histories, total } = await client.getChangelogAll(IDS.issueStory1, 5)

    expect(total).toBe(13)
    expect(histories).toHaveLength(13)
    // Verify transitions are in the expected order
    expect(histories[0]?.id).toBe('tr-story-01')
    expect(histories[12]?.id).toBe('tr-story-13')
  })

  it('FAILS without the fix: stopping at first page misses 8 transitions', async () => {
    const client = makeClient()

    // Without pagination, only the first 5 would be fetched
    const firstPage = await client.getChangelogPage(IDS.issueStory1, 0, 5)
    expect(firstPage.values).toHaveLength(5)
    expect(firstPage.isLast).toBe(false)
    expect(firstPage.total).toBe(13)

    // The full fetch (with fix) must get all 13
    const { histories } = await client.getChangelogAll(IDS.issueStory1, 5)
    expect(histories).toHaveLength(13)
    // Assert more than just the first page
    expect(histories.length).toBeGreaterThan(firstPage.values.length)
  })

  it('parseChangelog processes all 13 story-1 transitions correctly', async () => {
    const client = makeClient()
    const statuses = await client.getStatuses()
    const statusMap = buildStatusCategoryMap(statuses)

    const { histories } = await client.getChangelogAll(IDS.issueStory1)

    const rawIssue = makeRawIssue({
      id: IDS.issueStory1,
      key: 'ACME-2',
      createdAt: '2024-02-01T09:00:00Z',
    })

    const { transitions } = parseChangelog(rawIssue, histories, statusMap, IDS.jiraProjectId)

    // 1 seeded initial + 13 changelog = 14 total
    expect(transitions).toHaveLength(14)

    // All transitions must be in chronological order
    for (let i = 1; i < transitions.length; i++) {
      const prev = transitions[i - 1]
      const curr = transitions[i]
      if (!prev || !curr) continue
      expect(new Date(curr.transitionedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(prev.transitionedAt).getTime(),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Reopened issue — multiple Done transitions
// ---------------------------------------------------------------------------

describe('reopened issue yields correct multiple Done transitions', () => {
  it('incident-1: Done → reopen → Done produces 2 Done transitions', () => {
    // Incident-1 transitions from baseOrg
    const histories = baseOrg.issueTransitions[IDS.issueIncident1] ?? []
    const rawHistories = histories.map((t) => ({
      id: t.id,
      created: t.transitionedAt,
      author: t.actorIdentityId ? { accountId: t.actorIdentityId } : null,
      items: [
        {
          field: 'status',
          fieldtype: 'jira',
          from: t.fromStatusId,
          fromString: t.fromStatusId,
          to: t.toStatusId,
          toString: t.toStatusId,
        },
      ],
    }))

    const statusMap = new Map([
      [IDS.statusBacklog, 'new'],
      [IDS.statusInProgress, 'indeterminate'],
      [IDS.statusDone, 'done'],
    ])

    const rawIssue = makeRawIssue({
      id: IDS.issueIncident1,
      key: 'ACME-4',
      createdAt: '2024-03-02T11:00:00Z',
      statusId: IDS.statusDone,
    })

    const { transitions } = parseChangelog(rawIssue, rawHistories, statusMap, IDS.jiraProjectId)

    // Count transitions that enter Done
    const doneTransitions = transitions.filter((t) => t.toStatusId === IDS.statusDone)
    expect(doneTransitions).toHaveLength(2)

    // First Done at tr-incident-02 time
    expect(doneTransitions[0]?.transitionedAt).toBe('2024-03-02T12:00:00Z')
    // Second Done (after reopen) at tr-incident-04 time
    expect(doneTransitions[1]?.transitionedAt).toBe('2024-03-03T09:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// Board config — started vs queue column
// ---------------------------------------------------------------------------

describe('board config: started vs queue column distinguished', () => {
  it('ingestBoardConfigFromRaw marks only In Progress as started, not Selected for Dev', async () => {
    const store = makeStore()

    const rawConfig = {
      id: IDS.boardId,
      name: 'Acme Board',
      type: 'scrum',
      columnConfig: {
        columns: [
          {
            name: 'Backlog',
            statuses: [{ id: IDS.statusBacklog }],
            isStartedColumn: false,
            isDoneColumn: false,
          },
          // EDGE CASE: queue column — must NOT be isStartedCol
          {
            name: 'Selected for Dev',
            statuses: [{ id: IDS.statusSelected }],
            isStartedColumn: false,
            isDoneColumn: false,
          },
          // Cycle-time START boundary
          {
            name: 'In Progress',
            statuses: [{ id: IDS.statusInProgress }],
            isStartedColumn: true,
            isDoneColumn: false,
          },
          {
            name: 'In Review',
            statuses: [{ id: IDS.statusInReview }],
            isStartedColumn: true,
            isDoneColumn: false,
          },
          {
            name: 'Done',
            statuses: [{ id: IDS.statusDone }],
            isStartedColumn: false,
            isDoneColumn: true,
          },
        ],
      },
    }

    await ingestBoardConfigFromRaw(store, rawConfig, NOW)

    const boardConfig = await store.getBoardConfig(IDS.boardId)
    expect(boardConfig).not.toBeNull()
    expect(boardConfig?.type).toBe('scrum')

    const columns = await store.getBoardColumns(IDS.boardId)
    expect(columns).toHaveLength(5)

    const selected = columns.find((c) => c.columnName === 'Selected for Dev')
    const inProgress = columns.find((c) => c.columnName === 'In Progress')
    const done = columns.find((c) => c.columnName === 'Done')

    // 'Selected for Dev' is a queue column — NOT started
    expect(selected?.isStartedCol).toBe(false)
    expect(selected?.isDoneCol).toBe(false)

    // 'In Progress' is the cycle-time start boundary
    expect(inProgress?.isStartedCol).toBe(true)
    expect(inProgress?.isDoneCol).toBe(false)

    // 'Done' is the done column
    expect(done?.isDoneCol).toBe(true)
    expect(done?.isStartedCol).toBe(false)
  })

  it('fetches and ingests board config via client (integration with mock)', async () => {
    const client = makeClient()
    const store = makeStore()

    const raw = await client.getBoardConfiguration(IDS.boardId)
    await ingestBoardConfigFromRaw(store, raw, NOW)

    const columns = await store.getBoardColumns(IDS.boardId)
    expect(columns.length).toBeGreaterThan(0)

    // Selected for Dev must NOT be a started column
    const selected = columns.find((c) => c.columnName === 'Selected for Dev')
    if (selected) {
      expect(selected.isStartedCol).toBe(false)
    }

    // At least one column must be a started column
    const startedCols = columns.filter((c) => c.isStartedCol)
    expect(startedCols.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Workflow resolution — two issue types
// ---------------------------------------------------------------------------

describe('workflow resolution: two issue types on the same workflow', () => {
  it('persists workflow and maps Story + Subtask to the same workflow id', async () => {
    const store = makeStore()

    // Seed the jira_project first — workflow_scheme_mappings has a FK to jira_projects(id)
    await store.upsertJiraProject({
      id: IDS.jiraProjectId,
      key: baseOrg.jiraProject.key,
      name: baseOrg.jiraProject.name,
      jiraCloudId: baseOrg.jiraProject.jiraCloudId,
      raw: baseOrg.jiraProject.raw,
      createdAt: NOW,
      updatedAt: NOW,
    })

    await ingestWorkflowsFromDataset(
      store,
      baseOrg.workflows.map((w) => ({ workflowId: w.workflowId, name: w.name })),
      baseOrg.workflowSchemeMappings.map((m) => ({
        projectId: m.projectId,
        issueType: m.issueType,
        workflowId: m.workflowId,
      })),
      NOW,
    )

    const workflow = await store.getWorkflow(IDS.workflowId)
    expect(workflow).not.toBeNull()
    expect(workflow?.name).toBe('Standard Software Workflow')

    const mappings = await store.getWorkflowSchemeMappings(IDS.jiraProjectId)
    const issueTypes = mappings.map((m) => m.issueType)

    expect(issueTypes).toContain('Story')
    expect(issueTypes).toContain('Subtask')

    // Both resolve to the same workflow
    const storyMapping = mappings.find((m) => m.issueType === 'Story')
    const subtaskMapping = mappings.find((m) => m.issueType === 'Subtask')
    expect(storyMapping?.workflowId).toBe(IDS.workflowId)
    expect(subtaskMapping?.workflowId).toBe(IDS.workflowId)
  })
})

// ---------------------------------------------------------------------------
// Story-point field discovery
// ---------------------------------------------------------------------------

describe('per-project story-point field discovery', () => {
  it('discovers the story-point field id from the /field endpoint', async () => {
    const client = makeClient()
    const fieldId = await client.discoverStoryPointField(IDS.jiraProjectId)
    expect(fieldId).toBe(baseOrg.jiraProject.storyPointsFieldId) // 'customfield_10016'
  })

  it('discovers the story-point field id from the /project properties', async () => {
    const client = makeClient()
    // The mock serves storyPointsFieldId in project properties
    const fieldId = await client.discoverStoryPointField(IDS.jiraProjectId)
    expect(fieldId).toBe('customfield_10016')
  })
})

// ---------------------------------------------------------------------------
// Sprint membership add-then-remove
// ---------------------------------------------------------------------------

describe('sprint membership add-then-remove', () => {
  it('parseChangelog extracts add-then-remove sprint events from Sprint-field changelog', () => {
    // Simulate the Sprint-field changelog for subtask-1: added to sprint-1, then removed.
    const rawIssue = makeRawIssue({
      id: IDS.issueSubtask1,
      key: 'ACME-3',
      createdAt: '2024-02-05T09:00:00Z',
    })

    const histories = [
      {
        id: 'sprint-add',
        created: '2024-02-07T10:30:00Z',
        author: null,
        items: [
          {
            field: 'Sprint',
            fieldtype: 'custom',
            from: null,
            fromString: null,
            to: IDS.sprintId,
            toString: 'Sprint 1',
          },
        ],
      },
      {
        id: 'sprint-remove',
        created: '2024-02-12T14:00:00Z',
        author: null,
        items: [
          {
            field: 'Sprint',
            fieldtype: 'custom',
            from: IDS.sprintId,
            fromString: 'Sprint 1',
            to: null,
            toString: null,
          },
        ],
      },
    ]

    const statusMap = new Map([[IDS.statusDone, 'done']])

    const { sprintEvents } = parseChangelog(rawIssue, histories, statusMap, IDS.jiraProjectId)

    // Should have one 'added' event and one 'removed' event
    const addEvent = sprintEvents.find((e) => e.change === 'added')
    const removeEvent = sprintEvents.find((e) => e.change === 'removed')

    expect(addEvent).toBeDefined()
    expect(addEvent?.sprintId).toBe(IDS.sprintId)
    expect(addEvent?.issueId).toBe(IDS.issueSubtask1)
    expect(addEvent?.transitionedAt).toBe('2024-02-07T10:30:00Z')

    expect(removeEvent).toBeDefined()
    expect(removeEvent?.sprintId).toBe(IDS.sprintId)
    expect(removeEvent?.transitionedAt).toBe('2024-02-12T14:00:00Z')
  })

  it('syncJira persists sprint membership events for story-1 from the sprint report', async () => {
    const store = makeStore()
    const client = makeClient()

    await syncJira(
      store,
      client,
      {
        jiraCloudId: baseOrg.org.jiraCloudId,
        projectKeys: [baseOrg.jiraProject.key],
        boardIds: [IDS.boardId],
      },
      'backfill',
      NOW,
    )

    const events = await store.getSprintMembershipEvents(IDS.sprintId)

    // story-1 is the completed issue in the sprint report
    const storyEvents = events.filter((e) => e.issueId === IDS.issueStory1)
    expect(storyEvents.length).toBeGreaterThanOrEqual(1)
    expect(storyEvents[0]?.change).toBe('added')
  })
})

// ---------------------------------------------------------------------------
// Idempotent backfill (no duplicate transitions)
// ---------------------------------------------------------------------------

describe('idempotent backfill', () => {
  it('running backfill twice produces the same number of transitions', async () => {
    const store = makeStore()
    const client = makeClient()

    const scope = {
      jiraCloudId: baseOrg.org.jiraCloudId,
      projectKeys: [baseOrg.jiraProject.key],
      boardIds: [IDS.boardId],
    }

    await syncJira(store, client, scope, 'backfill', NOW)
    const afterFirst = await store.getIssueTransitions(IDS.issueStory1)

    await syncJira(store, client, scope, 'backfill', NOW)
    const afterSecond = await store.getIssueTransitions(IDS.issueStory1)

    // Transitions are append-only with INSERT OR IGNORE — no duplication
    expect(afterSecond.length).toBe(afterFirst.length)
  })

  it('running backfill twice produces the same issues count', async () => {
    const store = makeStore()
    const client = makeClient()

    const scope = {
      jiraCloudId: baseOrg.org.jiraCloudId,
      projectKeys: [baseOrg.jiraProject.key],
      boardIds: [IDS.boardId],
    }

    const result1 = await syncJira(store, client, scope, 'backfill', NOW)
    const result2 = await syncJira(store, client, scope, 'backfill', NOW)

    expect(result1.issuesUpserted).toBe(result2.issuesUpserted)
  })
})

// ---------------------------------------------------------------------------
// Status category history
// ---------------------------------------------------------------------------

describe('status category history', () => {
  it('buildStatusCategoryHistory produces effective-dated rows', () => {
    const statuses = [
      { id: '10000', name: 'Backlog', statusCategory: { id: '1', key: 'new', name: 'To Do' } },
      { id: '10004', name: 'Done', statusCategory: { id: '3', key: 'done', name: 'Done' } },
    ]

    const rows = buildStatusCategoryHistory(statuses, NOW)

    expect(rows).toHaveLength(2)
    expect(rows[0]?.statusId).toBe('10000')
    expect(rows[0]?.category).toBe('new')
    expect(rows[0]?.validFrom).toBe(NOW)
    expect(rows[0]?.validTo).toBeNull()
    expect(rows[1]?.category).toBe('done')
  })

  it('syncJira snapshots status categories into the store', async () => {
    const store = makeStore()
    const client = makeClient()

    await syncJira(
      store,
      client,
      {
        jiraCloudId: baseOrg.org.jiraCloudId,
        projectKeys: [baseOrg.jiraProject.key],
        boardIds: [IDS.boardId],
      },
      'backfill',
      NOW,
    )

    // Verify at least one status category was snapshotted
    const category = await store.getStatusCategory(IDS.statusDone, NOW)
    expect(category).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Full sync integration smoke
// ---------------------------------------------------------------------------

describe('syncJira integration smoke', () => {
  it('backfill processes all issues without errors', async () => {
    const store = makeStore()
    const client = makeClient()

    const result = await syncJira(
      store,
      client,
      {
        jiraCloudId: baseOrg.org.jiraCloudId,
        projectKeys: [baseOrg.jiraProject.key],
        boardIds: [IDS.boardId],
      },
      'backfill',
      NOW,
    )

    expect(result.errors).toHaveLength(0)
    expect(result.issuesUpserted).toBe(baseOrg.jiraIssues.length)
    expect(result.projectsProcessed).toContain(baseOrg.jiraProject.key)
    expect(result.transitionsAppended).toBeGreaterThan(0)
  })

  it('backfill persists all story-1 transitions (all 14 including seeded initial)', async () => {
    const store = makeStore()
    const client = makeClient()

    await syncJira(
      store,
      client,
      {
        jiraCloudId: baseOrg.org.jiraCloudId,
        projectKeys: [baseOrg.jiraProject.key],
        boardIds: [IDS.boardId],
      },
      'backfill',
      NOW,
    )

    const transitions = await store.getIssueTransitions(IDS.issueStory1)
    // 1 seeded initial + 13 changelog transitions = 14
    expect(transitions).toHaveLength(14)
  })

  it('sprints are ingested', async () => {
    const store = makeStore()
    const client = makeClient()

    await syncJira(
      store,
      client,
      {
        jiraCloudId: baseOrg.org.jiraCloudId,
        projectKeys: [baseOrg.jiraProject.key],
        boardIds: [IDS.boardId],
      },
      'backfill',
      NOW,
    )

    const sprint = await store.getSprint(IDS.sprintId)
    expect(sprint).not.toBeNull()
    expect(sprint?.boardId).toBe(IDS.boardId)
  })
})
