# lazy-flow

**Delivery intelligence for engineering managers — ask questions about your team in plain English, right inside Claude Code.**

lazy-flow pulls your team's GitHub and Jira activity into a private local database, then lets you *ask Claude* about it: how fast you're shipping, where work gets stuck, whether you're delivering what you committed to, and how individuals are tracking. It's the kind of insight you'd get from Pluralsight Flow or LinearB — except it runs entirely on your machine, nothing is sent to any server, and you query it by chatting, not by building dashboards.

> **Privacy first.** All data lives in a local SQLite file on your machine. There is no external service, no telemetry, and nothing leaves your laptop. Claude reads the local database directly to answer your questions.

---

## What you can use it for

- **Run a sprint or monthly review** — generate a delivery report covering speed, stability, bottlenecks, and commitment.
- **Find where work gets stuck** — see which stage of your flow (review, QA, deploy) is eating cycle time.
- **Prep for 1:1s** — pull an individual engineer's contribution and growth profile.
- **Spot key-person risk** — find code only one person understands (bus factor).
- **Check onboarding health** — see how recently-joined engineers are ramping.
- **Catch regressions early** — surface metrics that have drifted or degraded since last period.
- **Answer leadership questions** — "are we getting faster?", "where did our effort go this quarter?", "when will the backlog clear?"

You don't learn a query language or click through dashboards — you ask, and Claude runs the right metrics and explains the answer.

---

## Setup

### 1. Install the plugin

In Claude Code:

```
/plugin marketplace add https://github.com/Ricky-Stevens/lazy-flow
/plugin install lazy-flow
```

The server starts automatically — there's nothing to build or compile.

> If `/reload-plugins` misbehaves, just open a new Claude Code session.

### 2. Connect GitHub

lazy-flow uses your **existing GitHub login**. If you're already signed in with the GitHub CLI (`gh auth login`), you're done — leave the **GitHub Token** field blank when prompted and it'll use your `gh` account automatically.

Only set a token explicitly if you *aren't* using `gh` (or want a dedicated one): paste a GitHub Personal Access Token with read access to the repos you track.

### 3. Connect Jira (optional)

If you want Jira data alongside GitHub, provide:

