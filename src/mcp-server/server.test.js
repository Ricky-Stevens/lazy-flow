/**
 * MCP server tests — WP-MCP-SERVER, WP-MCP-TOOLS, WP-MCP-RESOURCES.
 *
 * Tests the server in-process using InMemoryTransport so we don't need a
 * subprocess.  The boot-smoke + grammar-load test (WP-E2E) lives in
 * src/e2e.test.ts and exercises the actual bundle.
 *
 * Test coverage:
 *   1. Server boots and lists the expected tools.
 *   2. `doctor` returns schema-valid structuredContent with overall + checks.
 *   3. `sync_status` returns schema-valid output with provenance fields.
 *   4. `explain_metric` returns the formulaDoc for known metrics.
 *   5. `get_dora` / `get_flow` / `get_pr_metrics` / `get_code_metrics` /
 *      `get_agile_metrics` return metric bundles with trust_tier + as_of.
 *   6. `export` returns structured rows with provenance columns.
 *   7. `query_db` runs read-only SELECT/WITH queries and rejects writes/DDL.
 *   8. Dashboard + schema resources are resolvable via lazy-flow://...
 */

import { describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BunSqliteStore, ENGINE_VERSION, migrate } from '../core/index.js'
import { loadConfig } from './config.js'

import { createServer } from './server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestCtx() {
  // Use in-memory DB for tests. Pin config.dbPath to ':memory:' too so query_db
  // routes through this shared store (not a separate on-disk readonly handle).
  const config = { ...loadConfig(), dbPath: ':memory:' }
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)

  return {
    config,
    store,
    githubClient: null,
    jiraClient: null,
  }
}

async function makeConnectedPair() {
  const ctx = makeTestCtx()
  const server = createServer(ctx)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)

  return { client, ctx }
}

/**
 * Connected pair backed by an ON-DISK DB so query_db routes through the isolated
 * child-process (subprocess) path — the only path with a hard SIGKILL timeout.
 * Returns a `cleanup()` that closes the store and removes the temp files.
 */
async function makeOnDiskConnectedPair({ queryDbTimeoutMs } = {}) {
  const dbPath = join(tmpdir(), `lazyflow-querydb-${process.pid}-${crypto.randomUUID()}.db`)
  const store = new BunSqliteStore(dbPath)
  migrate(store.db)
  const config = { ...loadConfig(), dbPath, queryDbTimeoutMs }
  const ctx = { config, store, githubClient: null, jiraClient: null }

  const server = createServer(ctx)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)

  const cleanup = () => {
    try {
      store.db.close()
    } catch {
      // best-effort
    }
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true })
    }
  }
  return { client, ctx, cleanup }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP server — bootstrap', () => {
  it('lists all expected tools', async () => {
    const { client } = await makeConnectedPair()

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()

    const expected = [
      'backfill_pr_patches',
      'data_overview',
      'doctor',
      'explain_metric',
      'export',
      'generate_report',
      'get_agile_metrics',
      'get_code_metrics',
      'get_dora',
      'get_flow',
      'get_person_report',
      'get_pr_metrics',
      'get_schema',
      'list_pending_ai_authorship',
      'list_pending_verdicts',
      'list_report_presets',
      'query_db',
      'record_ai_authorship_verdict',
      'record_verdict',
      'run_sync',
      'sync_status',
    ].sort()

    expect(names).toEqual(expected)
  })

  it('get_schema returns the schema guide + live DDL (tool mirror of the resource)', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({ name: 'get_schema', arguments: {} })
    expect(result.structuredContent).toBeDefined()
    const text = result.structuredContent.schema
    expect(typeof text).toBe('string')
    // Carries the live DDL section and at least one real table.
    expect(text).toContain('Live schema (sqlite_master)')
    expect(text).toContain('pull_requests')
  })
})

