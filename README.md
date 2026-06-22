# lazy-flow

lazy-flow brings your team's GitHub and Jira activity together in a private local database and lets you interrogate it: how the team is delivering, where work stalls, whether it hits its commitments, and how each engineer is performing against their own track record and the team's norms. It is the category of insight you would get from Pluralsight Flow or LinearB — built for the engineering manager who wants answers rather than dashboards — except it runs entirely on your own machine and you get those answers by asking, not by configuring reports.

**Who it's for:** engineering managers, team leads, and heads of engineering who need a clear, defensible read on team delivery and individual performance — for reviews, 1:1s, planning, and reporting upward.

> **Private by design.** Everything lives in a local SQLite file on your machine. There is no external service, no telemetry. Claude reads the local database directly to answer your questions.

---

## What it does

- **Assess team delivery** — speed, stability, predictability, and flow health across a sprint, month, or quarter.
- **Understand individual performance** — see how each engineer is tracking against their own baseline and the team distribution, with the evidence behind every reading. Built for review prep and 1:1s.
- **Find where delivery stalls** — identify which stage (review, QA, deploy) is consuming cycle time.
- **Surface risk** — key-person / bus-factor concentration, work that has gone quiet, and metrics that have regressed since the last period.
- **Check ramp** — how recently-joined engineers are progressing relative to the team.
- **Track AI adoption** — what share of the team's merged work is AI-assisted, and how that is trending.
- **Report upward** — produce a review covering delivery, investment mix, and a delivery forecast; answer questions like "are we getting faster?", "where did this quarter's effort go?", and "when will the backlog realistically clear?"

You do not learn a query language or maintain dashboards. You ask a question, and Claude runs the right metrics and explains the result — along with the basis for it.

---

## A note on measuring people

lazy-flow is designed to help a manager form a fair, evidence-backed picture of how individuals are performing — not to rank engineers or generate a leaderboard.

Every individual reading is framed against that person's **own history and the team distribution**, and every comparative claim carries its basis: sample size, coverage, and confidence. Comparisons against a thin peer group (fewer than eight) are flagged as provisional rather than presented as firm. The output is there to **inform a manager's judgement**, not to replace it or to gatekeep.

---

## Setup

### 1. Install the plugin

In Claude Code:

```
/plugin marketplace add https://github.com/Ricky-Stevens/lazy-flow
/plugin install lazy-flow
```

The server starts automatically — there is nothing to build or compile.

> If `/reload-plugins` misbehaves, open a new Claude Code session.

### 2. Connect GitHub

lazy-flow uses your **existing GitHub login**. If you are already signed in with the GitHub CLI (`gh auth login`), you are done — leave the **GitHub Token** field blank when prompted and it will use your `gh` account.

Set a token explicitly only if you are *not* using `gh` (or want a dedicated one): paste a GitHub Personal Access Token with read access to the repositories you intend to track.

### 3. Connect Jira (optional)

To include Jira data alongside GitHub, provide:

