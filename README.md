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
      "source": { "source": "github", "repo": "Ricky-Stevens/lazy-flow" }
    }
  },
  "enabledPlugins": {
    "lazy-flow@lazy-flow": true
  },
  "pluginConfigs": {
    "lazy-flow": {
      "options": {
        "repos": "ORG/app,ORG/api",
        "jira_projects": "ENG",
        "jira_email": "you@acme.com",
        "jira_base_url": "https://acme.atlassian.net"
      }
    }
  }
}
```

> `repos` and `jira_projects` are **comma-separated strings** (not JSON arrays).
> `jira_email` and `jira_base_url` are required for any Jira sync (see step 3).

> **Whole-org tracking:** instead of listing each repo, use the wildcard
> `"repos": ["ORG/*"]` to track every repository in an organisation. It excludes
> archived repos and forks, and can be mixed with explicit entries
> (`["ORG/*", "OTHER/special"]`). Note: org enumeration uses GitHub's org-repos
> listing, which can return nothing for an SSO/OAuth-restricted token even when
> that token can read individual repos — if a wildcard resolves to 0 repos the
> sync surfaces a warning rather than failing silently.

3. **On first launch**, Claude Code prompts each team member once to set the secret tokens (stored in the OS keychain):
   - `github_token` — GitHub PAT or App installation token (**required**)
   - `jira_oauth_token` — Jira Cloud **API token** (create at id.atlassian.com → API tokens); required only if you want Jira sync

   Jira sync also needs two **non-secret** values, set in `options` above: `jira_email` (your Atlassian account email — required for Basic auth, otherwise every Jira call returns 403) and `jira_base_url` (e.g. `https://acme.atlassian.net`). Run the `doctor` tool after setup — it reports exactly which of these is missing.

4. **The MCP server starts automatically** next session. No build/install step required — Bun runs the server straight from source at `src/mcp-server/index.js`. Once data is synced, Claude can query the local SQLite database directly via the `query_db` tool (see the `lazy-flow://schema` resource).

### Skills (question-shaped workflows)

The raw metrics are MCP tools Claude calls directly (`get_dora`, `get_flow`,
`get_pr_metrics`, `get_code_metrics`, `get_agile_metrics`, `data_overview`,
`query_db`, `explain_metric`, `run_sync`, …). The **skills** package the
multi-step *management* workflows on top of those tools — they chain the calls,
interpret the results, and produce manager-facing evaluations (ranking and
recommendations), each verdict carrying its confidence basis.

| Skill | Answers |
|---|---|
| `/lazy-flow:squad-review` | "Review the squad" — team metrics + per-person map + risks |
| `/lazy-flow:person-profile` | "How is X doing?" — one engineer's evaluation profile |
| `/lazy-flow:bus-factor` | "Where's our key-person risk?" — ownership/bus-factor map |
| `/lazy-flow:onboarding-health` | "How are newer contributors ramping?" |
| `/lazy-flow:verdicts` | Run the in-session LLM verdict pipeline (qualitative metrics) |
| `/lazy-flow:ai-authorship` | Adjudicate the ambiguous-band AI-vs-human authorship verdicts |

### Agents (dispatchable subagents)

| Agent | Role |
|---|---|
| `flow-analyst` | Narrates team delivery metrics; never computes, only reports tool values |
| `squad-reviewer` | Runs the end-to-end squad review workflow |
| `person-reviewer` | Builds one engineer's evaluation profile |
| `verdict-runner` | Drives the verdict pipeline (backfill diffs → judge → record) |
| `anomaly-scout` | Scans for regressions, drift, data-quality gaps, team risks |

All skills and agents produce **manager-facing evaluations** — they rank, name
top performers and development needs, and recommend actions. The one guard kept:
no verdict is asserted without its basis — sample size, cohort coverage, and
confidence travel with every comparative claim, and a comparison below the cohort
floor (< 8 peers) is marked provisional rather than presented as firm. It's open
data (GitHub + Jira); the tooling informs the manager's decision, it doesn't
gatekeep it.

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
      "source": { "source": "github", "repo": "Ricky-Stevens/lazy-flow" }
    }
  }
}
```
