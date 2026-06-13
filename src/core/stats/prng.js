/**
 * Deterministic seeded PRNG per SPEC §8.6.
 * Pinned implementation: mulberry32.
 * Ensures Monte Carlo forecasts are reproducible per engine-version + seed —
 * two installs on different Node/arch versions forecast identically.
 * Values are in [0, 1).
 *
 * MUST NOT be replaced with Math.random() in any metric path.
 */
export function createPrng(seed) {
  let s = seed >>> 0

  return function next() {
    s += 0x6d2b79f5
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const result = ((t ^ (t >>> 14)) >>> 0) / 0x100000000
    return result
  }
}
