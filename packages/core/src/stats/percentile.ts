/**
 * Percentile computation per SPEC §8.6.
 * Uses type-7 / R-7 linear interpolation (NumPy default / Excel PERCENTILE.INC)
 * so that two installs on identical data always produce the same p75/p90/p95.
 */

/**
 * Compute the p-th percentile of a set of values using type-7 / R-7
 * linear interpolation. Returns null for an empty input.
 * Throws RangeError if p is outside [0, 1].
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (p < 0 || p > 1) throw new RangeError(`p must be in [0, 1], got ${p}`)

  // Drop non-finite values (NaN/±Infinity) before sorting. `(a, b) => a - b`
  // yields NaN for any comparison involving NaN, which leaves Array.sort in an
  // unspecified, input-order-dependent order — directly breaking the §8.6
  // guarantee that identical data produces identical p75/p90/p95. Filtering is
  // deterministic (same input → same filtered set → same result).
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return null

  if (n === 1) return sorted[0] ?? null

  const h = (n - 1) * p
  const lower = Math.floor(h)
  const lo = sorted[lower]
  const hi = sorted[lower + 1]

  if (lo === undefined) return null
  if (hi === undefined) return lo

  return lo + (h - lower) * (hi - lo)
}

/**
 * Compute a standard set of quantiles (p50, p75, p85, p90, p95) in one pass.
 * Returns null for an empty input.
 */
export function quantiles(
  values: readonly number[],
): { p50: number; p75: number; p85: number; p90: number; p95: number } | null {
  // Filter once so the empty-after-filtering case returns null rather than a
  // record of nulls masquerading as numbers.
  const clean = values.filter(Number.isFinite)
  if (clean.length === 0) return null
  return {
    p50: percentile(clean, 0.5) as number,
    p75: percentile(clean, 0.75) as number,
    p85: percentile(clean, 0.85) as number,
    p90: percentile(clean, 0.9) as number,
    p95: percentile(clean, 0.95) as number,
  }
}
