/**
 * GitHub GraphQL client for lazy-flow ingestion (WP-GH-CLIENT).
 *
 * 100% GraphQL — every ingestion path is a bulk, nested query so a repo's data
 * comes back in O(pages) requests instead of the per-item REST N+1 (~2000
 * requests/repo before). Queries:
 *   - RepoMeta / OrgRepos     — repo metadata + discovery
 *   - CommitHistory           — default-branch commits with line stats + check runs inline
 *   - RepoPullRequests        — PRs with reviews / comments / files / head-checks nested
 *       (+ PrConnections continuation for a PR whose inline page overflows)
 *   - RepoDeployments         — deployments with latestStatus inline
 *   - RepoReleases            — release-tag deploy fallback
 *   - FileBlobs               — batched file contents for complexity analysis
 * Adapter functions normalise GraphQL nodes into the REST-ish shapes the sync
 * mappers consume, so the write layer is transport-agnostic. GraphQL exposes no
 * per-file patch text, so HALOC is derived from additions/deletions.
 *
 * Rate-limit: GraphQL has its own point budget; graphqlRequest retries on HTTP
 *   429/403 and body-level RATE_LIMITED with bounded backoff. `rateLimitRemaining`
 *   is updated from each response's `rateLimit` field.
 *
 * Base URL is configurable so tests can point at the MSW mock server which
 *   intercepts `https://api.github.com/graphql` by default.
 */