describe('MCP server — tool: doctor', () => {
  it('returns schema-valid structuredContent with overall + checks', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({ name: 'doctor', arguments: {} })

    expect(result.structuredContent).toBeDefined()
    const sc = result.structuredContent

    // Provenance fields
    expect(typeof sc.as_of).toBe('string')
    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(sc.trust_tier).toBe('n/a')

    // Structure
    expect(sc.overall).toMatch(/^(healthy|degraded|unhealthy)$/)
    expect(Array.isArray(sc.checks)).toBe(true)

    const checks = sc.checks
    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      expect(typeof check.name).toBe('string')
      expect(['ok', 'warn', 'error']).toContain(check.status)
      expect(typeof check.message).toBe('string')
    }

    // bun_runtime check should pass (running under Bun >=1.3)
    const bunCheck = checks.find((c) => c.name === 'bun_runtime')
    expect(bunCheck?.status).toBe('ok')

    // No tokens configured → warns
    const ghCheck = checks.find((c) => c.name === 'github_token')
    expect(ghCheck?.status).toBe('warn')
  })
})

describe('MCP server — tool: sync_status', () => {
  it('returns schema-valid output with provenance fields', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({ name: 'sync_status', arguments: {} })

    expect(result.structuredContent).toBeDefined()
    const sc = result.structuredContent

    expect(typeof sc.as_of).toBe('string')
    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(typeof sc.has_stale).toBe('boolean')
    expect(typeof sc.warn_count).toBe('number')
    expect(typeof sc.refuse_count).toBe('number')
    expect(Array.isArray(sc.resources)).toBe(true)
  })

  it('accepts custom threshold parameters', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'sync_status',
      arguments: { stale_threshold_hours: 2, refuse_threshold_hours: 12 },
    })
    expect(result.structuredContent).toBeDefined()
  })
})

describe('MCP server — tool: explain_metric', () => {
  it('returns formulaDoc for a known metric', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'deployment_frequency' },
    })
    const sc = result.structuredContent

    expect(sc.found).toBe(true)
    expect(typeof sc.formula_doc).toBe('string')
    expect(sc.formula_doc.length).toBeGreaterThan(10)
    expect(sc.metric).toBe('deployment_frequency')
  })

  it('returns found=false for an unknown metric', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'nonexistent_metric_xyz' },
    })
    const sc = result.structuredContent
    expect(sc.found).toBe(false)
  })

  it('returns formulaDoc for cognitive_complexity', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'cognitive_complexity' },
    })
    const sc = result.structuredContent
    expect(sc.found).toBe(true)
    // Should mention SonarSource rules
    expect(sc.formula_doc).toContain('SonarSource')
  })

  it('resolves FULLY-QUALIFIED metric ids (the ids the other tools emit)', async () => {
    // Regression: the curated short-name table only had ~10 entries, so every
    // qualified id a user gets back from get_dora/get_flow/get_person_report
    // (dora.*, flow.*, pr.*, code.*, agile.*, person.*) returned "not
    // documented". They must resolve from the engine modules' own formulaDoc.
    const { client } = await makeConnectedPair()
    for (const metric of [
      'dora.lead_time',
      'flow.cycle_time',
      'code.haloc_aggregate',
      'agile.say_do',
      'person.review_reciprocity',
      'pr.review_bypass_rate_received',
    ]) {
      const result = await client.callTool({ name: 'explain_metric', arguments: { metric } })
      const sc = result.structuredContent
      expect(sc.found, metric).toBe(true)
      expect(sc.formula_doc.length, metric).toBeGreaterThan(10)
    }
  })
})

describe('MCP server — metric bundle tools', () => {
  const metricTools = [
    { name: 'get_dora', args: {} },
    { name: 'get_flow', args: {} },
    { name: 'get_pr_metrics', args: {} },
    { name: 'get_code_metrics', args: {} },
    { name: 'get_agile_metrics', args: {} },
  ]

  for (const tool of metricTools) {
    it(`${tool.name} returns metric bundle with provenance + trust_tier`, async () => {
      const { client } = await makeConnectedPair()

      const result = await client.callTool({ name: tool.name, arguments: {} })
      const sc = result.structuredContent

      // Provenance
      expect(typeof sc.as_of).toBe('string')
      expect(sc.engine_version).toBe(ENGINE_VERSION)
      expect(typeof sc.trust_tier).toBe('string')
      expect(typeof sc.data_quality).toBe('string')

      // Bundle structure
      expect(typeof sc.scope).toBe('string')
      expect(typeof sc.window_days).toBe('number')
      expect(Array.isArray(sc.metrics)).toBe(true)

      const metrics = sc.metrics

      expect(metrics.length).toBeGreaterThan(0)
      for (const m of metrics) {
        expect(typeof m.metric).toBe('string')
        expect(['deterministic', 'hybrid', 'probabilistic']).toContain(m.trust_tier)
        expect(typeof m.data_quality).toBe('string')
        expect(typeof m.formula_doc).toBe('string')
      }
    })
  }

  it('get_dora accepts scope + window_days parameters', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'get_dora',
      arguments: { scope: 'my-team', window_days: 14 },
    })
    const sc = result.structuredContent
    expect(sc.scope).toBe('my-team')
    expect(sc.window_days).toBe(14)
  })
})

