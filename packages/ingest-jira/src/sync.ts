/**
 * Jira sync orchestrator (WP-JIRA-SYNC).
 *
 * syncJira(store, client, scope, mode):
 *   - backfill: paginate all issues via JQL; ingest changelog, workflows,
 *     board config, sprints; persist sprint_membership_events from both
 *     the sprint report and the Sprint-field changelog.
 *   - incremental: re-runs with `updated >= lastSync - overlap` JQL;
 *     same pipeline. Does not re-ingest workflows/board unless forced.
 *   - tombstone: full-enumerate the project's issues and soft-delete
 *     any that are in the store but not in the API's result set.
 *
 * Idempotent: upserts throughout; re-running a backfill produces no dupes.
 *
 * Tenant throttling note (SPEC §7.2):
 *   Jira Cloud applies tenant-level cost throttling — N concurrent local
 *   installs will 429 the entire tenant. The client respects 429+Retry-After.
 *   For team-scale use, route through the shared ingester (SPEC §5.4).
 */

import type { Issue, IssueKey, JiraProject, SprintMembershipEvent, Store } from '@lazy-flow/core'
import { scrubFreeText } from '@lazy-flow/core'
import { ingestBoardConfig } from './boardconfig.js'
import { buildStatusCategoryHistory, buildStatusCategoryMap, parseChangelog } from './changelog.js'
import type { JiraClient, RawChangelogHistory, RawIssue, RawSprint } from './client.js'
import { ingestWorkflows } from './workflow.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JiraSyncScope {
  /** Jira Cloud ID (subdomain). */
  jiraCloudId: string
  /** Project key(s) to sync (e.g. `['ACME']`). If empty, sync all visible. */
  projectKeys: string[]
  /** Board id(s) to ingest configuration for. */
  boardIds?: string[]
}

export type JiraSyncMode = 'backfill' | 'incremental' | 'tombstone'

