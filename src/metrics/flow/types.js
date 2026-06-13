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

