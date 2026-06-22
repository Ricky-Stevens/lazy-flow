/**
 * lazy-flow MCP server entry point.
 *
 * Constructs config + BunSqliteStore + clients and starts the server on stdio.
 * Wired by .claude-plugin/plugin.json:
 *   `bun ${CLAUDE_PLUGIN_ROOT}/src/mcp-server/index.js`
 *
 * The plugin runs from source under Bun — there is no build step. Grammar WASM
 * files resolve from node_modules/tree-sitter-wasms at runtime via
 * createRequire(import.meta.url) inside code-analysis, so no grammar-dir
 * override is needed.
 *
 * Secrets come from env vars only — NEVER logged or included in outputs.
 * See ./config.js for the full list.
 */

import { BunSqliteStore, migrate } from '../core/index.js'
import { GitHubClient } from '../ingest-github/index.js'
import { JiraClient } from '../ingest-jira/index.js'
import { githubTokenFromGhCli, loadConfig } from './config.js'
import { startServer } from './server.js'

async function main() {
  const config = loadConfig()

  // No token from the environment? Fall back to the locally-authenticated GitHub
  // CLI (`gh auth login`), so a local-first user need not paste a PAT — sync runs
  // as their gh account against repos that account can see. Done here (not in
  // loadConfig) to keep config loading pure; returns null if gh is unavailable.
  if (config.githubToken === null) {
    config.githubToken = githubTokenFromGhCli()
  }

  // Open / migrate the SQLite DB
  const store = new BunSqliteStore(config.dbPath)
  // Run migrations up (forward-only in prod per SPEC §6.4)
  migrate(store.db)

  // Build clients — only when tokens are available
  const githubClient =
    config.githubToken !== null ? new GitHubClient({ token: config.githubToken }) : null

  const jiraClient =
    config.jiraToken !== null && config.jiraBaseUrl !== ''
      ? new JiraClient({
          baseUrl: config.jiraBaseUrl,
          token: config.jiraToken,
          email: config.jiraEmail,
        })
      : null

  const ctx = {
    config,
    store,
    githubClient,
    jiraClient,
  }

  await startServer(ctx)
}

main().catch((err) => {
  // Write to stderr only — never stdout (MCP protocol is on stdout)
  process.stderr.write(`lazy-flow MCP server fatal error: ${String(err)}\n`)
  process.exit(1)
})