describe('MCP server — tool: export', () => {
  it('exports REAL snapshots from the store with provenance columns', async () => {
    const { client, ctx } = await makeConnectedPair()

    // Seed two real snapshots within the default 30-day window.
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    for (const day of [yesterday, today]) {
      await ctx.store.putSnapshot({
        scopeType: 'team',
        scopeId: 'team',
        metric: 'flow.cycle_time',
        day,
        value: 42,
        window: '30d',
        trustTier: 'deterministic',
        dataQuality: 'ok',
        engineVersion: ENGINE_VERSION,
        ingestWatermarkVersion: '1',
        coverageFingerprint: 'cov-abc',
        computedAt: `${day}T00:00:00.000Z`,
        isStale: false,
      })
    }

    const result = await client.callTool({
      name: 'export',
      arguments: { metric: 'flow.cycle_time', format: 'json' },
    })
    const sc = result.structuredContent

    expect(sc.format).toBe('json')
    expect(sc.metric).toBe('flow.cycle_time')
    expect(sc.data_quality).toBe('ok')
    expect(sc.trust_tier).toBe('deterministic')

    const rows = sc.rows
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.engine_version).toBe(ENGINE_VERSION)
      expect(row.metric).toBe('flow.cycle_time')
      expect(row.value).toBe(42)
      expect(row.coverage_fingerprint).toBe('cov-abc')
      expect(typeof row.day).toBe('string')
    }
  })

  it('returns CSV text and a no_data envelope when no snapshots exist', async () => {
    const { client } = await makeConnectedPair()

    const json = await client.callTool({
      name: 'export',
      arguments: { metric: 'flow.cycle_time', format: 'json' },
    })
    const sc = json.structuredContent
    expect(sc.row_count).toBe(0)
    expect(sc.data_quality).toBe('no_data')
    expect(sc.trust_tier).toBe('n/a')

    // CSV format returns the CSV string as the text content (empty when no rows).
    const csv = await client.callTool({
      name: 'export',
      arguments: { metric: 'flow.cycle_time', format: 'csv' },
    })
    const content = csv.content
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
  })
})

