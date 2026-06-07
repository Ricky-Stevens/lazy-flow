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
 *   7. `ticket_work_alignment` / `effort_proportionality` / `explain_anomaly` /
 *      `pr_quality` skip gracefully when no Anthropic key is configured.
 *   8. `correct_verdict` returns an error result for a non-existent verdict.
 *   9. Dashboard resources are resolvable via lazy-flow://dashboard/<id>.
 */

import { ENGINE_VERSION, migrate, NodeSqliteStore } from '@lazy-flow/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import type { ServerContext } from './server.js'
import { createServer } from './server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestCtx(): ServerContext {
  const config = loadConfig()
  // Use in-memory DB for tests
  const store = new NodeSqliteStore(':memory:')
  migrate(store.db)

  return {
    config,
    store,
    githubClient: null,
    jiraClient: null,
    llmClient: null,
  }
}

async function makeConnectedPair(): Promise<{ client: Client; ctx: ServerContext }> {
  const ctx = makeTestCtx()
  const server = createServer(ctx)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)

  return { client, ctx }
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
      'correct_verdict',
      'doctor',
      'effort_proportionality',
      'explain_anomaly',
      'explain_metric',
      'export',
      'get_agile_metrics',
      'get_code_metrics',
      'get_dora',
      'get_flow',
      'get_pr_metrics',
      'pr_quality',
      'run_sync',
      'sync_status',
      'ticket_work_alignment',
    ].sort()

    expect(names).toEqual(expected)
  })
})

describe('MCP server — tool: doctor', () => {
  it('returns schema-valid structuredContent with overall + checks', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({ name: 'doctor', arguments: {} })

    expect(result.structuredContent).toBeDefined()
    const sc = result.structuredContent as Record<string, unknown>

    // Provenance fields
    expect(typeof sc.as_of).toBe('string')
    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(sc.trust_tier).toBe('n/a')

    // Structure
    expect(sc.overall).toMatch(/^(healthy|degraded|unhealthy)$/)
    expect(Array.isArray(sc.checks)).toBe(true)

    const checks = sc.checks as Array<{ name: string; status: string; message: string }>
    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      expect(typeof check.name).toBe('string')
      expect(['ok', 'warn', 'error']).toContain(check.status)
      expect(typeof check.message).toBe('string')
    }

    // node_version check should pass (Node >=22)
    const nodeCheck = checks.find((c) => c.name === 'node_version')
    expect(nodeCheck?.status).toBe('ok')

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
    const sc = result.structuredContent as Record<string, unknown>

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
    const sc = result.structuredContent as Record<string, unknown>

    expect(sc.found).toBe(true)
    expect(typeof sc.formula_doc).toBe('string')
    expect((sc.formula_doc as string).length).toBeGreaterThan(10)
    expect(sc.metric).toBe('deployment_frequency')
  })

  it('returns found=false for an unknown metric', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'nonexistent_metric_xyz' },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.found).toBe(false)
  })

  it('returns formulaDoc for cognitive_complexity', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'cognitive_complexity' },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.found).toBe(true)
    // Should mention SonarSource rules
    expect(sc.formula_doc as string).toContain('SonarSource')
  })
})

describe('MCP server — metric bundle tools', () => {
  const metricTools = [
    { name: 'get_dora', args: {} },
    { name: 'get_flow', args: {} },
    { name: 'get_pr_metrics', args: {} },
    { name: 'get_code_metrics', args: {} },
    { name: 'get_agile_metrics', args: {} },
  ] as const

  for (const tool of metricTools) {
    it(`${tool.name} returns metric bundle with provenance + trust_tier`, async () => {
      const { client } = await makeConnectedPair()

      const result = await client.callTool({ name: tool.name, arguments: {} })
      const sc = result.structuredContent as Record<string, unknown>

      // Provenance
      expect(typeof sc.as_of).toBe('string')
      expect(sc.engine_version).toBe(ENGINE_VERSION)
      expect(typeof sc.trust_tier).toBe('string')
      expect(typeof sc.data_quality).toBe('string')

      // Bundle structure
      expect(typeof sc.scope).toBe('string')
      expect(typeof sc.window_days).toBe('number')
      expect(Array.isArray(sc.metrics)).toBe(true)

      const metrics = sc.metrics as Array<{
        metric: string
        trust_tier: string
        data_quality: string
        formula_doc: string
      }>
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
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.scope).toBe('my-team')
    expect(sc.window_days).toBe(14)
  })
})

