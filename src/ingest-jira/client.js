/**
 * Jira Cloud REST v3 + Agile client (WP-JIRA-CLIENT).
 *
 * Uses native fetch — no Jira SDK dependency (SPEC §7.2, per task scope).
 *
 * Auth: two schemes, selected by whether an account `email` is supplied:
 *   - Basic (email + API token): `Authorization: Basic base64(email:token)`.
 *     This is REQUIRED for an Atlassian API token (prefix `ATATT…`) against a
 *     Jira Cloud SITE URL (https://<tenant>.atlassian.net). It is the common case.
 *   - Bearer (OAuth 2.0 3LO access token): used when no email is given. Note a
 *     3LO token only works against https://api.atlassian.com/ex/jira/{cloudId},
 *     NOT the site URL — so this path is for callers that set baseUrl accordingly.
 * The caller is responsible for obtaining/refreshing the token.
 *
 * Endpoints covered:
 *   POST /rest/api/3/search/jql            — cursor-paginated issue search
 *   GET  /rest/api/3/issue/:id/changelog   — bulk changelog, paginated via startAt
 *   GET  /rest/api/3/status                — all statuses + category mapping
 *   GET  /rest/api/3/field                 — field list for story-point discovery
 *   GET  /rest/api/3/project/:id           — project metadata
 *   GET  /rest/agile/1.0/board             — list boards
 *   GET  /rest/agile/1.0/board/:id/sprint  — sprints for a board
 *   GET  /rest/agile/1.0/board/:id/sprint/:sid/report — sprint report
 *   GET  /rest/agile/1.0/board/:id/configuration       — board columns (cycle-time boundary)
 *   GET  /rest/api/3/workflow/search       — workflow discovery
 *   GET  /rest/api/3/workflowscheme        — workflow scheme discovery
 *   GET  /rest/api/3/workflowscheme/:id/issuetype — issue-type→workflow mapping
 *
 * Throttling: Jira Cloud applies tenant-level cost throttling. The client
 * respects 429 responses with Retry-After and has a configurable max-retry.
 */

import { assertSafeBaseUrl } from '../core/index.js'

/** Hard cap on any single 429 backoff sleep, so one Retry-After can't hang sync. */
const MAX_RETRY_WAIT_MS = 60_000

/**
 * True when an error from getJson represents a 404 (endpoint not available on
 * this Jira variant) — the only condition the discovery helpers may swallow.
 * Auth (401/403), throttle (429), server (5xx) and network errors must surface
 * so the sync reports degraded coverage instead of feigning an empty result.
 */
