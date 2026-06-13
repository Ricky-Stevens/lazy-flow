// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ingestBoardConfig
// ---------------------------------------------------------------------------

/**
 * Fetch and persist the board configuration for a single board.
 *
 * The mock exposes `isStartedColumn` / `isDoneColumn` flags on each column.
 * For real Jira Cloud boards without these flags we apply a heuristic:
 *   - A column whose statuses all have `statusCategory.key === 'done'`
 *     becomes `isDoneCol`.
 *   - The first column that is neither 'new' nor 'done' becomes `isStartedCol`
 *     (i.e. the leftmost 'indeterminate' column).
 *
 * The heuristic is a fallback only — when the flags are present we always use
 * the explicit values.
 */
export async function ingestBoardConfig(store, client, boardId, now) {
  const raw = await client.getBoardConfiguration(boardId)
  return ingestBoardConfigFromRaw(store, raw, now)
}

/**
 * Persist a board configuration from an already-fetched raw response.
 * Extracted so tests can call it directly without an HTTP round-trip.
 */
export async function ingestBoardConfigFromRaw(store, raw, now) {
  const boardId = String(raw.id)
  const boardType = normalizeType(raw.type)

  const config = {
    boardId,
    type: boardType,
    updatedAt: now,
  }
  await store.upsertBoardConfig(config)

  const columns = raw.columnConfig?.columns ?? []
  let columnsUpserted = 0

  for (const col of columns) {
    const statusIds = col.statuses.map((s) => s.id)

    // Use explicit flags if present; otherwise apply heuristic
    let isStartedCol
    let isDoneCol

    if (col.isStartedColumn !== undefined || col.isDoneColumn !== undefined) {
      isStartedCol = col.isStartedColumn === true
      isDoneCol = col.isDoneColumn === true
    } else {
      isDoneCol = false
      isStartedCol = false
      // Heuristic (last resort when the board omits explicit started/done flags):
      // recognise the common done-equivalent column names so a terminal column
      // isn't mis-flagged as "started" (which would count completed work as WIP
      // and corrupt cycle-time boundaries).
      const nameLower = col.name.toLowerCase()
      const DONE_NAMES = new Set([
        'done',
        'complete',
        'completed',
        'resolved',
        'closed',
        'shipped',
        'deployed',
        'released',
        'live',
      ])
      const NOT_STARTED_NAMES = new Set([
        'backlog',
        'to do',
        'todo',
        'selected for dev',
        'selected',
        'ready',
        'open',
        'new',
      ])
      if (DONE_NAMES.has(nameLower)) {
        isDoneCol = true
      } else if (!NOT_STARTED_NAMES.has(nameLower)) {
        isStartedCol = true
      }
    }

    const column = {
      boardId,
      columnName: col.name,
      statusIds: JSON.stringify(statusIds),
      isStartedCol,
      isDoneCol,
    }

    await store.upsertBoardColumn(column)
    columnsUpserted++
  }

  return { boardsUpserted: 1, columnsUpserted }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeType(raw) {
  return raw.toLowerCase() === 'kanban' ? 'kanban' : 'scrum'
}
