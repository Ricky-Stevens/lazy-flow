---
description: Build one engineer's full delivery profile — volume & cadence, collaboration, work-type mix, code footprint, knowledge ownership, and (if verdicts exist) qualitative signals — against their own history and the team distribution. An evaluative, manager-facing assessment that names strengths, gaps, trajectory, and recommended actions, with confidence on every call. Use for "how am I doing", "profile <name>", "review <person>".
---

# /lazy-flow:person-profile

Answers "how is this person doing?" as a manager-facing evaluation — strengths,
gaps, trajectory, and recommended actions. Replaces the old `me` and per-person
skills with one chained workflow.

## Step 1 — resolve the person
Read `lazy-flow://schema`, then resolve the handle to a `persons.id` (bind the
handle as a positional `?`, never interpolate):
```sql
SELECT p.id, p.display_name, i.kind, i.external_id
FROM persons p JOIN identities i ON i.person_id = p.id
WHERE i.external_id = ? OR p.display_name LIKE ?;
```
Show which identities stitched (GitHub login + commit email + Jira account) so
the user trusts the attribution.

## Step 2 — the report
Call `get_person_report` (default `window_days: 365` for a review) — this is the
primary surface: every per-person metric placed against the cohort (suppressed
under 8 ok-quality peers) plus a self-baseline trend.

For PR/flow detail, also call `get_pr_metrics` and `get_flow` with
`scope_type: "person"` + `person_id`. Note: team-only families (DORA, code
aggregates) return `no_data` at person scope **by design** — the per-person
code/quality signals live in `get_person_report`, not the team tools.

## Step 3 — present
- Volume & cadence (PRs, commits, cycle/merge times), collaboration (review
  reciprocity, coverage, self-merge rate), work-type mix, code footprint
  (complexity delta, conceptual surface, ownership/bus-factor), and qualitative
  signals if verdicts exist.
- Always show `dataQuality` and whether a comparison was `suppressed` /
  `requires_bucketing`. If verdict metrics are `no_data`, say they need
  `/lazy-flow:verdicts` run — do not imply they were assessed.
- Lead with an overall verdict (strong / solid / needs development, with the
  evidence), then the self-baseline trend (is the person growing?) and cohort
  position. Where cohort comparison is suppressed, say so and lean on the trend +
  raw values.

## Contract (evaluate honestly)
This is an evaluation, not a hedge: give an overall verdict, name strengths and
gaps, and recommend actions (stretch, training, the raise case). The one rule —
**never assert a verdict without its basis.** Attach sample size, coverage, and
confidence to every comparative claim; when cohort comparison is suppressed
(< 8 ok-quality peers), rank on the person's own trend + raw values and mark it
provisional. Interpret context (a high bug-fix share is support load, not a
demerit). If verdict metrics are `no_data`, say the assessment is missing its
strongest axis. The store is local/single-user; the person's own identities are
theirs to see.
