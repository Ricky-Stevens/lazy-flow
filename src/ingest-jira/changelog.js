// ---------------------------------------------------------------------------
// Status category map (numeric id → category)
// ---------------------------------------------------------------------------

/**
 * Build a status→category map from the /status API response.
 * Keyed on NUMERIC status IDs (C1 trap c) — never localized strings.
 */
export function buildStatusCategoryMap(statuses) {
  const map = new Map()
  for (const s of statuses) {
    const category = normalizeCategory(s.statusCategory.key)
    map.set(s.id, category)
  }
  return map
}

/**
 * Map Jira category keys/names to our three-value enum.
 * Jira uses "new" / "indeterminate" / "done" in the API, but also
 * "undefined" for some legacy statuses. Never rely on the display name.
 */
function normalizeCategory(key) {
  const k = key.toLowerCase()
  if (k === 'done' || k === 'complete' || k === 'resolved') return 'done'
  if (k === 'indeterminate' || k === 'in_progress' || k === 'inprogress') return 'indeterminate'
  // "new", "to_do", "todo", "open", "undefined" → 'new'
  return 'new'
}

// ---------------------------------------------------------------------------
// Status category history builder
// ---------------------------------------------------------------------------

/**
 * Produce `status_category_history` rows from the status list.
 * Each status gets a single open-ended row (valid_to=null) snapshotted at
 * ingest time. The effective-dated design means future admin reconfigurations
 * can be modelled by setting valid_to on the old row and inserting a new one.
 */
export function buildStatusCategoryHistory(statuses, ingestAt) {
  return statuses.map((s) => ({
    statusId: s.id,
    category: normalizeCategory(s.statusCategory.key),
    validFrom: ingestAt,
    validTo: null,
  }))
}

// ---------------------------------------------------------------------------
// Changelog parse result
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main parseChangelog
// ---------------------------------------------------------------------------

/**
 * Parse the full changelog for one issue into sorted, append-only transitions.
 *
 * @param issue            The raw Jira issue object (for created, key, id, statusId).
 * @param histories        All changelog histories fetched to exhaustion (C1 trap d).
 *                         May arrive in any order (C1 trap b — we sort them here).
 * @param statusCategoryMap  Numeric status id → category (C1 trap c).
 * @param projectId        The current project id (used for project_id_at_transition).
 */
