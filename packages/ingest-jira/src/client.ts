/**
 * Jira Cloud REST v3 + Agile client (WP-JIRA-CLIENT).
 *
 * Uses native fetch — no Jira SDK dependency (SPEC §7.2, per task scope).
 *
 * Auth: OAuth 2.0 3LO bearer token (read-only scopes) or API-token fallback —
 * both are passed via the Authorization header. The caller is responsible for
 * obtaining/refreshing the token.
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

import { assertSafeBaseUrl } from '@lazy-flow/core'

/** Hard cap on any single 429 backoff sleep, so one Retry-After can't hang sync. */
const MAX_RETRY_WAIT_MS = 60_000

/**
 * True when an error from getJson represents a 404 (endpoint not available on
 * this Jira variant) — the only condition the discovery helpers may swallow.
 * Auth (401/403), throttle (429), server (5xx) and network errors must surface
 * so the sync reports degraded coverage instead of feigning an empty result.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404\b/.test(err.message)
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Accepts the
 * delta-seconds form ("120") and the HTTP-date form (RFC 7231). Returns null
 * when absent or unparseable (the caller falls back to exponential backoff).
 * Never returns NaN or a negative value.
 */
function parseRetryAfterMs(header: string | null): number | null {
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

export interface JiraClientOptions {
  /**
   * Jira Cloud base URL, e.g. `https://acme.atlassian.net`.
   * Override in tests to point at the MSW mock.
   */
  baseUrl: string
  /**
   * Bearer token (OAuth 2.0 access token or base64-encoded API-token pair).
   * Set as `Authorization: Bearer <token>`.
   */
  token: string
  /** Maximum number of 429-retries before giving up. Defaults to 5. */
  maxRetries?: number
  /** Allow a non-https / private-host base URL (self-hosted DC behind a VPN, tests). Default false. */
  allowInsecureBaseUrl?: boolean
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------

export interface RawIssue {
  id: string
  key: string
  // biome-ignore lint/suspicious/noExplicitAny: raw Jira REST payload
  fields: Record<string, any>
}

export interface RawChangelogItem {
  field: string
  fieldtype: string
  from: string | null
  fromString: string | null
  to: string | null
  toString: string | null
}

export interface RawChangelogHistory {
  id: string
  created: string
  author: { accountId: string } | null
  items: RawChangelogItem[]
}

export interface RawChangelogPage {
  startAt: number
  maxResults: number
  total: number
  isLast: boolean
  values: RawChangelogHistory[]
}

export interface RawStatus {
  id: string
  name: string
  statusCategory: {
    id: string
    key: string
    name: string
  }
}

export interface RawField {
  id: string
  name: string
  custom: boolean
  schema?: {
    type: string
    custom?: string
  }
}

export interface RawBoard {
  id: string
  name: string
  type: string
  location?: {
    projectId?: string
    projectKey?: string
  }
}

export interface RawBoardConfiguration {
  id: string
  name: string
  type: string
  columnConfig: {
    columns: Array<{
      name: string
      statuses: Array<{ id: string }>
      isStartedColumn?: boolean
      isDoneColumn?: boolean
    }>
  }
  estimation?: {
    type: string
    field?: {
      fieldId: string
      displayName: string
    }
  }
}

export interface RawSprint {
  id: string
  name: string
  state: string
  startDate?: string | null
  endDate?: string | null
  completeDate?: string | null
  originBoardId?: string
}

export interface RawSprintReport {
  sprint: {
    id: string
    name: string
    state: string
    startDate?: string | null
    endDate?: string | null
    completeDate?: string | null
  }
  contents: {
    completedIssues: Array<{ id: string; key: string }>
    incompleteIssues: Array<{ id: string; key: string }>
    issuesNotCompletedInCurrentSprint: Array<{ id: string; key: string }>
    puntedIssues: Array<{ id: string; key: string }>
  }
}

export interface RawWorkflow {
  id: string
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: raw Jira workflow payload
  [key: string]: any
}

export interface RawWorkflowScheme {
  id: string
  name: string
  defaultWorkflow?: string
  issueTypeMappings?: Record<string, string>
  // biome-ignore lint/suspicious/noExplicitAny: raw payload
  [key: string]: any
}

export interface SearchResult {
  issues: RawIssue[]
  total: number
  nextPageToken?: string
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class JiraClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly maxRetries: number
  private readonly timeoutMs: number

  constructor(opts: JiraClientOptions) {
    // Validate before any token-bearing request: https-only and no private/
    // metadata host (unless opted in), so the bearer token is never sent in
    // cleartext or used for an authenticated SSRF (e.g. 169.254.169.254).
    assertSafeBaseUrl(opts.baseUrl, {
      allowInsecure: opts.allowInsecureBaseUrl,
      allowPrivate: opts.allowInsecureBaseUrl,
    })
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.maxRetries = opts.maxRetries ?? 5
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  // ---------------------------------------------------------------------------
  // Core fetch with retry on 429
  // ---------------------------------------------------------------------------

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
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

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetch(path, { method: 'GET' })
    if (!res.ok) {
      throw new Error(`Jira GET ${path} → HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Jira POST ${path} → HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // Issue search — cursor paginated (POST /rest/api/3/search/jql)
  // ---------------------------------------------------------------------------

  /**
   * Execute a JQL search and return one page. Pass `nextPageToken` from the
   * previous response to advance. Returns `undefined` nextPageToken when done.
   */
  async searchJql(opts: {
    jql: string
    fields?: string[]
    nextPageToken?: string
    maxResults?: number
    /** e.g. ['changelog'] to inline the first changelog page with each issue. */
    expand?: string[]
  }): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      jql: opts.jql,
      maxResults: opts.maxResults ?? 50,
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
        'customfield_10016',
      ],
    }
    if (opts.nextPageToken !== undefined) {
      body.nextPageToken = opts.nextPageToken
    }
    if (opts.expand !== undefined) {
      body.expand = opts.expand
    }

    const data = await this.postJson<{
      issues: RawIssue[]
      total: number
      nextPageToken?: string
    }>('/rest/api/3/search/jql', body)

    return {
      issues: data.issues,
      total: data.total,
      nextPageToken: data.nextPageToken,
    }
  }

  /**
   * Paginate a JQL search to exhaustion, yielding each page of issues.
   * The caller can process pages incrementally.
   */
  async *searchJqlAll(opts: {
    jql: string
    fields?: string[]
    maxResults?: number
    expand?: string[]
  }): AsyncGenerator<RawIssue[]> {
    let nextPageToken: string | undefined
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
  async getChangelogPage(
    issueId: string,
    startAt: number,
    maxResults?: number,
  ): Promise<RawChangelogPage> {
    const qs = `startAt=${startAt}&maxResults=${maxResults ?? 50}`
    return this.getJson<RawChangelogPage>(`/rest/api/3/issue/${issueId}/changelog?${qs}`)
  }

  /**
   * Paginate the changelog to exhaustion and return ALL history entries.
   * Asserts fetched == reported total per SPEC C1 trap 4b.
   */
  async getChangelogAll(
    issueId: string,
    pageSize = 50,
  ): Promise<{
    histories: RawChangelogHistory[]
    total: number
  }> {
    const allHistories: RawChangelogHistory[] = []
    let startAt = 0
    let reportedTotal: number | null = null

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

  async getStatuses(): Promise<RawStatus[]> {
    return this.getJson<RawStatus[]>('/rest/api/3/status')
  }

  // ---------------------------------------------------------------------------
  // Field list — GET /rest/api/3/field (story-point field discovery)
  // ---------------------------------------------------------------------------

  async getFields(): Promise<RawField[]> {
    return this.getJson<RawField[]>('/rest/api/3/field')
  }

  /**
   * Discover the story-point field id for a project.
   * Jira uses different custom fields per instance — this looks for the
   * numeric field named "Story Points" (or "Story point estimate").
   */
  async discoverStoryPointField(projectId: string): Promise<string | null> {
    // Try project properties first (the mock exposes it there)
    try {
      const proj = await this.getJson<{
        properties?: { storyPointsFieldId?: string }
      }>(`/rest/api/3/project/${projectId}`)
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

  // ---------------------------------------------------------------------------
  // Project metadata — GET /rest/api/3/project/:id
  // ---------------------------------------------------------------------------

  async getProject(projectId: string): Promise<{
    id: string
    key: string
    name: string
    properties?: Record<string, unknown>
  }> {
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
  private async paginateValues<T>(
    pathFor: (startAt: number) => string,
    pageSize = 50,
  ): Promise<T[]> {
    const all: T[] = []
    let startAt = 0
    while (true) {
      const data = await this.getJson<{
        values?: T[]
        workflows?: T[]
        schemes?: T[]
        isLast?: boolean
      }>(pathFor(startAt))
      const values = data.values ?? data.workflows ?? data.schemes ?? []
      all.push(...values)
      if (values.length === 0 || data.isLast === true || values.length < pageSize) break
      startAt += values.length
    }
    return all
  }

  async listBoards(): Promise<RawBoard[]> {
    return this.paginateValues<RawBoard>(
      (startAt) => `/rest/agile/1.0/board?maxResults=50&startAt=${startAt}`,
    )
  }

  async getBoardConfiguration(boardId: string): Promise<RawBoardConfiguration> {
    return this.getJson<RawBoardConfiguration>(`/rest/agile/1.0/board/${boardId}/configuration`)
  }

  // ---------------------------------------------------------------------------
  // Agile API — sprints
  // ---------------------------------------------------------------------------

  async listSprints(boardId: string): Promise<RawSprint[]> {
    return this.paginateValues<RawSprint>(
      (startAt) => `/rest/agile/1.0/board/${boardId}/sprint?maxResults=50&startAt=${startAt}`,
    )
  }

  async getSprintReport(boardId: string, sprintId: string): Promise<RawSprintReport> {
    return this.getJson<RawSprintReport>(
      `/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/report`,
    )
  }

  // ---------------------------------------------------------------------------
  // Workflow discovery — GET /rest/api/3/workflow/search
  // ---------------------------------------------------------------------------

  /**
   * Returns all workflows visible to the token. Uses the v3 workflow search
   * endpoint (paginated). Falls back gracefully if the endpoint returns 404
   * (Classic workflows use a different path).
   */
  async listWorkflows(): Promise<RawWorkflow[]> {
    try {
      return await this.paginateValues<RawWorkflow>(
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

  async listWorkflowSchemes(): Promise<RawWorkflowScheme[]> {
    try {
      return await this.paginateValues<RawWorkflowScheme>(
        (startAt) => `/rest/api/3/workflowscheme?maxResults=50&startAt=${startAt}`,
      )
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }

  async getWorkflowScheme(schemeId: string): Promise<RawWorkflowScheme> {
    return this.getJson<RawWorkflowScheme>(`/rest/api/3/workflowscheme/${schemeId}`)
  }

  async getWorkflowSchemeIssueTypeMappings(
    schemeId: string,
  ): Promise<{ issueType: string; workflow: string }[]> {
    try {
      const data = await this.getJson<{
        values?: Array<{ issueType: string; workflow: string }>
      }>(`/rest/api/3/workflowscheme/${schemeId}/issuetype?maxResults=50`)
      return data.values ?? []
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }
}
