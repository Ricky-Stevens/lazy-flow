/**
 * Shared input types for PR / Review metrics (Group C, SPEC §8.3).
 */

// ---------------------------------------------------------------------------
// PR record with all stage timestamps
// ---------------------------------------------------------------------------

/**
 * HALOC-based PR size thresholds (SPEC §8.3).
 * XS: 0–10, S: 11–50, M: 51–200, L: 201–500, XL: >500
 */
export function prSizeBucket(haloc) {
  if (haloc <= 10) return 'XS'
  if (haloc <= 50) return 'S'
  if (haloc <= 200) return 'M'
  if (haloc <= 500) return 'L'
  return 'XL'
}
