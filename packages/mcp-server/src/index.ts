/**
 * lazy-flow MCP server entry point.
 *
 * Constructs config + NodeSqliteStore + clients and starts the server on stdio.
 * Wired by .mcp.json: `node ${CLAUDE_PLUGIN_ROOT}/server/dist/server.js`
 *
 * Secrets come from env vars only — NEVER logged or included in outputs.
 * See src/config.ts for the full list.
 *
 * WASM grammar override (SPEC §12.3 / WP-E2E):
 *   When running from the bundle, setGrammarDir() redirects grammar resolution
 *   to server/dist/grammars/ (next to server.js) via import.meta.url, rather
 *   than require.resolve() against node_modules (which won't exist on a plugin
 *   host).  Must be called before any analyzeComplexity() invocation.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnthropicLlmClient } from '@lazy-flow/ai'
import { setGrammarDir } from '@lazy-flow/code-analysis'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { GitHubClient } from '@lazy-flow/ingest-github'
import { JiraClient } from '@lazy-flow/ingest-jira'
import { loadConfig } from './config.js'
import type { ServerContext } from './server.js'
import { startServer } from './server.js'

async function main(): Promise<void> {
  // Wire WASM grammar dir to server/dist/grammars/ (next to this file after bundling).
  // import.meta.url in the bundle resolves to the server.js file path.
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  setGrammarDir(join(bundleDir, 'grammars'))

  const config = loadConfig()

  // Open / migrate the SQLite DB
  const store = new NodeSqliteStore(config.dbPath)
  // Run migrations up (forward-only in prod per SPEC §6.4)
  migrate(store.db)

  // Build clients — only when tokens are available
  const githubClient =
    config.githubToken !== null ? new GitHubClient({ token: config.githubToken }) : null

  const jiraClient =
    config.jiraToken !== null && config.jiraBaseUrl !== ''
      ? new JiraClient({ baseUrl: config.jiraBaseUrl, token: config.jiraToken })
      : null

  const llmClient =
    config.anthropicApiKey !== null
      ? new AnthropicLlmClient({ apiKey: config.anthropicApiKey })
      : null

  const ctx: ServerContext = {
    config,
    store,
    githubClient,
    jiraClient,
    llmClient,
  }

  await startServer(ctx)
}

main().catch((err) => {
  // Write to stderr only — never stdout (MCP protocol is on stdout)
  process.stderr.write(`lazy-flow MCP server fatal error: ${String(err)}\n`)
  process.exit(1)
})