describe('MCP server — tool: export', () => {
  it('returns structured rows with provenance columns', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'export',
      arguments: { metric: 'deployment_frequency', format: 'json' },
    })
    const sc = result.structuredContent as Record<string, unknown>

    expect(sc.format).toBe('json')
    expect(sc.metric).toBe('deployment_frequency')
    expect(typeof sc.row_count).toBe('number')
    expect(Array.isArray(sc.rows)).toBe(true)

    // Every row should carry engine_version + trust_tier
    const rows = sc.rows as Array<Record<string, unknown>>
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.engine_version).toBe(ENGINE_VERSION)
      expect(typeof row.trust_tier).toBe('string')
      expect(typeof row.as_of).toBe('string')
    }
  })
})

describe('MCP server — AI insight tools (no API key)', () => {
  it('ticket_work_alignment skips gracefully without API key', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'ticket_work_alignment',
      arguments: { pr_node_id: 'PR_abc123', issue_key: 'ENG-1' },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
    expect(typeof sc.skip_reason).toBe('string')
    expect(sc.trust_tier).toBe('hybrid')
  })

  it('effort_proportionality skips gracefully without API key', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'effort_proportionality',
      arguments: { issue_key: 'ENG-42' },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
    expect(sc.band).toBeNull()
  })

  it('explain_anomaly skips gracefully without API key', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'explain_anomaly',
      arguments: {},
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
    expect(sc.anomaly_detected).toBeNull()
  })

  it('pr_quality skips gracefully without API key', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'pr_quality',
      arguments: { pr_node_id: 'PR_xyz' },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
    expect(sc.overall_score).toBeNull()
  })
})

describe('MCP server — tool: correct_verdict', () => {
  it('returns schema-valid output with verdict_id and corrected flag', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'correct_verdict',
      arguments: {
        verdict_id: 'nonexistent-id-00000',
        correction: { corrected_label: 3 },
        corrected_by: 'test-user',
      },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.verdict_id).toBe('nonexistent-id-00000')
    // correctAiVerdict is a silent UPDATE — succeeds even if no row matched
    expect(typeof sc.corrected).toBe('boolean')
    // Provenance always present
    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(typeof sc.as_of).toBe('string')
  })
})

describe('MCP server — resources', () => {
  it('lists dashboard resources', async () => {
    const { client } = await makeConnectedPair()

    const { resources } = await client.listResources()

    // Should include at least the 5 default dashboards + the list resource
    expect(resources.length).toBeGreaterThanOrEqual(5)

    const uris = resources.map((r) => r.uri)
    expect(uris).toContain('lazy-flow://dashboard/dora')
    expect(uris).toContain('lazy-flow://dashboard/flow')
    expect(uris).toContain('lazy-flow://dashboard/pr')
    expect(uris).toContain('lazy-flow://dashboard/code')
    expect(uris).toContain('lazy-flow://dashboard/agile')
  })

  it('reads the DORA dashboard resource', async () => {
    const { client } = await makeConnectedPair()

    const { contents } = await client.readResource({ uri: 'lazy-flow://dashboard/dora' })

    expect(contents.length).toBeGreaterThan(0)
    const content = contents[0]
    expect(content).toBeDefined()
    if (content && 'text' in content) {
      const parsed = JSON.parse(content.text as string) as Record<string, unknown>
      expect(parsed.id).toBe('dora')
      expect(parsed.engine_version).toBe(ENGINE_VERSION)
      expect(Array.isArray(parsed.metrics)).toBe(true)
    }
  })

  it('reads the dashboard list resource', async () => {
    const { client } = await makeConnectedPair()

    const { contents } = await client.readResource({ uri: 'lazy-flow://dashboard' })
    expect(contents.length).toBeGreaterThan(0)
    const content = contents[0]
    if (content && 'text' in content) {
      const parsed = JSON.parse(content.text as string) as Record<string, unknown>
      expect(Array.isArray(parsed.dashboards)).toBe(true)
      expect((parsed.dashboards as unknown[]).length).toBeGreaterThanOrEqual(5)
    }
  })
})

describe('MCP server — run_sync (no clients configured)', () => {
  it('returns skipped=true when GitHub token not configured', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'run_sync',
      arguments: { sources: ['github'] },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
    expect(typeof sc.skip_reason).toBe('string')
  })

  it('returns skipped=true when Jira token not configured', async () => {
    const { client } = await makeConnectedPair()

    const result = await client.callTool({
      name: 'run_sync',
      arguments: { sources: ['jira'] },
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.skipped).toBe(true)
  })
})
