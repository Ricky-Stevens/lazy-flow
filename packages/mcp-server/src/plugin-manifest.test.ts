/**
 * Plugin manifest validation — WP-PLUGIN deliverable 8.
 *
 * Parses plugin.json, .mcp.json, and marketplace.json as valid JSON, asserts
 * required fields are present, checks that the .mcp.json args path points at
 * a file that exists after build, and verifies that every ${user_config.*}
 * referenced in .mcp.json env has a matching userConfig key in plugin.json.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
// Repo root is 3 levels up from packages/mcp-server/src/
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

async function readJson(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, 'utf-8')
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// Extract ${user_config.*} references from an env block
// ---------------------------------------------------------------------------

function extractUserConfigRefs(env: Record<string, string>): string[] {
  const refs = new Set<string>()
  const pattern = /\$\{user_config\.([^}]+)\}/g
  for (const value of Object.values(env)) {
    let m = pattern.exec(value)
    while (m !== null) {
      const key = m[1]
      if (key !== undefined) refs.add(key)
      m = pattern.exec(value)
    }
    pattern.lastIndex = 0
  }
  return [...refs]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plugin.json', () => {
  const pluginJsonPath = join(REPO_ROOT, '.claude-plugin', 'plugin.json')

  it('parses as valid JSON', async () => {
    const parsed = await readJson(pluginJsonPath)
    expect(parsed).toBeTruthy()
  })

  it('has required top-level fields', async () => {
    const plugin = (await readJson(pluginJsonPath)) as Record<string, unknown>
    expect(plugin.name).toBe('lazy-flow')
    expect(typeof plugin.displayName).toBe('string')
    expect(typeof plugin.description).toBe('string')
    expect(typeof plugin.author).toBe('string')
    expect(plugin.license).toBe('MIT')
    expect(typeof plugin.repository).toBe('string')
    expect(plugin.mcpServers).toBe('./.mcp.json')
  })

  it('has a userConfig block with expected sensitive secret keys', async () => {
    const plugin = (await readJson(pluginJsonPath)) as Record<string, unknown>
    const userConfig = plugin.userConfig as Record<string, Record<string, unknown>>
    expect(userConfig).toBeTruthy()

    // Secrets — must be sensitive: true
    for (const secretKey of ['github_token', 'jira_oauth_token', 'anthropic_api_key']) {
      const entry = userConfig[secretKey]
      expect(entry, `userConfig.${secretKey} missing`).toBeTruthy()
      expect((entry ?? {}).sensitive, `${secretKey} must be sensitive`).toBe(true)
    }
  })

  it('has a userConfig block with expected non-sensitive config keys', async () => {
    const plugin = (await readJson(pluginJsonPath)) as Record<string, unknown>
    const userConfig = plugin.userConfig as Record<string, Record<string, unknown>>

    // Non-sensitive shared config keys
    for (const configKey of ['repos', 'jira_projects', 'visibility', 'churn_window_days']) {
      const entry = userConfig[configKey]
      expect(entry, `userConfig.${configKey} missing`).toBeTruthy()
      expect((entry ?? {}).sensitive, `${configKey} must not be sensitive`).not.toBe(true)
    }
  })
})

describe('.mcp.json', () => {
  const mcpJsonPath = join(REPO_ROOT, '.mcp.json')

  it('parses as valid JSON', async () => {
    const parsed = await readJson(mcpJsonPath)
    expect(parsed).toBeTruthy()
  })

  it('has a lazy-flow mcpServer entry with required fields', async () => {
    const mcp = (await readJson(mcpJsonPath)) as Record<string, unknown>
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>
    expect(servers).toBeTruthy()
    const lazyFlow = servers['lazy-flow']
    expect(lazyFlow, 'lazy-flow server entry missing').toBeTruthy()
    expect((lazyFlow ?? {}).command).toBe('node')
    expect(Array.isArray((lazyFlow ?? {}).args)).toBe(true)
    expect(typeof (lazyFlow ?? {}).env).toBe('object')
  })

  it('args path resolves to the built server.js (after build)', () => {
    // The args path uses ${CLAUDE_PLUGIN_ROOT} which resolves to the repo root at dev time.
    // We check that packages/mcp-server/server/dist/server.js exists.
    const builtServerPath = join(REPO_ROOT, 'packages', 'mcp-server', 'server', 'dist', 'server.js')
    expect(
      existsSync(builtServerPath),
      `Built server.js not found at ${builtServerPath} — run npm run build in packages/mcp-server first`,
    ).toBe(true)
  })

  it('grammars directory exists alongside server.js', () => {
    const grammarsDir = join(REPO_ROOT, 'packages', 'mcp-server', 'server', 'dist', 'grammars')
    expect(
      existsSync(grammarsDir),
      `grammars/ not found at ${grammarsDir} — run npm run build in packages/mcp-server first`,
    ).toBe(true)
  })

  it('every user_config ref in env has a matching userConfig key in plugin.json', async () => {
    const mcp = (await readJson(mcpJsonPath)) as Record<string, unknown>
    const plugin = (await readJson(join(REPO_ROOT, '.claude-plugin', 'plugin.json'))) as Record<
      string,
      unknown
    >

    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>
    const lazyFlowServer = servers['lazy-flow'] ?? {}
    const env = lazyFlowServer.env as Record<string, string>
    const userConfig = plugin.userConfig as Record<string, unknown>

    const refs = extractUserConfigRefs(env)
    expect(refs.length).toBeGreaterThan(0)

    for (const ref of refs) {
      expect(
        userConfig[ref],
        `user_config.${ref} referenced in .mcp.json env but missing from plugin.json userConfig`,
      ).toBeTruthy()
    }
  })
})

describe('marketplace.json', () => {
  const marketplaceJsonPath = join(REPO_ROOT, 'marketplace', '.claude-plugin', 'marketplace.json')

  it('parses as valid JSON', async () => {
    const parsed = await readJson(marketplaceJsonPath)
    expect(parsed).toBeTruthy()
  })

  it('lists the lazy-flow plugin with required fields', async () => {
    const marketplace = (await readJson(marketplaceJsonPath)) as Record<string, unknown>
    expect(Array.isArray(marketplace.plugins)).toBe(true)
    const plugins = marketplace.plugins as Array<Record<string, unknown>>
    expect(plugins.length).toBeGreaterThan(0)

    const lazyFlowPlugin = plugins.find((p) => p.name === 'lazy-flow')
    expect(lazyFlowPlugin, 'lazy-flow plugin missing from marketplace.json').toBeTruthy()

    if (lazyFlowPlugin) {
      expect(typeof lazyFlowPlugin.displayName).toBe('string')
      expect(typeof lazyFlowPlugin.description).toBe('string')
      expect(lazyFlowPlugin.license).toBe('MIT')
      expect(typeof lazyFlowPlugin.source).toBe('object')
    }
  })
})
