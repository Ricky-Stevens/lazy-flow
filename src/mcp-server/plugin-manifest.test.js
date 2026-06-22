/**
 * Plugin manifest validation — WP-PLUGIN deliverable 8.
 *
 * Parses plugin.json and marketplace.json (both under .claude-plugin/) as valid
 * JSON, asserts required fields are present, checks that the inline mcpServers
 * args path points at the source entry (src/mcp-server/index.js — the plugin
 * runs from source under Bun, no build step), and verifies that every
 * ${user_config.*} referenced in the server env has a matching userConfig key.
 *
 * NOTE: the MCP server is declared INLINE in plugin.json (the recommended form
 * for a distributed plugin). The root .mcp.json is a local-dev-only convenience
 * and is git-ignored, so it is intentionally NOT validated here — a clean clone
 * (and CI) has no .mcp.json.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
// Repo root is 2 levels up from src/mcp-server/
const REPO_ROOT = resolve(__dirname, '..', '..')

async function readJson(filePath) {
  const text = await readFile(filePath, 'utf-8')
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// Extract ${user_config.*} references from an env block
// ---------------------------------------------------------------------------

function extractUserConfigRefs(env) {
  const refs = new Set()
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

const pluginJsonPath = join(REPO_ROOT, '.claude-plugin', 'plugin.json')

describe('plugin.json', () => {
  it('parses as valid JSON', async () => {
    const parsed = await readJson(pluginJsonPath)
    expect(parsed).toBeTruthy()
  })

  it('has required top-level fields', async () => {
    const plugin = await readJson(pluginJsonPath)
    expect(plugin.name).toBe('lazy-flow')
    expect(typeof plugin.displayName).toBe('string')
    expect(typeof plugin.description).toBe('string')
    // The plugin host requires `author` to be an OBJECT ({ name, email?, url? }),
    // never a bare string — asserting string here previously masked a real install
    // failure ("author: expected object, received string").
    expect(typeof plugin.author).toBe('object')
    expect(typeof plugin.author?.name).toBe('string')
    expect(plugin.license).toBe('MIT')
    expect(typeof plugin.repository).toBe('string')
    // mcpServers is declared inline (recommended for distribution), not a path.
    expect(typeof plugin.mcpServers).toBe('object')
  })

  it('has a userConfig block with expected sensitive secret keys', async () => {
    const plugin = await readJson(pluginJsonPath)
    const userConfig = plugin.userConfig
    expect(userConfig).toBeTruthy()

    // Secrets — must be sensitive: true
    for (const secretKey of ['github_token', 'jira_oauth_token']) {
      const entry = userConfig[secretKey]
      expect(entry, `userConfig.${secretKey} missing`).toBeTruthy()
      expect(entry?.sensitive, `${secretKey} must be sensitive`).toBe(true)
    }
  })

  it('has a userConfig block with expected non-sensitive config keys', async () => {
    const plugin = await readJson(pluginJsonPath)
    const userConfig = plugin.userConfig

    // Non-sensitive shared config keys (minimal set — only what's needed to operate)
    for (const configKey of ['repos', 'jira_projects', 'jira_base_url']) {
      const entry = userConfig[configKey]
      expect(entry, `userConfig.${configKey} missing`).toBeTruthy()
      expect(entry?.sensitive, `${configKey} must not be sensitive`).not.toBe(true)
    }
  })
})

describe('plugin.json — inline mcpServers', () => {
  it('has a lazy-flow mcpServer entry with required fields', async () => {
    const plugin = await readJson(pluginJsonPath)
    const servers = plugin.mcpServers
    expect(servers).toBeTruthy()
    const lazyFlow = servers['lazy-flow']
    expect(lazyFlow, 'lazy-flow server entry missing').toBeTruthy()
    // Launched under Bun because the bundle imports bun:sqlite.
    expect(lazyFlow?.command).toBe('bun')
    expect(Array.isArray(lazyFlow?.args)).toBe(true)
    expect(typeof lazyFlow?.env).toBe('object')
  })

  it('args path resolves to the source entry', async () => {
    // The args path uses ${CLAUDE_PLUGIN_ROOT} which resolves to the repo root.
    // The plugin runs from source under Bun — no build step.
    const sourceEntry = join(REPO_ROOT, 'src', 'mcp-server', 'index.js')
    expect(existsSync(sourceEntry), `Source MCP entry not found at ${sourceEntry}`).toBe(true)

    // The manifest must actually point at that source entry. The expected value
    // is assembled by concatenation so the ${...} is a literal, not a JS
    // template placeholder (it is substituted by the Claude plugin host).
    const expectedArg = `\${CLAUDE_PLUGIN_ROOT}/src/mcp-server/index.js`
    const plugin = await readJson(pluginJsonPath)
    const args = plugin.mcpServers['lazy-flow']?.args
    expect(args).toContain(expectedArg)
  })

  it('every user_config ref in env has a matching userConfig key', async () => {
    const plugin = await readJson(pluginJsonPath)
    const servers = plugin.mcpServers
    const lazyFlowServer = servers['lazy-flow'] ?? {}
    const env = lazyFlowServer.env
    const userConfig = plugin.userConfig

    const refs = extractUserConfigRefs(env)
    expect(refs.length).toBeGreaterThan(0)

    for (const ref of refs) {
      expect(
        userConfig[ref],
        `user_config.${ref} referenced in mcpServers env but missing from plugin.json userConfig`,
      ).toBeTruthy()
    }
  })
})

describe('marketplace.json', () => {
  const marketplaceJsonPath = join(REPO_ROOT, '.claude-plugin', 'marketplace.json')

  it('parses as valid JSON', async () => {
    const parsed = await readJson(marketplaceJsonPath)
    expect(parsed).toBeTruthy()
  })

  it('lists the lazy-flow plugin with required fields', async () => {
    const marketplace = await readJson(marketplaceJsonPath)
    expect(Array.isArray(marketplace.plugins)).toBe(true)
    const plugins = marketplace.plugins
    expect(plugins.length).toBeGreaterThan(0)

    const lazyFlowPlugin = plugins.find((p) => p.name === 'lazy-flow')
    expect(lazyFlowPlugin, 'lazy-flow plugin missing from marketplace.json').toBeTruthy()

    if (lazyFlowPlugin) {
      expect(typeof lazyFlowPlugin.displayName).toBe('string')
      expect(typeof lazyFlowPlugin.description).toBe('string')
      expect(lazyFlowPlugin.license).toBe('MIT')
      // `source` may be a relative-path/URL STRING (canonical for a plugin
      // co-located in the marketplace repo, e.g. "./") OR an object form
      // (github/url/npm/git-subdir). Both are valid per the marketplace schema;
      // assert it's present and well-formed without forcing the object shape.
      const src = lazyFlowPlugin.source
      const validSource =
        (typeof src === 'string' && src.length > 0) || (typeof src === 'object' && src !== null)
      expect(validSource).toBe(true)
    }
  })
})