describe('MCP server — reporting tools', () => {
  it('list_report_presets enumerates presets', async () => {
    const { client } = await makeConnectedPair()
    const result = await client.callTool({ name: 'list_report_presets', arguments: {} })
    const sc = result.structuredContent
    expect(sc.count).toBeGreaterThan(0)
    const presets = sc.presets
    expect(presets.some((p) => p.key === 'monthly:team')).toBe(true)
  })

  it('generate_report produces a self-contained HTML artifact from real snapshots', async () => {
    const { client, ctx } = await makeConnectedPair()
    const today = new Date().toISOString().slice(0, 10)
    await ctx.store.putSnapshot({
      scopeType: 'team',
      scopeId: 'platform',
      metric: 'flow.cycle_time',
      day: today,
      value: 5,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion: '1',
      coverageFingerprint: 'cov-1',
      computedAt: `${today}T00:00:00.000Z`,
      isStale: false,
    })

    const result = await client.callTool({
      name: 'generate_report',
      arguments: { preset: 'monthly:team', scope: 'platform', format: 'html' },
    })
    const sc = result.structuredContent
    expect(sc.preset).toBe('monthly:team')
    expect(sc.format).toBe('html')
    expect(sc.person_scope).toBe(false)
    expect(sc.content.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(sc.content).toContain('Monthly Delivery Report')
  })

  it('generate_report refuses an out_path without a report extension (path-write guard)', async () => {
    const { client, ctx } = await makeConnectedPair()
    const today = new Date().toISOString().slice(0, 10)
    await ctx.store.putSnapshot({
      scopeType: 'team',
      scopeId: 'platform',
      metric: 'flow.cycle_time',
      day: today,
      value: 5,
      window: '30d',
      trustTier: 'deterministic',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      ingestWatermarkVersion: '1',
      coverageFingerprint: 'cov-1',
      computedAt: `${today}T00:00:00.000Z`,
      isStale: false,
    })

    // A poisoned out_path (no report extension) must be rejected BEFORE any
    // write, so the tool can't be steered into overwriting e.g. a dotfile.
    const result = await client.callTool({
      name: 'generate_report',
      arguments: {
        preset: 'monthly:team',
        scope: 'platform',
        format: 'html',
        out_path: '/tmp/lazyflow-test-pwned',
      },
    })
    expect(result.isError).toBe(true)
    const text = result.content?.map((c) => c.text).join(' ') ?? ''
    expect(text).toContain('report extension')
  })

  it('generate_report supports markdown + csv + json formats', async () => {
    const { client } = await makeConnectedPair()
    for (const format of ['markdown', 'csv', 'json']) {
      const result = await client.callTool({
        name: 'generate_report',
        arguments: { preset: 'monthly:team', scope: 'platform', format },
      })
      const sc = result.structuredContent
      expect(sc.format).toBe(format)
      expect(typeof sc.content).toBe('string')
    }
  })

  it('latest report resource resolves', async () => {
    const { client } = await makeConnectedPair()
    const res = await client.readResource({ uri: 'lazy-flow://report/latest' })
    const contents = res.contents
    expect(contents[0]?.mimeType).toBe('text/html')
    expect(typeof contents[0]?.text).toBe('string')
  })
})

describe('MCP server — tool: query_db', () => {
  it('returns rows for a simple SELECT', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: 'SELECT 1 AS one, ? AS two', params: [42] },
    })
    const sc = result.structuredContent

    expect(sc.error).toBeUndefined()
    expect(sc.columns).toEqual(['one', 'two'])
    expect(sc.row_count).toBe(1)
    expect(sc.truncated).toBe(false)
    const rows = sc.rows
    expect(rows[0]?.one).toBe(1)
    expect(rows[0]?.two).toBe(42)
  })

  it('reads REAL seeded data and aggregates it', async () => {
    const { client, ctx } = await makeConnectedPair()

    // Seed a person + identity directly so we can query them back.
    ctx.store.db
      .prepare(
        'INSERT INTO persons (id, display_name, primary_account_ref, updated_at) VALUES (?,?,?,?)',
      )
      .run('p1', 'Test Person', 'github:octocat', '2026-01-01T00:00:00.000Z')
    ctx.store.db
      .prepare(
        'INSERT INTO identities (id, person_id, kind, external_id, raw, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('i1', 'p1', 'github_login', 'octocat', '{}', '2026-01-01T00:00:00.000Z')

    const result = await client.callTool({
      name: 'query_db',
      arguments: {
        sql: 'SELECT person_id FROM identities WHERE kind = ? AND external_id = ?',
        params: ['github_login', 'octocat'],
      },
    })
    const sc = result.structuredContent
    expect(sc.row_count).toBe(1)
    const rows = sc.rows
    expect(rows[0]?.person_id).toBe('p1')
  })

  it('enforces max_rows and reports truncation', async () => {
    const { client } = await makeConnectedPair()

    // Generate 5 rows via a recursive CTE, cap at 2.
    const result = await client.callTool({
      name: 'query_db',
      arguments: {
        sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) SELECT n FROM c',
        max_rows: 2,
      },
    })
    const sc = result.structuredContent
    expect(sc.row_count).toBe(2)
    expect(sc.truncated).toBe(true)
  })

  it('bounds output by byte budget on a wide single row (no OOM)', async () => {
    // Regression: max_rows caps row COUNT, not width. A single wide row could
    // materialise hundreds of MB. The byte budget must truncate before the
    // response balloons. randomblob(20MB) hex-expands to 40MB > the 16MB budget.
    const { client } = await makeConnectedPair()
    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: 'SELECT hex(randomblob(20000000)) AS big' },
    })
    const sc = result.structuredContent
    // The over-budget row is dropped and the response is flagged truncated,
    // rather than returning a 40MB string.
    expect(sc.truncated).toBe(true)
    expect(sc.row_count).toBe(0)
  })

  it('rejects a non-SELECT (DML) statement', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: "DELETE FROM persons WHERE id = 'p1'" },
    })
    const sc = result.structuredContent
    expect(typeof sc.error).toBe('string')
    expect(sc.row_count).toBe(0)
    // The DELETE keyword must be the reported reason.
    expect(sc.error).toMatch(/DELETE|SELECT\/WITH/)
  })

  it('rejects a DDL statement disguised after a WITH clause', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: 'WITH x AS (SELECT 1) INSERT INTO persons VALUES (1)' },
    })
    const sc = result.structuredContent
    expect(typeof sc.error).toBe('string')
    expect(sc.error).toMatch(/INSERT/)
  })

  it('rejects multiple statements', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: 'SELECT 1; SELECT 2' },
    })
    const sc = result.structuredContent
    expect(typeof sc.error).toBe('string')
    expect(sc.error).toMatch(/Multiple statements/)
  })

  it('rejects PRAGMA writes', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: 'PRAGMA writable_schema = ON' },
    })
    const sc = result.structuredContent
    expect(typeof sc.error).toBe('string')
  })

  it('allows a SELECT with a forbidden keyword inside a string literal (regression)', async () => {
    const { client } = await makeConnectedPair()

    // 'DELETE' and ';' appear only as DATA inside a string literal — the
    // read-only guard used to scan the raw text and wrongly reject this.
    const result = await client.callTool({
      name: 'query_db',
      arguments: { sql: "SELECT 'DELETE; DROP' AS note, 'a@b.com' AS email" },
    })
    const sc = result.structuredContent
    expect(sc.error).toBeUndefined()
    expect(sc.row_count).toBe(1)
    expect(sc.rows[0]?.note).toBe('DELETE; DROP')
  })
})

