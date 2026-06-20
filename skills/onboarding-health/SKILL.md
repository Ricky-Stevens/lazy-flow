---
description: Assess how newer or ramping contributors are progressing — trajectory (self-baseline drift, complexity regime-change), PR-size discipline, test/ticket hygiene, and which owned areas they could grow into. Gives a clear verdict on whether each is on track, needs support, or is stalled, with concrete development actions. Use for "how are the juniors doing", "onboarding health", "is X ramping up".
---

# /lazy-flow:onboarding-health

A development lens for contributors who are newer, lower-volume, or visibly
ramping. Give a clear verdict on trajectory — on track / needs support / stalled —
and the actions that would help. Lower volume is expected context for newer
people, not an automatic mark against them.

## Steps
1. Identify candidates: lower PR/commit volume and/or low
   `knowledge_ownership_index`, OR anyone the manager names. Roster via the safe
   `query_db` joins from `/lazy-flow:squad-review`.
2. For each, call `get_person_report` and focus on **trajectory over position**:
   - the `trend` array — especially `driftStatus: "regime_change"` on
     `person.complexity_authored_delta` (taking on harder work) or rising
     `bugfix_share`/coverage.
   - `person.wip_small_pr_discipline` + `medianHaloc` (are they shipping in
     reviewable batches?).
   - `person.test_inclusion_rate`, `person.ticket_linkage_rate`,
     `person.ci_green_before_merge_rate` (process hygiene that's coachable early).
   - `person.skill_domain_footprint` (where they work now → where to stretch).
3. Cross-reference `/lazy-flow:bus-factor`: a great onboarding move is to pair a
   ramping contributor into a concentrated owner's area — grows them AND
   de-risks the team.

## Present
Per contributor: a short trajectory read (improving / steady / needs support),
2–3 concrete development suggestions, and a suggested stretch area. Lead with the
self-baseline trend; cohort position is secondary and often suppressed for
low-volume people (say so).

## Contract
Give a clear trajectory verdict (on track / needs support / stalled) and concrete
development actions — that is the job. Weigh trajectory over absolute position:
lower volume/ownership is expected for newer people and is context, not an
automatic deficiency. Attach sample size / coverage / confidence; cohort
comparison is often suppressed for low-volume people, so lean on the self-baseline
trend and say when the peer band is thin.
