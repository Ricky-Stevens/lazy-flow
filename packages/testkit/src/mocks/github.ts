/**
 * MSW v2 handlers for the GitHub REST + GraphQL APIs.
 *
 * Serves the base-org dataset as realistic GitHub responses so ingestion
 * code under test can paginate, exhaust inner connections, and validate
 * rate-limit handling without hitting the real API.
 *
 * REST endpoints:
 *   GET /repos/:owner/:repo/commits          (since-paginated)
 *   GET /repos/:owner/:repo/pulls            (state=all, paginated)
 *   GET /repos/:owner/:repo/pulls/:number/reviews
 *   GET /repos/:owner/:repo/pulls/:number/comments
 *   GET /repos/:owner/:repo/pulls/:number/timeline
 *   GET /repos/:owner/:repo/deployments
 *   GET /repos/:owner/:repo/releases
 *   GET /repos/:owner/:repo/commits/:ref/check-runs
 *   GET /repos/:owner/:repo                  (repo metadata)
 *   GET /orgs/:org/repos
 *
 * GraphQL:
 *   query PullRequestGraph — per-PR object graph with paginated inner
 *   connections (reviews / comments / timeline / commits) exposing
 *   pageInfo{hasNextPage,endCursor} so pagination-to-exhaustion is testable.
 *   Includes a rateLimit field.
 */

import type { RequestHandler } from 'msw'
import { graphql, HttpResponse, http } from 'msw'
import { baseOrg } from '../dataset/baseOrg.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a Link header pointing to the next page (page is 1-based). */
function nextLink(url: URL, page: number): string {
  const next = new URL(url.toString())
  next.searchParams.set('page', String(page))
  return `<${next.toString()}>; rel="next"`
}

/** Standard rate-limit headers appended to every REST response. */
const rateLimitHeaders: Record<string, string> = {
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '4999',
  'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
}

// ---------------------------------------------------------------------------
// REST — repo metadata
// ---------------------------------------------------------------------------

