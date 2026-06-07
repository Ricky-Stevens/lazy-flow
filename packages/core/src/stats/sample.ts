/**
 * Sample-floor primitives per SPEC §8.6.
 * Minimum sample sizes for percentile computation — below floor, the metric
 * engine MUST return data_quality='insufficient_sample' rather than a number.
 */

export type DataQuality = 'ok' | 'no_data' | 'insufficient_sample'

/**
 * Minimum sample sizes by percentile tier.
 * n >= 20 for p90; n >= 30 for p95.
 */
export const SAMPLE_FLOORS = {
  p90: 20,
  p95: 30,
} as const

/**
 * Returns the minimum sample floor for a given percentile value p.
 * p >= 0.95 → 30; p >= 0.90 → 20; else 1.
 */
export function sampleFloorFor(p: number): number {
  if (p >= 0.95) return SAMPLE_FLOORS.p95
  if (p >= 0.9) return SAMPLE_FLOORS.p90
  return 1
}

/**
 * Returns true when the sample size n meets the floor for percentile p.
 */
export function meetsSampleFloor(n: number, p: number): boolean {
  return n >= sampleFloorFor(p)
}