describe('MCP server — resources', () => {
  it('registers no stale dashboard resources (removed in favour of report presets)', async () => {
    const { client } = await makeConnectedPair()

    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)

    // The seeded in-memory dashboards carried stale metric ids and were referenced
    // by no skill; they were deleted. The report presets are the real surfacing path.
    expect(uris.some((u) => u.startsWith('lazy-flow://dashboard'))).toBe(false)
  })

  it('exposes the schema resource listing real tables + the person-resolution guide', async () => {
    const { client } = await makeConnectedPair()

    const res = await client.readResource({ uri: 'lazy-flow://schema' })
    const contents = res.contents
    expect(contents[0]?.mimeType).toBe('text/markdown')
    const text = contents[0]?.text ?? ''

    // Live DDL must list core tables (proves it reads sqlite_master, not a stub).
    expect(text).toContain('CREATE TABLE')
    for (const table of ['identities', 'persons', 'pull_requests', 'metric_snapshots']) {
      expect(text, `schema should mention ${table}`).toContain(table)
    }
    // Hand-written guide: person resolution via identities.person_id.
    expect(text).toContain('identities.person_id')
    // Explicit transparency header.
    expect(text.toLowerCase()).toContain('transparency')
  })
})

describe('MCP server — run_sync (no clients configured)', () => {
  it('returns skipped=true when GitHub token not configured', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'run_sync',
      arguments: { sources: ['github'] },
    })
    const sc = result.structuredContent
    expect(sc.skipped).toBe(true)
    expect(typeof sc.skip_reason).toBe('string')
  })

  it('returns skipped=true when Jira token not configured', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'run_sync',
      arguments: { sources: ['jira'] },
    })
    const sc = result.structuredContent
    expect(sc.skipped).toBe(true)
  })

  it('syncs github-only without requiring a jira client (regression: Client unexpectedly null)', async () => {
    // github IS configured, jira is NOT. Requesting sources=['github'] must run a
    // github-only sync, not throw. Previously runSync required BOTH clients
    // regardless of requested sources and threw "Client unexpectedly null".
    const ctx = makeTestCtx()
    // Minimal stub: no repos → syncGitHub is a clean no-op, so none of the other
    // client methods are reached. Each is still present so a future code path
    // change surfaces as a clear failure rather than an undefined-call crash.
    const empty = async () => []
    ctx.githubClient = {
      listOrgRepos: empty,
      listCommits: empty,
      getCommitDetail: async () => null,
      listPullRequests: empty,
      listPullRequestsUpdatedSince: empty,
      listReviews: empty,
      listReviewComments: empty,
      listPrFiles: empty,
      listCheckRuns: empty,
      listDeployments: empty,
      listReleases: empty,
    }
    ctx.jiraClient = null

    const server = createServer(ctx)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'run_sync',
      arguments: { sources: ['github'] },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent
    expect(sc).toBeDefined()
    expect(sc.skipped).toBe(false)
    // jira was skipped → empty jira results, no jira error.
    expect(sc.jira.issues_upserted).toBe(0)
    expect(sc.jira.errors).toEqual([])
  })
})

