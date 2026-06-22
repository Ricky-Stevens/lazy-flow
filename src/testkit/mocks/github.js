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

/** Build a GraphQL repository node from a dataset repo record. databaseId is the
 * node id the old REST raw carried, so the stored githubNodeId is unchanged. */
function repoMetaNode(r) {
  return {
    databaseId: r.githubNodeId,
    nameWithOwner: `${r.owner}/${r.name}`,
    defaultBranchRef: { name: r.defaultBranch },
    isArchived: r.isArchived,
    isFork: r.isFork,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
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
      // Mirror the REAL GitHub *list* endpoint (GET /pulls): it returns
      // `merged_at` but NOT the `merged` boolean (that field only exists on the
      // single-PR detail endpoint). The fixture raws carry a synthetic
      // `merged:true`; strip it and project `merged_at` from the record so the
      // mock matches production and exercises merged-state derivation honestly.
      const bodies = repoPrs.map((p) => {
        const body = JSON.parse(p.raw)
        body.merged = undefined
        delete body.merged
        if (p.mergedAt != null) body.merged_at = p.mergedAt
        return body
      })
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

    // Repo metadata (replaces REST GET /repos/{o}/{r}). databaseId mirrors the
    // node id the REST raw carried so the stored githubNodeId is unchanged.
    graphql.query('RepoMeta', ({ variables }) => {
      const { owner, name } = variables
      const r = baseOrg.repositories.find((x) => x.owner === owner && x.name === name)
      return HttpResponse.json({
        data: {
          repository: r ? repoMetaNode(r) : null,
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Org repo discovery (replaces REST GET /orgs/{org}/repos).
    graphql.query('OrgRepos', ({ variables }) => {
      const { org } = variables
      const nodes = baseOrg.repositories.filter((r) => r.owner === org).map(repoMetaNode)
      return HttpResponse.json({
        data: {
          organization: {
            repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Releases (replaces REST GET /repos/{o}/{r}/releases). Base dataset has none.
    graphql.query('RepoReleases', () => {
      return HttpResponse.json({
        data: {
          repository: {
            releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Bulk default-branch commit history with line stats + check runs inline
    // (replaces REST list + per-commit detail + per-commit check-runs). additions/
    // deletions mirror the REST commit-DETAIL fixture (so stored stats match);
    // check runs are nested per commit by head sha, with UPPER-case enums the
    // client adapter lower-cases.
    graphql.query('CommitHistory', ({ variables }) => {
      const { owner, name } = variables
      const repo = baseOrg.repositories.find((r) => r.owner === owner && r.name === name)
      if (!repo) {
        return HttpResponse.json({
          data: {
            repository: null,
            rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
          },
        })
      }
      const nodes = baseOrg.commits
        .filter((c) => c.repoId === repo.id)
        .map((c) => {
          const detail = baseOrg.commitDetails.find((d) => d.sha === c.sha)
          const rawObj = JSON.parse(c.raw)
          const login = rawObj.author?.login ?? null
          const checkRuns = baseOrg.checkRuns
            .filter((cr) => cr.headSha === c.sha)
            .map((cr) => ({
              databaseId: cr.nodeId,
              name: cr.name,
              status: cr.status ? cr.status.toUpperCase() : null,
              conclusion: cr.conclusion ? cr.conclusion.toUpperCase() : null,
              startedAt: cr.startedAt ?? null,
              completedAt: cr.completedAt ?? null,
            }))
          return {
            oid: c.sha,
            committedDate: c.committedAt,
            authoredDate: c.authoredAt,
            additions: detail?.additions ?? 0,
            deletions: detail?.deletions ?? 0,
            message: c.message ?? '',
            author: { name: null, email: 'unknown', user: login ? { login } : null },
            checkSuites: { nodes: [{ checkRuns: { nodes: checkRuns } }] },
          }
        })
      return HttpResponse.json({
        data: {
          repository: {
            defaultBranchRef: {
              target: { history: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
            },
          },
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Bulk file-content blobs. The base dataset carries no file contents (the
    // REST contents endpoint 404'd here too), so every alias resolves to null —
    // complexity analysis finds no source and writes nothing, exactly as before.
    graphql.query('FileBlobs', () => {
      return HttpResponse.json({
        data: {
          repository: {},
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Bulk deployments with inline latestStatus (replaces REST list + per-deploy
    // status N+1). databaseId mirrors the REST numeric id so String(databaseId)
    // equals the row id the engine stored via the old REST path; the latest
    // status state is the upper-case GraphQL enum the mapper lower-cases.
    // AI-tooling config probe (object(expression:"HEAD:<path>") existence checks).
    // The base dataset has no AI config files, so every alias resolves to null.
    graphql.query('RepoPaths', () => {
      return HttpResponse.json({
        data: {
          repository: {},
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    graphql.query('RepoDeployments', ({ variables }) => {
      const { owner, name } = variables
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === name)
      if (!repoRecord) {
        return HttpResponse.json({
          data: {
            repository: null,
            rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
          },
        })
      }
      const deploys = baseOrg.deployments.filter((d) => d.repoId === repoRecord.id)
      const nodes = deploys.map((d) => {
        const raw = JSON.parse(d.raw)
        return {
          databaseId: d.id,
          environment: raw.environment ?? 'production',
          commitOid: raw.sha ?? '',
          createdAt: d.createdAt ?? raw.created_at ?? null,
          updatedAt: d.updatedAt ?? raw.updated_at ?? d.createdAt ?? null,
          latestStatus: {
            state: String(d.status).toUpperCase(),
            createdAt: d.finishedAt ?? d.createdAt ?? null,
          },
        }
      })
      return HttpResponse.json({
        data: {
          repository: {
            deployments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
          rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
        },
      })
    }),

    // Bulk PRs with reviews, review-thread comments, files and head-commit check
    // runs nested inline (replaces REST PR list + per-PR reviews/comments/files/
    // check-runs N+1). Enums are UPPER-case as real GitHub returns them; the
    // client adapter normalises. The fixture PR `raw` omits `user`/`merged_by`,
    // so author/mergedBy are null here too (parity with the old REST list path).
    graphql.query('RepoPullRequests', ({ variables }) => {
      const { owner, name } = variables
      const repoRecord = baseOrg.repositories.find((r) => r.owner === owner && r.name === name)
      if (!repoRecord) {
        return HttpResponse.json({
          data: {
            repository: null,
            rateLimit: { cost: 1, remaining: 4999, resetAt: new Date().toISOString() },
          },
        })
      }
      const stateEnum = { merged: 'MERGED', closed: 'CLOSED', open: 'OPEN' }
      const nodes = baseOrg.pullRequests
        .filter((p) => p.repoId === repoRecord.id)
        .map((p) => {
          const raw = JSON.parse(p.raw)
          const headSha = raw.head?.sha ?? null
          const reviews = baseOrg.reviews
            .filter((r) => r.prId === p.id)
            .map((r) => {
              const rraw = JSON.parse(r.raw)
              return {
                databaseId: r.nodeId,
                state: rraw.state ?? r.state.toUpperCase(),
                submittedAt: r.submittedAt,
                author: rraw.user?.login
                  ? { login: rraw.user.login, __typename: rraw.user.type ?? 'User' }
                  : null,
              }
            })
          const threads = baseOrg.reviewComments
            .filter((c) => c.prId === p.id)
            .map((c) => {
              const craw = JSON.parse(c.raw)
              return {
                comments: {
                  nodes: [
                    {
                      databaseId: craw.id ?? c.nodeId,
                      createdAt: c.createdAt,
                      updatedAt: c.updatedAt,
                      path: c.path ?? null,
                      author: craw.user?.login
                        ? { login: craw.user.login, __typename: craw.user.type ?? 'User' }
                        : null,
                      replyTo: c.inReplyTo ? { databaseId: c.inReplyTo } : null,
                    },
                  ],
                },
              }
            })
          const files = baseOrg.prFiles
            .filter((f) => f.prId === p.id)
            .map((f) => ({
              path: f.path,
              additions: f.additions,
              deletions: f.deletions,
              changeType: (f.status ?? 'modified').toUpperCase(),
            }))
          const headCheckRuns = baseOrg.checkRuns
            .filter((cr) => cr.headSha === headSha)
            .map((cr) => ({
              databaseId: cr.nodeId,
              name: cr.name,
              status: cr.status ? cr.status.toUpperCase() : null,
              conclusion: cr.conclusion ? cr.conclusion.toUpperCase() : null,
              startedAt: cr.startedAt ?? null,
              completedAt: cr.completedAt ?? null,
            }))
          return {
            number: p.number,
            title: raw.title ?? null,
            body: raw.body ?? null,
            state: stateEnum[p.state] ?? 'OPEN',
            isDraft: raw.draft ?? false,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            mergedAt: p.mergedAt ?? null,
            baseRefName: p.baseRef,
            baseRefOid: null,
            headRefName: p.headRef,
            headRefOid: headSha,
            author: null,
            mergedBy: null,
            firstCommit: p.firstCommitAt
              ? { nodes: [{ commit: { authoredDate: p.firstCommitAt } }] }
              : { nodes: [] },
            reviews: { pageInfo: { hasNextPage: false }, nodes: reviews },
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
            files: { pageInfo: { hasNextPage: false }, nodes: files },
            headChecks: {
              nodes: headSha
                ? [
                    {
                      commit: {
                        oid: headSha,
                        checkSuites: { nodes: [{ checkRuns: { nodes: headCheckRuns } }] },
                      },
                    },
                  ]
                : [],
            },
          }
        })
      return HttpResponse.json({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
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
