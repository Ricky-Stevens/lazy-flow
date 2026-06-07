/**
 * Keyed-HMAC pseudonymisation (SPEC §6.5, WP-GDPR-SCAFFOLD).
 *
 * A plain unsalted hash of a low-entropy corporate email is reversed by
 * dictionary attack in milliseconds and is NOT anonymisation (GDPR Recital 26).
 *
 * pseudonymize(value, key) uses HMAC-SHA256 with a caller-supplied key that
 * MUST live only in the OS keychain or environment — never in the DB or repo.
 * The output is deterministic given the same key, making it suitable for
 * joining/grouping; a different key produces a different output, so the data
 * cannot be re-identified without the key.
 *
 * Key sourcing: pass the key as a Buffer or hex string.  In practice, read it
 * from process.env.LAZY_FLOW_PSEUDONYM_KEY (populated by the OS keychain
 * integration in WP-MCP-SERVER) — never hard-code or persist it.
 */

import { createHmac } from 'node:crypto'

/**
 * Produce a deterministic HMAC-SHA256 pseudonym for `value`.
 *
 * @param value - The plaintext to pseudonymise (e.g. email, accountId).
 * @param key   - The HMAC key as a hex string or Buffer.
 *                MUST NOT be stored in the DB or repo.
 * @returns Lowercase hex digest (64 chars).
 */
export function pseudonymize(value: string, key: string | Buffer): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex')
}