function repoMetadataHandlers(): RequestHandler[] {
  return [
    // Single repo
    http.get('https://api.github.com/repos/:owner/:repo', ({ params }) => {
      const { owner, repo } = params as Record<string, string>
      const found = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!found) return new HttpResponse(null, { status: 404 })
      return HttpResponse.json(JSON.parse(found.raw), { headers: rateLimitHeaders })
    }),

    // Org repos list
    http.get('https://api.github.com/orgs/:org/repos', ({ params }) => {
      const { org } = params as Record<string, string>
      const repos = baseOrg.repositories.filter((r) => r.owner === org)
      const bodies = repos.map((r) => JSON.parse(r.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — commits (since-paginated, per_page=2 for alpha-service so the
// consumer is forced to follow the Link header)
// ---------------------------------------------------------------------------

function commitsHandlers(): RequestHandler[] {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/commits', ({ request, params }) => {
      const { owner, repo } = params as Record<string, string>
      const url = new URL(request.url)
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('per_page') ?? '2')

      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const repoCommits = baseOrg.commits.filter((c) => c.repoId === repoRecord.id)
      const start = (page - 1) * perPage
      const slice = repoCommits.slice(start, start + perPage)
      const hasMore = start + perPage < repoCommits.length

      const bodies = slice.map((c) => JSON.parse(c.raw))
      const headers: Record<string, string> = { ...rateLimitHeaders }
      if (hasMore) {
        headers.Link = nextLink(url, page + 1)
      }
      return HttpResponse.json(bodies, { headers })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — pull requests
// ---------------------------------------------------------------------------

function pullsHandlers(): RequestHandler[] {
  return [
    // List PRs for a repo
    http.get('https://api.github.com/repos/:owner/:repo/pulls', ({ params }) => {
      const { owner, repo } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const repoPrs = baseOrg.pullRequests.filter((p) => p.repoId === repoRecord.id)
      const bodies = repoPrs.map((p) => JSON.parse(p.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),

    // Reviews for a PR
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/reviews', ({ params }) => {
      const { owner, repo, number } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const pr = baseOrg.pullRequests.find(
        (p) => p.repoId === repoRecord.id && String(p.number) === number,
      )
      if (!pr) return new HttpResponse(null, { status: 404 })

      const prReviews = baseOrg.reviews.filter((r) => r.prId === pr.id)
      const bodies = prReviews.map((r) => JSON.parse(r.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),

    // Review comments for a PR
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/comments', ({ params }) => {
      const { owner, repo, number } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const pr = baseOrg.pullRequests.find(
        (p) => p.repoId === repoRecord.id && String(p.number) === number,
      )
      if (!pr) return new HttpResponse(null, { status: 404 })

      const comments = baseOrg.reviewComments.filter((c) => c.prId === pr.id)
      const bodies = comments.map((c) => JSON.parse(c.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),

    // Timeline for a PR
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/timeline', ({ params }) => {
      const { owner, repo, number } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const pr = baseOrg.pullRequests.find(
        (p) => p.repoId === repoRecord.id && String(p.number) === number,
      )
      if (!pr) return new HttpResponse(null, { status: 404 })

      const timeline: unknown[] = []
      const prReviews = baseOrg.reviews.filter((r) => r.prId === pr.id)
      for (const rev of prReviews) {
        timeline.push({
          event: 'reviewed',
          id: rev.nodeId,
          state: rev.state,
          submitted_at: rev.submittedAt,
          user: { login: rev.reviewerIdentityId },
        })
      }
      if (pr.mergedAt) {
        timeline.push({ event: 'merged', created_at: pr.mergedAt })
      }
      return HttpResponse.json(timeline, { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — deployments
// ---------------------------------------------------------------------------

function deploymentsHandlers(): RequestHandler[] {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/deployments', ({ params }) => {
      const { owner, repo } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const repoDeploys = baseOrg.deployments.filter((d) => d.repoId === repoRecord.id)
      const bodies = repoDeploys.map((d) => JSON.parse(d.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — releases
// ---------------------------------------------------------------------------

function releasesHandlers(): RequestHandler[] {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/releases', ({ params }) => {
      const { owner, repo } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })
      // Base dataset has no explicit releases
      return HttpResponse.json([], { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — check runs
// ---------------------------------------------------------------------------

function checkRunsHandlers(): RequestHandler[] {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/commits/:ref/check-runs', ({ params }) => {
      const { owner, repo } = params as Record<string, string>
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })
      return HttpResponse.json({ total_count: 0, check_runs: [] }, { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// GraphQL — PullRequestGraph
//
// Returns the full per-PR graph with paginated inner connections.
// Cursor format: base64("cursor:<index>")
//
// PAGE_SIZE=1 so that pr-1's two reviews span two pages, making
// pagination-to-exhaustion testable with minimal fixture complexity.
// ---------------------------------------------------------------------------

const GQL_PAGE_SIZE = 1

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64')
}

function decodeCursor(cursor: string): number {
  const raw = Buffer.from(cursor, 'base64').toString('utf8')
  const n = Number(raw.replace('cursor:', ''))
  return Number.isFinite(n) ? n : 0
}

/** Build a paginated GraphQL connection from an array of nodes. */
function paginatedConnection<T>(
  nodes: readonly T[],
  after: string | null,
  pageSize: number,
): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const startIndex = after !== null ? decodeCursor(after) + 1 : 0
  const slice = nodes.slice(startIndex, startIndex + pageSize)
  const endIndex = startIndex + slice.length - 1
  const hasNextPage = endIndex < nodes.length - 1
  return {
    nodes: slice,
    pageInfo: {
      hasNextPage,
      endCursor: slice.length > 0 ? encodeCursor(endIndex) : null,
    },
  }
}

function buildGraphQLPrResponse(
  prId: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const pr = baseOrg.pullRequests.find((p) => p.id === prId)
  if (!pr) return { errors: [{ message: `PR not found: ${prId}` }] }

  const repoRecord = baseOrg.repositories.find((r) => r.id === pr.repoId)
  if (!repoRecord) return { errors: [{ message: `Repo not found: ${pr.repoId}` }] }

  const reviewsAfter = (variables.reviewsAfter as string | null) ?? null
  const commentsAfter = (variables.commentsAfter as string | null) ?? null
  const timelineAfter = (variables.timelineAfter as string | null) ?? null
  const commitsAfter = (variables.commitsAfter as string | null) ?? null

  // Reviews
  const prReviews = baseOrg.reviews.filter((r) => r.prId === pr.id)
  const reviewsConn = paginatedConnection(prReviews, reviewsAfter, GQL_PAGE_SIZE)
  const reviewNodes = reviewsConn.nodes.map((r) => ({
    id: r.nodeId,
    state: r.state.toUpperCase(),
    submittedAt: r.submittedAt,
    author: { login: r.reviewerIdentityId },
  }))

  // Review comments
  const prComments = baseOrg.reviewComments.filter((c) => c.prId === pr.id)
  const commentsConn = paginatedConnection(prComments, commentsAfter, GQL_PAGE_SIZE)
  const commentNodes = commentsConn.nodes.map((c) => ({
    id: c.nodeId,
    createdAt: c.createdAt,
    path: c.path,
    author: { login: c.authorIdentityId },
  }))

  // Timeline: reviews + merge event in chronological order
  type TimelineItem =
    | { type: 'review'; nodeId: string; submittedAt: string }
    | { type: 'merged'; mergedAt: string }
  const timelineItems: TimelineItem[] = [
    ...prReviews.map((r) => ({
      type: 'review' as const,
      nodeId: r.nodeId,
      submittedAt: r.submittedAt,
    })),
    ...(pr.mergedAt ? [{ type: 'merged' as const, mergedAt: pr.mergedAt }] : []),
  ]
  const timelineConn = paginatedConnection(timelineItems, timelineAfter, GQL_PAGE_SIZE)
  const timelineNodes = timelineConn.nodes.map((t) => {
    if (t.type === 'review') {
      return { __typename: 'PullRequestReview', id: t.nodeId, submittedAt: t.submittedAt }
    }
    return { __typename: 'MergedEvent', createdAt: t.mergedAt }
  })

  // Commits in this PR's repo
  const prCommits = baseOrg.commits.filter((c) => c.repoId === pr.repoId)
  const commitsConn = paginatedConnection(prCommits, commitsAfter, GQL_PAGE_SIZE)
  const commitNodes = commitsConn.nodes.map((c) => ({
    oid: c.sha,
    authoredDate: c.authoredAt,
    message: c.message,
    author: { user: { login: c.authorIdentityId } },
  }))

  return {
    data: {
      repository: {
        owner: repoRecord.owner,
        name: repoRecord.name,
        pullRequest: {
          id: pr.id,
          number: pr.number,
          state: pr.state.toUpperCase(),
          isDraft: pr.isDraft,
          createdAt: pr.createdAt,
          mergedAt: pr.mergedAt,
          baseRefName: pr.baseRef,
          headRefName: pr.headRef,
          author: { login: pr.authorIdentityId },
          reviews: { nodes: reviewNodes, pageInfo: reviewsConn.pageInfo },
          comments: { nodes: commentNodes, pageInfo: commentsConn.pageInfo },
          timelineItems: { nodes: timelineNodes, pageInfo: timelineConn.pageInfo },
          commits: { nodes: commitNodes, pageInfo: commitsConn.pageInfo },
        },
      },
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    },
  }
}

function graphQLHandlers(): RequestHandler[] {
  return [
    graphql.query('PullRequestGraph', ({ variables }) => {
      const vars = variables as Record<string, unknown>
      const prId = vars.prId as string
      const result = buildGraphQLPrResponse(prId, vars)
      return HttpResponse.json(result)
    }),

    // Convenience query: list all PRs for a repo
    graphql.query('RepoPullRequests', ({ variables }) => {
      const vars = variables as Record<string, unknown>
      const owner = vars.owner as string
      const name = vars.name as string
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === name)
      if (!repoRecord) {
        return HttpResponse.json({ errors: [{ message: 'repo not found' }] })
      }
      const prs = baseOrg.pullRequests.filter((p) => p.repoId === repoRecord.id)
      return HttpResponse.json({
        data: {
          repository: {
            pullRequests: {
              nodes: prs.map((p) => ({ id: p.id, number: p.number, state: p.state })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
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
 * as realistic GitHub REST and GraphQL responses.
 *
 * Mount with `setupServer(...mockGitHub())` or pass to `withMockServer`.
 */
export function mockGitHub(): RequestHandler[] {
  return [
    ...repoMetadataHandlers(),
    ...commitsHandlers(),
    ...pullsHandlers(),
    ...deploymentsHandlers(),
    ...releasesHandlers(),
    ...checkRunsHandlers(),
    ...graphQLHandlers(),
  ]
}
