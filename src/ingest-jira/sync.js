import { mapWithConcurrency, scrubFreeText } from '../core/index.js'
import { ingestBoardConfig } from './boardconfig.js'
import { buildStatusCategoryHistory, buildStatusCategoryMap, parseChangelog } from './changelog.js'

import { ingestWorkflows } from './workflow.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Overlap for incremental sync (SPEC §7.3)
// ---------------------------------------------------------------------------

const INCREMENTAL_OVERLAP_MINUTES = 30

// Maximum real-world timezone offset (UTC+14). Added to the incremental lookback
// so a naive-datetime JQL boundary interpreted in the instance TZ never drops
// updates regardless of where the Jira instance is configured.
const TZ_SAFETY_MINUTES = 14 * 60

/** Escape a string for safe interpolation inside a JQL double-quoted literal. */
function escapeJqlString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Extract the HTTP status embedded in a JiraClient error message, or null. */
function httpStatusOf(err) {
  const m = err instanceof Error ? err.message.match(/HTTP (\d{3})\b/) : null
  return m ? Number(m[1]) : null
}

/** Concurrent Jira read round trips in flight at once (sprint reports, etc.). */
const JIRA_FETCH_CONCURRENCY = 8

// ---------------------------------------------------------------------------
// syncJira
// ---------------------------------------------------------------------------

