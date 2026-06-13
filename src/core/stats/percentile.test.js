import { describe, expect, it } from 'bun:test'
import { percentile, quantiles } from './percentile.js'

describe('percentile (type-7 / R-7)', () => {
  it('returns null for empty array', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('returns the single element for a one-element array', () => {
    expect(percentile([42], 0.5)).toBe(42)
  })

  it('throws RangeError when p < 0', () => {
    expect(() => percentile([1, 2], -0.1)).toThrow(RangeError)
  })

  it('throws RangeError when p > 1', () => {
    expect(() => percentile([1, 2], 1.1)).toThrow(RangeError)
  })

  // Golden assertions for [1..10]
  const tenValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('p50 of [1..10] → 5.5', () => {
    expect(percentile(tenValues, 0.5)).toBe(5.5)
  })

  it('p75 of [1..10] → 7.75', () => {
    expect(percentile(tenValues, 0.75)).toBe(7.75)
  })

  it('p90 of [1..10] → 9.1', () => {
    expect(percentile(tenValues, 0.9)).toBeCloseTo(9.1, 10)
  })

  it('p100 (1.0) of [1..10] → 10', () => {
    expect(percentile(tenValues, 1.0)).toBe(10)
  })

  it('p0 of [1..10] → 1', () => {
    expect(percentile(tenValues, 0)).toBe(1)
  })

  // Regression: NaN/±Infinity must not corrupt the sort or produce
  // order-dependent quantiles (§8.6 determinism).
  it('ignores non-finite values and is order-independent', () => {
    const a = percentile([5, Number.NaN, 1, 3, 2], 0.5)
    const b = percentile([Number.NaN, 2, 1, 5, 3], 0.5)
    // Equivalent to percentile([1,2,3,5], 0.5) = 2.5 regardless of input order.
    expect(a).toBe(2.5)
    expect(b).toBe(2.5)
  })

  it('drops Infinity values', () => {
    expect(percentile([1, 2, 3, Number.POSITIVE_INFINITY], 1.0)).toBe(3)
  })

  it('returns null when every value is non-finite', () => {
    expect(percentile([Number.NaN, Number.POSITIVE_INFINITY], 0.5)).toBeNull()
  })
})

describe('quantiles', () => {
  it('returns null for empty array', () => {
    expect(quantiles([])).toBeNull()
  })

  it('computes all quantiles for [1..10]', () => {
    const result = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(result).not.toBeNull()
    expect(result?.p50).toBe(5.5)
    expect(result?.p75).toBe(7.75)
    expect(result?.p90).toBeCloseTo(9.1, 10)
  })
})
