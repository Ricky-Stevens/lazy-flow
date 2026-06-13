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
export async function assertOrgBound(store, orgId) {
  await store.assertOrgBound(orgId)
}
