/**
 * Subject erasure helper (SPEC §11.2, WP-GDPR-SCAFFOLD).
 *
 * erasePerson(store, personId) cascade-removes a person's identities and
 * nullifies their attributable rows (person_id FKs), non-destructive to
 * team aggregates already snapshotted as aggregate-scope rows.
 *
 * The actual implementation lives in Store.erasePerson() so it can be done
 * atomically per-backend. This module is a thin, documented façade.
 */

import type { Store } from '../store/Store.js'

export interface ErasePersonResult {
  /** The person ID that was erased. */
  personId: string
  /** Identity IDs whose person_id FK was severed. */
  erasedIdentityIds: string[]
}

/**
 * Erase a data subject (GDPR Art. 17).
 *
 * Removes the person record, severs their identity links, and removes their
 * team-membership rows. Metric snapshots scoped to teams/orgs that incidentally
 * covered this person are NOT removed — those are aggregate-only and contain
 * no individual attribution after erasure.
 *
 * @param store    - The store instance to operate on.
 * @param personId - The internal person ID to erase.
 */
export async function erasePerson(store: Store, personId: string): Promise<ErasePersonResult> {
  const { erasedIdentityIds } = await store.erasePerson(personId)
  return { personId, erasedIdentityIds }
}