- **Jira API Token** — create one at [id.atlassian.com → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- **Jira Account Email** — your Atlassian login email (required, or every Jira call is rejected)
- **Jira Base URL** — e.g. `https://yourcompany.atlassian.net`

### 4. Choose the repositories and projects to track

When prompted (or in config — see [For administrators](#for-administrators)):

- **GitHub Repositories** — comma-separated, e.g. `acme/web,acme/api`. Use `acme/*` to track every repository in an organisation.
- **Jira Project Keys** — comma-separated, e.g. `ENG,INFRA`

### 5. Verify and load your data

Ask Claude:

> **"Run doctor"** — confirms your tokens, repositories, and database are configured correctly.

> **"Run a full sync"** — loads your history into the local database. The first run can take a few minutes, depending on how many repositories and how much history are in scope.

From there, you ask questions.

---

## Using it — ask in plain language

Once data is synced, put your question to Claude directly. Some examples of what managers ask:

**Team delivery — speed and stability**
> "How fast is the team shipping this quarter? Show me the DORA metrics."
> "Has our lead time improved since last month?"
> "What is our change failure rate, and is it trending up?"

**Where delivery stalls**
> "Where is work getting stuck in our delivery flow?"
> "Which pull requests have been waiting on review the longest?"
> "How long does work spend in code review versus actually being worked on?"

**Predictability and commitment**
> "Are we delivering what we commit to each sprint?"
> "When will the current backlog realistically clear?" *(Monte Carlo forecast)*
> "How accurate are our story-point estimates?"

**People and team health**
> "Review the squad — how is the team doing and where are the risks?"
> "How is Priya performing this quarter? I have a 1:1 with her."
> "Where is our bus-factor risk — what code does only one person understand?"
> "How are our new joiners ramping compared to the team?"

**Investment and reporting**
> "How much of our effort went to features versus bugs versus maintenance?"
> "Generate a sprint review report."
> "What has regressed or drifted since last month?"

To see how any number is produced, ask **"Explain the lead-time metric"** and Claude returns the exact formula and data sources.

---

## What it measures

lazy-flow computes a deterministic catalogue across five core areas — plus per-person performance signals and AI-adoption detection. You do not need to memorise these — Claude selects the right ones for your question — but here is what it covers.

### DORA (speed and stability)
| Metric | What it tells you |
|---|---|
| Deployment frequency | How often the team ships |
| Lead time for changes | Commit → production |
| Change failure rate | Share of deploys that cause incidents |
| Mean time to recovery (MTTR) | How quickly the team recovers from failures |
| Deployment rework rate | Churn introduced by deploys |

### Flow (where work goes)
| Metric | What it tells you |
|---|---|
| Cycle time | Start → done for a unit of work |
| Flow efficiency | Active time versus waiting time |
| Aging WIP | How old in-progress work is |
| Throughput | Items completed per period |
| Time in status | Where work sits and waits |
| WIP load | How much is in flight at once |
| Monte Carlo forecast | Probabilistic "when will it be done" |

### Pull requests (the review pipeline)
| Metric | What it tells you |
|---|---|
| PR size | How large changes are |
| Review latency | Time to first review |
| Review coverage | How much gets reviewed |
| CI health | Build / test reliability |
| Stale PRs | Open PRs that have gone quiet |

### Code health
| Metric | What it tells you |
|---|---|
| Complexity delta | Whether the code is getting harder to maintain |
| Maintainability index | Overall maintainability score |
| Rework churn | Code rewritten shortly after merge |
| Change impact / risk | Blast radius of changes |

### Agile (commitment)
| Metric | What it tells you |
|---|---|
| Velocity | Points / items completed per sprint |
| Say/do ratio | Committed versus delivered |
| Sprint predictability | Consistency of delivery |
| Estimation accuracy | Estimate versus actual |
| Priority mix | What kinds of work the team focuses on |

### Individual performance
Around two dozen per-person signals — work-type mix, knowledge ownership, review depth and mentorship, change atomicity, ticket linkage, and more — power the people-focused reviews below. Each is read against the engineer's own history and the team distribution (see [A note on measuring people](#a-note-on-measuring-people)).

### AI adoption
Detects AI-assisted authorship across commits and pull requests using tool-agnostic heuristics, so you can see what share of the team's merged work is AI-assisted and how that is trending. Ambiguous cases can be adjudicated with the `ai-authorship` review below.

---

## Pre-built reviews

For the questions managers ask most often, lazy-flow ships ready-made reviews you invoke as slash commands. Each chains the right metrics, interprets the results, and produces a manager-facing summary.

| Command | Answers |
|---|---|
| `/lazy-flow:squad-review` | "Review the squad" — team metrics, a per-person contribution map, and risks |
| `/lazy-flow:person-profile` | "How is this engineer performing?" — one person's profile against their baseline and the team |
| `/lazy-flow:bus-factor` | "Where is our key-person risk?" |
| `/lazy-flow:onboarding-health` | "How are newer engineers ramping?" |
| `/lazy-flow:verdicts` | Run the qualitative (LLM-judged) assessments |
| `/lazy-flow:ai-authorship` | Adjudicate ambiguous AI-versus-human authorship cases |

Deeper, multi-step analysis is available through dispatchable agents — `flow-analyst`, `squad-reviewer`, `person-reviewer`, and `anomaly-scout`.

---

## Keeping your data current

Your data is a local snapshot, so refresh it before a review:

> **"Run an incremental sync"** — pulls only what has changed since last time (fast; this is the default). Do this before any review or report.

> **"Run a full sync"** — re-pulls complete history. Rarely needed — only after adding repositories or projects, or if you suspect gaps.

You can sync a single source — *"sync only GitHub."* Syncs are idempotent, so running one twice does no harm.

**To update the plugin** when a new version ships: open `/plugins` → **Marketplaces** → lazy-flow → **Update marketplace**, then **Browse Plugins** → lazy-flow → **Update**, then start a new session. To remove it: `/plugin uninstall lazy-flow`.

