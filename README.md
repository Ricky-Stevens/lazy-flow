# lazy-flow

An open-source, self-hostable software-delivery intelligence platform that matches Pluralsight Flow on
the deterministic metric catalogue and beats it on insight — by owning explainable AI judgment, a unified
GitHub + Jira value stream, and radical transparency shipped where engineers already work (Claude Code).

See [docs/SPEC.md](docs/SPEC.md) for the full product specification.

## Getting started

```sh
npm install
```

## Scripts

| Command | Description |
|---|---|
| `npm run format` | Auto-format all files with Biome |
| `npm run lint` | Lint with Biome |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm test` | Run all tests with Vitest |
| `npm run check` | Run lint + typecheck + test |

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
        "jira_projects": ["ENG"],
        "visibility": "public"
      }
    }
  }
}
```

3. **On first launch**, Claude Code prompts each team member once to set secrets (stored in the OS keychain):
   - `github_token` — GitHub PAT or App installation token
   - `jira_oauth_token` — Jira Cloud OAuth 2.0 token (optional)
   - `anthropic_api_key` — Anthropic API key (optional, for AI insights)

4. **The MCP server starts automatically** next session. No build/install step required — the bundled `server.js` is pre-built and ships in the repo at `packages/mcp-server/server/dist/server.js`.

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
| `/lazy-flow:anomaly` | AI-cited anomaly explanation |
| `/lazy-flow:align` | Ticket-work alignment for a PR |
| `/lazy-flow:config` | Health check + configuration guide |
| `/lazy-flow:identities` | Review/confirm fuzzy identity matches |
| `/lazy-flow:contest` | Contest or correct an AI verdict |

### Bundled artifact

The MCP server bundle (`packages/mcp-server/server/dist/server.js` + `grammars/`) is committed to the repo and excluded from `.gitignore` so it ships with no build step on the host. To rebuild it after changes:

```sh
cd packages/mcp-server && npm run build
```

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