import { assertSafeBaseUrl } from '../core/index.js'

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
        author { login __typename }
        reviews(first: 100, after: $reviewsAfter) {
          nodes { id state submittedAt author { login __typename } }
          pageInfo { hasNextPage endCursor }
        }
        comments(first: 100, after: $commentsAfter) {
          nodes { id createdAt path author { login __typename } }
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

/**
 * Bulk deployments with their outcome INLINE (`latestStatus`), paginated 100 at
 * a time. Replaces the REST list + per-deployment status N+1 with O(pages)
 * queries. `databaseId` is the REST numeric id (kept as the stable row id);
 * `state` is an upper-case enum the mapper lower-cases to match the REST states.
 */
const DEPLOYMENTS_QUERY = /* graphql */ `
  query RepoDeployments($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      deployments(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId
          environment
          commitOid
          createdAt
          updatedAt
          latestStatus { state createdAt }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

/**
 * Bulk commit history (default branch) with line stats AND check runs INLINE,
 * paginated 100 commits at a time. Replaces the REST list + per-commit DETAIL +
 * per-commit check-runs N+1 (~2 REST calls PER commit) with O(commits/100)
 * GraphQL requests. GraphQL exposes no per-file PATCH text, so HALOC is derived
 * from additions/deletions (the documented fallback) rather than per-hunk.
 */
const COMMIT_HISTORY_QUERY = /* graphql */ `
  query CommitHistory($owner: String!, $name: String!, $since: GitTimestamp, $after: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, since: $since, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                oid
                committedDate
                authoredDate
                additions
                deletions
                message
                author { name email user { login } }
                # GraphQL bills by requested node count: history(100) × suites ×
                # runs is the largest point sink in the whole sync. 6 suites × 30
                # runs = 180 checks/commit is far above typical CI fan-out while
                # cutting the per-page check cost ~5×. (These inline connections
                # have no overflow paginator, so the cap is a hard ceiling — kept
                # generous deliberately.)
                checkSuites(first: 6) {
                  nodes {
                    checkRuns(first: 30) {
                      nodes { databaseId name status conclusion startedAt completedAt }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

/**
 * Bulk pull requests with reviews, review-thread comments, changed files and the
 * head commit's check runs ALL nested inline, paginated 50 PRs at a time, ordered
 * by UPDATED_AT desc for watermark early-exit. Replaces the REST PR list + the
 * per-PR reviews/comments/files/check-runs N+1 (4 REST calls PER pr). Inner
 * connections take first:100; a PR that overflows that is re-fetched via the
 * paginated REST methods (rare — 100+ reviews/files on one PR). GraphQL files
 * carry no patch, so pr_files HALOC uses additions/deletions.
 */
const REPO_PULL_REQUESTS_QUERY = /* graphql */ `
  query RepoPullRequests($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          isDraft
          createdAt
          updatedAt
          mergedAt
          baseRefName
          baseRefOid
          headRefName
          headRefOid
          author { login __typename }
          mergedBy { login __typename }
          firstCommit: commits(first: 1) {
            nodes { commit { authoredDate } }
          }
          # Inline page sizes are cost-tuned to typical PRs, NOT worst case:
          # GraphQL bills the requested node count, so first:100 everywhere paid
          # ~20× for headroom rarely used. reviews/reviewThreads/files each carry a
          # pageInfo and an overflow paginator (fetchPrConnectionsFull), so a PR
          # that exceeds these caps is transparently topped up — the reduction is
          # lossless, just cheaper for the common case.
          reviews(first: 30) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId body state submittedAt author { login __typename } }
          }
          reviewThreads(first: 30) {
            pageInfo { hasNextPage endCursor }
            nodes {
              # comments has NO per-thread overflow path, so keep it generous (a
              # single thread with >50 comments is vanishingly rare).
              comments(first: 50) {
                nodes { databaseId body createdAt updatedAt path author { login __typename } replyTo { databaseId } }
              }
            }
          }
          files(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { path additions deletions }
          }
          headChecks: commits(last: 1) {
            nodes {
              commit {
                oid
                checkSuites(first: 6) {
                  nodes {
                    checkRuns(first: 30) {
                      nodes { databaseId name status conclusion startedAt completedAt }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

/** Repo metadata via GraphQL (replaces REST GET /repos/{o}/{r} and the org repo
 * list). Selected fields map 1:1 onto the REST-ish raw `mapRepository` consumes. */
const REPO_META_FIELDS = /* graphql */ `
  databaseId
  nameWithOwner
  defaultBranchRef { name }
  isArchived
  isFork
  createdAt
  updatedAt
  pushedAt
`
const REPO_META_QUERY = /* graphql */ `
  query RepoMeta($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { ${REPO_META_FIELDS} }
    rateLimit { cost remaining resetAt }
  }
`
const ORG_REPOS_QUERY = /* graphql */ `
  query OrgRepos($org: String!, $after: String) {
    organization(login: $org) {
      repositories(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REPO_META_FIELDS} }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`
const RELEASES_QUERY = /* graphql */ `
  query RepoReleases($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      releases(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { tagName createdAt tagCommit { oid } }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

// Continuation query for a SINGLE PR whose reviews/comments/files overflowed the
// bulk query's first:100 inline page. Each connection is paged independently to
// exhaustion (only the still-live cursors advance) — keeping fat PRs 100% GraphQL.
const PR_CONNECTIONS_QUERY = /* graphql */ `
  query PrConnections(
    $owner: String!
    $name: String!
    $number: Int!
    $reviewsAfter: String
    $threadsAfter: String
    $filesAfter: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $reviewsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes { databaseId body state submittedAt author { login } }
        }
        reviewThreads(first: 100, after: $threadsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            comments(first: 50) {
              nodes { databaseId body createdAt updatedAt path author { login } replyTo { databaseId } }
            }
          }
        }
        files(first: 100, after: $filesAfter) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

// Hard cap on Link-followed REST pages. A misbehaving proxy / non-advancing
// `rel="next"` would otherwise loop forever firing authenticated requests. At
// 100 items/page this bounds collection at ~1M items — far beyond any real repo.
const MAX_PAGES = 10_000

/** Adapt a GraphQL repository node to the REST-ish raw shape mapRepository reads. */
function adaptRepoNode(node) {
  return {
    node_id: node.databaseId != null ? String(node.databaseId) : node.nameWithOwner,
    full_name: node.nameWithOwner,
    default_branch: node.defaultBranchRef?.name ?? 'main',
    archived: node.isArchived ?? false,
    fork: node.isFork ?? false,
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
    // Last push to ANY branch — the activity signal the org-wildcard idle filter
    // keys off (covers commits + PR-branch pushes; cheap, returned inline).
    pushed_at: node.pushedAt ?? null,
  }
}

/** Flatten a GraphQL commit/PR-head checkSuites connection into REST-shaped
 * check-run objects (lower-cased status/conclusion to match the REST states). */
function adaptCheckRuns(checkSuites) {
  const checks = []
  for (const suite of checkSuites?.nodes ?? []) {
    for (const cr of suite?.checkRuns?.nodes ?? []) {
      checks.push({
        node_id: cr.databaseId != null ? String(cr.databaseId) : undefined,
        name: cr.name,
        status: cr.status != null ? String(cr.status).toLowerCase() : undefined,
        conclusion: cr.conclusion != null ? String(cr.conclusion).toLowerCase() : null,
        started_at: cr.startedAt ?? null,
        completed_at: cr.completedAt ?? null,
      })
    }
  }
  return checks
}

/** Adapt a GraphQL commit-history node to the REST-ish raw shape mapCommit +
 * the commit write loop already consume, plus `__detail` (stats, no patch →
 * HALOC = max(add,del)) and `__checks` (REST-shaped). */
function adaptCommitNode(node) {
  const additions = node.additions ?? 0
  const deletions = node.deletions ?? 0
  return {
    sha: node.oid,
    commit: {
      committer: { date: node.committedDate },
      author: {
        date: node.authoredDate,
        email: node.author?.email ?? 'unknown',
        name: node.author?.name,
      },
      message: node.message ?? '',
    },
    author: node.author?.user?.login ? { login: node.author.user.login } : null,
    stats: { additions, deletions },
    __detail: { additions, deletions, haloc: Math.max(additions, deletions) },
    __checks: adaptCheckRuns(node.checkSuites),
  }
}

/** Adapt a GraphQL pull-request node into the REST-ish shapes writePr consumes:
 * `rawPr` (PR metadata), `reviews`, `comments`, `files`, `headChecks`, plus
 * `__overflow` flags so the caller can REST-paginate any connection that
 * exceeded its inline page. GraphQL enums (state, review state) are
 * preserved/lower-cased to match what the REST mappers expect. */
// Field mappers shared by adaptPrNode and the overflow continuation.
const adaptReviewNode = (r) => ({
  id: r.databaseId,
  // Carry the actor `__typename` (User|Bot|Organization|…) so bot reviewers
  // (GitHub Apps like claude/semgrep/linearb) are classified at write time —
  // resolveIdentities only re-derives bot-ness from commit/PR authors, never
  // reviewers, so a pure bot reviewer is otherwise never flagged.
  user: r.author?.login ? { login: r.author.login, type: r.author.__typename } : null,
  state: r.state, // UPPER enum; normaliseReviewState upper-cases anyway
  submitted_at: r.submittedAt,
  // Review summary text — required by the qualitative verdict layer
  // (review_depth_mentorship). null when GitHub returns an empty review body.
  // Scrubbed downstream in writePr (raw = scrubFreeText(JSON.stringify(...))).
  body: r.body ?? null,
})
const adaptThreadComments = (threadNodes) => {
  const comments = []
  for (const thread of threadNodes ?? []) {
    for (const c of thread?.comments?.nodes ?? []) {
      comments.push({
        id: c.databaseId,
        user: c.author?.login ? { login: c.author.login, type: c.author.__typename } : null,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        path: c.path ?? null,
        in_reply_to_id: c.replyTo?.databaseId ?? null,
        // Inline review-comment text — required by the qualitative verdict layer
        // (feedback_severity_mix_received). null when the body is empty.
        // Scrubbed downstream in writePr (raw = scrubFreeText(JSON.stringify(...))).
        body: c.body ?? null,
      })
    }
  }
  return comments
}
const adaptFileNode = (f) => ({
  filename: f.path,
  additions: f.additions ?? 0,
  deletions: f.deletions ?? 0,
  // GraphQL exposes no per-file patch — mapPrFile falls back to max(add,del).
})

function adaptPrNode(node) {
  const merged = node.state === 'MERGED'
  const reviews = (node.reviews?.nodes ?? []).map(adaptReviewNode)
  const comments = adaptThreadComments(node.reviewThreads?.nodes)
  const files = (node.files?.nodes ?? []).map(adaptFileNode)
  const headCommit = node.headChecks?.nodes?.[0]?.commit
  const headSha = node.headRefOid ?? headCommit?.oid ?? null
  // first_commit_at: earliest commit authored date on the PR branch. The PR
  // `commits` connection is chronological, so `commits(first: 1)` is the oldest.
  // `firstCommit` is the bulk-query alias; fall back to a full `commits` page for
  // the single-PR query shape (PR_GRAPH_QUERY).
  const firstCommitNode = node.firstCommit?.nodes?.[0] ?? node.commits?.nodes?.[0]
  const firstCommitAt = firstCommitNode?.commit?.authoredDate ?? null
  return {
    rawPr: {
      number: node.number,
      title: node.title,
      body: node.body,
      // REST `state` is open|closed (merged shown via merged_at). resolveState
      // keys off merged/merged_at, so set both.
      state: merged ? 'closed' : node.state ? String(node.state).toLowerCase() : 'open',
      merged,
      merged_at: node.mergedAt ?? null,
      draft: node.isDraft ?? false,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      first_commit_at: firstCommitAt,
      base: { ref: node.baseRefName, sha: node.baseRefOid ?? null },
      head: { ref: node.headRefName, sha: headSha },
      user: node.author?.login ? { login: node.author.login, type: node.author.__typename } : null,
      merged_by: node.mergedBy?.login
        ? { login: node.mergedBy.login, type: node.mergedBy.__typename }
        : null,
    },
    reviews,
    comments,
    files,
    headChecks: adaptCheckRuns(headCommit?.checkSuites),
    headSha,
    __overflow: {
      reviews: node.reviews?.pageInfo?.hasNextPage ?? false,
      comments: node.reviewThreads?.pageInfo?.hasNextPage ?? false,
      files: node.files?.pageInfo?.hasNextPage ?? false,
    },
  }
}

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
  /** ISO timestamp when the GraphQL point budget next resets (from rateLimit.resetAt). */
  rateLimitResetAt = null

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
    // Transient-failure retry budget (see graphqlRequest). `retryBackoffMs` is the
    // exponential-backoff base; tests pass a small value to keep retries instant.
    this.maxRetries = opts.maxRetries ?? 4
    this.retryBackoffMs = opts.retryBackoffMs ?? 500
    // Overall wall-clock cap across all retry attempts for one request.
    this.retryDeadlineMs = opts.retryDeadlineMs ?? 90_000
  }

  // -------------------------------------------------------------------------
  // Repo metadata
  // -------------------------------------------------------------------------

  async getRepo(owner, repo) {
    const { data } = await this.graphqlRequest(REPO_META_QUERY, 'RepoMeta', { owner, name: repo })
    if (!data.repository) throw new Error(`GitHub repo not found: ${owner}/${repo}`)
    return adaptRepoNode(data.repository)
  }

  async listOrgRepos(org) {
    const repos = []
    let after = null
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const { data } = await this.graphqlRequest(ORG_REPOS_QUERY, 'OrgRepos', { org, after })
      const conn = data.organization?.repositories
      if (!conn) break
      for (const node of conn.nodes ?? []) repos.push(adaptRepoNode(node))
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break
      after = conn.pageInfo.endCursor
    }
    this.visibleRepos = repos.map((r) => r.full_name)
    return repos
  }

  // -------------------------------------------------------------------------
  // Deployments / releases / check runs
  // -------------------------------------------------------------------------

  /**
   * Bulk deployment fetch via GraphQL. The REST LIST omits each deployment's
   * outcome (it lives in a per-deployment status sub-resource → one extra REST
   * call each), so the previous path was an N+1. GraphQL returns `latestStatus`
   * INLINE, so a whole repo's deployments + outcomes come back in O(pages)
   * queries instead of O(deployments) REST calls. Returns nodes in the same
   * normalised shape the REST mapper consumed plus `latestStatus`.
   */
  async fetchDeployments(owner, repo) {
    const all = []
    let after = null
    // Hard backstop against a non-advancing cursor firing authenticated POSTs forever.
    for (let pages = 0; pages < 10_000; pages++) {
      const { data } = await this.graphqlRequest(DEPLOYMENTS_QUERY, 'RepoDeployments', {
        owner,
        name: repo,
        after,
      })
      const conn = data.repository?.deployments
      if (!conn) break
      for (const node of conn.nodes ?? []) all.push(node)
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break
      after = conn.pageInfo.endCursor
    }
    return all
  }

  /**
   * Bulk default-branch commit history via GraphQL, returning each commit in the
   * SAME normalised shape the REST commit path consumed (so mapCommit and the
   * write loop are unchanged) plus `__detail` (additions/deletions/haloc, no
   * patch) and `__checks` (REST-shaped check runs). Replaces the per-commit
   * DETAIL + check-runs REST N+1. `since` (ISO) bounds incremental runs.
   */
  async fetchCommitHistory(owner, repo, since) {
    const all = []
    let after = null
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const { data } = await this.graphqlRequest(COMMIT_HISTORY_QUERY, 'CommitHistory', {
        owner,
        name: repo,
        since: since ?? null,
        after,
      })
      const history = data.repository?.defaultBranchRef?.target?.history
      if (!history) break
      for (const node of history.nodes ?? []) all.push(adaptCommitNode(node))
      if (!history.pageInfo?.hasNextPage || !history.pageInfo?.endCursor) break
      after = history.pageInfo.endCursor
    }
    return all
  }

  /**
   * Bulk pull-request fetch via GraphQL: returns each PR adapted into the
   * REST-ish shapes writePr consumes (rawPr + reviews/comments/files/headChecks).
   * Replaces the REST PR list + per-PR reviews/comments/files/check-runs N+1.
   * `since` (ISO) bounds incremental runs: results are ordered updated-desc, so
   * pagination stops as soon as a PR older than the watermark is seen. Any PR
   * whose inline connection overflowed first:100 is topped up via the paginated
   * REST methods (rare).
   */
  async fetchPullRequests(owner, repo, since) {
    const sinceMs = since ? new Date(since).getTime() : null
    const out = []
    let after = null
    let stop = false
    for (let pages = 0; !stop && pages < MAX_PAGES; pages++) {
      const { data } = await this.graphqlRequest(REPO_PULL_REQUESTS_QUERY, 'RepoPullRequests', {
        owner,
        name: repo,
        after,
      })
      const conn = data.repository?.pullRequests
      if (!conn) break
      for (const node of conn.nodes ?? []) {
        if (sinceMs !== null && node.updatedAt && new Date(node.updatedAt).getTime() < sinceMs) {
          stop = true
          break
        }
        const pr = adaptPrNode(node)
        // Top up any connection that exceeded its inline page via GraphQL
        // continuation (rare — >100 reviews/threads/files on a single PR).
        if (pr.__overflow.reviews || pr.__overflow.comments || pr.__overflow.files) {
          const full = await this.fetchPrConnectionsFull(owner, repo, node.number)
          if (pr.__overflow.reviews) pr.reviews = full.reviews
          if (pr.__overflow.comments) pr.comments = full.comments
          if (pr.__overflow.files) pr.files = full.files
        }
        out.push(pr)
      }
      if (stop || !conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break
      after = conn.pageInfo.endCursor
    }
    return out
  }

  /**
   * Paginate ONE pull request's reviews / review-thread comments / files to
   * exhaustion via GraphQL (only still-live cursors advance each round). Used to
   * top up a PR whose inline first:100 page overflowed in the bulk query.
   */
  async fetchPrConnectionsFull(owner, repo, number) {
    const reviews = []
    const files = []
    const threadNodes = []
    let reviewsAfter = null
    let threadsAfter = null
    let filesAfter = null
    let reviewsDone = false
    let threadsDone = false
    let filesDone = false
    for (let i = 0; !(reviewsDone && threadsDone && filesDone) && i < MAX_PAGES; i++) {
      const { data } = await this.graphqlRequest(PR_CONNECTIONS_QUERY, 'PrConnections', {
        owner,
        name: repo,
        number,
        reviewsAfter: reviewsDone ? null : reviewsAfter,
        threadsAfter: threadsDone ? null : threadsAfter,
        filesAfter: filesDone ? null : filesAfter,
      })
      const pr = data.repository?.pullRequest
      if (!pr) break
      if (!reviewsDone) {
        for (const r of pr.reviews?.nodes ?? []) reviews.push(adaptReviewNode(r))
        if (pr.reviews?.pageInfo?.hasNextPage && pr.reviews.pageInfo.endCursor)
          reviewsAfter = pr.reviews.pageInfo.endCursor
        else reviewsDone = true
      }
      if (!threadsDone) {
        for (const t of pr.reviewThreads?.nodes ?? []) threadNodes.push(t)
        if (pr.reviewThreads?.pageInfo?.hasNextPage && pr.reviewThreads.pageInfo.endCursor)
          threadsAfter = pr.reviewThreads.pageInfo.endCursor
        else threadsDone = true
      }
      if (!filesDone) {
        for (const f of pr.files?.nodes ?? []) files.push(adaptFileNode(f))
        if (pr.files?.pageInfo?.hasNextPage && pr.files.pageInfo.endCursor)
          filesAfter = pr.files.pageInfo.endCursor
        else filesDone = true
      }
    }
    return { reviews, comments: adaptThreadComments(threadNodes), files }
  }

  async listReleases(owner, repo) {
    const out = []
    let after = null
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const { data } = await this.graphqlRequest(RELEASES_QUERY, 'RepoReleases', {
        owner,
        name: repo,
        after,
      })
      const conn = data.repository?.releases
      if (!conn) break
      for (const node of conn.nodes ?? []) {
        // Adapt to the REST-ish raw mapReleaseAsDeployment reads.
        out.push({
          tag_name: node.tagName,
          created_at: node.createdAt ?? null,
          target_commitish: node.tagCommit?.oid ?? '',
        })
      }
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break
      after = conn.pageInfo.endCursor
    }
    return out
  }

  /**
   * Whole-file contents at a specific ref (GET …/contents/{path}?ref={sha}),
   * decoded from base64. Returns null when the path is absent at that ref (404 —
   * e.g. a file added in a PR has no base version), is a directory/submodule, or
   * exceeds the contents API's ~1 MB inline limit. Best-effort: complexity
   * analysis is optional, so any fetch failure yields null rather than throwing.
   */
  /**
   * Bulk file-content fetch via GraphQL. Each (sha, path) becomes a
   * `object(expression: "<sha>:<path>")` Blob alias, so up to BLOB_BATCH files
   * come back in ONE query instead of one REST contents call each (the per-file
   * N+1 that dominated complexity ingestion). The expression is passed as a
   * GraphQL VARIABLE (never interpolated into the query text), so a path cannot
   * break or inject into the query. Returns a Map keyed `"<sha>:<path>"` →
   * source text, with null for binary / missing / oversized blobs (parity with
   * the REST path). `refPaths` order is irrelevant; lookups are by key.
   */
  async fetchBlobs(owner, repo, refPaths) {
    const out = new Map()
    const BLOB_BATCH = 50
    for (let start = 0; start < refPaths.length; start += BLOB_BATCH) {
      const chunk = refPaths.slice(start, start + BLOB_BATCH)
      // Build aliased Blob selections + their variable declarations dynamically.
      const decls = ['$owner: String!', '$name: String!']
      const selections = []
      const variables = { owner, name: repo }
      chunk.forEach((rp, i) => {
        decls.push(`$e${i}: String!`)
        selections.push(`b${i}: object(expression: $e${i}) { ... on Blob { text isBinary } }`)
        variables[`e${i}`] = `${rp.sha}:${rp.path}`
      })
      const query = `query FileBlobs(${decls.join(', ')}) {
        repository(owner: $owner, name: $name) {
          ${selections.join('\n          ')}
        }
        rateLimit { cost remaining resetAt }
      }`
      const { data } = await this.graphqlRequest(query, 'FileBlobs', variables)
      const repository = data.repository ?? {}
      chunk.forEach((rp, i) => {
        const node = repository[`b${i}`]
        const text = node && node.isBinary !== true ? (node.text ?? null) : null
        out.set(`${rp.sha}:${rp.path}`, text)
      })
    }
    return out
  }

  /**
   * Check which of `paths` exist at the repo's default-branch HEAD, via one (or a
   * few) batched GraphQL `object(expression:"HEAD:<path>")` lookups. Returns the
   * set of present paths. Used for tool-agnostic AI-tooling detection (CLAUDE.md,
   * .cursor, copilot-instructions, …). Paths are passed as VARIABLES, never
   * interpolated, so a path cannot break or inject into the query.
   */
  async fetchPathsPresent(owner, repo, paths) {
    const present = new Set()
    const BATCH = 40
    for (let start = 0; start < paths.length; start += BATCH) {
      const chunk = paths.slice(start, start + BATCH)
      const decls = ['$owner: String!', '$name: String!']
      const selections = []
      const variables = { owner, name: repo }
      chunk.forEach((p, i) => {
        decls.push(`$e${i}: String!`)
        selections.push(`o${i}: object(expression: $e${i}) { __typename }`)
        variables[`e${i}`] = `HEAD:${p}`
      })
      const query = `query RepoPaths(${decls.join(', ')}) {
        repository(owner: $owner, name: $name) {
          ${selections.join('\n          ')}
        }
        rateLimit { cost remaining resetAt }
      }`
      const { data } = await this.graphqlRequest(query, 'RepoPaths', variables)
      const repository = data.repository ?? {}
      chunk.forEach((p, i) => {
        if (repository[`o${i}`]) present.add(p)
      })
    }
    return present
  }

  // -------------------------------------------------------------------------
  // GraphQL — per-PR object graph with exhausted inner connections
  // -------------------------------------------------------------------------

  /**
   * Execute a named GraphQL query against the mock or real GitHub GraphQL
   * endpoint. `operationName` is embedded in the body so the MSW mock (which
   * matches on `graphql.query('<name>', ...)`) can route it.
   */
  async graphqlRequest(query, operationName, variables) {
    // GraphQL has its OWN point-based budget (separate from REST) and rate-limits
    // via either HTTP 429/403 or a 200 body carrying a `RATE_LIMITED` error. A
    // backfill that exhausts the budget must back off and retry, not crash the
    // whole sync. Mirror the REST retry policy.
    const maxAttempts = this.maxRetries
    // Serialise the body ONCE, OUTSIDE the retry loop. A non-serialisable
    // `variables` (circular ref / BigInt) is a PROGRAMMING error, not a transient
    // failure — it must throw immediately here, never be caught below and retried
    // (which would burn the retry budget and obscure the real cause).
    const body = JSON.stringify({ query, operationName, variables })
    // Overall wall-clock budget across all attempts — bounds the worst case
    // (maxAttempts × per-attempt timeout + backoff) on a persistently-failing host.
    const retryDeadline = Date.now() + this.retryDeadlineMs
    for (let attempt = 0; ; attempt++) {
      let response
      try {
        response = await fetch(`${this.baseUrl}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          // Do not auto-follow a server-controlled redirect with the bearer token
          // attached; the GraphQL endpoint never legitimately 30x's.
          redirect: 'manual',
        })
      } catch (err) {
        // fetch() rejects ONLY on network failure / abort / timeout — all
        // transient and safe to retry (every GraphQL call here is a READ).
        if (attempt < maxAttempts && Date.now() < retryDeadline) {
          await sleep(backoffMs(attempt, this.retryBackoffMs))
          continue
        }
        throw new Error(
          `GitHub GraphQL request failed after ${attempt + 1} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }

      if (response.status >= 300 && response.status < 400) {
        throw new Error(`GitHub GraphQL unexpected redirect (${response.status})`)
      }

      // HTTP-level rate limit: honour Retry-After / X-RateLimit-Reset backoff.
      if ((response.status === 429 || response.status === 403) && attempt < maxAttempts) {
        const waitMs = rateLimitWaitMs(response.headers)
        if (waitMs !== null) {
          await sleep(waitMs)
          continue
        }
      }

      // Transient server/gateway errors (500/502/503/504): GitHub returns these
      // under load or during brief outages. Back off and retry rather than failing
      // the repo — this is exactly what forced a manual second run_sync before
      // (and that re-run is what exposed the identity-graph idempotency bug).
      if (
        TRANSIENT_HTTP_STATUSES.has(response.status) &&
        attempt < maxAttempts &&
        Date.now() < retryDeadline
      ) {
        await sleep(backoffMs(attempt, this.retryBackoffMs))
        continue
      }

      if (!response.ok) {
        throw new Error(`GitHub GraphQL HTTP ${response.status}`)
      }

      let json
      try {
        json = await response.json()
      } catch (err) {
        throw new Error(
          `GitHub GraphQL invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const errors = json.errors ?? []
      // Body-level rate limiting (HTTP 200 + RATE_LIMITED): wait until the budget
      // resets, then retry.
      if (errors.some((e) => e?.type === 'RATE_LIMITED') && attempt < maxAttempts) {
        const resetAt = json.data?.rateLimit?.resetAt
        const resetMs = resetAt ? new Date(resetAt).getTime() - Date.now() : 2 ** attempt * 1000
        await sleep(Math.min(Math.max(resetMs, 0), 120_000))
        continue
      }
      // A request that returns NO data AND errors is fatal (bad query, not-found
      // root, auth). Field-level errors alongside partial `data` (e.g. one node
      // with a GC'd commit) are tolerated — proceed with the data we got.
      if (errors.length > 0 && json.data == null) {
        throw new Error(`GitHub GraphQL error: ${errors[0]?.message ?? 'unknown'}`)
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
      // Track the reset time so a budget-aware caller can report when the window
      // reopens (used by the sync's graceful-stop warning).
      if (rateLimit.resetAt) this.rateLimitResetAt = rateLimit.resetAt
      return { data, rateLimit }
    }
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
      const { data, rateLimit } = await this.graphqlRequest(PR_GRAPH_QUERY, 'PullRequestGraph', {
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
 * Transient server/gateway statuses GitHub returns under load or during brief
 * outages — safe to retry (every GraphQL call in this client is a read).
 */
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504])

/**
 * Exponential backoff with full jitter, capped at 30s. Jitter de-synchronises
 * retries across the repos being fetched concurrently so they don't thunder back
 * at GitHub in lockstep.
 */
function backoffMs(attempt, baseMs) {
  const capped = Math.min(baseMs * 2 ** attempt, 30_000)
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

/**
 * Compute how long to wait before retrying a rate-limited GitHub response.
 * Prefers `Retry-After` (seconds), then `X-RateLimit-Reset` (epoch seconds).
 * Returns null when neither is present (caller then surfaces the error).
 * Capped at 120s: GitHub's secondary-rate-limit `Retry-After` is legitimately
 * 60–120s, so a 60s cap caused a premature retry that immediately 403'd again
 * and burned an attempt. 120s honours the real values while still bounding a
 * pathological/misconfigured header so a sync can't hang indefinitely.
 */
function rateLimitWaitMs(headers) {
  const MAX_WAIT_MS = 120_000
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
