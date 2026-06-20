---
description: Drive the in-session LLM verdict pipeline that powers lazy-flow's qualitative metrics — design-bearing vs boilerplate, review difficulty, PR-description quality, convention adherence, review depth/mentorship. Pulls artifacts (with diffs), the running Claude session judges each locally, records them, and reports coverage. No external API. Use for "run verdicts", "assess PR quality", "judge the diffs".
---

# /lazy-flow:verdicts

Automates the differentiator: the Claude session that is already running reads
the real artifacts and produces structured verdicts that lazy-flow's
probabilistic metrics aggregate. **Nothing leaves the machine** — no external
model call.

## Step 0 — make sure there are diffs to judge
Call `backfill_pr_patches` with `drain: true` **once** — it processes every
remaining patch-less file to completion in a single call. Without patches the
artifacts carry only title/body/file-list and verdicts are lower-confidence.
`run_sync` auto-backfills only a bounded chunk each run (for speed), so a drain
is the way to reach the full diff set before a verdict pass. The `remaining` it
reports after draining is the genuinely unfetchable residual (e.g. blobs removed
from history) — judge those from title/body/file-list and lower confidence.

(Note: this is only for the verdict layer. `code.haloc_aggregate` is already
correct without any backfill — it uses the complete denormalised HALOC column.)

## Step 1 — choose scope
Ask (or infer) which metric(s) and whom to judge:
- author-PR metrics: `person.design_bearing_ratio`, `person.pr_review_difficulty`,
  `person.pr_description_quality`, `person.pr_atomicity`, `person.convention_adherence`
- received-feedback: `pr.feedback_severity_mix_received` (review-comment artifacts)
- reviews-given: `person.review_depth_mentorship` (the reviews the person GAVE —
  the strongest signal for senior/IC mentorship)

For a squad pass, iterate every human (resolve via the safe roster query).

## Step 2 — judge in batches
For each (metric, person):
1. `list_pending_verdicts` (limit ~10–25). Each artifact carries title, body,
   file list, and the synthesised `patch` per file where backfilled.
2. Read each artifact and decide the structured verdict per the metric's shape
   (the tool returns `verdictShape`). Judge the *substance*, not length or line
   count — a 30-line change through 8 hard functions outweighs a 400-line fixture.
3. `record_verdict` for each, with `confidence` (lower it when the diff would be
   decisive but is absent) and 1–3 cited `evidence` strings (file:line / quotes).
   Verdicts are idempotent per (subject, metric).
4. Repeat until `pendingCount` is 0 for that metric/person.

## Step 3 — report
Re-read `get_person_report` (or the team view) so the now-populated metrics show,
and summarise: design-bearing share, review-difficulty distribution,
description-quality mix, mentorship depth — with the evidence behind any notable
value. Note remaining `no_data` metrics and why (artifact stream not yet judged).

## Contract
Every verdict must be grounded in the artifact text/diff — never guess, never use
outside knowledge of the person. These feed evaluative metrics, so cross-person
comparison and ranking are valid once the squad is judged. Record honest
confidence — a thin artifact deserves a low one — so downstream rankings can
weight or flag low-confidence calls rather than over-trusting them.
