// ---------------------------------------------------------------------------
// query_db guard rails — shared by the MCP server (in-process for :memory:) and
// the queryRunner child process (on-disk). Pure logic, no SDK/transport deps so
// the child can import it cheaply.
//
// Threat model, in priority order:
//   1. RUNAWAY COMPUTE — a query that returns few rows but costs enormous work
//      (e.g. a cartesian/fan-out JOIN feeding COUNT(DISTINCT)). The OLD guards
//      only bounded OUTPUT size (rows/bytes), so such a query sailed through and
//      pegged the single-threaded server for hours. The real backstop now is
//      OUT-OF-PROCESS execution with a hard SIGKILL timeout (see queryRunner.js
//      / server.js). This module adds a cheap pre-flight that rejects the common
//      foot-gun — a full table scan of a LARGE table with no index — before any
//      work happens, so "use the indexes" is enforced, not hoped for.
//   2. WRITES — only SELECT/WITH may run; every write/DDL/PRAGMA keyword is
//      rejected statically AND the connection is opened read-only + query_only.
//   3. WIDE OUTPUT — a row/byte budget caps the response so one wide row can't
//      OOM the consumer.
// ---------------------------------------------------------------------------

export const QUERY_DB_DEFAULT_MAX_ROWS = 1000
export const QUERY_DB_HARD_CAP_ROWS = 5000
// Cumulative output-bytes budget for a single response. max_rows bounds row
// COUNT but not WIDTH; without this a single wide row (a multi-MB blob column or
// `hex(randomblob(...))`) can exhaust memory. ~16 MB is generous for legitimate
// analysis output yet caps the wide-row attack.
export const QUERY_DB_MAX_BYTES = 16 * 1024 * 1024
// Hard wall-clock ceiling for a single on-disk query. The child process is
// SIGKILL'd at this deadline regardless of what native SQLite call it is stuck
// in — the guarantee that a runaway can never again wedge the server for hours.
export const QUERY_DB_TIMEOUT_MS = 10_000
// A full table scan (no index) is fine for small tables (instant) but is the
// classic source of slow queries on large ones. Above this row count, a planned
// full scan is rejected with guidance to add an indexed filter.
export const LARGE_SCAN_ROW_THRESHOLD = 100_000

/** Keywords that must never appear as statements in a read-only query. */
export const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'CREATE',
  'ALTER',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'TRUNCATE',
]

/** Thrown when a query_db request fails validation; message is safe to return. */
export class QueryDbError extends Error {}

/**
 * Strip SQL comments (-- line and block) and surrounding whitespace so we can
 * inspect the real first keyword and statement structure.
 */
export function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
}

/**
 * Blank out the CONTENTS of string literals and quoted identifiers (length is
 * preserved; delimiters are kept) so the keyword/semicolon read-only checks scan
 * only real SQL, not data. Without this, a legitimate read query like
 * `SELECT * WHERE name = 'DELETE'` or `... LIKE '%;%'` is wrongly rejected.
 * Operates on already-comment-stripped SQL. SQLite escapes a quote by doubling
 * it ('' / "" / ``), which is handled by staying inside the quoted run. Masking
 * only ever HIDES characters from the scan, so it can never let a real write
 * keyword/extra statement that sits OUTSIDE quotes slip through.
 */
export function maskSqlLiterals(sql) {
  let out = ''
  let quote = null // active closing delimiter: "'", '"', '`', or ']'
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) {
        if (quote !== ']' && sql[i + 1] === quote) {
          out += '  '
          i++
        } else {
          quote = null
          out += ch
        }
      } else {
        out += ' '
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
    } else if (ch === '[') {
      quote = ']'
      out += ch
    } else {
      out += ch
    }
  }
  return out
}

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement. Throws
 * QueryDbError with a specific reason on any violation.
 */
