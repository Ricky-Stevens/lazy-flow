import { classifyStatus } from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure every (workflowId, statusId) pair in `statuses` has an active
 * flow_state_models row.
 *
 * For each status that has no currently-active row (i.e. `getFlowStateModel`
 * returns null), inserts a low-confidence deterministic default derived from
 * the category + name heuristic in seed.ts.
 *
 * Statuses that already have an active row are left unchanged — this function
 * never supersedes confirmed or seeded mappings.
 *
 * @param store      - Store to query and write into.
 * @param workflowId - Jira workflow id.
 * @param statuses   - All statuses that belong to this workflow.
 * @param options    - Optional valid_from override.
 */
export async function ensureFallbackMapping(store, workflowId, statuses, options) {
  const validFrom = options?.validFrom ?? new Date().toISOString()

  let inserted = 0

  for (const status of statuses) {
    const existing = await store.getFlowStateModel(workflowId, status.id)
    if (existing !== null) {
      // Already has an active mapping — do not overwrite.
      continue
    }

    // Derive a deterministic but low-confidence default.
    const classified = classifyStatus(status)

    // Cap confidence to ensure it stays in the "needs confirmation" range.
    // classifyStatus returns at most 0.95 for category-derived results, but
    // the fallback path is only reached when no prior row exists, meaning the
    // workflow was never seeded — so confidence should always be low here.
    const confidence = Math.min(classified.confidence, 0.45)

    await store.upsertFlowStateModel({
      workflowId,
      statusId: status.id,
      flowState: classified.flowState,
      confidence,
      confirmedBy: null,
      confirmedAt: null,
      validFrom,
      validTo: null,
    })
    inserted++
  }

  return { total: statuses.length, inserted }
}