export function parseChangelog(
  issue,
  histories,
  _statusCategoryMap,
  projectId,
  /**
   * sprintId → sprint startDate (ISO). When supplied, an "added" event whose
   * changelog timestamp is at/before the sprint start is correctly recorded as
   * committed scope (wasPresentAtStart=true) instead of always false.
   */
  sprintStarts,
  /**
   * The story-point custom field id discovered for this project. Sprint-event
   * point snapshots read this first; the hardcoded candidate list is only a
   * fallback for when discovery failed.
   */
  storyPointFieldId,
  /**
   * projectKey → projectId for projects in scope. Used to stamp
   * project_id_at_transition with the project the issue was actually in at the
   * time of each transition (issues can move between projects). Falls back to
   * the current projectId when the historical project is out of scope/unknown.
   */
  projectKeyToId,
) {
  const issueId = issue.id
  const createdAt = issue.fields.created ?? new Date(0).toISOString()
  const currentKey = issue.key
  const currentProjectKey = currentKey.split('-')[0] ?? ''

  // -------------------------------------------------------------------------
  // C1 trap (b): Sort histories by `created` ascending
  // -------------------------------------------------------------------------
  const sorted = [...histories].sort((a, b) => {
    return new Date(a.created).getTime() - new Date(b.created).getTime()
  })

  // -------------------------------------------------------------------------
  // Extract status-change and sprint-change items from histories
  // -------------------------------------------------------------------------
  const statusHistories = sorted.filter((h) => h.items.some((i) => i.field === 'status'))
  const sprintHistories = sorted.filter((h) =>
    h.items.some((i) => i.field === 'Sprint' || i.field === 'sprint'),
  )
  const keyHistories = sorted.filter((h) =>
    h.items.some((i) => i.field === 'Key' || i.field === 'key'),
  )

  // -------------------------------------------------------------------------
  // C1 trap (a): Seed the initial status transition
  // The initial status is NOT in the changelog. Reconstruct it from:
  //   - transitionedAt = fields.created
  //   - toStatusId = first transition's `from` (or current statusId if none)
  // -------------------------------------------------------------------------
  const transitions = []

  // -------------------------------------------------------------------------
  // Build the project-key timeline FIRST, so each transition can be stamped
  // with the project the issue was actually in at that time. Each Key history
  // entry records from=oldKey at history.created, so the interval [prevAt,
  // change-time) carries the OLD key and the final open interval carries the
  // current key. (Previously this was computed AFTER the transition loop, so
  // the project mutation was dead code and every transition was stamped with
  // the current project id — wrong for any moved issue.)
  // -------------------------------------------------------------------------
  const keyEvents = []
  for (const history of keyHistories) {
    const item = history.items.find((i) => i.field === 'Key' || i.field === 'key')
    if (item?.from) keyEvents.push({ key: item.from, at: history.created })
  }
  keyEvents.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  const keyIntervals = []
  let prevAt = createdAt
  for (const event of keyEvents) {
    keyIntervals.push({ key: event.key, from: prevAt, to: event.at })
    prevAt = event.at
  }
  keyIntervals.push({ key: currentKey, from: prevAt, to: null })

  // Resolve the project id in effect at a given timestamp via the key timeline.
  // The current project resolves to the known projectId; a historical project
  // resolves through projectKeyToId when it is in scope, else falls back to the
  // current projectId (its real id is not available at parse time).
  const resolveProjectIdAt = (ts) => {
    const t = new Date(ts).getTime()
    for (const iv of keyIntervals) {
      const from = new Date(iv.from).getTime()
      const to = iv.to === null ? Number.POSITIVE_INFINITY : new Date(iv.to).getTime()
      if (t >= from && t < to) {
        const projKey = iv.key.split('-')[0] ?? ''
        if (projKey === currentProjectKey) return projectId
        return projectKeyToId?.get(projKey) ?? projectId
      }
    }
    return projectId
  }

  const firstStatusHistory = statusHistories[0]
  const firstStatusItem = firstStatusHistory?.items.find((i) => i.field === 'status')
  const initialStatusId = firstStatusItem?.from ?? issue.fields.status?.id ?? ''

  if (initialStatusId) {
    // Seed the initial "created in this status" synthetic transition.
    // fromStatusId is set to the same as toStatusId because there is no prior status.
    transitions.push({
      id: `${issueId}-init`,
      issueId,
      fromStatusId: initialStatusId,
      toStatusId: initialStatusId,
      projectIdAtTransition: resolveProjectIdAt(createdAt),
      transitionedAt: createdAt,
      actorIdentityId: null,
    })
  }

  // -------------------------------------------------------------------------
  // Process status transitions
  // -------------------------------------------------------------------------
  for (const history of statusHistories) {
    const item = history.items.find((i) => i.field === 'status')
    if (!item) continue

    // C1 trap (c): use numeric IDs from `from`/`to`, NEVER `fromString`/`toString`
    const fromStatusId = item.from ?? ''
    const toStatusId = item.to ?? ''
    if (!fromStatusId || !toStatusId) continue

    transitions.push({
      id: `${issueId}-${history.id}`,
      issueId,
      fromStatusId,
      toStatusId,
      projectIdAtTransition: resolveProjectIdAt(history.created),
      transitionedAt: history.created,
      // Identity resolution (Jira accountId → internal identity) is a separate
      // pass; set to null here to avoid FK violations on identities(id).
      actorIdentityId: null,
    })
  }

  // -------------------------------------------------------------------------
  // issue_keys history (project moves / key renames) — derived from the same
  // key timeline built above.
  // -------------------------------------------------------------------------
  const issueKeys = keyIntervals.map((iv) => ({
    issueId,
    key: iv.key,
    validFrom: iv.from,
    validTo: iv.to,
  }))

  // -------------------------------------------------------------------------
  // Sprint membership events from sprint-field changelog
  // -------------------------------------------------------------------------
  const sprintEvents = []

  for (const history of sprintHistories) {
    const item = history.items.find((i) => i.field === 'Sprint' || i.field === 'sprint')
    if (!item) continue

    // Jira encodes sprint changes as from=oldSprintIds, to=newSprintIds
    // (comma-separated sprint IDs or names). We parse the numeric IDs.
    const fromSprints = parseSprints(item.from)
    const toSprints = parseSprints(item.to)

    // Added to sprint: in `to` but not `from`
    for (const sprintId of toSprints) {
      if (!fromSprints.includes(sprintId)) {
        // Committed scope = added at/before the sprint started. Without a known
        // start date we conservatively record false (added-after-start).
        const start = sprintStarts?.get(sprintId)
        const wasPresentAtStart =
          start !== undefined && new Date(history.created).getTime() <= new Date(start).getTime()
        sprintEvents.push({
          sprintId,
          issueId,
          change: 'added',
          pointsAtEvent: extractStoryPoints(issue, storyPointFieldId),
          transitionedAt: history.created,
          wasPresentAtStart,
        })
      }
    }

    // Removed from sprint: in `from` but not `to`
    for (const sprintId of fromSprints) {
      if (!toSprints.includes(sprintId)) {
        sprintEvents.push({
          sprintId,
          issueId,
          change: 'removed',
          pointsAtEvent: extractStoryPoints(issue, storyPointFieldId),
          transitionedAt: history.created,
          wasPresentAtStart: false,
        })
      }
    }
  }

  return { transitions, issueKeys, sprintEvents }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse sprint IDs from a Jira sprint-field value.
 * Jira may encode as:
 *   - A numeric string: "123"
 *   - Comma-separated: "123,456"
 *   - Jira sprint bean: "com.atlassian.greenhopper.service.sprint.Sprint@...[id=123,...]"
 *   - Non-numeric id string (e.g. "sprint-1" in test fixtures)
 */
function parseSprints(raw) {
  if (!raw) return []

  const results = []

  // Try to extract numeric ids from the bean notation first
  const beanMatches = raw.matchAll(/\bid=(\d+)/g)
  for (const m of beanMatches) {
    const id = m[1]
    if (id) results.push(id)
  }
  if (results.length > 0) return results

  // Split on commas and keep each non-empty segment as a sprint id.
  // Real Jira Cloud uses purely numeric sprint ids, but test fixtures
  // may use string ids like "sprint-1".
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed.length > 0) {
      results.push(trimmed)
    }
  }

  return results
}

function extractStoryPoints(issue, storyPointFieldId) {
  // Prefer the field discovered for this project; the hardcoded candidates are
  // only a fallback for when field discovery failed. Without this, a Jira whose
  // story-point field is outside the candidate list silently emits null points
  // on every sprint event, zeroing scope/committed-points metrics.
  if (storyPointFieldId) {
    const discovered = issue.fields[storyPointFieldId]
    if (typeof discovered === 'number') return discovered
  }
  const candidates = ['customfield_10016', 'customfield_10028', 'story_points', 'customfield_10014']
  for (const f of candidates) {
    const val = issue.fields[f]
    if (typeof val === 'number') return val
  }
  return null
}

// Re-export status utilities for use in sync.ts
export { normalizeCategory }
