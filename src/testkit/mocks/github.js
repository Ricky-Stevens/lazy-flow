import { graphql, HttpResponse, http } from 'msw'
import { baseOrg } from '../dataset/baseOrg.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a Link header pointing to the next page (page is 1-based). */
function nextLink(url, page) {
  const next = new URL(url.toString())
  next.searchParams.set('page', String(page))
  return `<${next.toString()}>; rel="next"`
}

/** Standard rate-limit headers appended to every REST response. */
const rateLimitHeaders = {
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '4999',
  'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
}

// ---------------------------------------------------------------------------
// REST — repo metadata
// ---------------------------------------------------------------------------

function repoMetadataHandlers() {
  return [
    // Single repo
    http.get('https://api.github.com/repos/:owner/:repo', ({ params }) => {
      const { owner, repo } = params
      const found = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!found) return new HttpResponse(null, { status: 404 })
      return HttpResponse.json(JSON.parse(found.raw), { headers: rateLimitHeaders })
    }),

    // Org repos list
    http.get('https://api.github.com/orgs/:org/repos', ({ params }) => {
      const { org } = params
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

function commitsHandlers() {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/commits', ({ request, params }) => {
      const { owner, repo } = params
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
      const headers = { ...rateLimitHeaders }
      if (hasMore) {
        headers.Link = nextLink(url, page + 1)
      }
      return HttpResponse.json(bodies, { headers })
    }),

    // Per-commit DETAIL (stats + per-file patches). The ingester fetches this
    // for each windowed commit because the LIST payload carries no stats.
    // Registered AFTER the list handler; MSW matches the more specific path.
    http.get('https://api.github.com/repos/:owner/:repo/commits/:ref', ({ params }) => {
      const { owner, repo, ref } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const detail = baseOrg.commitDetails.find((d) => d.sha === ref)
      if (!detail) {
        // Commit exists in the list but we have no detailed fixture: return a
        // well-formed payload with empty stats/files so the ingester records 0
        // (honest — no synthetic volume).
        return HttpResponse.json(
          { sha: ref, stats: { additions: 0, deletions: 0, total: 0 }, files: [] },
          { headers: rateLimitHeaders },
        )
      }
      return HttpResponse.json(
        {
          sha: detail.sha,
          stats: {
            additions: detail.additions,
            deletions: detail.deletions,
            total: detail.additions + detail.deletions,
          },
          files: detail.files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.additions + f.deletions,
            patch: f.patch,
          })),
        },
        { headers: rateLimitHeaders },
      )
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — pull requests
// ---------------------------------------------------------------------------

function pullsHandlers() {
  return [
    // List PRs for a repo
    http.get('https://api.github.com/repos/:owner/:repo/pulls', ({ params }) => {
      const { owner, repo } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const repoPrs = baseOrg.pullRequests.filter((p) => p.repoId === repoRecord.id)
      const bodies = repoPrs.map((p) => JSON.parse(p.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),

    // Reviews for a PR
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/reviews', ({ params }) => {
      const { owner, repo, number } = params
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
      const { owner, repo, number } = params
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

    // Changed files for a PR (GET /pulls/{n}/files).
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/files', ({ params }) => {
      const { owner, repo, number } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const pr = baseOrg.pullRequests.find(
        (p) => p.repoId === repoRecord.id && String(p.number) === number,
      )
      if (!pr) return new HttpResponse(null, { status: 404 })

      const files = baseOrg.prFiles.filter((f) => f.prId === pr.id)
      const bodies = files.map((f) => ({
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        patch: f.patch,
      }))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),

    // Timeline for a PR
    http.get('https://api.github.com/repos/:owner/:repo/pulls/:number/timeline', ({ params }) => {
      const { owner, repo, number } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const pr = baseOrg.pullRequests.find(
        (p) => p.repoId === repoRecord.id && String(p.number) === number,
      )
      if (!pr) return new HttpResponse(null, { status: 404 })

      const timeline = []
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

function deploymentsHandlers() {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/deployments', ({ params }) => {
      const { owner, repo } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      const repoDeploys = baseOrg.deployments.filter((d) => d.repoId === repoRecord.id)
      const bodies = repoDeploys.map((d) => JSON.parse(d.raw))
      return HttpResponse.json(bodies, { headers: rateLimitHeaders })
    }),
    // Per-deployment status history — the real outcome lives here, not on the
    // LIST. Newest-first: a single terminal status carrying the fixture's state.
    http.get('https://api.github.com/repos/:owner/:repo/deployments/:id/statuses', ({ params }) => {
      const { id } = params
      const deploy = baseOrg.deployments.find((d) => d.id === id)
      if (!deploy) return HttpResponse.json([], { headers: rateLimitHeaders })
      return HttpResponse.json(
        [{ state: deploy.status, created_at: deploy.finishedAt ?? deploy.createdAt }],
        { headers: rateLimitHeaders },
      )
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — releases
// ---------------------------------------------------------------------------

function releasesHandlers() {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/releases', ({ params }) => {
      const { owner, repo } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })
      // Base dataset has no explicit releases
      return HttpResponse.json([], { headers: rateLimitHeaders })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — file contents (whole-file source at a ref, for complexity analysis)
// ---------------------------------------------------------------------------

function contentsHandlers() {
  return [
    // The base dataset ships no file-source fixtures, so contents 404 → the
    // complexity ingester records nothing (honest). Tests that exercise the
    // complexity path override this handler with real base64 source.
    http.get('https://api.github.com/repos/:owner/:repo/contents/*', () => {
      return new HttpResponse(null, { status: 404 })
    }),
  ]
}

// ---------------------------------------------------------------------------
// REST — check runs
// ---------------------------------------------------------------------------

function checkRunsHandlers() {
  return [
    http.get('https://api.github.com/repos/:owner/:repo/commits/:ref/check-runs', ({ params }) => {
      const { owner, repo, ref } = params
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === repo)
      if (!repoRecord) return new HttpResponse(null, { status: 404 })

      // Serve the runs recorded for this head sha (ref). Empty for unknown refs
      // (honest — no synthetic CI status).
      const runs = baseOrg.checkRuns.filter((c) => c.repoId === repoRecord.id && c.headSha === ref)
      const bodies = runs.map((c) => JSON.parse(c.raw))
      return HttpResponse.json(
        { total_count: bodies.length, check_runs: bodies },
        { headers: rateLimitHeaders },
      )
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

function encodeCursor(index) {
  return Buffer.from(`cursor:${index}`).toString('base64')
}

function decodeCursor(cursor) {
  const raw = Buffer.from(cursor, 'base64').toString('utf8')
  const n = Number(raw.replace('cursor:', ''))
  return Number.isFinite(n) ? n : 0
}

/** Build a paginated GraphQL connection from an array of nodes. */
function paginatedConnection(nodes, after, pageSize) {
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

function buildGraphQLPrResponse(prId, variables) {
  const pr = baseOrg.pullRequests.find((p) => p.id === prId)
  if (!pr) return { errors: [{ message: `PR not found: ${prId}` }] }

  const repoRecord = baseOrg.repositories.find((r) => r.id === pr.repoId)
  if (!repoRecord) return { errors: [{ message: `Repo not found: ${pr.repoId}` }] }

  const reviewsAfter = variables.reviewsAfter ?? null
  const commentsAfter = variables.commentsAfter ?? null
  const timelineAfter = variables.timelineAfter ?? null
  const commitsAfter = variables.commitsAfter ?? null

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

  const timelineItems = [
    ...prReviews.map((r) => ({
      type: 'review',
      nodeId: r.nodeId,
      submittedAt: r.submittedAt,
    })),
    ...(pr.mergedAt ? [{ type: 'merged', mergedAt: pr.mergedAt }] : []),
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

function graphQLHandlers() {
  return [
    graphql.query('PullRequestGraph', ({ variables }) => {
      const vars = variables
      const prId = vars.prId
      const result = buildGraphQLPrResponse(prId, vars)
      return HttpResponse.json(result)
    }),

    // Convenience query: list all PRs for a repo
    graphql.query('RepoPullRequests', ({ variables }) => {
      const vars = variables
      const owner = vars.owner
      const name = vars.name
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
export function mockGitHub() {
  return [
    ...repoMetadataHandlers(),
    ...commitsHandlers(),
    ...pullsHandlers(),
    ...deploymentsHandlers(),
    ...releasesHandlers(),
    ...contentsHandlers(),
    ...checkRunsHandlers(),
    ...graphQLHandlers(),
  ]
}