- **Jira API Token** — create one at [id.atlassian.com → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- **Jira Account Email** — your Atlassian login email (required, or every Jira call is rejected)
- **Jira Base URL** — e.g. `https://yourcompany.atlassian.net`

### 4. Tell it which repos and projects to track

When prompted (or in config — see [For administrators](#for-administrators)):

- **GitHub Repositories** — comma-separated, e.g. `acme/web,acme/api`. Use `acme/*` to track every repo in an org.
- **Jira Project Keys** — comma-separated, e.g. `ENG,INFRA`

### 5. Verify and pull your data

Ask Claude:

> **"Run doctor"** — confirms your tokens, repos, and database are all set up correctly.

> **"Run a full sync"** — pulls your history into the local database (this can take a few minutes the first time, depending on how many repos and how much history).

That's it. From here you just ask questions.

---

## Using it: just ask

Once data is synced, talk to Claude in plain language. A few examples of what you can ask:

**Delivery speed & stability**
> "How fast are we shipping this quarter? Show me DORA metrics."
> "Has our lead time improved since last month?"
> "What's our change failure rate, and is it trending up?"

**Where work gets stuck**
> "Where is work getting stuck in our delivery flow?"
> "Which pull requests have been sitting without review the longest?"
> "How long does work spend in code review vs actually being worked on?"

**Predictability & commitment**
> "Are we delivering what we commit to each sprint?"
> "When will the current backlog realistically clear?" *(Monte Carlo forecast)*
> "How accurate are our story-point estimates?"

**People & team health** *(uses the skills below)*
> "Review the squad — how's the team doing and where are the risks?"
> "How is Priya tracking this quarter? I've got a 1:1 with her."
> "Where's our bus-factor risk — what code does only one person understand?"
> "How are our new joiners ramping compared to the team?"

**Investment & reporting**
> "How much of our effort went to features vs bugs vs maintenance?"
> "Generate a sprint review report."
> "What's regressed or drifted since last month?"

If you ever want to know *how* a number is calculated, ask **"Explain the lead-time metric"** and Claude will return the exact formula and data sources.

---

## Metrics it tracks

lazy-flow computes a deterministic catalogue across five areas. You don't need to memorise these — Claude picks the right ones for your question — but here's what's under the hood.

### DORA (speed & stability)
| Metric | What it tells you |
|---|---|
| Deployment frequency | How often you ship |
| Lead time for changes | Commit → production |
| Change failure rate | % of deploys that cause incidents |
| Mean time to recovery (MTTR) | How fast you recover from failures |
| Deployment rework rate | Churn introduced by deploys |

### Flow (where work goes)
| Metric | What it tells you |
|---|---|
| Cycle time | Start → done for a unit of work |
| Flow efficiency | Active time vs waiting time |
| Aging WIP | How old your in-progress work is |
| Throughput | Items completed per period |
| Time in status | Where work sits and waits |
| WIP load | How much is in flight at once |
| Monte Carlo forecast | Probabilistic "when will it be done" |

### Pull requests (the review pipeline)
| Metric | What it tells you |
|---|---|
| PR size | How big changes are |
| Review latency | Time to first review |
| Review coverage | How much gets reviewed |
| CI health | Build/test reliability |
| Stale PRs | Open PRs going quiet |

### Code health
| Metric | What it tells you |
|---|---|
| Complexity delta | Is the code getting harder to maintain |
| Maintainability index | Overall maintainability score |
| Rework churn | Code rewritten shortly after merge |
| Change impact / risk | Blast radius of changes |

### Agile (commitment)
| Metric | What it tells you |
|---|---|
| Velocity | Points/items completed per sprint |
| Say/do ratio | Committed vs delivered |
| Sprint predictability | Consistency of delivery |
| Estimation accuracy | Estimate vs actual |
| Priority mix | What kinds of work you focus on |

### Per-person signals
Around two dozen individual signals — work-type mix, knowledge ownership, review depth and mentorship, PR atomicity, ticket linkage, and more — feed the people-focused workflows below.

> **A note on the people metrics:** every comparative claim carries its basis — sample size, coverage, and confidence — and comparisons against a thin peer group (fewer than 8) are flagged as provisional rather than presented as firm. These are meant to *inform* a manager's judgement, not to rank or gatekeep.

---

## Pre-built workflows

For common management questions there are ready-made workflows you invoke as slash commands. They chain the right metrics, interpret the results, and produce a manager-facing summary.

| Command | Answers |
|---|---|
| `/lazy-flow:squad-review` | "Review the squad" — team metrics, per-person map, and risks |
| `/lazy-flow:person-profile` | "How is X doing?" — one engineer's profile |
| `/lazy-flow:bus-factor` | "Where's our key-person risk?" |
| `/lazy-flow:onboarding-health` | "How are newer contributors ramping?" |
| `/lazy-flow:verdicts` | Run the qualitative (LLM-judged) assessments |
| `/lazy-flow:ai-authorship` | Adjudicate ambiguous AI-vs-human authorship cases |

There are also dispatchable agents (`flow-analyst`, `squad-reviewer`, `person-reviewer`, `anomaly-scout`) for deeper, multi-step analysis.

---

## Keeping it up to date

Your data is a local snapshot, so refresh it before a review:

> **"Run an incremental sync"** — pulls only what's changed since last time (fast; this is the default). Do this before any review or report.

> **"Run a full sync"** — re-pulls complete history. You rarely need this — only after adding new repos/projects or if you suspect gaps.

You can sync just one source if you like: *"sync only GitHub."* Syncs are idempotent — running one twice does no harm.

**To update the plugin itself** when a new version ships: open `/plugins` → **Marketplaces** → lazy-flow → **Update marketplace**, then **Browse Plugins** → lazy-flow → **Update**, then start a new session. To remove it: `/plugin uninstall lazy-flow`.

---

## For administrators

### Team-wide install (config as code)

Commit this to your consuming repo's `.claude/settings.json` so every team member gets the plugin pre-configured:

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
        "repos": "acme/web,acme/api",
        "jira_projects": "ENG",
        "jira_email": "you@acme.com",
        "jira_base_url": "https://acme.atlassian.net"
      }
    }
  }
}
```

- `repos` and `jira_projects` are **comma-separated strings**, not JSON arrays.
- **Whole-org tracking:** use `"repos": "acme/*"` to track every repo in an org (excludes archived repos and forks; can be mixed with explicit entries, e.g. `"acme/*,other/special"`). Org enumeration relies on GitHub's org-repos listing, which can return nothing for an SSO/OAuth-restricted token even when that token can read individual repos — if a wildcard resolves to 0 repos the sync warns rather than failing silently.
- Each member is still prompted once for their own secret tokens (stored in the OS keychain). The GitHub token is optional — members already signed in via `gh auth login` can leave it blank.

### Org enforcement (optional)

Add to your org's managed Claude Code settings to pin the marketplace:

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

---

## For contributors

This is a plain modern-ESM JavaScript project run directly under [Bun](https://bun.sh) (>=1.3.0) — **no build step**. The plugin runs from source: Bun executes `src/mcp-server/index.js`, which the plugin manifest launches directly. It runs under Bun because it imports `bun:sqlite` and resolves grammar WASM assets from `node_modules/tree-sitter-wasms` at runtime.

```sh
bun install
```

| Command | Description |
|---|---|
| `bun run format` | Auto-format all files with Biome |
| `bun run lint` | Lint with Biome |
| `bun test` | Run the test suite (Bun's native runner) |
| `bun run check` | Lint + test |

For local plugin development against an unbuilt checkout:

```sh
claude --plugin-dir /path/to/lazy-flow
```

Under the hood, the raw metrics are exposed as MCP tools Claude calls directly — `get_dora`, `get_flow`, `get_pr_metrics`, `get_code_metrics`, `get_agile_metrics`, `get_person_report`, `data_overview`, `query_db`, `explain_metric`, `run_sync`, `sync_status`, `doctor`, and `export`. The skills and agents are workflows layered on top of these. Once data is synced, Claude can also query the local SQLite database directly via `query_db` (see the `lazy-flow://schema` resource).
