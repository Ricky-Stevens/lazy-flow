import { describe, expect, it } from 'bun:test'
import { meetsSampleFloor } from './sample.js'

describe('meetsSampleFloor', () => {
  it('(19, 0.9) → false', () => {
    expect(meetsSampleFloor(19, 0.9)).toBe(false)
  })

  it('(20, 0.9) → true', () => {
    expect(meetsSampleFloor(20, 0.9)).toBe(true)
  })

  it('(29, 0.95) → false', () => {
    expect(meetsSampleFloor(29, 0.95)).toBe(false)
  })

  it('(30, 0.95) → true', () => {
    expect(meetsSampleFloor(30, 0.95)).toBe(true)
  })

  it('(5, 0.5) → true (floor is 1 for p < 0.9)', () => {
    expect(meetsSampleFloor(5, 0.5)).toBe(true)
  })
})
