/**
 * WP-SCRUB — ingest-time payload sanitiser (SPEC §6.5, §11 WP-SCRUB).
 *
 * scrubFreeText(text)       — redact secrets and emails from a free-text string.
 * scrubRawPayload(obj, allowlist) — keep only allowed fields on an object, then
 *                                   scrub any string values in those fields.
 *
 * Detected patterns (in order):
 *   1. AWS access-key IDs          — AKIA[0-9A-Z]{16}
 *   2. GitHub tokens                — ghp_*, gho_*, ghs_*, ghu_*, github_pat_*
 *   3. Slack tokens                 — xox[aboprs]-[A-Za-z0-9\-]+
 *   4. JSON Web Tokens              — three base64url segments separated by dots
 *   5. Generic high-entropy strings — [A-Za-z0-9_\-]{32,} (entropy ≥ 3.5 bits/char)
 *   6. Email addresses              — addr@domain.tld
 *
 * Pattern 5 uses Shannon entropy to avoid redacting long but low-entropy strings
 * (e.g. repeated test IDs). Threshold is empirically tuned; see tests.
 *
 * Replacements:
 *   emails  → [REDACTED_EMAIL]
 *   secrets → [REDACTED_SECRET]
 */

// ---------------------------------------------------------------------------
// Entropy helper
// ---------------------------------------------------------------------------

/** Shannon entropy in bits per character. */
function shannonEntropy(s) {
  const freq = new Map()
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  let h = 0
  for (const count of freq.values()) {
    const p = count / s.length
    h -= p * Math.log2(p)
  }
  return h
}

// ---------------------------------------------------------------------------
// Regex catalogue
// ---------------------------------------------------------------------------

// AWS access-key IDs: AKIA followed by 16 uppercase letters/digits.
const RE_AWS_KEY = /AKIA[0-9A-Z]{16}/g

// GitHub tokens: various prefixes.
const RE_GITHUB_TOKEN = /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{10,}\b/g

// Slack tokens: xox followed by a type letter and a hyphenated string.
const RE_SLACK_TOKEN = /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g

// JSON Web Tokens: three base64url segments.
const RE_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g

// Generic high-entropy alphanumeric strings (≥32 chars). We check entropy
// post-match to avoid redacting long test fixture IDs like 'aaaaaa…'.
const RE_HIGH_ENTROPY = /[A-Za-z0-9_-]{32,}/g

// Email addresses. Quantifiers are bounded and the domain labels exclude the
// dot separator (matched explicitly) so there is no ambiguous split between a
// repeated class and the following literal dot — that ambiguity caused
// quadratic catastrophic backtracking (ReDoS) on adversarial free text such as
// `a@` + `a.`.repeat(n). With every quantifier bounded, per-start-position work
// is constant, so matching is linear in input length. Bounds comfortably cover
// RFC 5321 limits (local ≤64, label ≤63, ≤8 labels, TLD ≤24).
const RE_EMAIL = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g

const HIGH_ENTROPY_THRESHOLD = 3.5

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact secret patterns and email addresses from a free-text string.
 *
 * The function is idempotent — running it twice produces the same output.
 * It replaces in order: named patterns first (most specific), then emails,
 * then generic high-entropy strings.
 */
export function scrubFreeText(text) {
  // Replace named secret patterns first (most specific, no entropy check).
  let out = text
    .replace(RE_AWS_KEY, '[REDACTED_SECRET]')
    .replace(RE_GITHUB_TOKEN, '[REDACTED_SECRET]')
    .replace(RE_SLACK_TOKEN, '[REDACTED_SECRET]')
    .replace(RE_JWT, '[REDACTED_SECRET]')

  // Emails before the generic pass so they don't get caught by RE_HIGH_ENTROPY.
  out = out.replace(RE_EMAIL, '[REDACTED_EMAIL]')

  // Generic high-entropy strings: only redact when Shannon entropy is high
  // enough to indicate a token rather than a human-readable identifier.
  out = out.replace(RE_HIGH_ENTROPY, (match) => {
    // Skip if already a placeholder (idempotency).
    if (match.startsWith('[REDACTED')) return match
    return shannonEntropy(match) >= HIGH_ENTROPY_THRESHOLD ? '[REDACTED_SECRET]' : match
  })

  return out
}

/**
 * Sanitise a raw API payload object before it is serialised to the store.
 *
 * Only the fields named in `fieldAllowlist` are retained; all others are
 * dropped. String values in the retained fields are passed through
 * `scrubFreeText`. Non-string primitive values are kept as-is.
 *
 * Returns a plain object (never null/undefined) suitable for JSON.stringify.
 *
 * @param obj           - The raw API response object (or any unknown value).
 * @param fieldAllowlist - Field names to retain. Drop everything else.
 */
export function scrubRawPayload(obj, fieldAllowlist) {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    return {}
  }
  const record = obj
  const result = {}
  for (const field of fieldAllowlist) {
    if (!(field in record)) continue
    const value = record[field]
    result[field] = typeof value === 'string' ? scrubFreeText(value) : value
  }
  return result
}
