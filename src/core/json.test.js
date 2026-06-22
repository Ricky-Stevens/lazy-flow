/**
 * Tests for safeJsonParse — focusing on the primitive-payload guard introduced
 * to prevent crashes when a stored JSON payload is a JSON primitive (null,
 * number, string) but the caller expects an object.
 */

import { describe, expect, it } from 'bun:test'
import { safeJsonParse } from './json.js'

describe('safeJsonParse', () => {
  it('parses a valid JSON object', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
  })

  it('returns the fallback on a parse error', () => {
    expect(safeJsonParse('not json', {})).toEqual({})
  })

  it('returns the fallback for null raw', () => {
    expect(safeJsonParse(null, {})).toEqual({})
  })

  it('returns the fallback for undefined raw', () => {
    expect(safeJsonParse(undefined, { x: 1 })).toEqual({ x: 1 })
  })

  // Primitive-payload guard: JSON.parse('null') / JSON.parse('"x"') succeed but
  // return a non-object; callers expecting an object would crash on property access.
  it('returns object fallback when stored payload is JSON null', () => {
    expect(safeJsonParse('null', {})).toEqual({})
  })

  it('returns object fallback when stored payload is a JSON string', () => {
    expect(safeJsonParse('"x"', { title: '' })).toEqual({ title: '' })
  })

  it('returns object fallback when stored payload is a JSON number', () => {
    expect(safeJsonParse('42', {})).toEqual({})
  })

  it('returns object fallback when stored payload is a JSON boolean', () => {
    expect(safeJsonParse('true', {})).toEqual({})
  })

  // Callers that explicitly pass null as fallback (e.g. coauthors.js) should
  // still get the primitive back — the guard only fires when fallback is a
  // non-null object.
  it('returns the parsed primitive when fallback is null (opt-in behaviour)', () => {
    expect(safeJsonParse('null', null)).toBeNull()
    expect(safeJsonParse('"hello"', null)).toBe('hello')
  })

  it('parses a valid JSON array', () => {
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3])
  })
})
