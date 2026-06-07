/**
 * MSW v2 handlers for the Jira Cloud REST v3 + Agile APIs.
 *
 * Endpoints served:
 *   POST /rest/api/3/search/jql                            (cursor-paginated issue search)
 *   GET  /rest/api/3/issue/:issueId/changelog              (bulk changelog, >1 page)
 *   GET  /rest/api/3/status                                (all statuses)
 *   GET  /rest/api/3/project/:projectId                    (project metadata + field discovery)
 *   GET  /rest/agile/1.0/board                             (boards list)
 *   GET  /rest/agile/1.0/board/:boardId/sprint             (sprints for a board)
 *   GET  /rest/agile/1.0/board/:boardId/sprint/:sprintId/report  (sprint report)
 *   GET  /rest/agile/1.0/board/:boardId/configuration      (started/done columns)
 *
 * Pagination design:
 *   - /search/jql: cursor-based via `nextPageToken`; PAGE_SIZE=2 so 5 issues
 *     span multiple pages.
 *   - /changelog: paginated via `startAt` + `maxResults`; CHANGELOG_PAGE=5 so
 *     the 13-transition story-1 spans three pages — exhaustion is testable.
 *
 * All response data is derived from `baseOrg`.
 */

import type { RequestHandler } from 'msw'
import { HttpResponse, http } from 'msw'
import { baseOrg, IDS } from '../dataset/baseOrg.js'

// ---------------------------------------------------------------------------
// Pagination constants
// ---------------------------------------------------------------------------

/** Issues returned per /search/jql page. */
const SEARCH_PAGE_SIZE = 2

/** Changelog entries returned per /changelog page. */
const CHANGELOG_PAGE_SIZE = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Jira issue REST shape from the base-org record. */
function issueToJiraShape(issue: (typeof baseOrg.jiraIssues)[number]): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    summary: `${issue.type}: ${issue.key}`,
    issuetype: { name: issue.type, subtask: issue.isSubtask },
    status: {
      id: issue.statusId,
      name: issue.statusId, // name not used in ingestion; id is the key
      statusCategory: { key: issue.statusCategory },
    },
    project: { id: issue.projectId, key: baseOrg.jiraProject.key },
    created: issue.createdAt,
    resolutiondate: issue.resolvedAt,
    assignee: issue.assigneeIdentityId ? { accountId: issue.assigneeIdentityId } : null,
    parent: issue.parentId ? { id: issue.parentId } : undefined,
  }
  // Story points on the project-specific field
  if (issue.storyPointsFieldId && issue.storyPoints !== null) {
    fields[issue.storyPointsFieldId] = issue.storyPoints
  }

  return {
    id: issue.id,
    key: issue.key,
    fields,
  }
}

// ---------------------------------------------------------------------------
// /search/jql — cursor-paginated
// ---------------------------------------------------------------------------

function searchHandlers(): RequestHandler[] {
  return [
    http.post('*/rest/api/3/search/jql', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      const nextPageToken = body.nextPageToken as string | undefined
      const startIndex = nextPageToken ? Number(nextPageToken) : 0

      const issues = [...baseOrg.jiraIssues]
      const slice = issues.slice(startIndex, startIndex + SEARCH_PAGE_SIZE)
      const nextStart = startIndex + SEARCH_PAGE_SIZE
      const hasMore = nextStart < issues.length

      return HttpResponse.json({
        issues: slice.map(issueToJiraShape),
        total: issues.length,
        maxResults: SEARCH_PAGE_SIZE,
        startAt: startIndex,
        nextPageToken: hasMore ? String(nextStart) : undefined,
      })
    }),

    // Also support GET form used by some clients
    http.get('*/rest/api/3/search', ({ request }) => {
      const url = new URL(request.url)
      const startAt = Number(url.searchParams.get('startAt') ?? '0')
      const maxResults = Number(url.searchParams.get('maxResults') ?? String(SEARCH_PAGE_SIZE))

      const issues = [...baseOrg.jiraIssues]
      const slice = issues.slice(startAt, startAt + maxResults)
      const nextStart = startAt + maxResults
      const isLast = nextStart >= issues.length

      return HttpResponse.json({
        issues: slice.map(issueToJiraShape),
        total: issues.length,
        maxResults,
        startAt,
        isLast,
      })
    }),
  ]
}

