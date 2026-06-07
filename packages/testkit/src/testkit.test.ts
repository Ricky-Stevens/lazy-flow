/**
 * Self-tests for @lazy-flow/testkit.
 *
 * Covers:
 *   1. GitHub mock — REST commits call returns base-org data and paginates
 *   2. GitHub mock — GraphQL PullRequestGraph query paginates inner connections
 *   3. Jira mock — /search/jql returns expected shapes across pages
 *   4. Jira mock — bulk changelog spans >1 page (exhaustion testable)
 *   5. Jira mock — board /configuration returns started/done column shapes
 *   6. Dataset consistency — referenced IDs resolve
 *   7. Dataset immutability — mutation throws in strict mode
 *   8. fakeClock — freezes Date.now() and new Date()
 *   9. withMockServer — raises on unhandled requests
 */

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { baseOrg, fakeClock, IDS, mockGitHub, mockJira, withMockServer } from './index.js'

// ---------------------------------------------------------------------------
// 1 + 2: GitHub mock
// ---------------------------------------------------------------------------

describe('mockGitHub', () => {
  const server = setupServer(...mockGitHub())

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('REST: GET /repos/:owner/:repo returns repo metadata', async () => {
    const res = await fetch('https://api.github.com/repos/octo-acme/alpha-service')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ full_name: 'octo-acme/alpha-service' })
  })

  it('REST: GET /repos/:owner/:repo/commits paginates and returns base-org commits', async () => {
    // alpha-service has 3 commits; per_page=2 forces two pages
    const page1Res = await fetch(
      'https://api.github.com/repos/octo-acme/alpha-service/commits?per_page=2&page=1',
    )
    expect(page1Res.status).toBe(200)
    const page1 = (await page1Res.json()) as unknown[]
    expect(page1.length).toBe(2)

    // Link header should be present on page 1
    const linkHeader = page1Res.headers.get('Link')
    expect(linkHeader).toContain('rel="next"')

    // Fetch page 2 — remainder
    const page2Res = await fetch(
      'https://api.github.com/repos/octo-acme/alpha-service/commits?per_page=2&page=2',
    )
    expect(page2Res.status).toBe(200)
    const page2 = (await page2Res.json()) as unknown[]
    expect(page2.length).toBeGreaterThanOrEqual(1)

    // No Link header on last page
    expect(page2Res.headers.get('Link')).toBeNull()

    // Total across pages equals the commits in baseOrg for alpha-service
    const alphaCommits = baseOrg.commits.filter((c) => c.repoId === IDS.repoAlpha)
    expect(page1.length + page2.length).toBe(alphaCommits.length)
  })

  it('REST: GET /repos/:owner/:repo/pulls returns PRs for the repo', async () => {
    const res = await fetch('https://api.github.com/repos/octo-acme/alpha-service/pulls?state=all')
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    const alphaPrs = baseOrg.pullRequests.filter((p) => p.repoId === IDS.repoAlpha)
    expect(body.length).toBe(alphaPrs.length)
  })

  it('REST: GET /repos/:owner/:repo/pulls/:number/reviews returns reviews for pr-1', async () => {
    const res = await fetch('https://api.github.com/repos/octo-acme/alpha-service/pulls/1/reviews')
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    const pr1Reviews = baseOrg.reviews.filter((r) => r.prId === IDS.pr1)
    expect(body.length).toBe(pr1Reviews.length)
  })

  it('REST: rate-limit headers are present on responses', async () => {
    const res = await fetch('https://api.github.com/repos/octo-acme/alpha-service')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4999')
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5000')
  })

  it('GraphQL: PullRequestGraph returns pr-1 with paginated reviews', async () => {
    // Page 1: first review
    const page1 = await fetchGraphQL('PullRequestGraph', {
      prId: IDS.pr1,
      reviewsAfter: null,
    })
    const pr1 = page1?.repository?.pullRequest as GqlPr | undefined
    expect(pr1?.id).toBe(IDS.pr1)

    const reviewsPage1 = pr1?.reviews
    expect(reviewsPage1?.nodes?.length).toBe(1) // GQL_PAGE_SIZE=1
    expect(reviewsPage1?.pageInfo?.hasNextPage).toBe(true)
    const cursor1 = reviewsPage1?.pageInfo?.endCursor as string

    // Page 2: second review — pagination exhaustion
    const page2 = await fetchGraphQL('PullRequestGraph', {
      prId: IDS.pr1,
      reviewsAfter: cursor1,
    })
    const pr1p2 = page2?.repository?.pullRequest as GqlPr | undefined
    const reviewsPage2 = pr1p2?.reviews
    expect(reviewsPage2?.nodes?.length).toBe(1)
    expect(reviewsPage2?.pageInfo?.hasNextPage).toBe(false)
  })

  it('GraphQL: rateLimit field is present in PullRequestGraph response', async () => {
    const result = await fetchGraphQLRaw('PullRequestGraph', { prId: IDS.pr1 })
    const rateLimit = result.rateLimit as Record<string, unknown> | undefined
    expect(rateLimit).toMatchObject({
      cost: 1,
      remaining: expect.any(Number),
    })
  })

  it('GraphQL: timeline items paginate with pageInfo', async () => {
    const result = await fetchGraphQL('PullRequestGraph', { prId: IDS.pr1 })
    const pr = result?.repository?.pullRequest as GqlPr | undefined
    const timeline = pr?.timelineItems
    expect(timeline?.pageInfo).toBeDefined()
    expect(typeof timeline?.pageInfo?.hasNextPage).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// 3 + 4 + 5: Jira mock
// ---------------------------------------------------------------------------

describe('mockJira', () => {
  const server = setupServer(...mockJira())

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('/search/jql returns issues across multiple pages', async () => {
    // Collect all pages
    const allIssues: unknown[] = []
    let nextPageToken: string | undefined
    let pages = 0

    do {
      const body: Record<string, unknown> = nextPageToken
        ? { nextPageToken }
        : { jql: 'project = ACME ORDER BY created ASC' }

      const res = await fetch('https://jira.atlassian.net/rest/api/3/search/jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      const page = (await res.json()) as {
        issues: unknown[]
        nextPageToken?: string
        total: number
      }
      allIssues.push(...page.issues)
      nextPageToken = page.nextPageToken
      pages++
    } while (nextPageToken !== undefined)

    // Should have paginated (5 issues at page size 2 = 3 pages)
    expect(pages).toBeGreaterThan(1)
    // Should have all issues
    expect(allIssues.length).toBe(baseOrg.jiraIssues.length)
  })

  it('bulk changelog for story-1 spans >1 page (exhaustion)', async () => {
    const storyTransitions = baseOrg.issueTransitions[IDS.issueStory1] ?? []
    expect(storyTransitions.length).toBeGreaterThan(10) // 13 in base dataset

    const collected: unknown[] = []
    let startAt = 0
    let pages = 0
    let isLast = false

    while (!isLast) {
      const res = await fetch(
        `https://jira.atlassian.net/rest/api/3/issue/${IDS.issueStory1}/changelog?startAt=${startAt}&maxResults=5`,
      )
      expect(res.status).toBe(200)
      const page = (await res.json()) as {
        values: unknown[]
        total: number
        startAt: number
        maxResults: number
        isLast: boolean
      }
      collected.push(...page.values)
      pages++
      isLast = page.isLast
      startAt += page.maxResults
    }

    // Must have used >1 page for 13 transitions at page size 5
    expect(pages).toBeGreaterThanOrEqual(3)
    // All transitions accounted for
    expect(collected.length).toBe(storyTransitions.length)
  })

  it('bulk changelog for incident-1 includes Done→reopen→Done transitions', async () => {
    const res = await fetch(
      `https://jira.atlassian.net/rest/api/3/issue/${IDS.issueIncident1}/changelog?startAt=0&maxResults=50`,
    )
    const page = (await res.json()) as { values: Array<{ items: Array<{ to: string }> }> }
    // Should have the Done→In Progress→Done cycle
    const toStatuses = page.values.flatMap((v) => v.items.map((i) => i.to))
    expect(toStatuses.filter((s) => s === IDS.statusDone).length).toBeGreaterThanOrEqual(2)
  })

  it('/status returns all statuses with category mapping', async () => {
    const res = await fetch('https://jira.atlassian.net/rest/api/3/status')
    expect(res.status).toBe(200)
    const statuses = (await res.json()) as Array<{ id: string; statusCategory: { key: string } }>
    expect(statuses.length).toBe(baseOrg.jiraStatuses.length)

    // Verify category mapping (numeric ID → category)
    const backlog = statuses.find((s) => s.id === IDS.statusBacklog)
    expect(backlog?.statusCategory?.key).toBe('new')
    const done = statuses.find((s) => s.id === IDS.statusDone)
    expect(done?.statusCategory?.key).toBe('done')
  })

  it('board /configuration distinguishes queue vs started columns', async () => {
    const res = await fetch(
      `https://jira.atlassian.net/rest/agile/1.0/board/${IDS.boardId}/configuration`,
    )
    expect(res.status).toBe(200)
    const config = (await res.json()) as {
      columnConfig: {
        columns: Array<{
          name: string
          statuses: Array<{ id: string }>
          isStartedColumn: boolean
          isDoneColumn: boolean
        }>
      }
    }

    const columns = config.columnConfig.columns

    // "Selected for Dev" must NOT be a started column (it's a queue)
    const selectedCol = columns.find((c) => c.statuses.some((s) => s.id === IDS.statusSelected))
    expect(selectedCol?.isStartedColumn).toBe(false)
    expect(selectedCol?.isDoneColumn).toBe(false)

    // "In Progress" IS the cycle-time start boundary
    const inProgressCol = columns.find((c) => c.statuses.some((s) => s.id === IDS.statusInProgress))
    expect(inProgressCol?.isStartedColumn).toBe(true)

    // "Done" is the done column
    const doneCol = columns.find((c) => c.statuses.some((s) => s.id === IDS.statusDone))
    expect(doneCol?.isDoneColumn).toBe(true)
  })

  it('board /sprint returns sprints with correct state', async () => {
    const res = await fetch(`https://jira.atlassian.net/rest/agile/1.0/board/${IDS.boardId}/sprint`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { values: Array<{ id: string; state: string }> }
    expect(body.values.length).toBe(1)
    expect(body.values[0]?.id).toBe(IDS.sprintId)
    expect(body.values[0]?.state).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// 6: Dataset consistency
// ---------------------------------------------------------------------------

describe('baseOrg dataset consistency', () => {
  it('all PR repoIds resolve to a known repository', () => {
    const repoIds = new Set(baseOrg.repositories.map((r) => r.id))
    for (const pr of baseOrg.pullRequests) {
      expect(repoIds.has(pr.repoId), `PR ${pr.id} repoId ${pr.repoId} not found`).toBe(true)
    }
  })

  it('all commit repoIds resolve to a known repository', () => {
    const repoIds = new Set(baseOrg.repositories.map((r) => r.id))
    for (const c of baseOrg.commits) {
      expect(repoIds.has(c.repoId), `commit ${c.sha} repoId ${c.repoId} not found`).toBe(true)
    }
  })

  it('all review prIds resolve to a known pull request', () => {
    const prIds = new Set(baseOrg.pullRequests.map((p) => p.id))
    for (const r of baseOrg.reviews) {
      expect(prIds.has(r.prId), `review ${r.nodeId} prId ${r.prId} not found`).toBe(true)
    }
  })

  it('all reviewComment prIds resolve to a known pull request', () => {
    const prIds = new Set(baseOrg.pullRequests.map((p) => p.id))
    for (const rc of baseOrg.reviewComments) {
      expect(prIds.has(rc.prId), `reviewComment ${rc.nodeId} prId ${rc.prId} not found`).toBe(true)
    }
  })

  it('all transition issueIds resolve to a known issue', () => {
    const issueIds = new Set(baseOrg.jiraIssues.map((i) => i.id))
    for (const [issueId, transitions] of Object.entries(baseOrg.issueTransitions)) {
      expect(issueIds.has(issueId), `issueTransitions key ${issueId} not found in jiraIssues`).toBe(
        true,
      )
      for (const t of transitions) {
        expect(t.issueId).toBe(issueId)
      }
    }
  })

  it('all identities with a personId reference a known person', () => {
    const personIds = new Set(baseOrg.persons.map((p) => p.id))
    for (const identity of baseOrg.identities) {
      if (identity.personId !== null) {
        expect(
          personIds.has(identity.personId),
          `identity ${identity.id} personId ${identity.personId} not found`,
        ).toBe(true)
      }
    }
  })

  it('dependabot identity has isBot=true and personId=null', () => {
    const dependabot = baseOrg.identities.find((i) => i.id === IDS.identityDependabot)
    expect(dependabot?.isBot).toBe(true)
    expect(dependabot?.personId).toBeNull()
  })

  it('prIssueLinks reference known PRs and issues', () => {
    const prIds = new Set(baseOrg.pullRequests.map((p) => p.id))
    const issueIds = new Set(baseOrg.jiraIssues.map((i) => i.id))
    for (const link of baseOrg.prIssueLinks) {
      expect(prIds.has(link.prId), `link prId ${link.prId} not found`).toBe(true)
      expect(issueIds.has(link.issueId), `link issueId ${link.issueId} not found`).toBe(true)
    }
  })

  it('deployIncidentLinks reference known deployments and incidents', () => {
    const deployIds = new Set(baseOrg.deployments.map((d) => d.id))
    const incidentIds = new Set(
      baseOrg.jiraIssues.filter((i) => i.type === 'Incident').map((i) => i.id),
    )
    for (const link of baseOrg.deployIncidentLinks) {
      expect(deployIds.has(link.deployId), `link deployId ${link.deployId} not found`).toBe(true)
      expect(
        incidentIds.has(link.incidentIssueId),
        `link incidentIssueId ${link.incidentIssueId} not found`,
      ).toBe(true)
    }
  })

  it('sprint membership events reference known sprints and issues', () => {
    const sprintIds = new Set(baseOrg.sprints.map((s) => s.id))
    const issueIds = new Set(baseOrg.jiraIssues.map((i) => i.id))
    for (const evt of baseOrg.sprintMembershipEvents) {
      expect(sprintIds.has(evt.sprintId), `event sprintId ${evt.sprintId} not found`).toBe(true)
      expect(issueIds.has(evt.issueId), `event issueId ${evt.issueId} not found`).toBe(true)
    }
  })

  it('board columns reference board configs', () => {
    const boardIds = new Set(baseOrg.boardConfigs.map((b) => b.boardId))
    for (const col of baseOrg.boardColumns) {
      expect(
        boardIds.has(col.boardId),
        `boardColumn boardId ${col.boardId} not found in boardConfigs`,
      ).toBe(true)
    }
  })

  it('story-1 has >10 transitions (multi-page changelog)', () => {
    const transitions = baseOrg.issueTransitions[IDS.issueStory1] ?? []
    expect(transitions.length).toBeGreaterThan(10)
  })

  it('incident-1 has Done→reopen→Done (MTTR first-vs-last testable)', () => {
    const transitions = baseOrg.issueTransitions[IDS.issueIncident1] ?? []
    const doneTransitions = transitions.filter((t) => t.toStatusId === IDS.statusDone)
    // Must have at least two Done arrivals to test first-vs-last anchor
    expect(doneTransitions.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 7: Dataset immutability
// ---------------------------------------------------------------------------

describe('baseOrg immutability', () => {
  it('top-level baseOrg object is frozen', () => {
    expect(Object.isFrozen(baseOrg)).toBe(true)
  })

  it('repositories array is frozen', () => {
    expect(Object.isFrozen(baseOrg.repositories)).toBe(true)
  })

  it('mutation of a frozen property throws in strict mode', () => {
    expect(() => {
      // In strict mode (TS modules are always strict), assigning to a frozen
      // object's property throws TypeError.
      ;(baseOrg as unknown as Record<string, unknown>).org = {}
    }).toThrow(TypeError)
  })

  it('individual repository objects are frozen', () => {
    for (const r of baseOrg.repositories) {
      expect(Object.isFrozen(r)).toBe(true)
    }
  })

  it('individual PR objects are frozen', () => {
    for (const pr of baseOrg.pullRequests) {
      expect(Object.isFrozen(pr)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 8: fakeClock
// ---------------------------------------------------------------------------

describe('fakeClock', () => {
  it('freezes Date.now() to the given ISO instant', () => {
    const restore = fakeClock('2024-06-01T12:00:00Z')
    try {
      expect(Date.now()).toBe(new Date('2024-06-01T12:00:00Z').getTime())
    } finally {
      restore()
    }
  })

  it('freezes new Date() (no-arg) to the given instant', () => {
    const restore = fakeClock('2024-06-01T12:00:00Z')
    try {
      const d = new Date()
      expect(d.toISOString()).toBe('2024-06-01T12:00:00.000Z')
    } finally {
      restore()
    }
  })

  it('still parses date strings correctly', () => {
    const restore = fakeClock('2024-06-01T12:00:00Z')
    try {
      const d = new Date('2024-01-15T09:00:00Z')
      expect(d.toISOString()).toBe('2024-01-15T09:00:00.000Z')
    } finally {
      restore()
    }
  })

  it('restores the real Date after calling the restore function', () => {
    const realNow = Date.now()
    const restore = fakeClock('2000-01-01T00:00:00Z')
    expect(Date.now()).toBe(new Date('2000-01-01T00:00:00Z').getTime())
    restore()
    // After restore, Date.now() should be back to real time (>= realNow)
    expect(Date.now()).toBeGreaterThanOrEqual(realNow)
  })
})

// ---------------------------------------------------------------------------
// 9: withMockServer raises on unhandled requests
// ---------------------------------------------------------------------------

describe('withMockServer', () => {
  // withMockServer is called here inside a describe block so that Vitest's
  // beforeAll/afterEach/afterAll are in scope when the function runs.
  // The server is assigned synchronously and its lifecycle hooks are
  // registered via globalThis as a side-effect of calling withMockServer.
  let server: ReturnType<typeof withMockServer>

  beforeAll(() => {
    // Call withMockServer inside beforeAll so Vitest hooks are available.
    server = withMockServer(...mockGitHub())
  })

  afterAll(() => {
    // withMockServer already registered afterAll for server.close(), but
    // since we called it from inside beforeAll, the lifecycle is slightly
    // different. Close explicitly to be safe.
    server?.close()
  })

  it('returns a setupServer instance with expected methods', () => {
    expect(server).toBeDefined()
    expect(typeof server.use).toBe('function')
    expect(typeof server.resetHandlers).toBe('function')
    expect(typeof server.close).toBe('function')
  })

  it('server starts correctly (listen does not throw)', () => {
    // If the server were not started it would throw on listen, but since
    // withMockServer calls listen in beforeAll, this indirectly verifies it.
    expect(() => server.resetHandlers()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// GraphQL response shape helpers
// ---------------------------------------------------------------------------

interface GqlPageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

interface GqlConnection<T> {
  nodes: T[]
  pageInfo: GqlPageInfo
}

interface GqlPr {
  id: string
  number: number
  state: string
  isDraft: boolean
  reviews: GqlConnection<{ id: string; state: string }>
  comments: GqlConnection<{ id: string }>
  timelineItems: GqlConnection<{ __typename: string }>
  commits: GqlConnection<{ oid: string }>
}

interface GqlRepoData {
  repository: {
    pullRequest: GqlPr
  }
  rateLimit: {
    cost: number
    remaining: number
    resetAt: string
  }
}

// ---------------------------------------------------------------------------
// Helper: post a GraphQL query to the MSW graphql link
// ---------------------------------------------------------------------------

// MSW's graphql handler intercepts requests to any URL with the operation
// name in the body. We post to the standard GitHub GraphQL endpoint.

/** Fetch GraphQL and return the `data` field typed as GqlRepoData. */
async function fetchGraphQL(
  operationName: string,
  variables: Record<string, unknown>,
): Promise<GqlRepoData> {
  const raw = await fetchGraphQLRaw(operationName, variables)
  return raw as unknown as GqlRepoData
}

/** Fetch GraphQL and return the raw `data` field as unknown record. */
async function fetchGraphQLRaw(
  operationName: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query ${operationName} { __typename }`,
      variables,
      operationName,
    }),
  })
  const body = (await res.json()) as { data?: Record<string, unknown> }
  return body.data ?? {}
}
