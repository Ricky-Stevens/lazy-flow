/**
 * safeJsonParse — guarded JSON.parse for stored raw payloads.
 *
 * Stored `raw` payloads (commits, PRs, identities, Jira issues, structured
 * verdicts, etc.) can be malformed under the full-transparency contract: the
 * SQLite file is intentionally user-writable, payloads can be hand-edited or
 * partially scrubbed, and ingest writes can be interrupted mid-flight. A
 * single bad payload must not crash a metric read or a stitching pass —
 * degrade to the caller-provided `fallback` instead. The smaller resulting
 * sample is handled honestly by the SPEC §8.6 sample floors; a thrown
 * exception is not.
 *
 * Centralised here so the suppression rationale is justified ONCE (the
 * project's hard "no silent catch without a comment" rule) rather than
 * scattered across every parse site.
 *
 * @template T
 * @param {unknown} raw - the raw value to parse; coerced via String() so a
 *   typed-row `Uint8Array`/`number` from sqlite is handled the same as a string.
 * @param {T} [fallback={}] - the value returned when `raw` is missing or
 *   unparseable. Caller is responsible for passing the shape its downstream
 *   code expects (e.g. `null`, `{ title: '', body: '' }`).
 * @returns {T | any} the parsed value, or `fallback` on failure.
 */
export function safeJsonParse(raw, fallback = {}) {
  if (raw === null || raw === undefined) return fallback
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    // Guard: if the caller expects an object/array (non-null object fallback) but
    // the stored payload is a JSON primitive (null, number, string, boolean),
    // return the fallback instead of propagating a value whose property accesses
    // would throw or silently return undefined.
    if (
      fallback !== null &&
      typeof fallback === 'object' &&
      (v === null || typeof v !== 'object')
    ) {
      return fallback
    }
    return v
  } catch {
    return fallback
  }
}
