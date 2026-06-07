/**
 * Org-bound DB guard (SPEC §6.5, WP-GDPR-SCAFFOLD).
 *
 * assertOrgBound(store, orgId) hard-errors when the store already contains
 * data for a different org. This prevents one install from mixing two clients'
 * repositories — a critical control where an operator might configure a second
 * Jira cloud ID into an existing DB.
 *
 * The actual SQL lives in Store.assertOrgBound() so the check is atomic.
 */

import type { Store } from '../store/Store.js'

/**
 * Assert that this store is bound to `orgId` only.
 *
 * Throws if the store already contains organisations with a different ID.
 * Safe to call on every sync init; no-ops when the store is empty or already
 * bound to `orgId`.
 *
 * @param store - The store instance to check.
 * @param orgId - The organisation ID this install should be bound to.
 */
export async function assertOrgBound(store: Store, orgId: string): Promise<void> {
  await store.assertOrgBound(orgId)
}