// ---------------------------------------------------------------------------
// /issue/:issueId/changelog — bulk, paginated across >1 page
//
// The 13-transition story-1 is split across 3 pages (5 + 5 + 3) with
// CHANGELOG_PAGE_SIZE=5. Clients must follow startAt until exhausted.
// ---------------------------------------------------------------------------

function changelogHandlers(): RequestHandler[] {
  return [
    http.get('*/rest/api/3/issue/:issueId/changelog', ({ request, params }) => {
      const { issueId } = params as Record<string, string>
      const url = new URL(request.url)
      const startAt = Number(url.searchParams.get('startAt') ?? '0')
      const maxResults = Number(url.searchParams.get('maxResults') ?? String(CHANGELOG_PAGE_SIZE))

      // Look up transitions for this issue (noUncheckedIndexedAccess: key may be absent)
      const transitions: readonly import('../dataset/baseOrg.js').TransitionShape[] =
        issueId !== undefined ? (baseOrg.issueTransitions[issueId] ?? []) : []

      // Convert each transition to a Jira changelog history entry
      const histories = transitions.map((t) => ({
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

      const slice = histories.slice(startAt, startAt + maxResults)
      const total = histories.length
      const isLast = startAt + maxResults >= total

      return HttpResponse.json({
        startAt,
        maxResults,
        total,
        isLast,
        values: slice,
      })
    }),
  ]
}

// ---------------------------------------------------------------------------
// /status — all statuses with category mapping
// ---------------------------------------------------------------------------

function statusHandlers(): RequestHandler[] {
  return [
    http.get('*/rest/api/3/status', () => {
      const statuses = baseOrg.jiraStatuses.map((s) => ({
        id: s.id,
        name: s.name,
        statusCategory: {
          id: s.id,
          key: s.category,
          name: s.category,
        },
      }))
      return HttpResponse.json(statuses)
    }),
  ]
}

// ---------------------------------------------------------------------------
// /project/:projectId — project metadata + story-point field discovery
// ---------------------------------------------------------------------------

function projectHandlers(): RequestHandler[] {
  return [
    http.get('*/rest/api/3/project/:projectId', ({ params }) => {
      const { projectId } = params as Record<string, string>
      if (projectId !== IDS.jiraProjectId && projectId !== baseOrg.jiraProject.key) {
        return new HttpResponse(null, { status: 404 })
      }

      return HttpResponse.json({
        id: baseOrg.jiraProject.id,
        key: baseOrg.jiraProject.key,
        name: baseOrg.jiraProject.name,
        // Expose the story-point field id so clients can discover it
        properties: {
          storyPointsFieldId: baseOrg.jiraProject.storyPointsFieldId,
        },
      })
    }),

    // Field metadata endpoint (used for story-point field discovery)
    http.get('*/rest/api/3/field', () => {
      return HttpResponse.json([
        {
          id: baseOrg.jiraProject.storyPointsFieldId,
          name: 'Story Points',
          custom: true,
          schema: {
            type: 'number',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
          },
        },
        {
          id: 'status',
          name: 'Status',
          custom: false,
          schema: { type: 'status', system: 'status' },
        },
      ])
    }),

    // Workflow discovery (auxiliary). Empty result set — exercises the sync's
    // workflow path without a Classic-workflow fixture. The client paginator
    // stops on isLast=true.
    http.get('*/rest/api/3/workflow/search', () => {
      return HttpResponse.json({ values: [], startAt: 0, maxResults: 50, total: 0, isLast: true })
    }),
    http.get('*/rest/api/3/workflowscheme', () => {
      return HttpResponse.json({ values: [], startAt: 0, maxResults: 50, total: 0, isLast: true })
    }),
    http.get('*/rest/api/3/workflowscheme/:schemeId/issuetype', () => {
      return HttpResponse.json({ values: [] })
    }),
  ]
}

// ---------------------------------------------------------------------------
// Agile API — boards
// ---------------------------------------------------------------------------

function boardHandlers(): RequestHandler[] {
  return [
    // List boards
    http.get('*/rest/agile/1.0/board', () => {
      return HttpResponse.json({
        maxResults: 50,
        startAt: 0,
        total: 1,
        isLast: true,
        values: [
          {
            id: IDS.boardId,
            name: 'Acme Board',
            type: baseOrg.boardConfigs[0]?.type ?? 'scrum',
            location: { projectId: IDS.jiraProjectId, projectKey: baseOrg.jiraProject.key },
          },
        ],
      })
    }),

    // Board configuration (started/done columns) — the key endpoint for
    // cycle-time start boundary (SPEC WP-JIRA-BOARDCONFIG)
    http.get('*/rest/agile/1.0/board/:boardId/configuration', ({ params }) => {
      const { boardId } = params as Record<string, string>
      if (boardId !== IDS.boardId) return new HttpResponse(null, { status: 404 })

      const columns = baseOrg.boardColumns.map((col) => ({
        name: col.columnName,
        statuses: col.statusIds.map((sid) => ({ id: sid })),
        // Expose the started/done flags as custom fields that ingestion reads
        isStartedColumn: col.isStartedCol,
        isDoneColumn: col.isDoneCol,
      }))

      return HttpResponse.json({
        id: IDS.boardId,
        name: 'Acme Board',
        type: baseOrg.boardConfigs[0]?.type ?? 'scrum',
        columnConfig: { columns },
        estimation: {
          type: 'field',
          field: {
            fieldId: baseOrg.jiraProject.storyPointsFieldId,
            displayName: 'Story Points',
          },
        },
      })
    }),
  ]
}

// ---------------------------------------------------------------------------
// Agile API — sprints
// ---------------------------------------------------------------------------

function sprintHandlers(): RequestHandler[] {
  return [
    // List sprints for a board
    http.get('*/rest/agile/1.0/board/:boardId/sprint', ({ params }) => {
      const { boardId } = params as Record<string, string>
      if (boardId !== IDS.boardId) return new HttpResponse(null, { status: 404 })

      const sprints = baseOrg.sprints.map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        startDate: s.startAt,
        endDate: s.endAt,
        completeDate: s.completeAt,
        originBoardId: IDS.boardId,
      }))

      return HttpResponse.json({
        maxResults: 50,
        startAt: 0,
        total: sprints.length,
        isLast: true,
        values: sprints,
      })
    }),

    // Sprint report
    http.get('*/rest/agile/1.0/board/:boardId/sprint/:sprintId/report', ({ params }) => {
      const { boardId, sprintId } = params as Record<string, string>
      if (boardId !== IDS.boardId || sprintId !== IDS.sprintId) {
        return new HttpResponse(null, { status: 404 })
      }

      // Build completed and not-completed issue lists from membership events
      const addedIssueIds = new Set<string>()
      const removedIssueIds = new Set<string>()
      for (const evt of baseOrg.sprintMembershipEvents) {
        if (evt.sprintId === sprintId) {
          if (evt.change === 'added') addedIssueIds.add(evt.issueId)
          else removedIssueIds.add(evt.issueId)
        }
      }

      const completedIssues = baseOrg.jiraIssues
        .filter(
          (i) =>
            addedIssueIds.has(i.id) && !removedIssueIds.has(i.id) && i.statusCategory === 'done',
        )
        .map((i) => ({ id: i.id, key: i.key }))

      const incompleteIssues = baseOrg.jiraIssues
        .filter(
          (i) =>
            addedIssueIds.has(i.id) && !removedIssueIds.has(i.id) && i.statusCategory !== 'done',
        )
        .map((i) => ({ id: i.id, key: i.key }))

      const sprint = baseOrg.sprints.find((s) => s.id === sprintId)

      return HttpResponse.json({
        sprint: {
          id: sprintId,
          name: sprint?.name ?? sprintId,
          state: sprint?.state ?? 'closed',
          startDate: sprint?.startAt,
          endDate: sprint?.endAt,
          completeDate: sprint?.completeAt,
        },
        contents: {
          completedIssues,
          incompleteIssues,
          issuesNotCompletedInCurrentSprint: incompleteIssues,
          puntedIssues: [],
        },
      })
    }),
  ]
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Returns an array of MSW v2 request handlers that serve the base-org dataset
 * as realistic Jira Cloud REST v3 + Agile API responses.
 *
 * The bulk changelog for issue-story-1 spans three pages (CHANGELOG_PAGE_SIZE=5,
 * 13 transitions) so pagination-to-exhaustion is testable.
 *
 * Mount with `setupServer(...mockJira())` or pass to `withMockServer`.
 */
export function mockJira(): RequestHandler[] {
  return [
    ...searchHandlers(),
    ...changelogHandlers(),
    ...statusHandlers(),
    ...projectHandlers(),
    ...boardHandlers(),
    ...sprintHandlers(),
  ]
}
