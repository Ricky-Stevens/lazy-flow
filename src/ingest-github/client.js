/**
 * GitHub REST + GraphQL client for lazy-flow ingestion (WP-GH-CLIENT).
 *
 * REST: bulk discovery — commits (since-paginated), PRs, reviews, review
 *   comments, timeline, deployments, releases, check runs, repo metadata.
 *
 * GraphQL: per-PR object graph with cursor-paginated inner connections
 *   (reviews / comments / timeline / commits) exhausted page by page so a
 *   fat PR never silently caps at the first page (SPEC §7.1).
 *
 * Rate-limit: exposes remaining headroom from REST headers and the GraphQL
 *   rateLimit field. Callers can inspect `client.rateLimitRemaining`.
 *
 * Access scope: records which repos are visible via `listOrgRepos()` for the
 *   coverage fingerprint (SPEC §5.3).
 *
 * Base URL is configurable so tests can point at the MSW mock server which
 *   intercepts `https://api.github.com` by default.
 */

import { assertSafeBaseUrl, assertSameOrigin } from '../core/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

/**
 * Named query — MUST match the name `PullRequestGraph` that the MSW mock
 * intercepts via `graphql.query('PullRequestGraph', ...)`.
 */
const PR_GRAPH_QUERY = /* graphql */ `
  query PullRequestGraph(
    $prId: ID!
    $reviewsAfter: String
    $commentsAfter: String
    $timelineAfter: String
    $commitsAfter: String
  ) {
    node(id: $prId) {
      ... on PullRequest {
        id
        number
        state
        isDraft
        createdAt
        mergedAt
        baseRefName
        headRefName
        author { login }
        reviews(first: 100, after: $reviewsAfter) {
          nodes { id state submittedAt author { login } }
          pageInfo { hasNextPage endCursor }
        }
        comments(first: 100, after: $commentsAfter) {
          nodes { id createdAt path author { login } }
          pageInfo { hasNextPage endCursor }
        }
        timelineItems(first: 100, after: $timelineAfter) {
          nodes {
            __typename
            ... on PullRequestReview { id submittedAt }
            ... on MergedEvent { createdAt }
          }
          pageInfo { hasNextPage endCursor }
        }
        commits(first: 100, after: $commitsAfter) {
          nodes {
            commit {
              oid
              authoredDate
              message
              author { user { login } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

// ---------------------------------------------------------------------------
// GitHubClient
// ---------------------------------------------------------------------------

export class GitHubClient {
  token
  baseUrl
  baseOrigin
  timeoutMs
  /**
   * The number of API requests remaining before the rate-limit resets.
   * Updated after every REST response and after each GraphQL page.
   */
  rateLimitRemaining = 5000

  /**
   * Repos visible to this credential — populated by `listOrgRepos()`.
   * Used by `syncGitHub` to build the coverage fingerprint (SPEC §5.3).
   */
  visibleRepos = []

  constructor(opts) {
    this.token = opts.token
    // Validate the base URL before any token-bearing request: https-only and no
    // private/metadata host (unless explicitly opted in), so the PAT cannot be
    // sent in cleartext or used to drive an authenticated SSRF.
    const url = assertSafeBaseUrl(opts.baseUrl ?? 'https://api.github.com', {
      allowInsecure: opts.allowInsecureBaseUrl,
      allowPrivate: opts.allowInsecureBaseUrl,
    })
    this.baseOrigin = url.origin
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  // -------------------------------------------------------------------------
  // Shared REST fetch
  // -------------------------------------------------------------------------

  /**
   * Perform a single REST GET, update rate-limit tracking, and return the
   * parsed JSON body together with the raw Response so callers can read the
   * Link header for pagination.
   */
  async restGet(path) {
    let url = path.startsWith('http') ? path : `${this.baseUrl}${path}`
    // Never attach the token to a URL outside the configured origin (an absolute
    // URL only reaches here via paginator next-links, which are server-controlled).
    if (path.startsWith('http')) assertSameOrigin(url, this.baseOrigin)

    const maxAttempts = 4
    let redirects = 0
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        // Do NOT auto-follow redirects: a server-controlled 30x Location would
        // otherwise be fetched (with the bearer token) without passing through
        // the SSRF/same-origin guards. We validate the target explicitly below.
        redirect: 'manual',
      })

      // Handle redirects manually: only follow a same-origin target (cross-origin
      // is an SSRF/token-leak vector and never legitimate for the GitHub REST API).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location')
        if (!location || redirects >= 3) {
          throw new Error(`GitHub REST ${response.status} with no/too-many redirects: ${url}`)
        }
        const resolved = new URL(location, url).toString()
        assertSameOrigin(resolved, this.baseOrigin) // throws on cross-origin
        url = resolved
        redirects++
        continue
      }

      this.updateRateLimitFromHeaders(response.headers)

      // Honour primary (403 + X-RateLimit-Remaining:0) and secondary (429)
      // rate limits with bounded Retry-After / X-RateLimit-Reset backoff.
      if ((response.status === 429 || response.status === 403) && attempt < maxAttempts) {
        const waitMs = rateLimitWaitMs(response.headers)
        if (waitMs !== null) {
          await sleep(waitMs)
          continue
        }
      }

      if (!response.ok) {
        throw new Error(`GitHub REST ${response.status}: ${url}`)
      }

      const body = await response.json()
      return { body, response }
    }
  }

  /**
   * Follow Link header pagination, collecting all pages into a flat array.
   * The per-page default mirrors what the MSW mock uses (small pages) so
   * tests exercise the paginator with the real base dataset.
   */
  async restGetAll(path) {
    const results = []
    let next = `${this.baseUrl}${path}`

    while (next !== null) {
      // Reject a cross-origin next-link before it reaches restGet (defence in depth).
      assertSameOrigin(next, this.baseOrigin)
      const { body, response } = await this.restGet(next)
      const page = body
      results.push(...page)
      next = parseLinkNext(response.headers.get('Link'))
    }

    return results
  }

  updateRateLimitFromHeaders(headers) {
    const remaining = headers.get('X-RateLimit-Remaining')
    if (remaining !== null) {
      this.rateLimitRemaining = Number(remaining)
    }
  }

  // -------------------------------------------------------------------------
  // Repo metadata
  // -------------------------------------------------------------------------

  async getRepo(owner, repo) {
    const { body } = await this.restGet(`/repos/${owner}/${repo}`)
    return body
  }

  async listOrgRepos(org) {
    const repos = await this.restGetAll(`/orgs/${org}/repos`)
    this.visibleRepos = repos.map((r) => r.full_name)
    return repos
  }

  // -------------------------------------------------------------------------
  // Commits (since-paginated)
  // -------------------------------------------------------------------------

  async listCommits(owner, repo, since) {
    const qs = since ? `?since=${encodeURIComponent(since)}` : ''
    return this.restGetAll(`/repos/${owner}/${repo}/commits${qs}`)
  }

  /**
   * Fetch the per-commit DETAIL payload (GET /repos/{o}/{r}/commits/{sha}).
   *
   * The commit LIST endpoint (`listCommits`) carries no per-commit stats or
   * file diffs, so commit volume (additions/deletions/HALOC) is only available
   * via this detail fetch. It costs one request per commit, so callers must
   * only invoke it for commits inside the sync window (see syncRepo) to respect
   * the rate limit.
   */
  async getCommitDetail(owner, repo, sha) {
    const { body } = await this.restGet(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`,
    )
    return body
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  async listPullRequests(owner, repo) {
    return this.restGetAll(`/repos/${owner}/${repo}/pulls?state=all`)
  }

  /**
   * Incremental PR fetch: returns only PRs updated at/after `since`, sorted by
   * `updated` descending so pagination stops as soon as a page crosses the
   * watermark. Without this an incremental run re-paginates the entire PR
   * history every cycle. Falls back to the full list when `since` is absent.
   */
  async listPullRequestsUpdatedSince(owner, repo, since) {
    if (!since) return this.listPullRequests(owner, repo)
    const sinceMs = new Date(since).getTime()
    const collected = []
    let next = `${this.baseUrl}/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`
    while (next !== null) {
      assertSameOrigin(next, this.baseOrigin)
      const { body, response } = await this.restGet(next)
      const page = body
      let crossedWatermark = false
      for (const pr of page) {
        const updated = pr.updated_at
        if (updated && new Date(updated).getTime() < sinceMs) {
          crossedWatermark = true
          break
        }
        collected.push(pr)
      }
      if (crossedWatermark) break
      next = parseLinkNext(response.headers.get('Link'))
    }
    return collected
  }

  async listReviews(owner, repo, prNumber) {
    return this.restGetAll(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`)
  }

  async listReviewComments(owner, repo, prNumber) {
    return this.restGetAll(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
  }

  /**
   * List the changed files of a PR (GET /repos/{o}/{r}/pulls/{n}/files),
   * following Link pagination. Each entry carries filename, additions,
   * deletions, changes, status and the unified-diff `patch` (absent for binary
   * files / oversized diffs). This is the source for the per-file diffs the
   * code.* metrics aggregate.
   */
  async listPrFiles(owner, repo, prNumber) {
    return this.restGetAll(`/repos/${owner}/${repo}/pulls/${prNumber}/files`)
  }

  async listTimeline(owner, repo, prNumber) {
    return this.restGetAll(`/repos/${owner}/${repo}/pulls/${prNumber}/timeline`)
  }

  // -------------------------------------------------------------------------
  // Deployments / releases / check runs
  // -------------------------------------------------------------------------

  async listDeployments(owner, repo) {
    return this.restGetAll(`/repos/${owner}/${repo}/deployments`)
  }

  async listReleases(owner, repo) {
    return this.restGetAll(`/repos/${owner}/${repo}/releases`)
  }

  async listCheckRuns(owner, repo, ref) {
    const { body } = await this.restGet(`/repos/${owner}/${repo}/commits/${ref}/check-runs`)
    const typed = body
    return typed.check_runs
  }

  // -------------------------------------------------------------------------
  // GraphQL — per-PR object graph with exhausted inner connections
  // -------------------------------------------------------------------------

  /**
   * Execute the named `PullRequestGraph` GraphQL query against the mock or
   * real GitHub GraphQL endpoint.
   *
   * The MSW mock intercepts `graphql.query('PullRequestGraph', ...)` using
   * the operation name, not the URL + body structure. We therefore POST to
   * `${baseUrl}/graphql` with the operation name embedded in the body so MSW
   * can match it.
   */
  async graphqlRequest(variables) {
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: PR_GRAPH_QUERY,
        operationName: 'PullRequestGraph',
        variables,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      // Do not auto-follow a server-controlled redirect with the bearer token
      // attached; the GraphQL endpoint never legitimately 30x's.
      redirect: 'manual',
    })

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`GitHub GraphQL unexpected redirect (${response.status})`)
    }
    if (!response.ok) {
      throw new Error(`GitHub GraphQL HTTP ${response.status}`)
    }

    const json = await response.json()

    if (json.errors && json.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`)
    }

    // The MSW mock wraps everything under `data` including rateLimit.
    const data = json.data ?? {}
    const rateLimit = data.rateLimit ?? {
      cost: 1,
      remaining: this.rateLimitRemaining,
      resetAt: new Date().toISOString(),
    }

    if (typeof rateLimit.remaining === 'number') {
      this.rateLimitRemaining = rateLimit.remaining
    }

    return { data, rateLimit }
  }

  /**
   * Fetch the full per-PR object graph for a PR identified by its GraphQL
   * node id. Inner connections (reviews / comments / timeline / commits) are
   * cursor-paginated to exhaustion so fat PRs never silently cap at page 1
   * (SPEC §7.1).
   *
   * The MSW mock for `PullRequestGraph` takes `prId` as the PR's internal id
   * (e.g. `'pr-1'`) and returns paginated connections with PAGE_SIZE=1, so
   * multiple round trips are needed for PRs with >1 review/comment.
   */
  async fetchPrGraph(owner, repo, prId) {
    // Cursors for each inner connection; null = start from the beginning.
    let reviewsAfter = null
    let commentsAfter = null
    let timelineAfter = null
    let commitsAfter = null

    const allReviews = []
    const allComments = []
    const allTimeline = []
    const allCommits = []

    let prBase = null
    let lastRateLimit = {
      cost: 1,
      remaining: this.rateLimitRemaining,
      resetAt: new Date().toISOString(),
    }
    let repoOwner = owner
    let repoName = repo

    // We keep looping until all four inner connections are exhausted.
    let reviewsDone = false
    let commentsDone = false
    let timelineDone = false
    let commitsDone = false

    // Hard backstop: a misbehaving endpoint/proxy that returns hasNextPage:true
    // with a non-advancing cursor would otherwise spin forever, firing an
    // authenticated GraphQL POST each pass. Per-connection non-advance detection
    // (below) is the primary guard; this caps total iterations as defence.
    const MAX_PAGE_ITERATIONS = 10_000
    let iterations = 0
    while (!reviewsDone || !commentsDone || !timelineDone || !commitsDone) {
      if (++iterations > MAX_PAGE_ITERATIONS) {
        throw new Error(
          `GraphQL pagination exceeded ${MAX_PAGE_ITERATIONS} iterations for prId=${prId} — aborting (non-advancing cursor?)`,
        )
      }
      const { data, rateLimit } = await this.graphqlRequest({
        prId,
        reviewsAfter: reviewsDone ? null : reviewsAfter,
        commentsAfter: commentsDone ? null : commentsAfter,
        timelineAfter: timelineDone ? null : timelineAfter,
        commitsAfter: commitsDone ? null : commitsAfter,
      })

      lastRateLimit = rateLimit

      // The MSW mock wraps the response differently from the real GitHub API.
      // Real API uses `node(id: $prId)` → `... on PullRequest`.
      // The mock uses `repository { pullRequest { ... } }`.
      // We detect which shape we got and adapt.
      const prData = extractPrFromResponse(data)
      if (prData === null) {
        throw new Error(`GraphQL: could not extract PR data for prId=${prId}`)
      }

      // Capture repo owner/name from the mock response if available.
      const repoData = data.repository
      if (repoData) {
        repoOwner = repoData.owner ?? owner
        repoName = repoData.name ?? repo
      }

      if (prBase === null) {
        prBase = prData
      }

      // Accumulate reviews
      if (!reviewsDone) {
        allReviews.push(...prData.reviews.nodes)
        const cur = prData.reviews.pageInfo.endCursor
        if (prData.reviews.pageInfo.hasNextPage && cur !== null && cur !== reviewsAfter) {
          reviewsAfter = cur
        } else {
          reviewsDone = true // done, or cursor not advancing → stop
        }
      }

      // Accumulate comments
      if (!commentsDone) {
        allComments.push(...prData.comments.nodes)
        const cur = prData.comments.pageInfo.endCursor
        if (prData.comments.pageInfo.hasNextPage && cur !== null && cur !== commentsAfter) {
          commentsAfter = cur
        } else {
          commentsDone = true
        }
      }

      // Accumulate timeline
      if (!timelineDone) {
        allTimeline.push(...prData.timelineItems.nodes)
        const cur = prData.timelineItems.pageInfo.endCursor
        if (prData.timelineItems.pageInfo.hasNextPage && cur !== null && cur !== timelineAfter) {
          timelineAfter = cur
        } else {
          timelineDone = true
        }
      }

      // Accumulate commits
      if (!commitsDone) {
        allCommits.push(...prData.commits.nodes)
        const cur = prData.commits.pageInfo.endCursor
        if (prData.commits.pageInfo.hasNextPage && cur !== null && cur !== commitsAfter) {
          commitsAfter = cur
        } else {
          commitsDone = true
        }
      }
    }

    if (prBase === null) {
      throw new Error(`GraphQL: no data returned for prId=${prId}`)
    }

    const exhausted = {
      id: prBase.id,
      number: prBase.number,
      state: prBase.state,
      isDraft: prBase.isDraft,
      createdAt: prBase.createdAt,
      mergedAt: prBase.mergedAt,
      baseRefName: prBase.baseRefName,
      headRefName: prBase.headRefName,
      author: prBase.author,
      reviews: { nodes: allReviews },
      comments: { nodes: allComments },
      timelineItems: { nodes: allTimeline },
      commits: { nodes: allCommits },
    }

    return {
      pr: exhausted,
      rateLimit: lastRateLimit,
      repoOwner,
      repoName,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Compute how long to wait before retrying a rate-limited GitHub response.
 * Prefers `Retry-After` (seconds), then `X-RateLimit-Reset` (epoch seconds).
 * Returns null when neither is present (caller then surfaces the error).
 * Capped at 60s so a misconfigured header can't hang a sync indefinitely.
 */
function rateLimitWaitMs(headers) {
  const MAX_WAIT_MS = 60_000
  const retryAfter = headers.get('Retry-After')
  if (retryAfter !== null) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_WAIT_MS)
  }
  const reset = headers.get('X-RateLimit-Reset')
  const remaining = headers.get('X-RateLimit-Remaining')
  if (reset !== null && (remaining === null || Number(remaining) === 0)) {
    const resetMs = Number(reset) * 1000
    if (Number.isFinite(resetMs)) {
      const waitMs = resetMs - Date.now()
      if (waitMs > 0) return Math.min(waitMs, MAX_WAIT_MS)
      return 0
    }
  }
  return null
}

/**
 * Parse the RFC 5988 `Link` header and return the `rel="next"` URL, or null.
 * Example: `<https://api.github.com/…?page=2>; rel="next"`
 */
function parseLinkNext(link) {
  if (!link) return null
  for (const part of link.split(',')) {
    const trimmed = part.trim()
    if (trimmed.includes('rel="next"')) {
      const match = /^<([^>]+)>/.exec(trimmed)
      if (match?.[1]) return match[1]
    }
  }
  return null
}

/**
 * The MSW mock returns `{ data: { repository: { pullRequest: {...} } } }`,
 * while the real GitHub GraphQL API returns `{ data: { node: {...} } }`.
 * This function normalises both into a `GqlPullRequest`.
 */
function extractPrFromResponse(data) {
  // MSW mock shape: data.repository.pullRequest
  const repoData = data.repository
  if (repoData) {
    const pr = repoData.pullRequest
    if (pr) return pr
  }

  // Real API shape: data.node (type PullRequest)
  const node = data.node
  if (node && typeof node.id === 'string') return node

  return null
}
