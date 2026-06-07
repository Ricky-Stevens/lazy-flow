/**
 * safeRatio — determinism primitive per SPEC §8.6.
 * Every ratio in the metric engine MUST use this function so that a zero
 * denominator always returns null (rendered "N/A"), never NaN or Infinity.
 */
export function safeRatio(numerator: number, denominator: number): number | null {
  // Guard the full non-finite surface, not just denominator===0: a NaN/±Infinity
  // numerator or denominator (e.g. from an unparseable date diff upstream) would
  // otherwise propagate a NaN/Infinity ratio, violating the "never NaN/Infinity"
  // contract this primitive exists to enforce.
  if (denominator === 0) return null
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  return numerator / denominator
}
