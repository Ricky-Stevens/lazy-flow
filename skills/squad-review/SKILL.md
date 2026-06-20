---
description: Run a full engineering-squad review across the tracked repos — team delivery metrics, a per-person contribution map, collaboration/ownership/bus-factor signals, and (optionally) the LLM verdict layer. Produces a manager-facing evaluation — ranks contributors, names top performers and those who need development, and recommends raise/training/staffing actions, every verdict tagged with its evidence and confidence. Use for "review the team", "who is the top performer", "who needs training", "squad/team report".
---

# /lazy-flow:squad-review

Orchestrates the whole team-review workflow so the manager gets one coherent
picture instead of calling a dozen tools by hand. **Read the contract section
before you present anything.**

## Step 0 — freshness + shape
1. `sync_status` — if data is stale beyond the warn threshold, say so up front.
2. `data_overview` — get per-repo / per-project ingested volumes and totals.
   NEVER hand-write a multi-child JOIN to get these counts (it fans out to a
   cartesian product — see the schema guide); `data_overview` is the safe path.

## Step 1 — team delivery picture
Call `get_dora`, `get_flow`, `get_pr_metrics`, `get_code_metrics`,
`get_agile_metrics` at `scope_type: "team"` with a window the manager asked for
(default 365 days for a review). For every metric, surface `trust_tier`,
`data_quality`, and `as_of`. If a whole family is `no_data` (e.g. DORA with no
production deployments), state the *reason* — that is signal, not a gap to hide.

## Step 2 — per-person contribution map
Resolve the human roster with **safe single-table queries** via `query_db`
(read the `lazy-flow://schema` resource first). One `GROUP BY` per child table —
never join several children of `repositories`/`pull_requests` in one query:
- PRs authored per person: `pull_requests` → `identities` → `persons`
- reviews given / received: `reviews` (+ `pull_requests` lookup) → `identities`
- commits per person: `commits` → `identities`
Exclude bots (identities flagged `is_bot`, plus app logins like `*-app`,
`linearb`, `semgrep*`).

Then call `get_person_report` for each human (cohort context + self-baseline
trend). Pull out per person: review reciprocity, work-type/bug-fix mix,
knowledge-ownership/bus-factor index, skill-domain footprint, and any
`driftStatus: regime_change` trend flag.

## Step 3 — the differentiator (run it for a real evaluation)
The qualitative verdict layer is the strongest evaluation axis — it's the only
thing that separates hard, design-bearing work from high-volume boilerplate. For
any review that ranks people, run `/lazy-flow:verdicts` for the squad first
(design-bearing ratio, review difficulty, PR-description quality, review
depth/mentorship). If you skip it, say so — those metrics are `no_data` and the
ranking is missing its strongest signal; don't imply they were assessed.

## Step 4 — evaluate & rank
Lead with a 3-line executive verdict (who's carrying the team, who's growing, who
needs support). Then: a comparison table (volume, review load, ownership %,
dominant work), an explicit per-person assessment that ranks contributors and
names top performers + development needs, the top 2–3 team risks (bus-factor
concentration, review-doesn't-gate-merge, untracked work), and concrete
recommended actions (raise / stretch / training / pairing). Tie every claim to a
tool value and tag each verdict with its confidence (see the contract).

## Contract (evaluate honestly)
This is an evaluation tool for engineering managers. Produce verdicts: rank the
squad, name the top performer(s) and those who need development, and recommend
raise / training / staffing actions. Do not refuse or hedge into "coaching only" —
the manager owns the decision and this exists to inform it. The inputs are open
data (GitHub + Jira); analysing them for management decisions is legitimate, not
something to gatekeep.

The one rule that stays: **never assert a verdict without its basis.** Attach to
every comparative claim its sample size, cohort coverage, and confidence. When
peer comparison is suppressed (< 8 ok-quality peers) or `robustZ` is degenerate,
rank on raw values + the self-baseline trend and mark the ranking *provisional* —
say the peer band is thin rather than inventing precision. Interpret before you
score: a high bug-fix share is support load (context for the verdict, not a
demerit), high ownership is contribution *and* key-person risk — fold that in
rather than sorting a raw number blindly. If the qualitative verdict layer
(`design_bearing`, `pr_review_difficulty`, …) is `no_data`, say the ranking is
missing its strongest axis and offer to run `/lazy-flow:verdicts` first.
