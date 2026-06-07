/**
 * Flow State Model — implicit-wait fallback.
 *
 * Guarantees that downstream Flow metrics NEVER read an empty flow_state_models
 * table for a workflow. For any (workflowId, statusId) pair that has no active
 * row, this module derives a deterministic low-confidence default mapping and
 * persists it.
 *
 * The fallback heuristic is identical to the deterministic seed heuristic in
 * seed.ts (category → name patterns), but ALWAYS produces a row with:
 *   - confidence ≤ 0.45  (flagged low-confidence)
 *   - confirmedBy = null  (unconfirmed)
 *
 * This means any unconfirmed workflow will produce output, but the confidence
 * score signals to callers / the metrics layer that the mapping has not been
 * reviewed.
 *
 * --- Hook for the metrics layer ---
 * Detecting *implicit wait* from assignee gaps, blocked-flag activity, or
 * no-activity windows is the metrics package's job (WP-METRICS-FLOW). This
 * module provides the safe default mapping. When WP-METRICS-FLOW detects an
 * implicit-wait signal, it should call `overrideFlowState` (confirm.ts) with
 * a `confirmedBy` of `'__implicit_wait__'` and a lower confidence (e.g. 0.60)
 * to record the detection without requiring human review. That override then
 * becomes part of the effective-dated history.
 *
 * SPEC §6.2, WP-FLOWSTATE-MODEL (fallback parts).
 */

import type { Store } from '../store/Store.js'
import { classifyStatus, type StatusInput } from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnsureFallbackMappingOptions {
  /** ISO-8601 timestamp for valid_from on any newly inserted rows. */
  validFrom?: string
}

export interface EnsureFallbackMappingResult {
  /** Number of statuses checked. */
  total: number
  /** Number of new fallback rows inserted (statuses that had no active row). */
  inserted: number
}

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
export async function ensureFallbackMapping(
  store: Store,
  workflowId: string,
  statuses: StatusInput[],
  options?: EnsureFallbackMappingOptions,
): Promise<EnsureFallbackMappingResult> {
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
