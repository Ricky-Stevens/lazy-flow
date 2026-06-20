---
description: Map knowledge concentration and bus-factor risk across the squad — who solely owns which parts of the codebase, what share of total complexity sits in one person's head, and where to spread it via pairing/review. Ranks contributors by concentration risk and recommends mitigations; reads high ownership as both real contribution and a key-person liability. Use for "bus factor", "key-person risk", "who owns what".
---

# /lazy-flow:bus-factor

Surfaces concentration risk: "where would we hurt if this person left?" Read
ownership as **two-sided** — it is real contribution *and* a key-person
liability. Name both; don't treat "owns the most" as automatically "best" or
automatically "a problem".

## Steps
1. Resolve the human roster (exclude bots) via `query_db` single-table joins, as
   in `/lazy-flow:squad-review`.
2. For each human, call `get_person_report` and read
   `person.knowledge_ownership_index`:
   - `value` (sum of cyclomatic complexity over solely-owned paths)
   - `busFactor1Paths` (paths with ≥0.8 share and a single contributor)
   - `ownedShareOfRepoComplexity` (their slice of the whole)
   - `evidencePaths` (concrete files to start de-risking)
3. Also read `person.skill_domain_footprint` (depth/breadth) to see whether a
   domain has only one deep owner (coverage gap).

## Present
- A ranked-by-risk table (this is ranking *risk*, which is legitimate — not
  ranking people): person, ownership %, bus-factor-1 path count, top domains.
- The headline: combined share owned by the top 1–2 people (e.g. "two engineers
  solely own ~77% of complexity").
- Concrete mitigations tied to `evidencePaths`: pairing rotations, review
  ownership spread, and steering newer contributors (see
  `/lazy-flow:onboarding-health`) into the concentrated areas.

## Contract
Rank and report concentration risk plainly — naming who owns what is the point.
Read ownership as two-sided: it is real contribution AND a single-point-of-failure
the team should de-risk, so pair the verdict with mitigation, not blame. Attach
sample size / coverage / confidence to comparative claims; where data is thin, say
so. The fair headline is "where would we hurt if this person left" — a team-design
action, not only an individual score.
