/**
 * Flow State Model seeder — WP-FLOWSTATE-MODEL (deterministic seed pass).
 *
 * Maps each workflow status → flow_state ∈ {new, active, wait, done} using a
 * two-phase heuristic:
 *
 *   Phase 1 — status category (numeric, not localized):
 *     'new'           → flow_state: 'new',  confidence: 0.95
 *     'done'          → flow_state: 'done', confidence: 0.95
 *     'indeterminate' → phase 2
 *
 *   Phase 2 — name pattern matching on the indeterminate bucket:
 *     active pattern  → flow_state: 'active', confidence: 0.80
 *     wait   pattern  → flow_state: 'wait',   confidence: 0.80
 *     no match        → low-confidence default ('wait'),  confidence: 0.45
 *
 *   Phase 3 — board-column cross-check (adjusts confidence, may override):
 *     Status is ONLY in non-started columns → cannot be 'active'; demote to
 *     'wait' or 'new' and set confidence: 0.70 (board beats the name heuristic
 *     for the active/wait split, but we don't override 'new'/'done' from cat).
 *     Status appears in a started column → biases 'active'; if phase-2 result
 *     was 'wait' with low confidence, promote to 'active' at confidence 0.75.
 *
 * Effective-dating: every call inserts a NEW row with valid_from = now.
 * Existing rows for that (workflow_id, status_id) are superseded by closing
 * their valid_to (set to the same valid_from of the new row) — preserving
 * history so CFD replay can use the classification in effect at each interval.
 *
 * The LLM-seed pass (Wave 5, WP-FLOWSTATE-MODEL AI wave) should call
 * `upsertFlowStateModel` directly with the AI-derived values and a
 * `confirmedBy` of '__llm__'; the effective-dating contract here covers it.
 *
 * SPEC §1 C3, §6.2, §8.2, WP-FLOWSTATE-MODEL (deterministic seed parts).
 */

import type { FlowStateModel, Store } from '../store/Store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusInput {
  /** Jira numeric status id (string representation). */
  id: string
  /** Display name, used for pattern matching in the indeterminate bucket. */
  name: string
  /**
   * Jira status category as stored in status_category_history.
   * 'new' | 'indeterminate' | 'done' — null means unknown, falls through to
   * indeterminate path.
   */
  category: 'new' | 'indeterminate' | 'done' | null
}

export interface BoardColumnInput {
  /** Jira numeric status ids that belong to this column. */
  statusIds: string[]
  isStartedCol: boolean
  isDoneCol: boolean
}

export interface SeedFlowStateModelOptions {
  /** ISO-8601 timestamp to use as valid_from for new rows. Defaults to now. */
  validFrom?: string
  /**
   * Board columns to cross-check against. If provided, the active/wait
   * classification is adjusted based on whether a status appears in a started
   * column or only in non-started columns.
   */
  boardColumns?: BoardColumnInput[]
}

export interface SeedFlowStateModelResult {
  /** Number of statuses processed. */
  total: number
  /** Number of new rows inserted (including supersessions). */
  inserted: number
}

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

export interface ClassifyResult {
  flowState: 'new' | 'active' | 'wait' | 'done'
  confidence: number
}

/**
 * Classify a single status deterministically from its category + name.
 * Does NOT apply board-column adjustment — that is handled in seedFlowStateModel.
 */
export function classifyStatus(status: StatusInput): ClassifyResult {
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
export function applyBoardColumnAdjustment(
  statusId: string,
  initial: ClassifyResult,
  boardColumns: BoardColumnInput[],
): ClassifyResult {
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
 * which works because NodeSqliteStore's upsert uses ON CONFLICT(workflow_id,
 * status_id, valid_from) DO UPDATE — so updating valid_to on an existing key
 * is safe.
 */
async function supersede(
  store: Store,
  workflowId: string,
  statusId: string,
  validFrom: string,
  newRow: FlowStateModel,
): Promise<void> {
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
export async function seedFlowStateModel(
  store: Store,
  workflowId: string,
  statuses: StatusInput[],
  options?: SeedFlowStateModelOptions,
): Promise<SeedFlowStateModelResult> {
  const validFrom = options?.validFrom ?? new Date().toISOString()
  const boardColumns = options?.boardColumns ?? []

  let inserted = 0

  for (const status of statuses) {
    const initial = classifyStatus(status)
    const adjusted =
      boardColumns.length > 0
        ? applyBoardColumnAdjustment(status.id, initial, boardColumns)
        : initial

    const newRow: FlowStateModel = {
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