function isNotFound(err) {
  return err instanceof Error && /HTTP 404\b/.test(err.message)
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Accepts the
 * delta-seconds form ("120") and the HTTP-date form (RFC 7231). Returns null
 * when absent or unparseable (the caller falls back to exponential backoff).
 * Never returns NaN or a negative value.
 */
function parseRetryAfterMs(header) {
  if (header === null) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed)
    return Number.isFinite(secs) ? secs * 1000 : null
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }
  return null
}

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class JiraClient {
  baseUrl
  token
  email
  authHeader
  maxRetries
  timeoutMs

  constructor(opts) {
    // Validate before any token-bearing request: https-only and no private/
    // metadata host (unless opted in), so the credential is never sent in
    // cleartext or used for an authenticated SSRF (e.g. 169.254.169.254).
    assertSafeBaseUrl(opts.baseUrl, {
      allowInsecure: opts.allowInsecureBaseUrl,
      allowPrivate: opts.allowInsecureBaseUrl,
    })
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.email = opts.email ?? ''
    // An API token against a Jira Cloud site URL requires Basic auth
    // (base64(email:token)); only a 3LO OAuth token uses Bearer. Pick the scheme
    // up front so every request is consistent. The header value is a secret and
    // is never logged.
    this.authHeader =
      this.email !== ''
        ? `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`
        : `Bearer ${this.token}`
    this.maxRetries = opts.maxRetries ?? 5
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  // ---------------------------------------------------------------------------
  // Core fetch with retry on 429
  // ---------------------------------------------------------------------------

  async fetch(path, init) {
    const url = `${this.baseUrl}${path}`
    const headers = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    }

    let attempt = 0
    while (true) {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        // Do not auto-follow a server-controlled redirect with the bearer token
        // attached (SSRF). Jira REST does not legitimately 30x JSON GETs; a 3xx
        // is surfaced as a non-ok response by getJson and fails closed.
        redirect: 'manual',
      })

      if (res.status !== 429) return res

      attempt++
      if (attempt > this.maxRetries) {
        throw new Error(`Jira rate limit exceeded after ${this.maxRetries} retries: ${url}`)
      }

      // Bound and validate Retry-After: an unbounded/NaN value would otherwise
      // sleep for hours (or fire immediately, defeating backoff). Falls back to
      // exponential backoff when the header is missing or unparseable, and is
      // capped so one hostile header cannot hang the sync.
      const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
      const delayMs = Math.min(retryAfterMs ?? 2 ** attempt * 1000, MAX_RETRY_WAIT_MS)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  async getJson(path) {
    const res = await this.fetch(path, { method: 'GET' })
    if (!res.ok) {
      throw new Error(`Jira GET ${path} → HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch (err) {
      // A 200 with a malformed/partial body (proxy error, truncated transfer)
      // would otherwise throw a bare SyntaxError. Surface it as an API error.
      throw new Error(
        `Jira GET ${path} → invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async postJson(path, body) {
    const res = await this.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Jira POST ${path} → HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch (err) {
      throw new Error(
        `Jira POST ${path} → invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Issue search — cursor paginated (POST /rest/api/3/search/jql)
  // ---------------------------------------------------------------------------

  /**
   * Execute a JQL search and return one page. Pass `nextPageToken` from the
   * previous response to advance. Returns `undefined` nextPageToken when done.
   */
  async searchJql(opts) {
    const body = {
      jql: opts.jql,
      maxResults: opts.maxResults ?? 50,
      // Generic base fields present on every Jira instance. Instance-specific
      // custom fields (story points, epic link) are NOT hardcoded here — the
      // caller discovers them per-instance and appends them via opts.fields.
      fields: opts.fields ?? [
        'summary',
        'issuetype',
        'status',
        'project',
        'created',
        'updated',
        'resolutiondate',
        'assignee',
        'parent',
        'priority',
        'resolution',
      ],
    }
    if (opts.nextPageToken !== undefined) {
      body.nextPageToken = opts.nextPageToken
    }
    if (opts.expand !== undefined) {
      // The enhanced /rest/api/3/search/jql endpoint expects `expand` as a
      // comma-separated STRING. The deprecated /search accepted an array; passing
      // an array here returns HTTP 400 and silently blocks all issue ingestion.
      body.expand = Array.isArray(opts.expand) ? opts.expand.join(',') : opts.expand
    }

    const data = await this.postJson('/rest/api/3/search/jql', body)

    // A 200 can legitimately omit `issues` (e.g. an empty/last page). Default to
    // an empty array so the pagination loop's `page.issues.length` never throws
    // and crashes the whole project sync.
    const issues = Array.isArray(data.issues) ? data.issues : []
    return {
      issues,
      total: typeof data.total === 'number' ? data.total : issues.length,
      nextPageToken: data.nextPageToken,
    }
  }

  /**
   * Paginate a JQL search to exhaustion, yielding each page of issues.
   * The caller can process pages incrementally.
   */
  async *searchJqlAll(opts) {
    let nextPageToken
    do {
      const page = await this.searchJql({ ...opts, nextPageToken })
      if (page.issues.length > 0) yield page.issues
      nextPageToken = page.nextPageToken
    } while (nextPageToken !== undefined)
  }

  // ---------------------------------------------------------------------------
  // Bulk changelog — GET /rest/api/3/issue/:id/changelog (paginated by startAt)
  //
  // SPEC §7.2 / WP-JIRA-CHANGELOG C1 trap 4:
  //   The bulk changelog is itself paginated. We follow startAt until
  //   isLast===true and assert fetched == total.
  // ---------------------------------------------------------------------------

  /**
   * Fetch one page of the changelog for an issue.
   */
  async getChangelogPage(issueId, startAt, maxResults) {
    const qs = `startAt=${startAt}&maxResults=${maxResults ?? 50}`
    return this.getJson(`/rest/api/3/issue/${issueId}/changelog?${qs}`)
  }

  /**
   * Paginate the changelog to exhaustion and return ALL history entries.
   * Asserts fetched == reported total per SPEC C1 trap 4b.
   */
  async getChangelogAll(issueId, pageSize = 50) {
    const allHistories = []
    let startAt = 0
    let reportedTotal = null

    while (true) {
      const page = await this.getChangelogPage(issueId, startAt, pageSize)

      if (reportedTotal === null) {
        reportedTotal = page.total
      }

      allHistories.push(...page.values)

      if (page.isLast || allHistories.length >= page.total) break
      // No progress on a non-last page (empty values but total>0) would spin
      // forever issuing token-bearing requests. Stop; the exhaustion assertion
      // below then surfaces the inconsistency deterministically.
      if (page.values.length === 0) break
      startAt = allHistories.length
    }

    const total = reportedTotal ?? 0

    // Assert fetched == reported total (C1 trap 4b)
    if (allHistories.length !== total) {
      throw new Error(
        `Changelog exhaustion assertion failed for issue ${issueId}: ` +
          `fetched=${allHistories.length} reported=${total}`,
      )
    }

    return { histories: allHistories, total }
  }

  // ---------------------------------------------------------------------------
  // Status list — GET /rest/api/3/status
  // ---------------------------------------------------------------------------

  async getStatuses() {
    return this.getJson('/rest/api/3/status')
  }

  // ---------------------------------------------------------------------------
  // Field list — GET /rest/api/3/field (story-point field discovery)
  // ---------------------------------------------------------------------------

  async getFields() {
    return this.getJson('/rest/api/3/field')
  }

  /**
   * Discover the story-point field id for a project.
   * Jira uses different custom fields per instance — this looks for the
   * numeric field named "Story Points" (or "Story point estimate").
   */
  async discoverStoryPointField(projectId) {
    // Try project properties first (the mock exposes it there)
    try {
      const proj = await this.getJson(`/rest/api/3/project/${projectId}`)
      if (proj.properties?.storyPointsFieldId) {
        return proj.properties.storyPointsFieldId
      }
    } catch {
      // fall through to field-list discovery
    }

    const fields = await this.getFields()
    // Look for numeric custom fields whose name matches common story-point names
    const storyPointNames = new Set([
      'story points',
      'story point estimate',
      'story point',
      'points',
    ])
    const match = fields.find(
      (f) => f.custom && f.schema?.type === 'number' && storyPointNames.has(f.name.toLowerCase()),
    )
    return match?.id ?? null
  }

  /**
   * Discover the epic-link field id for an instance (classic Jira boards store
   * the epic on a custom field, e.g. customfield_10014 — but the id differs per
   * instance, so it must be discovered, never hardcoded). Team-managed projects
   * expose the parent directly and don't need this. Returns null when absent.
   */
  async discoverEpicLinkField() {
    const fields = await this.getFields()
    const match = fields.find(
      (f) =>
        f.custom &&
        (f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link' ||
          f.name?.toLowerCase() === 'epic link'),
    )
    return match?.id ?? null
  }

  // ---------------------------------------------------------------------------
  // Project metadata — GET /rest/api/3/project/:id
  // ---------------------------------------------------------------------------

  async getProject(projectId) {
    return this.getJson(`/rest/api/3/project/${projectId}`)
  }

  // ---------------------------------------------------------------------------
  // Agile API — boards
  // ---------------------------------------------------------------------------

  /**
   * Paginate a `values`/`isLast` (Agile / v3 search) collection to exhaustion.
   * Stops on isLast, an empty page, or a short page (for endpoints that omit
   * isLast) — so tenants with >50 boards/sprints/workflows are not silently
   * truncated to the first page. `pageSize` must match the maxResults in path.
   */
  async paginateValues(pathFor, pageSize = 50) {
    const all = []
    let startAt = 0
    while (true) {
      const data = await this.getJson(pathFor(startAt))
      const values = data.values ?? data.workflows ?? data.schemes ?? []
      all.push(...values)
      if (values.length === 0 || data.isLast === true || values.length < pageSize) break
      startAt += values.length
    }
    return all
  }

  async listBoards() {
    return this.paginateValues(
      (startAt) => `/rest/agile/1.0/board?maxResults=50&startAt=${startAt}`,
    )
  }

  async getBoardConfiguration(boardId) {
    return this.getJson(`/rest/agile/1.0/board/${boardId}/configuration`)
  }

  // ---------------------------------------------------------------------------
  // Agile API — sprints
  // ---------------------------------------------------------------------------

  async listSprints(boardId) {
    return this.paginateValues(
      (startAt) => `/rest/agile/1.0/board/${boardId}/sprint?maxResults=50&startAt=${startAt}`,
    )
  }

  async getSprintReport(boardId, sprintId) {
    return this.getJson(`/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/report`)
  }

  // ---------------------------------------------------------------------------
  // Workflow discovery — GET /rest/api/3/workflow/search
  // ---------------------------------------------------------------------------

  /**
   * Returns all workflows visible to the token. Uses the v3 workflow search
   * endpoint (paginated). Falls back gracefully if the endpoint returns 404
   * (Classic workflows use a different path).
   */
  async listWorkflows() {
    try {
      return await this.paginateValues(
        (startAt) => `/rest/api/3/workflow/search?maxResults=50&startAt=${startAt}`,
      )
    } catch (err) {
      if (isNotFound(err)) return [] // Classic workflows use a different path.
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Workflow scheme discovery
  // ---------------------------------------------------------------------------

  async listWorkflowSchemes() {
    try {
      return await this.paginateValues(
        (startAt) => `/rest/api/3/workflowscheme?maxResults=50&startAt=${startAt}`,
      )
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }

  async getWorkflowScheme(schemeId) {
    return this.getJson(`/rest/api/3/workflowscheme/${schemeId}`)
  }

  async getWorkflowSchemeIssueTypeMappings(schemeId) {
    try {
      const data = await this.getJson(
        `/rest/api/3/workflowscheme/${schemeId}/issuetype?maxResults=50`,
      )
      return data.values ?? []
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }
}
