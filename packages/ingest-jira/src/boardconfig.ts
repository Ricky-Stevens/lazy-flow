/**
 * Board configuration ingestion (WP-JIRA-BOARDCONFIG).
 *
 * Ingest `/rest/agile/1.0/board/:id/configuration` → `board_configs` /
 * `board_columns` with `is_started_col` / `is_done_col`.
 *
 * The started column is the required source for cycle-time start (SPEC §8.2):
 *   "start = first entry into a status mapped to a *started* board column"
 *   — `status_category` alone is too coarse (it lumps "Selected for Dev"
 *   queue columns with active "In Progress" columns).
 *
 * Kanban boards are flagged in `board_configs.type = 'kanban'` for graceful
 * degradation (no velocity/say-do, throughput/cycle-time only).
 */

import type { BoardColumn, BoardConfig, Store } from '@lazy-flow/core'
import type { JiraClient, RawBoardConfiguration } from './client.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BoardConfigSyncResult {
  boardsUpserted: number
  columnsUpserted: number
}

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
export async function ingestBoardConfig(
  store: Store,
  client: JiraClient,
  boardId: string,
  now: string,
): Promise<BoardConfigSyncResult> {
  const raw = await client.getBoardConfiguration(boardId)
  return ingestBoardConfigFromRaw(store, raw, now)
}

/**
 * Persist a board configuration from an already-fetched raw response.
 * Extracted so tests can call it directly without an HTTP round-trip.
 */
export async function ingestBoardConfigFromRaw(
  store: Store,
  raw: RawBoardConfiguration,
  now: string,
): Promise<BoardConfigSyncResult> {
  const boardId = String(raw.id)
  const boardType = normalizeType(raw.type)

  const config: BoardConfig = {
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
    let isStartedCol: boolean
    let isDoneCol: boolean

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

    const column: BoardColumn = {
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

function normalizeType(raw: string): 'scrum' | 'kanban' {
  return raw.toLowerCase() === 'kanban' ? 'kanban' : 'scrum'
}
