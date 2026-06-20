/**
 * Unit tests for the query_db guard rails (queryGuard.js).
 *
 * These cover the pure validation/budget/plan logic shared by the MCP server and
 * the queryRunner child process. The end-to-end timeout + subprocess behaviour
 * is covered in server.test.js ("query_db (on-disk, isolated)").
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  assertIndexedPlan,
  assertReadOnlyQuery,
  QueryDbError,
  runBudgetedQuery,
} from './queryGuard.js'

describe('assertReadOnlyQuery', () => {
  it('accepts a plain SELECT and a WITH (CTE)', () => {
    expect(() => assertReadOnlyQuery('SELECT 1')).not.toThrow()
    expect(() => assertReadOnlyQuery('WITH x AS (SELECT 1 AS n) SELECT n FROM x')).not.toThrow()
  })

  it('rejects DML / DDL / PRAGMA, even disguised after a WITH', () => {
    expect(() => assertReadOnlyQuery('DELETE FROM t WHERE id = 1')).toThrow(QueryDbError)
    expect(() => assertReadOnlyQuery('WITH x AS (SELECT 1) INSERT INTO t VALUES (1)')).toThrow(
      /INSERT/,
    )
    expect(() => assertReadOnlyQuery('PRAGMA writable_schema = ON')).toThrow(QueryDbError)
  })

  it('rejects multiple statements', () => {
    expect(() => assertReadOnlyQuery('SELECT 1; SELECT 2')).toThrow(/Multiple statements/)
  })

  it('allows a forbidden keyword that appears only inside a string literal', () => {
    expect(() => assertReadOnlyQuery("SELECT * FROM t WHERE name = 'DELETE'")).not.toThrow()
  })
})

describe('runBudgetedQuery', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('caps row count and flags truncation', () => {
    const sql =
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 10) SELECT n FROM c'
    const out = runBudgetedQuery(db, sql, [], { maxRows: 3 })
    expect(out.rows.length).toBe(3)
    expect(out.truncated).toBe(true)
    expect(out.columns).toEqual(['n'])
  })

  it('caps output by byte budget on a single wide row', () => {
    const out = runBudgetedQuery(db, 'SELECT hex(randomblob(100000)) AS big', [], {
      maxRows: 1000,
      maxBytes: 1000,
    })
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBe(0)
  })
})

describe('assertIndexedPlan', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = db.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
    for (let i = 1; i <= 5; i++) insert.run(i, `row${i}`)
  })

  it('rejects a full scan of a table over the row threshold', () => {
    // threshold 2, table has 5 rows, SELECT * is a full SCAN with no index.
    expect(() => assertIndexedPlan(db, 'SELECT * FROM t', [], { threshold: 2 })).toThrow(
      /full-scan large table "t"/,
    )
  })

  it('allows an indexed lookup even over the threshold', () => {
    // PK lookup → SEARCH USING INTEGER PRIMARY KEY, not a full scan.
    expect(() =>
      assertIndexedPlan(db, 'SELECT v FROM t WHERE id = ?', [3], { threshold: 2 }),
    ).not.toThrow()
  })

  it('allows a full scan of a small table (under threshold)', () => {
    expect(() => assertIndexedPlan(db, 'SELECT * FROM t', [], { threshold: 1000 })).not.toThrow()
  })

  it('does not block on an unparseable query (lets the executor surface it)', () => {
    expect(() => assertIndexedPlan(db, 'SELECT FROM WHERE', [], { threshold: 1 })).not.toThrow()
  })
})
