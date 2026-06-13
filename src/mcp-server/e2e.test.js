/**
 * Boot smoke test — WP-E2E (SPEC §12.3, AC#1).
 *
 * Verifies that the source MCP server entry (src/mcp-server/index.js):
 *   1. Boots from `bun src/mcp-server/index.js` with no install/build step.
 *   2. Completes the MCP handshake (initialize + initialized).
 *   3. Responds with schema-valid structuredContent on a deterministic tool call.
 *   4. Grammar WASM resolution: calls explain_metric for cognitive_complexity and
 *      verifies the formula references SonarSource. Grammar .wasm files resolve
 *      from node_modules/tree-sitter-wasms at runtime via createRequire.
 *      Full grammar *load* (tree-sitter parse) is not tested here because it
 *      requires an actual git diff.
 *
 * This test is the gate that makes "no install step" real (SPEC D12, WP-E2E).
 * It runs the actual source entry under Bun, not in-memory transports.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ENGINE_VERSION } from '../core/index.js'

// ---------------------------------------------------------------------------
// Resolve source entry path
// ---------------------------------------------------------------------------

// The server runs from source under Bun — index.js lives next to this test.
const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = join(__dirname, 'index.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectToBundle() {
  const transport = new StdioClientTransport({
    // The server imports bun:sqlite, so it MUST be launched under Bun.
    // When this test runs under Bun (`bun test`), process.execPath is the bun
    // binary; fall back to a PATH-resolved `bun` otherwise.
    command: typeof Bun !== 'undefined' ? process.execPath : 'bun',
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      // Use in-memory DB for the smoke test
      LAZYFLOW_DB_PATH: ':memory:',
      // No real tokens needed for smoke test
      LAZYFLOW_GITHUB_TOKEN: '',
      LAZYFLOW_JIRA_TOKEN: '',
    },
  })

  const client = new Client({ name: 'e2e-smoke', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E boot smoke — source entry under Bun', () => {
  it('source entry exists', () => {
    expect(existsSync(SERVER_ENTRY)).toBe(true)
  })

  it('boots and completes the MCP handshake', async () => {
    const client = await connectToBundle()
    // If we got here without throwing, the handshake succeeded.
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    await client.close()
  })

  it('doctor tool returns schema-valid structuredContent', async () => {
    const client = await connectToBundle()

    const result = await client.callTool({ name: 'doctor', arguments: {} })

    expect(result.structuredContent).toBeDefined()
    const sc = result.structuredContent

    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(typeof sc.as_of).toBe('string')
    expect(sc.overall).toMatch(/^(healthy|degraded|unhealthy)$/)
    expect(Array.isArray(sc.checks)).toBe(true)

    // bun_runtime check must pass (bundle launched under Bun >=1.3)
    const checks = sc.checks
    const bunCheck = checks.find((c) => c.name === 'bun_runtime')
    expect(bunCheck?.status).toBe('ok')

    await client.close()
  }, 15_000)

  it('explain_metric returns SonarSource cognitive complexity formula (grammar path wired)', async () => {
    // This call proves that:
    //   (a) the code-analysis module loaded under Bun from source
    //   (b) the formula doc for cognitive_complexity references SonarSource
    // Grammar .wasm files resolve from node_modules/tree-sitter-wasms at runtime.
    const client = await connectToBundle()

    const result = await client.callTool({
      name: 'explain_metric',
      arguments: { metric: 'cognitive_complexity' },
    })

    const sc = result.structuredContent
    expect(sc.found).toBe(true)
    expect(sc.formula_doc).toContain('SonarSource')

    await client.close()
  }, 15_000)

  it('sync_status returns schema-valid output with provenance', async () => {
    const client = await connectToBundle()

    const result = await client.callTool({ name: 'sync_status', arguments: {} })
    const sc = result.structuredContent

    expect(sc.engine_version).toBe(ENGINE_VERSION)
    expect(typeof sc.as_of).toBe('string')
    expect(typeof sc.has_stale).toBe('boolean')
    expect(Array.isArray(sc.resources)).toBe(true)

    await client.close()
  }, 15_000)

  it('a resource is @-mentionable end-to-end', async () => {
    const client = await connectToBundle()

    // The seeded dashboards were removed (WS-8). report/latest is a stable
    // resource that proves resource registration end-to-end.
    const { contents } = await client.readResource({ uri: 'lazy-flow://report/latest' })
    expect(contents.length).toBeGreaterThan(0)
    const content = contents[0]
    if (content && 'text' in content) {
      expect(content.mimeType).toBe('text/html')
      expect(content.text.length).toBeGreaterThan(0)
    }

    await client.close()
  }, 15_000)
})
