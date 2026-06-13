import { describe, expect, it } from 'bun:test'
import { createPrng } from './prng.js'

function firstN(prng, n) {
  return Array.from({ length: n }, () => prng())
}

describe('createPrng', () => {
  it('produces identical first 5 values for the same seed', () => {
    const a = firstN(createPrng(42), 5)
    const b = firstN(createPrng(42), 5)
    expect(a).toEqual(b)
  })

  it('produces different sequences for different seeds', () => {
    const a = firstN(createPrng(1), 5)
    const b = firstN(createPrng(2), 5)
    expect(a).not.toEqual(b)
  })

  it('all values are in [0, 1)', () => {
    const values = firstN(createPrng(99), 1000)
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
