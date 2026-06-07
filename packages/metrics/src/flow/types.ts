/**
 * Shared input/record types for Flow (Group B) metrics.
 *
 * These types are lightweight data-transfer shapes — pure data,
 * no Store or async dependencies.  The caller (MCP tool or test)
 * projects from the Store into these shapes before calling compute().
 */

// ---------------------------------------------------------------------------
// Transition record — one entry from issue_transitions
// ---------------------------------------------------------------------------

/**
 * A single Jira issue transition, as needed by the flow engine.
 */
export interface TransitionRecord {
  id: string
  issueId: string
  fromStatusId: string
  toStatusId: string
  transitionedAt: string
}

// ---------------------------------------------------------------------------
// Flow-state classification — effective-dated lookup result
// ---------------------------------------------------------------------------

/**
 * The flow state classification for a (workflowId, statusId) pair
 * at a specific point in time.  Callers supply this by calling
 * `store.getFlowStateModel(workflowId, statusId, at)`.
 */
export type FlowState = 'new' | 'active' | 'wait' | 'done'

/**
 * Per-status resolved flow state.  Used when the caller has already
 * resolved the effective-dated mapping for a whole workflow.
 */
export interface StatusFlowState {
  statusId: string
  flowState: FlowState
}

// ---------------------------------------------------------------------------
// Issue record — lightweight shape for flow computations
// ---------------------------------------------------------------------------

/**
 * Lightweight issue record for flow metric inputs.
 */
export interface FlowIssueRecord {
  id: string
  type: string
  /** The workflow id that governs this issue's transitions. */
  workflowId: string | null
  /** All transitions, sorted ascending by transitionedAt (SPEC C1). */
  transitions: readonly TransitionRecord[]
  /** Current status id — used for Aging WIP. */
  currentStatusId: string
  /** When the issue was created (ISO-8601). */
  createdAt: string
}

// ---------------------------------------------------------------------------
// Board column shape — for cycle-time start boundary
// ---------------------------------------------------------------------------

/**
 * Board column input — specifies which status ids are in a started/done column.
 */
export interface FlowBoardColumn {
  statusIds: readonly string[]
  isStartedCol: boolean
  isDoneCol: boolean
}