describe('MCP server — tool: data_overview', () => {
  it('returns per-repo / per-project counts and totals without raw SQL', async () => {
    const { client, ctx } = await makeConnectedPair()
    const now = '2026-01-01T00:00:00.000Z'

    ctx.store.db
      .prepare(
        'INSERT INTO organisations (id, github_login, name, created_at, updated_at) VALUES (?,?,?,?,?)',
      )
      .run('org1', 'acme', 'Acme', now, now)
    ctx.store.db
      .prepare(
        'INSERT INTO repositories (id, github_node_id, org_id, owner, name, default_branch, is_archived, is_fork, raw, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run('repo1', 'node1', 'org1', 'acme', 'web', 'main', 0, 0, '{}', now, now)
    ctx.store.db
      .prepare(
        'INSERT INTO identities (id, person_id, kind, external_id, raw, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('id1', null, 'github_login', 'octocat', '{}', now)
    ctx.store.db
      .prepare(
        'INSERT INTO pull_requests (id, repo_id, number, author_identity_id, state, head_ref, base_ref, created_at, updated_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run('repo1#1', 'repo1', 1, 'id1', 'merged', 'feature', 'main', now, now, '{}')
    ctx.store.db
      .prepare(
        'INSERT INTO jira_projects (id, key, name, jira_cloud_id, raw, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run('proj1', 'BP', 'Big Project', 'cloud1', '{}', now, now)

    const result = await client.callTool({ name: 'data_overview', arguments: {} })
    const sc = result.structuredContent

    expect(sc.error).toBeUndefined()
    expect(sc.totals.repositories).toBe(1)
    expect(sc.totals.pull_requests).toBe(1)
    const repo = sc.repos.find((r) => r.repo === 'acme/web')
    expect(repo).toBeDefined()
    expect(repo.prs).toBe(1)
    const proj = sc.jira_projects.find((p) => p.project === 'BP')
    expect(proj).toBeDefined()
    expect(proj.issues).toBe(0)
  })
})

describe('MCP server — tool: query_db (on-disk, isolated)', () => {
  it('runs a SELECT through the isolated child process and returns rows', async () => {
    const { client, ctx, cleanup } = await makeOnDiskConnectedPair()
    try {
      ctx.store.db
        .prepare(
          'INSERT INTO persons (id, display_name, primary_account_ref, updated_at) VALUES (?,?,?,?)',
        )
        .run('p1', 'Disk Person', 'github:octocat', '2026-01-01T00:00:00.000Z')

      const result = await client.callTool({
        name: 'query_db',
        arguments: { sql: 'SELECT display_name FROM persons WHERE id = ?', params: ['p1'] },
      })
      const sc = result.structuredContent
      expect(sc.error).toBeUndefined()
      expect(sc.row_count).toBe(1)
      expect(sc.rows[0]?.display_name).toBe('Disk Person')
    } finally {
      cleanup()
    }
  })

  it('force-kills a runaway query at the timeout instead of hanging forever', async () => {
    // The whole point: an unbounded query must NOT be able to wedge the server.
    // A recursive CTE with no termination would run until the heat death of the
    // universe in-process; here it is SIGKILL'd at the (short, test-only) limit.
    const { client, cleanup } = await makeOnDiskConnectedPair({ queryDbTimeoutMs: 1500 })
    try {
      const started = Date.now()
      const result = await client.callTool({
        name: 'query_db',
        arguments: {
          sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c',
        },
      })
      const elapsed = Date.now() - started
      const sc = result.structuredContent
      expect(typeof sc.error).toBe('string')
      expect(sc.error).toMatch(/exceeded|aborted|limit/i)
      // Killed near the deadline, not run away for minutes/hours.
      expect(elapsed).toBeLessThan(8000)
    } finally {
      cleanup()
    }
  }, 15000)
})

describe('MCP server — metric bundles load the dataset once (perf regression guard)', () => {
  // Wrap the store in a counting proxy so we can assert the full-table load runs
  // ONCE per bundle, not once per metric. Before the load-once fix, computeRows
  // ran a fresh loadScopeData per metric (~13× for get_pr_metrics), freezing the
  // single-threaded server and spiking memory N× on a large install.
  function countingCtx() {
    const config = { ...loadConfig(), dbPath: ':memory:' }
    const store = new BunSqliteStore(':memory:')
    migrate(store.db)
    const counts = {}
    const proxy = new Proxy(store, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver)
        if (typeof val !== 'function') return val
        return (...args) => {
          counts[prop] = (counts[prop] ?? 0) + 1
          return val.apply(target, args)
        }
      },
    })
    return { ctx: { config, store: proxy, githubClient: null, jiraClient: null }, counts }
  }

  it('get_pr_metrics calls getAllPullRequests at most once for the whole bundle', async () => {
    const { ctx, counts } = countingCtx()
    const server = createServer(ctx)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'get_pr_metrics',
      arguments: { window_days: 30 },
    })
    expect(result.isError).toBeFalsy()
    // One shared load for the bundle — NOT once per metric.
    expect(counts.getAllPullRequestsMeta ?? counts.getAllPullRequests ?? 0).toBeLessThanOrEqual(1)
  })

  // ---------------------------------------------------------------------------
  // Fat-column regression guard — Finding 1
  //
  // The metric-compute path must NEVER hit the patch-bearing pr_files getter
  // unless a metric in the request actually re-parses unified diffs (currently
  // only `code.haloc_aggregate`). Every other tool — PR/flow/DORA/agile/person
  // bundles — must go through `getAllPrFilesMeta` (no patch column). Loading
  // hundreds of MB of diff text just to compute pr.cycle_time was the single
  // largest source of wasted I/O before this fix.
  //
  // Symmetric guard for the patch path: a tool that DOES need patches
  // (`get_code_metrics`, which computes `code.haloc_aggregate`) must hit the
  // patch-bearing getter exactly once and NOT the patch-less variant.
  // ---------------------------------------------------------------------------
  it('get_pr_metrics never loads the patch-bearing pr_files getter', async () => {
    const { ctx, counts } = countingCtx()
    const server = createServer(ctx)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'get_pr_metrics',
      arguments: { window_days: 30 },
    })
    expect(result.isError).toBeFalsy()
    // Patch-less variant should have run; the patch-bearing variant must NOT
    // — pr.* metrics read denormalised additions/deletions/haloc, never patch.
    expect(counts.getAllPrFiles ?? 0).toBe(0)
    expect(counts.getAllPrFilesMeta ?? 0).toBeLessThanOrEqual(1)
  })

  it('get_code_metrics loads pr_files patches exactly once and skips the meta variant', async () => {
    const { ctx, counts } = countingCtx()
    const server = createServer(ctx)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'get_code_metrics',
      arguments: { window_days: 30 },
    })
    expect(result.isError).toBeFalsy()
    // code.haloc_aggregate is patch-bearing → patch getter runs (≤ once per
    // dataset memo slot); the meta variant must NOT also fire for the same
    // bundle, otherwise we'd be paying for both loads.
    expect(counts.getAllPrFiles ?? 0).toBeLessThanOrEqual(1)
    expect(counts.getAllPrFilesMeta ?? 0).toBe(0)
  })
})