export function assertReadOnlyQuery(sql) {
  const stripped = stripSqlComments(sql)
  if (stripped.length === 0) {
    throw new QueryDbError('Empty query after stripping comments.')
  }

  const masked = maskSqlLiterals(stripped)

  // Reject multiple statements: a ';' is only allowed as the final character.
  const semicolonIdx = masked.indexOf(';')
  if (semicolonIdx !== -1 && semicolonIdx !== masked.length - 1) {
    throw new QueryDbError(
      'Multiple statements are not allowed — submit a single SELECT/WITH query.',
    )
  }

  const firstKeywordMatch = masked.match(/^([a-zA-Z]+)/)
  const firstKeyword = firstKeywordMatch?.[1]?.toUpperCase() ?? ''
  if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
    throw new QueryDbError(
      `Only SELECT/WITH read queries are allowed (got "${firstKeyword || '?'}").`,
    )
  }

  // Reject any forbidden write/DDL/PRAGMA keyword anywhere (word-boundary match).
  const upper = masked.toUpperCase()
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new QueryDbError(`Disallowed keyword "${kw}" — query_db is read-only.`)
    }
  }
}

/**
 * Cheap, no-execution pre-flight: ask SQLite for the query plan and reject if it
 * would full-scan (no index) a base table larger than `threshold` rows. This
 * catches the "forgot to filter on an indexed column" foot-gun instantly, before
 * any rows are touched, and enforces the contract that large-table access must
 * hit an index. EXPLAIN QUERY PLAN only COMPILES the statement — it never runs
 * it — so this is safe to call on any connection. Returns [] (allow) when the
 * plan can't be read (let the real execution surface the syntax error) or when
 * every scan is indexed / against a small table.
 */
export function assertIndexedPlan(db, sql, bind = [], opts = {}) {
  const threshold = opts.threshold ?? LARGE_SCAN_ROW_THRESHOLD
  let plan
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bind)
  } catch {
    // Unparseable / planner error — don't block here; the executor will report
    // the real error to the caller.
    return []
  }

  for (const step of plan) {
    const detail = String(step.detail ?? '')
    // A full table scan reads as "SCAN <table>" (older SQLite: "SCAN TABLE t").
    // Indexed access reads as "... USING [COVERING] INDEX ..." or
    // "... USING [INTEGER] PRIMARY KEY". SEARCH steps are always indexed.
    const m = detail.match(/^SCAN (?:TABLE )?([A-Za-z_][A-Za-z0-9_]*)/)
    if (!m) continue
    if (/USING (?:COVERING )?INDEX|USING (?:INTEGER )?PRIMARY KEY/.test(detail)) continue

    const table = m[1]
    // Subquery / CTE materialisations also render as "SCAN <name>"; only guard
    // real base tables.
    const isBaseTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table)
    if (!isBaseTable) continue

    let rowCount = 0
    try {
      rowCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0)
    } catch {
      rowCount = 0
    }
    if (rowCount > threshold) {
      throw new QueryDbError(
        `Query would full-scan large table "${table}" (${rowCount.toLocaleString()} rows) ` +
          'without using an index. Add a WHERE filter on an indexed column ' +
          '(e.g. repo_id, pr_id, created_at) or restructure so the planner can use an ' +
          'index. Tip: never JOIN several child tables of the same parent in one query ' +
          '— that fans out to a cartesian product. Query each separately, or use the ' +
          'data_overview tool for ingestion counts.',
      )
    }
  }
  return []
}

/**
 * Execute a prepared read query, streaming rows with a row-count AND byte
 * budget. `iterate()` stops early rather than `all()` which would materialise the
 * entire result set first. Returns { columns, rows, truncated }.
 */
export function runBudgetedQuery(db, sql, bind = [], opts = {}) {
  const maxRows = opts.maxRows ?? QUERY_DB_DEFAULT_MAX_ROWS
  const maxBytes = opts.maxBytes ?? QUERY_DB_MAX_BYTES
  const stmt = db.prepare(sql)
  const rows = []
  let bytes = 0
  let truncated = false
  for (const row of stmt.iterate(...bind)) {
    if (rows.length >= maxRows) {
      truncated = true
      break
    }
    bytes += JSON.stringify(row).length
    if (bytes > maxBytes) {
      truncated = true
      break
    }
    rows.push(row)
  }
  const columns =
    Array.isArray(stmt.columnNames) && stmt.columnNames.length > 0
      ? stmt.columnNames
      : rows[0] !== undefined
        ? Object.keys(rows[0])
        : []
  return { columns, rows, truncated }
}
