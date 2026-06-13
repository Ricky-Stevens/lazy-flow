// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Patterns that signal *active* work (performing work right now).
 *
 * Notes:
 *   - `develop\w*` matches "development", "developing", etc.
 *   - `implement\w*` matches "implementing", "implementation".
 *   - `test\w*` matches "Test", "Testing", "Tested" ("Testing" is an extremely
 *     common active Jira status; a bare `test` token would NOT match it because
 *     the trailing "ing" defeats the `\b` after `test`).
 *   - `\bdev\b` matches standalone "Dev" but not "Selected for Dev" (that hits
 *     WAIT_PATTERN first since WAIT is checked before ACTIVE).
 *   - `qa(?!\s*queue)` matches "QA" / "QA Testing" but not "QA Queue".
 */
const ACTIVE_PATTERN =
  /\b(progress|develop\w*|implement\w*|review|coding|test\w*|qa(?!\s*queue)|dev)\b/i

/**
 * Patterns that signal *waiting* (blocked, queued, or pending external action).
 *
 * `await\w*` matches "Awaiting Review"/"Awaiting QA"/"Awaits" — these are queued
 * states and must be caught here (WAIT is evaluated before ACTIVE) so they are
 * not mis-bucketed as active by the "review"/"qa" token. A bare `waiting` token
 * does NOT match "Awaiting" because the leading "A" defeats the `\b`.
 */
const WAIT_PATTERN =
  /\b(blocked|waiting|await\w*|on\s+hold|hold|uat|staging|queue|ready\s+for|pending|triage|selected\s+for)\b/i

/**
 * Classify a single status deterministically from its category + name.
 * Does NOT apply board-column adjustment — that is handled in seedFlowStateModel.
 */
export function classifyStatus(status) {
  const cat = status.category

  if (cat === 'new') {
    return { flowState: 'new', confidence: 0.95 }
  }

  if (cat === 'done') {
    return { flowState: 'done', confidence: 0.95 }
  }

  // 'indeterminate' or null → name-pattern matching
  const name = status.name

  // Check wait before active: "Selected for Dev" must land in wait (the "selected for"
  // wait pattern) even though "Dev" also appears. Waiting states are more conservative
  // — if a status name has any wait signal, it is not actively worked on.
  if (WAIT_PATTERN.test(name)) {
    return { flowState: 'wait', confidence: 0.8 }
  }

  if (ACTIVE_PATTERN.test(name)) {
    return { flowState: 'active', confidence: 0.8 }
  }

  // Ambiguous — low-confidence default. We default to 'wait' rather than
  // 'active' because over-counting active time inflates Flow Efficiency.
  return { flowState: 'wait', confidence: 0.45 }
}

/**
 * Apply board-column cross-check to an initial classification result.
 *
 * Rules:
 *   - If a status appears ONLY in non-started columns and the initial result
 *     is 'active', demote to 'wait' at confidence 0.70.
 *   - If a status appears in at least one started column and the initial result
 *     was 'wait' with confidence ≤ 0.50 (ambiguous default), promote to
 *     'active' at confidence 0.75.
 *   - 'new' and 'done' (derived from Jira category) are never overridden by
 *     board-column information.
 *
 * The board-column check is optional (only when board data was ingested).
 */
