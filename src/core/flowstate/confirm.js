// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Confidence threshold above which a mapping is considered "high confidence"
 * and does not need to appear in the confirm queue.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.75

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of flow-state mappings for a workflow that are unconfirmed
 * and below the high-confidence threshold — i.e., mappings that need a human
 * to verify or override before they are used in production metrics.
 *
 * Only the currently-active row (valid_to IS NULL) is returned; historical
 * rows that have already been superseded are excluded.
 *
 * @param store      - Store to query.
 * @param workflowId - Workflow to inspect.
 */
export async function listPendingConfirmations(store, workflowId) {
  const models = await store.getFlowStateModelsByWorkflow(workflowId)

  return models
    .filter(
      (m) =>
        m.validTo === null && // currently active row only
        m.confirmedBy === null && // not yet confirmed
        m.confidence < HIGH_CONFIDENCE_THRESHOLD,
    )
    .map((m) => ({
      workflowId: m.workflowId,
      statusId: m.statusId,
      flowState: m.flowState,
      confidence: m.confidence,
      validFrom: m.validFrom,
    }))
}

/**
 * Confirm the current mapping for a (workflowId, statusId) pair without
 * changing the flow_state.
 *
 * Records `confirmedBy` and `confirmedAt` on the existing open row (no new
 * row is inserted — the classification itself does not change, so effective-
 * dating is unchanged).
 *
 * Throws if no currently-open row exists for the pair.
 */
export async function confirmFlowState(store, options) {
  const { workflowId, statusId, confirmedBy } = options
  const confirmedAt = options.confirmedAt ?? new Date().toISOString()

  const current = await store.getFlowStateModel(workflowId, statusId)
  if (!current) {
    throw new Error(
      `No active flow_state_models row found for workflow=${workflowId} status=${statusId}`,
    )
  }

  // Update the existing row in place (same valid_from → upsert overwrites it).
  await store.upsertFlowStateModel({ ...current, confirmedBy, confirmedAt })
}

/**
 * Override the flow_state for a (workflowId, statusId) pair.
 *
 * Inserts a new effective-dated row superseding the current open row (the old
 * row's valid_to is set to the new row's valid_from). Past rows are never
 * rewritten — CFD replay that references historical intervals will still see
 * the old classification.
 *
 * Throws if no currently-open row exists for the pair.
 */
export async function overrideFlowState(store, options) {
  const { workflowId, statusId, flowState, confirmedBy } = options
  const validFrom = options.validFrom ?? new Date().toISOString()

  const current = await store.getFlowStateModel(workflowId, statusId)
  if (!current) {
    throw new Error(
      `No active flow_state_models row found for workflow=${workflowId} status=${statusId}`,
    )
  }

  // Close the current open row.
  await store.upsertFlowStateModel({ ...current, validTo: validFrom })

  // Insert the new override row with full confidence (human-confirmed).
  const newRow = {
    workflowId,
    statusId,
    flowState,
    confidence: 1.0,
    confirmedBy,
    confirmedAt: validFrom,
    validFrom,
    validTo: null,
  }
  await store.upsertFlowStateModel(newRow)
}