export async function syncJira(store, client, scope, mode, now = new Date().toISOString()) {
  const result = {
    mode,
    projectsProcessed: [],
    issuesUpserted: 0,
    transitionsAppended: 0,
    sprintEventsAppended: 0,
    errors: [],
    // Expected, non-fatal conditions on a normal-permission token (kanban boards
    // have no sprints, workflow search needs admin, future/empty sprints have no
    // report). These must NOT pollute `errors` or a healthy sync looks broken.
    warnings: [],
  }

  // -------------------------------------------------------------------------
  // 1. Fetch and snapshot status categories (C1 trap c)
  // -------------------------------------------------------------------------
  let statusCategoryMap
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
    statusCategoryMap = new Map()
  }

  // -------------------------------------------------------------------------
  // 1b. Discover boards ONCE and pre-fetch sprints. Sprint start dates are
  // needed during changelog parsing to classify committed vs added-after-start
  // scope. Sprints have no FK to issues so they can be upserted up front;
  // sprint-report MEMBERSHIP (which references issues) is ingested after the
  // issue loop in section 8. (Also fixes boards being auto-discovered twice.)
  // -------------------------------------------------------------------------
  const boardIds = [...(scope.boardIds ?? [])]
  const boardSprints = []
  const sprintStarts = new Map()
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
        // A 400 here means the board has no sprint support (e.g. a Kanban board) —
        // expected, not a failure.
        if (httpStatusOf(err) === 400) {
          result.warnings.push(`board ${boardId} does not support sprints (skipped)`)
        } else {
          result.errors.push(`Sprint list failed for board ${boardId}: ${String(err)}`)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Ingest workflows (for all projects)
  // -------------------------------------------------------------------------
  const projectIds = []
  // projectKey → projectId for projects resolved in this run, so parseChangelog
  // can stamp project_id_at_transition correctly for issues that moved between
  // in-scope projects.
  const projectKeyToId = new Map()

  for (const projectKey of scope.projectKeys) {
    try {
      // Resolve project key to project record
      const rawProject = await client.getProject(projectKey)
      const projectId = rawProject.id

      const project = {
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

      // Discover story-point field. When it can't be found, EVERY issue gets
      // story_points=null and the whole agile suite (velocity, say/do,
      // predictability, estimation accuracy) silently returns no_data. Surface
      // that loudly so the operator knows to map the field rather than assuming
      // the metrics are simply empty.
      const storyPointFieldId = await client.discoverStoryPointField(projectId)
      if (!storyPointFieldId) {
        result.errors.push(
          `Story-point field not found for project ${projectKey} — velocity, say/do, ` +
            `predictability and estimation-accuracy metrics will be empty for it. Check the ` +
            `custom-field name/permissions or set the project's storyPointsFieldId property.`,
        )
      }

      // Ingest workflows for this project. Workflow discovery is auxiliary
      // (status-mapping enrichment); a failure is reported but must NOT abort
      // core issue ingestion for the project.
      if (mode !== 'tombstone') {
        try {
          await ingestWorkflows(store, client, projectId, now)
        } catch (err) {
          // Workflow search requires Jira admin; a 403/404 on a read-only token is
          // expected. Flow metrics fall back to the status-category heuristic.
          const status = httpStatusOf(err)
          if (status === 403 || status === 404) {
            result.warnings.push(
              `workflow metadata unavailable for ${projectKey} (needs admin or not present; skipped)`,
            )
          } else {
            result.errors.push(`Workflow ingest failed for project ${projectKey}: ${String(err)}`)
          }
        }
      }

      // -----------------------------------------------------------------------
      // 3. Build JQL for issue fetch
      // -----------------------------------------------------------------------
      let jql

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
      const seenIssueIds = new Set()
      // Track the latest issue updated-time seen so the watermark is anchored on
      // server-provided timestamps (robust to local/Jira clock skew) rather than
      // the local sync-start clock.
      let maxUpdatedAt = null
      // parent_id is a self-FK. A child issue can be synced before its parent
      // (created-ASC ordering isn't a guarantee, and the parent may be in an
      // unsynced project), so we write parent_id=null when the parent isn't
      // present yet and fill it in a second pass once the project is fully
      // ingested. Without this, the parent FK aborts the whole project sync.
      const deferredParents = []

      // expand=changelog returns the first changelog page inline with each issue,
      // eliminating the per-issue changelog round trip (N+1) for issues whose
      // history fits one page. Issues with a truncated inline changelog fall back
      // to the paginated getChangelogAll below.
      for await (const issuesBatch of client.searchJqlAll({ jql, expand: ['changelog'] })) {
        for (const rawIssue of issuesBatch) {
          seenIssueIds.add(rawIssue.id)

          // One try PER ISSUE: a single bad issue (FK edge, malformed payload)
          // must never abort ingestion of the rest of the project.
          try {
            const issue = mapRawIssue(
              rawIssue,
              projectId,
              storyPointFieldId,
              statusCategoryMap,
              now,
            )

            // Defer a parent link whose parent isn't in the store yet (see above).
            if (issue.parentId && (await store.getIssue(issue.parentId)) === null) {
              deferredParents.push({ childId: issue.id, parentId: issue.parentId })
              issue.parentId = null
            }

            await store.upsertIssue(issue)
            result.issuesUpserted++
            if (issue.updatedAt && (maxUpdatedAt === null || issue.updatedAt > maxUpdatedAt)) {
              maxUpdatedAt = issue.updatedAt
            }

            // Upsert current key
            const issueKey = {
              issueId: rawIssue.id,
              key: rawIssue.key,
              validFrom: issue.createdAt,
              validTo: null,
            }
            await store.upsertIssueKey(issueKey)

            // Use the inline changelog when expand returned a complete one; only
            // paginate via getChangelogAll for issues whose history was truncated.
            const inline = rawIssue.changelog
            let histories
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

            // Append sprint events from Sprint-field changelog. Guard the
            // sprint FK: a changelog can reference a sprint we never fetched
            // (a Kanban board skipped, or a sprint on an un-enumerated board);
            // skip those rather than violate sprint_membership_events → sprints.
            for (const evt of sprintEvents) {
              if ((await store.getSprint(evt.sprintId)) === null) continue
              await store.appendSprintMembershipEvent(evt)
              result.sprintEventsAppended++
            }
          } catch (err) {
            result.errors.push(`Issue ${rawIssue.key} sync failed: ${String(err)}`)
          }
        }
      }

      // Second pass: fill the parent links we deferred, now that every issue in
      // the project has been written. A parent still absent here lives in an
      // unsynced project — leave it null rather than fabricate a row.
      for (const { childId, parentId } of deferredParents) {
        if ((await store.getIssue(parentId)) !== null) {
          await store.setIssueParent(childId, parentId)
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
    // The agile sprint-report endpoint 404s for sprints without an available
    // report (future/empty sprints, or instances on the newer report variant).
    // That is expected and high-volume, so aggregate it into a single warning
    // rather than emitting one error per sprint.
    // Fetch every sprint's report CONCURRENTLY (was the main serial Jira N+1),
    // then ingest membership sequentially (SQLite single-writer).
    const sprintTasks = boardSprints.flatMap(({ boardId, sprints }) =>
      sprints.map((rawSprint) => ({ boardId, sprintId: String(rawSprint.id) })),
    )
    const reports = await mapWithConcurrency(sprintTasks, JIRA_FETCH_CONCURRENCY, async (t) => {
      try {
        return { sprintId: t.sprintId, report: await client.getSprintReport(t.boardId, t.sprintId) }
      } catch (err) {
        return { sprintId: t.sprintId, error: err }
      }
    })
    let reportsUnavailable = 0
    for (const r of reports) {
      if (r.error) {
        if (httpStatusOf(r.error) === 404) reportsUnavailable++
        else result.errors.push(`Sprint report failed for sprint ${r.sprintId}: ${String(r.error)}`)
        continue
      }
      try {
        await ingestSprintMembership(store, r.report, r.sprintId, now)
      } catch (err) {
        result.errors.push(`Sprint report failed for sprint ${r.sprintId}: ${String(err)}`)
      }
    }
    if (reportsUnavailable > 0) {
      result.warnings.push(`${reportsUnavailable} sprint report(s) unavailable (skipped)`)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRawIssue(raw, projectId, storyPointFieldId, statusCategoryMap, now) {
  const fields = raw.fields

  const statusId = fields.status?.id ?? ''
  const statusCategory =
    statusCategoryMap.get(statusId) ??
    normalizeStatusCategoryKey(fields.status?.statusCategory?.key ?? 'new')

  let storyPoints = null
  let storyPointsRaw = null

  if (storyPointFieldId) {
    const raw_val = fields[storyPointFieldId]
    if (typeof raw_val === 'number') {
      storyPoints = raw_val
      storyPointsRaw = String(raw_val)
    } else if (raw_val !== null && raw_val !== undefined) {
      storyPointsRaw = String(raw_val)
    }
  }

  const issueType = fields.issuetype?.name ?? 'Unknown'
  const isSubtask = fields.issuetype?.subtask === true

  const parentId = fields.parent?.id ?? null

  const hierarchyLevel = isSubtask ? 2 : parentId ? 1 : 0

  const epicKey = fields.epic?.key ?? fields.customfield_10014 ?? null

  // Identity resolution (Jira accountId → internal identity) is handled by a
  // separate identity-resolution pass; set to null here to avoid FK violations.
  const assigneeId = null

  const createdAt = fields.created ?? now
  const resolvedAt = fields.resolutiondate ?? null
  // Use the server-provided updated time so the incremental watermark is
  // anchored on Jira's clock (robust to local/Jira skew); fall back to now only
  // when the field is absent (e.g. the test mock omits it).
  const updatedAt = fields.updated ?? now

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

function toIdentityRef(actor) {
  if (!actor || typeof actor !== 'object') return null
  const a = actor
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
function buildScrubbedIssueRaw(raw) {
  const scrubbed = JSON.parse(scrubFreeText(JSON.stringify(raw)))

  const assignee = toIdentityRef(raw.fields?.assignee)

  const actors = []
  const changelog = raw.changelog
  for (const history of changelog?.histories ?? []) {
    const at = history.created
    const ref = toIdentityRef(history.author)
    if (typeof at === 'string' && ref) actors.push({ at, ...ref })
  }

  scrubbed._identityRefs = { assignee: assignee ?? undefined, actors }
  return JSON.stringify(scrubbed)
}

async function ingestSprintMembership(store, report, sprintId, now) {
  const sprintStart = report.sprint.startDate ?? now

  const allIssues = [
    ...report.contents.completedIssues,
    ...report.contents.issuesNotCompletedInCurrentSprint,
    ...report.contents.puntedIssues,
  ]

  // De-duplicate
  const seen = new Set()
  for (const i of allIssues) {
    if (seen.has(i.id)) continue
    seen.add(i.id)

    // sprint_membership_events.issue_id is a FK. A sprint report can list issues
    // outside the synced project/window (cross-project sprints, issues filtered
    // out by the JQL) — skip those rather than violate the FK and abort the
    // sprint's membership ingest.
    if ((await store.getIssue(i.id)) === null) continue

    const event = {
      sprintId,
      issueId: i.id,
      change: 'added',
      // Greenhopper sprint reports DO carry the points per issue: estimateStatistic
      // is the estimate at sprint start (the committed scope), currentEstimateStatistic
      // the current value. Capture the start estimate so membership rows record the
      // committed points, not null. (NB: velocity currently sums CURRENT issue
      // story_points for present-at-start issues; this stored value enables a
      // committed-at-start computation and is surfaced for inspection.)
      pointsAtEvent: reportIssuePoints(i),
      transitionedAt: sprintStart,
      wasPresentAtStart: true,
    }
    await store.appendSprintMembershipEvent(event)
  }
}

/** Extract the story-point estimate from a Greenhopper sprint-report issue, or null. */
export function reportIssuePoints(issue) {
  const v =
    issue.estimateStatistic?.statFieldValue?.value ??
    issue.currentEstimateStatistic?.statFieldValue?.value ??
    null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normalizeSprintState(raw) {
  const s = raw.toLowerCase()
  if (s === 'active') return 'active'
  if (s === 'closed' || s === 'complete' || s === 'completed') return 'closed'
  return 'future'
}

function normalizeStatusCategoryKey(key) {
  const k = key.toLowerCase()
  if (k === 'done' || k === 'complete') return 'done'
  if (k === 'indeterminate') return 'indeterminate'
  return 'new'
}