export interface JiraSyncResult {
  mode: JiraSyncMode
  projectsProcessed: string[]
  issuesUpserted: number
  transitionsAppended: number
  sprintEventsAppended: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Overlap for incremental sync (SPEC §7.3)
// ---------------------------------------------------------------------------

const INCREMENTAL_OVERLAP_MINUTES = 30

// Maximum real-world timezone offset (UTC+14). Added to the incremental lookback
// so a naive-datetime JQL boundary interpreted in the instance TZ never drops
// updates regardless of where the Jira instance is configured.
const TZ_SAFETY_MINUTES = 14 * 60

/** Escape a string for safe interpolation inside a JQL double-quoted literal. */
function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------------------
// syncJira
// ---------------------------------------------------------------------------

export async function syncJira(
  store: Store,
  client: JiraClient,
  scope: JiraSyncScope,
  mode: JiraSyncMode,
  now = new Date().toISOString(),
): Promise<JiraSyncResult> {
  const result: JiraSyncResult = {
    mode,
    projectsProcessed: [],
    issuesUpserted: 0,
    transitionsAppended: 0,
    sprintEventsAppended: 0,
    errors: [],
  }

  // -------------------------------------------------------------------------
  // 1. Fetch and snapshot status categories (C1 trap c)
  // -------------------------------------------------------------------------
  let statusCategoryMap: Map<string, 'new' | 'indeterminate' | 'done'>
  try {
    const statuses = await client.getStatuses()
    statusCategoryMap = buildStatusCategoryMap(statuses)

    // Snapshot into status_category_history (effective-dated)
    const historyRows = buildStatusCategoryHistory(statuses, now)
    for (const row of historyRows) {
      await store.upsertStatusCategoryHistory(row)
    }
  } catch (err) {
    result.errors.push(`Failed to fetch statuses: ${String(err)}`)
    statusCategoryMap = new Map<string, 'new' | 'indeterminate' | 'done'>()
  }

  // -------------------------------------------------------------------------
  // 1b. Discover boards ONCE and pre-fetch sprints. Sprint start dates are
  // needed during changelog parsing to classify committed vs added-after-start
  // scope. Sprints have no FK to issues so they can be upserted up front;
  // sprint-report MEMBERSHIP (which references issues) is ingested after the
  // issue loop in section 8. (Also fixes boards being auto-discovered twice.)
  // -------------------------------------------------------------------------
  const boardIds: string[] = [...(scope.boardIds ?? [])]
  const boardSprints: Array<{ boardId: string; sprints: RawSprint[] }> = []
  const sprintStarts = new Map<string, string>()
  if (mode !== 'tombstone') {
    if (boardIds.length === 0) {
      try {
        const boards = await client.listBoards()
        for (const board of boards) boardIds.push(String(board.id))
      } catch (err) {
        result.errors.push(`Board discovery failed: ${String(err)}`)
      }
    }
    for (const boardId of boardIds) {
      try {
        const sprints = await client.listSprints(boardId)
        boardSprints.push({ boardId, sprints })
        for (const rawSprint of sprints) {
          await store.upsertSprint({
            id: String(rawSprint.id),
            boardId,
            state: normalizeSprintState(rawSprint.state),
            startAt: rawSprint.startDate ?? null,
            endAt: rawSprint.endDate ?? null,
            completeAt: rawSprint.completeDate ?? null,
            updatedAt: now,
          })
          if (rawSprint.startDate) sprintStarts.set(String(rawSprint.id), rawSprint.startDate)
        }
      } catch (err) {
        result.errors.push(`Sprint list failed for board ${boardId}: ${String(err)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Ingest workflows (for all projects)
  // -------------------------------------------------------------------------
  const projectIds: string[] = []
  // projectKey → projectId for projects resolved in this run, so parseChangelog
  // can stamp project_id_at_transition correctly for issues that moved between
  // in-scope projects.
  const projectKeyToId = new Map<string, string>()

  for (const projectKey of scope.projectKeys) {
    try {
      // Resolve project key to project record
      const rawProject = await client.getProject(projectKey)
      const projectId = rawProject.id

      const project: JiraProject = {
        id: projectId,
        key: rawProject.key,
        name: rawProject.name,
        jiraCloudId: scope.jiraCloudId,
        raw: JSON.stringify(rawProject),
        createdAt: now,
        updatedAt: now,
      }
      await store.upsertJiraProject(project)
      projectIds.push(projectId)
      projectKeyToId.set(rawProject.key, projectId)

      // Discover story-point field
      const storyPointFieldId = await client.discoverStoryPointField(projectId)

      // Ingest workflows for this project. Workflow discovery is auxiliary
      // (status-mapping enrichment); a failure is reported but must NOT abort
      // core issue ingestion for the project.
      if (mode !== 'tombstone') {
        try {
          await ingestWorkflows(store, client, projectId, now)
        } catch (err) {
          result.errors.push(`Workflow ingest failed for project ${projectKey}: ${String(err)}`)
        }
      }

      // -----------------------------------------------------------------------
      // 3. Build JQL for issue fetch
      // -----------------------------------------------------------------------
      let jql: string

      // Escape the project key for safe interpolation into JQL (defends against
      // a key containing a quote/backslash breaking out of the string literal).
      const safeKey = escapeJqlString(projectKey)

      if (mode === 'incremental') {
        const syncState = await store.getSyncState('jira', 'issues', projectId)
        const lastSync = syncState?.watermarkAt ?? null

        if (lastSync) {
          // The JQL `updated >= "YYYY-MM-DD HH:mm"` boundary is a NAIVE datetime
          // that Jira interprets in the INSTANCE timezone, while our watermark is
          // UTC. Subtract a timezone-safety margin (max offset 14h) on top of the
          // overlap so no updates are dropped regardless of the instance TZ.
          // Re-fetched issues are idempotent (upsert + INSERT OR IGNORE).
          const overlapMs = (INCREMENTAL_OVERLAP_MINUTES + TZ_SAFETY_MINUTES) * 60 * 1000
          const fromAt = new Date(new Date(lastSync).getTime() - overlapMs).toISOString()
          // JQL date format: "YYYY-MM-DD HH:mm"
          const jqlDate = fromAt.replace('T', ' ').replace(/\.\d+Z$/, '')
          jql = `project = "${safeKey}" AND updated >= "${jqlDate}" ORDER BY updated ASC`
        } else {
          // No watermark yet — treat as backfill
          jql = `project = "${safeKey}" ORDER BY created ASC`
        }
      } else if (mode === 'tombstone') {
        // Full enumeration — we'll compare against store contents
        jql = `project = "${safeKey}" ORDER BY created ASC`
      } else {
        // backfill
        jql = `project = "${safeKey}" ORDER BY created ASC`
      }

      // -----------------------------------------------------------------------
      // 4. Fetch issues and ingest changelogs
      // -----------------------------------------------------------------------
      const seenIssueIds = new Set<string>()
      // Track the latest issue updated-time seen so the watermark is anchored on
      // server-provided timestamps (robust to local/Jira clock skew) rather than
      // the local sync-start clock.
      let maxUpdatedAt: string | null = null

      // expand=changelog returns the first changelog page inline with each issue,
      // eliminating the per-issue changelog round trip (N+1) for issues whose
      // history fits one page. Issues with a truncated inline changelog fall back
      // to the paginated getChangelogAll below.
      for await (const issuesBatch of client.searchJqlAll({ jql, expand: ['changelog'] })) {
        for (const rawIssue of issuesBatch) {
          seenIssueIds.add(rawIssue.id)

          const issue = mapRawIssue(rawIssue, projectId, storyPointFieldId, statusCategoryMap, now)
          await store.upsertIssue(issue)
          result.issuesUpserted++
          if (issue.updatedAt && (maxUpdatedAt === null || issue.updatedAt > maxUpdatedAt)) {
            maxUpdatedAt = issue.updatedAt
          }

          // Upsert current key
          const issueKey: IssueKey = {
            issueId: rawIssue.id,
            key: rawIssue.key,
            validFrom: issue.createdAt,
            validTo: null,
          }
          await store.upsertIssueKey(issueKey)

          // Use the inline changelog when expand returned a complete one; only
          // paginate via getChangelogAll for issues whose history was truncated.
          try {
            const inline = (
              rawIssue as {
                changelog?: {
                  histories?: RawChangelogHistory[]
                  total?: number
                  maxResults?: number
                }
              }
            ).changelog
            let histories: RawChangelogHistory[]
            // Trust the inline page only when we can PROVE it is complete:
            //  - total is a known number and the page covers it, OR
            //  - total is unknown but the page is plainly not truncated (its
            //    length is below the page size, so there cannot be a next page).
            // Otherwise (total unknown AND a full-looking page) the rest of the
            // history may have been dropped — paginate via getChangelogAll.
            // Previously any `total === undefined` was treated as complete,
            // silently truncating long histories on Jira variants that omit it.
            const pageSize = inline?.maxResults ?? 100
            const inlineLen = inline?.histories?.length ?? 0
            const inlineProvenComplete =
              typeof inline?.total === 'number' ? inlineLen >= inline.total : inlineLen < pageSize
            if (inline?.histories && inlineProvenComplete) {
              histories = inline.histories
            } else {
              histories = (await client.getChangelogAll(rawIssue.id)).histories
            }
            const { transitions, issueKeys, sprintEvents } = parseChangelog(
              rawIssue,
              histories,
              statusCategoryMap,
              projectId,
              sprintStarts,
              storyPointFieldId,
              projectKeyToId,
            )

            // Append transitions (append-only log)
            if (transitions.length > 0) {
              await store.appendIssueTransitions(transitions)
              result.transitionsAppended += transitions.length
            }

            // Upsert issue keys (from changelog key-history)
            for (const k of issueKeys) {
              await store.upsertIssueKey(k)
            }

            // Append sprint events from Sprint-field changelog
            for (const evt of sprintEvents) {
              await store.appendSprintMembershipEvent(evt)
              result.sprintEventsAppended++
            }
          } catch (err) {
            result.errors.push(`Changelog fetch failed for issue ${rawIssue.key}: ${String(err)}`)
          }
        }
      }

      // -----------------------------------------------------------------------
      // 5. Tombstoning
      // -----------------------------------------------------------------------
      if (mode === 'tombstone') {
        const storedIssues = await store.getIssuesByProject(projectId)
        for (const stored of storedIssues) {
          if (!seenIssueIds.has(stored.id) && !stored.deletedAt) {
            await store.softDelete('issues', stored.id)
          }
        }
      }

      // -----------------------------------------------------------------------
      // 6. Update sync watermark
      // -----------------------------------------------------------------------
      await store.putSyncState({
        source: 'jira',
        resource: 'issues',
        scopeId: projectId,
        cursor: null,
        // Anchor the watermark on the latest server-provided updated-time (with
        // the overlap/TZ margin applied on the next run), falling back to local
        // now only when no issues were processed.
        watermarkAt: maxUpdatedAt ?? now,
        lastRunAt: now,
        status: 'idle',
        error: null,
      })

      result.projectsProcessed.push(projectKey)
    } catch (err) {
      result.errors.push(`Project ${projectKey} sync failed: ${String(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // 7. Board configuration (SPEC WP-JIRA-BOARDCONFIG) — reuse boards discovered
  //    in section 1b (no second discovery).
  // -------------------------------------------------------------------------
  if (mode !== 'tombstone') {
    for (const boardId of boardIds) {
      try {
        await ingestBoardConfig(store, client, boardId, now)
      } catch (err) {
        result.errors.push(`Board config ingest failed for board ${boardId}: ${String(err)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Sprint membership from sprint reports. Sprints themselves were upserted
  //    in section 1b; membership references issues so it runs here, after the
  //    issue loop (FK). Reuses the sprints fetched in 1b (no re-list).
  // -------------------------------------------------------------------------
  if (mode !== 'tombstone') {
    for (const { boardId, sprints } of boardSprints) {
      for (const rawSprint of sprints) {
        try {
          const report = await client.getSprintReport(boardId, String(rawSprint.id))
          await ingestSprintMembership(store, report, String(rawSprint.id), now)
        } catch (err) {
          result.errors.push(`Sprint report failed for sprint ${rawSprint.id}: ${String(err)}`)
        }
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRawIssue(
  raw: RawIssue,
  projectId: string,
  storyPointFieldId: string | null,
  statusCategoryMap: Map<string, 'new' | 'indeterminate' | 'done'>,
  now: string,
): Issue {
  const fields = raw.fields

  const statusId: string = (fields.status as { id: string } | undefined)?.id ?? ''
  const statusCategory =
    statusCategoryMap.get(statusId) ??
    normalizeStatusCategoryKey(
      (fields.status as { statusCategory?: { key: string } } | undefined)?.statusCategory?.key ??
        'new',
    )

  let storyPoints: number | null = null
  let storyPointsRaw: string | null = null

  if (storyPointFieldId) {
    const raw_val = fields[storyPointFieldId]
    if (typeof raw_val === 'number') {
      storyPoints = raw_val
      storyPointsRaw = String(raw_val)
    } else if (raw_val !== null && raw_val !== undefined) {
      storyPointsRaw = String(raw_val)
    }
  }

  const issueType = (fields.issuetype as { name: string } | undefined)?.name ?? 'Unknown'
  const isSubtask = (fields.issuetype as { subtask?: boolean } | undefined)?.subtask === true

  const parentId = (fields.parent as { id: string } | undefined)?.id ?? null

  const hierarchyLevel = isSubtask ? 2 : parentId ? 1 : 0

  const epicKey =
    (fields.epic as { key: string } | undefined)?.key ??
    (fields.customfield_10014 as string | undefined) ??
    null

  // Identity resolution (Jira accountId → internal identity) is handled by a
  // separate identity-resolution pass; set to null here to avoid FK violations.
  const assigneeId: string | null = null

  const createdAt: string = (fields.created as string | undefined) ?? now
  const resolvedAt: string | null = (fields.resolutiondate as string | undefined) ?? null
  // Use the server-provided updated time so the incremental watermark is
  // anchored on Jira's clock (robust to local/Jira skew); fall back to now only
  // when the field is absent (e.g. the test mock omits it).
  const updatedAt: string = (fields.updated as string | undefined) ?? now

  return {
    id: raw.id,
    projectId,
    key: raw.key,
    type: issueType,
    statusId,
    statusCategory,
    storyPoints,
    storyPointsFieldId: storyPointFieldId,
    storyPointsRaw,
    parentId,
    epicKey,
    isSubtask,
    hierarchyLevel,
    assigneeIdentityId: assigneeId,
    createdAt,
    resolvedAt,
    deletedAt: null,
    // Scrub issue body/description before persistence (WP-SCRUB / SPEC §6.5),
    // then re-attach the structured identity references extracted from the
    // UN-scrubbed payload. The generic secret/email scrubber would otherwise
    // redact Jira accountIds (the long hex form) and emailAddress fields,
    // corrupting downstream actor/assignee attribution in the identity pass.
    raw: buildScrubbedIssueRaw(raw),
    updatedAt,
  }
}

/** A structured, scrub-exempt identity reference parsed from a raw Jira payload. */
interface JiraIdentityRef {
  accountId: string
  displayName?: string
  emailAddress?: string
}

function toIdentityRef(actor: unknown): JiraIdentityRef | null {
  if (!actor || typeof actor !== 'object') return null
  const a = actor as Record<string, unknown>
  const accountId = a.accountId
  if (typeof accountId !== 'string' || accountId.length === 0) return null
  return {
    accountId,
    displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
    emailAddress: typeof a.emailAddress === 'string' ? a.emailAddress : undefined,
  }
}

/**
 * Scrub the raw issue for persistence, then re-attach an `_identityRefs` field
 * holding the assignee + inline-changelog actor accountIds (and any
 * emailAddress) read from the ORIGINAL, un-scrubbed payload. The identity pass
 * reads these structured refs instead of re-parsing accountIds out of scrubbed
 * free text.
 */
function buildScrubbedIssueRaw(raw: RawIssue): string {
  const scrubbed = JSON.parse(scrubFreeText(JSON.stringify(raw))) as Record<string, unknown>

  const assignee = toIdentityRef((raw.fields as Record<string, unknown>)?.assignee)

  const actors: Array<{ at: string } & JiraIdentityRef> = []
  const changelog = (raw as { changelog?: { histories?: Array<Record<string, unknown>> } })
    .changelog
  for (const history of changelog?.histories ?? []) {
    const at = history.created
    const ref = toIdentityRef(history.author)
    if (typeof at === 'string' && ref) actors.push({ at, ...ref })
  }

  scrubbed._identityRefs = { assignee: assignee ?? undefined, actors }
  return JSON.stringify(scrubbed)
}

async function ingestSprintMembership(
  store: Store,
  report: Awaited<ReturnType<JiraClient['getSprintReport']>>,
  sprintId: string,
  now: string,
): Promise<void> {
  const sprintStart = report.sprint.startDate ?? now

  const allIssues = [
    ...report.contents.completedIssues,
    ...report.contents.issuesNotCompletedInCurrentSprint,
    ...report.contents.puntedIssues,
  ]

  // De-duplicate
  const seen = new Set<string>()
  for (const i of allIssues) {
    if (seen.has(i.id)) continue
    seen.add(i.id)

    const event: SprintMembershipEvent = {
      sprintId,
      issueId: i.id,
      change: 'added',
      pointsAtEvent: null, // Points not available in the report payload
      transitionedAt: sprintStart,
      wasPresentAtStart: true,
    }
    await store.appendSprintMembershipEvent(event)
  }
}

function normalizeSprintState(raw: string): 'active' | 'closed' | 'future' {
  const s = raw.toLowerCase()
  if (s === 'active') return 'active'
  if (s === 'closed' || s === 'complete' || s === 'completed') return 'closed'
  return 'future'
}

function normalizeStatusCategoryKey(key: string): 'new' | 'indeterminate' | 'done' {
  const k = key.toLowerCase()
  if (k === 'done' || k === 'complete') return 'done'
  if (k === 'indeterminate') return 'indeterminate'
  return 'new'
}
