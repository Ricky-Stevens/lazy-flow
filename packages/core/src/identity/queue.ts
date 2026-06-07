/**
 * Human-confirm queue API for identity stitching (SPEC §6.3 WP-IDENTITY).
 *
 * Provides a thin wrapper over the Store's candidate_match methods so the
 * calling layer doesn't need to import Store directly for queue operations.
 */

import type { Store } from '../store/Store.js'
import type { CandidateMatch } from './types.js'

export interface QueueListOptions {
  /** Filter by status; omit to return all. */
  status?: CandidateMatch['status']
}

/**
 * List pending (or all) candidate matches from the human-confirm queue.
 */
export async function listCandidateMatches(
  store: Store,
  options: QueueListOptions = {},
): Promise<CandidateMatch[]> {
  return store.getCandidateMatches(options.status ?? 'pending')
}

/**
 * Confirm a candidate match.
 *
 * Merges both identities under the same person (the person already linked to
 * either identity, or one must exist). The merge is audited and reversible:
 * setting the identity's person_id to null effectively un-merges it.
 *
 * @param id         The candidate match id.
 * @param decidedBy  Identifier of the human who confirmed (e.g. GitHub login).
 * @param now        ISO timestamp (default: current time).
 */
export async function confirmCandidateMatch(
  store: Store,
  id: string,
  decidedBy: string,
  now?: string,
): Promise<void> {
  const decidedAt = now ?? new Date().toISOString()
  await store.resolveCandidateMatch(id, 'confirmed', decidedBy, decidedAt)
}

/**
 * Reject a candidate match (suppresses it from the queue permanently).
 *
 * The identities remain separate persons. The rejection is audited so the
 * same pair is not re-queued by a future stitchPersons run.
 */
export async function rejectCandidateMatch(
  store: Store,
  id: string,
  decidedBy: string,
  now?: string,
): Promise<void> {
  const decidedAt = now ?? new Date().toISOString()
  await store.resolveCandidateMatch(id, 'rejected', decidedBy, decidedAt)
}

/**
 * Un-merge two identities that were previously confirmed as the same person.
 *
 * This is non-destructive: it sets the person_id of the "secondary" identity
 * back to null so it is effectively de-linked. The "secondary" is determined
 * as the less-anchored identity (commit_email first; if both equal, identityIdB).
 * The person record for the primary anchor is retained.
 *
 * The merge audit record in candidate_matches is NOT modified (preserves history).
 */
export async function unmergeIdentities(
  store: Store,
  matchId: string,
  now?: string,
): Promise<void> {
  const match = await store.getCandidateMatch(matchId)
  if (!match) throw new Error(`CandidateMatch not found: ${matchId}`)
  if (match.status !== 'confirmed') {
    throw new Error(`CandidateMatch ${matchId} is not confirmed — cannot un-merge`)
  }

  const updatedAt = now ?? new Date().toISOString()

  // Find both identities
  const identities = await store.listAllIdentities()
  const identityA = identities.find((id) => id.id === match.identityIdA)
  const identityB = identities.find((id) => id.id === match.identityIdB)

  // Determine which to de-link: prefer to de-link the commit_email (less-anchored).
  // Anchor strength order (highest first): github_login = jira_account > commit_email.
  function anchorStrength(identity: { kind: string }): number {
    if (identity.kind === 'commit_email') return 0
    return 1
  }

  let toDelink = identityB // default: de-link the lexicographically-second one
  if (identityA && identityB) {
    if (anchorStrength(identityA) > anchorStrength(identityB)) {
      toDelink = identityB
    } else if (anchorStrength(identityB) > anchorStrength(identityA)) {
      toDelink = identityA
    }
    // If equal strength, keep default (identityB)
  }

  if (toDelink) {
    await store.upsertIdentity({ ...toDelink, personId: null, updatedAt })
  }
}
