#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// query_db child process.
//
// Runs exactly ONE read-only query against a SEPARATE read-only connection to
// the on-disk DB, then exits. The PARENT (server.js) spawns this with
// Bun.spawn({ timeout, killSignal: 'SIGKILL' }), so a query that runs away —
// e.g. an accidental cartesian/fan-out JOIN that grinds inside a single native
// sqlite3_step() — is force-killed at the deadline. A worker thread could NOT
// guarantee this (terminate() can't interrupt an in-flight native call); only a
// separate OS process can be SIGKILL'd unconditionally. The long-lived MCP
// server process is never touched and stays responsive to every other tool.
//
// Protocol: read a JSON request from stdin, write a JSON result to stdout.
//   in:  { dbPath, sql, params, maxRows, maxBytes, scanThreshold }
//   out: { ok: true, columns, rows, truncated } | { ok: false, error }
// ---------------------------------------------------------------------------
import { Database } from 'bun:sqlite'

import {
  assertIndexedPlan,
  assertReadOnlyQuery,
  QueryDbError,
  runBudgetedQuery,
} from './queryGuard.js'

async function main() {
  const raw = await Bun.stdin.text()
  let req
  try {
    req = JSON.parse(raw)
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: `bad request: ${String(err)}` }))
    return
  }

  const { dbPath, sql, params = [], maxRows, maxBytes, scanThreshold } = req
  let db = null
  try {
    // Defense in depth — the parent already validated, but never trust input.
    assertReadOnlyQuery(sql)
    db = new Database(dbPath, { readonly: true })
    // The readonly flag already rejects writes; query_only pins the guarantee on
    // a second, independent mechanism.
    db.exec('PRAGMA query_only = ON')
    assertIndexedPlan(db, sql, params, { threshold: scanThreshold })
    const out = runBudgetedQuery(db, sql, params, { maxRows, maxBytes })
    process.stdout.write(JSON.stringify({ ok: true, ...out }))
  } catch (err) {
    const message = err instanceof QueryDbError ? err.message : `query failed: ${String(err)}`
    process.stdout.write(JSON.stringify({ ok: false, error: message }))
  } finally {
    db?.close()
  }
}

await main()
