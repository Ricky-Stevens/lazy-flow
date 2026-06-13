# lazy-flow

An open-source, local-first software-delivery intelligence platform that rivals Pluralsight Flow on the
deterministic metric catalogue (DORA, Flow, PR, Code, Agile) over a unified GitHub + Jira value stream —
captured into a local SQLite database that **Claude queries directly over SQL**, right where engineers
already work (Claude Code). No data ever leaves your machine; no external service, no telemetry.

## Getting started

This is a Bun project — install [Bun](https://bun.sh) (>=1.3.0), then:

```sh
bun install
```

## Scripts

The project is plain modern ESM JavaScript run directly under Bun — there is no
build step and the test suite uses Bun's native test runner.

| Command | Description |
|---|---|
| `bun run format` | Auto-format all files with Biome |
| `bun run lint` | Lint with Biome |
| `bun test` | Run all tests with Bun's native test runner |
| `bun run check` | Run lint + test |

## Claude Code plugin install

### Team-wide install (recommended)

1. **Host the marketplace** — this repo *is* the marketplace. No separate hosting needed; Claude Code resolves it from GitHub.

2. **Commit to your consuming repo's `.claude/settings.json`:**

```jsonc
{
  "extraKnownMarketplaces": {
    "lazy-flow": {
      "source": { "source": "github", "repo": "ORG/lazy-flow" }
    }
  },
  "enabledPlugins": {
    "lazy-flow@lazy-flow": true
  },
  "pluginConfigs": {
    "lazy-flow": {
      "options": {
        "repos": ["ORG/app", "ORG/api"],
        "jira_projects": ["ENG"]
      }
    }
  }
}
```

3. **On first launch**, Claude Code prompts each team member once to set secrets (stored in the OS keychain):
   - `github_token` — GitHub PAT or App installation token
   - `jira_oauth_token` — Jira Cloud OAuth 2.0 token (optional)

4. **The MCP server starts automatically** next session. No build/install step required — Bun runs the server straight from source at `src/mcp-server/index.js`. Once data is synced, Claude can query the local SQLite database directly via the `query_db` tool (see the `lazy-flow://schema` resource).

### Available slash commands

| Command | Description |
|---|---|
| `/lazy-flow:sync` | Trigger GitHub + Jira sync, show freshness |
| `/lazy-flow:dora` | DORA metrics with band classification |
| `/lazy-flow:flow` | Cycle time, flow efficiency, WIP, CFD |
| `/lazy-flow:pr` | PR review health, 4-phase cycle time |
| `/lazy-flow:code` | HALOC, rework/churn, complexity deltas |
| `/lazy-flow:agile` | Velocity, say/do, sprint predictability |
| `/lazy-flow:forecast` | Monte Carlo delivery forecast |
| `/lazy-flow:me` | Personal metrics (self scope) |
| `/lazy-flow:team` | Team-level cross-dimension view |
| `/lazy-flow:org` | Org-level aggregate view |
| `/lazy-flow:explain` | Formula + methodology for any metric |
| `/lazy-flow:report` | Generate an exportable HTML/MD/CSV/JSON report |
| `/lazy-flow:config` | Health check + configuration guide |
| `/lazy-flow:identities` | Review/confirm fuzzy identity matches |

### Runs from source under Bun

There is no build step. The plugin runs directly from source — Bun executes
`src/mcp-server/index.js`, which is what the plugin manifest launches. A Claude
marketplace plugin is copied as-is with no install or build on the user's
machine, and Bun transpiles and runs the JavaScript source on the fly. It is
launched under the Bun runtime because it imports `bun:sqlite` and grammar WASM
assets resolve from `node_modules/tree-sitter-wasms` at runtime.

### Org enforcement (optional)

Add to your org's managed Claude Code settings:

```jsonc
{
  "strictKnownMarketplaces": true,
  "extraKnownMarketplaces": {
    "lazy-flow": {
      "source": { "source": "github", "repo": "ORG/lazy-flow" }
    }
  }
}
```