export function applyBoardColumnAdjustment(statusId, initial, boardColumns) {
  // 'new' and 'done' are category-derived — board columns don't override them.
  if (initial.flowState === 'new' || initial.flowState === 'done') {
    return initial
  }

  const inStarted = boardColumns.some((col) => col.isStartedCol && col.statusIds.includes(statusId))
  const inDoneOnly =
    boardColumns.some((col) => col.isDoneCol && col.statusIds.includes(statusId)) && !inStarted
  const inNonStartedOnly =
    boardColumns.some(
      (col) => !col.isStartedCol && !col.isDoneCol && col.statusIds.includes(statusId),
    ) && !inStarted

  if (inDoneOnly) {
    // The board's done column is the authoritative done boundary (SPEC §8.2):
    // an indeterminate-categorised status that the board places in a done column
    // is completed work, not active/wait. (category-derived 'new'/'done' already
    // returned above, so this only promotes active/wait name-heuristic results.)
    return { flowState: 'done', confidence: 0.75 }
  }

  if (initial.flowState === 'active' && inNonStartedOnly) {
    // Queue column — must not be active.
    return { flowState: 'wait', confidence: 0.7 }
  }

  if (initial.flowState === 'wait' && initial.confidence <= 0.5 && inStarted) {
    // Ambiguous name, but the board says this is a started column → active.
    return { flowState: 'active', confidence: 0.75 }
  }

  return initial
}

// ---------------------------------------------------------------------------
// Effective-dating helper
// ---------------------------------------------------------------------------

/**
 * Supersede all open rows for (workflowId, statusId) by closing their
 * valid_to. Then insert the new row.
 *
 * We close existing rows by fetching them and re-upserting with valid_to set,
 * which works because BunSqliteStore's upsert uses ON CONFLICT(workflow_id,
 * status_id, valid_from) DO UPDATE — so updating valid_to on an existing key
 * is safe.
 */
async function supersede(store, workflowId, statusId, validFrom, newRow) {
  const existing = await store.getFlowStateModelsByWorkflow(workflowId)
  const openRows = existing.filter((r) => r.statusId === statusId && r.validTo === null)

  // Guard against out-of-order / backfill seeds creating inverted (valid_to <
  // valid_from) or overlapping intervals, which silently corrupt CFD replay.
  let newValidTo = newRow.validTo
  for (const row of openRows) {
    if (row.validFrom < validFrom) {
      // Existing row genuinely precedes the new one → close it at validFrom.
      await store.upsertFlowStateModel({ ...row, validTo: validFrom })
    } else if (row.validFrom > validFrom) {
      // Existing open row starts AFTER the new row (out-of-order seed): the new
      // row must end where the later row begins rather than running open and
      // overlapping it. Never set valid_to earlier than valid_from.
      if (newValidTo === null || row.validFrom < newValidTo) {
        newValidTo = row.validFrom
      }
    }
    // row.validFrom === validFrom shares the PK and is overwritten by the upsert.
  }

  await store.upsertFlowStateModel({ ...newRow, validTo: newValidTo })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the `flow_state_models` table for a single workflow.
 *
 * For each status in `statuses`, derives a flow_state + confidence via the
 * category→name-pattern heuristic, optionally cross-checked against
 * `boardColumns`. Supersedes any currently-open rows for the same
 * (workflowId, statusId) pair — preserving history via effective-dating.
 *
 * This is the **deterministic seed pass** (Wave 3.5). The LLM-seed pass
 * (Wave 5) and human-confirm pass (`packages/core/src/flowstate/confirm.ts`)
 * operate on the same table via the same effective-dating contract.
 *
 * @param store     - The Store implementation to write into.
 * @param workflowId - Jira workflow id.
 * @param statuses   - Statuses belonging to this workflow.
 * @param options    - Optional valid_from override and board columns.
 */
export async function seedFlowStateModel(store, workflowId, statuses, options) {
  const validFrom = options?.validFrom ?? new Date().toISOString()
  const boardColumns = options?.boardColumns ?? []

  let inserted = 0

  for (const status of statuses) {
    const initial = classifyStatus(status)
    const adjusted =
      boardColumns.length > 0
        ? applyBoardColumnAdjustment(status.id, initial, boardColumns)
        : initial

    const newRow = {
      workflowId,
      statusId: status.id,
      flowState: adjusted.flowState,
      confidence: adjusted.confidence,
      confirmedBy: null,
      confirmedAt: null,
      validFrom,
      validTo: null,
    }

    await supersede(store, workflowId, status.id, validFrom, newRow)
    inserted++
  }

  return { total: statuses.length, inserted }
}
