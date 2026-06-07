import { describe, expect, it } from 'vitest'
import { safeRatio } from './ratio.js'

describe('safeRatio', () => {
  it('returns null when denominator is 0 (0/0)', () => {
    expect(safeRatio(0, 0)).toBeNull()
  })

  it('returns null when denominator is 0 (1/0)', () => {
    expect(safeRatio(1, 0)).toBeNull()
  })

  it('returns 0.75 for (3, 4)', () => {
    expect(safeRatio(3, 4)).toBe(0.75)
  })

  it('returns 0 for (0, 5)', () => {
    expect(safeRatio(0, 5)).toBe(0)
  })

  it('returns null for a NaN numerator (never propagates NaN)', () => {
    expect(safeRatio(Number.NaN, 5)).toBeNull()
  })

  it('returns null for non-finite denominator', () => {
    expect(safeRatio(5, Number.POSITIVE_INFINITY)).toBeNull()
  })
})
