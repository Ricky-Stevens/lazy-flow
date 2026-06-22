---
description: Drive the in-session AI-authorship verdict pipeline — adjudicate the AMBIGUOUS band that the deterministic stylometry scorer can't confidently call. The running Claude session reads each change's writing style, decides AI-assisted vs human, and records the verdict locally. No external API, no API key. Use for "judge AI authorship", "fill in the ambiguous AI calls", "drain the AI-authorship verdict queue".
---

# /lazy-flow:ai-authorship

Automates the headline differentiator for AI-vs-human authorship: the Claude
session already running adjudicates the changes whose deterministic ai_score is
inconclusive (the 0.35–0.65 band). The verdict OVERRIDES the stylometry score
for downstream metrics. **Nothing leaves the machine** — no external model call.

## Step 0 — confirm the deterministic pass has run
The pending queue is built from `ai_authorship` rows. If `data_overview` shows
zero rows there, `run_sync` first — stylometry is part of sync.

## Step 1 — drain the queue in batches
Loop until empty:

1. `list_pending_ai_authorship` (default `limit: 25`, `lo_band: 0.35`,
   `hi_band: 0.65`). Each pending item carries `entity_type`
   (`commit` | `pull_request`), `entity_id`, `aiScore`, and the `text` to judge
   (commit message; PR title + body).
2. Read each `text` and decide using STYLE and STRUCTURE — not a single phrase.
   The strong AI tells: polished multi-section markdown (## Summary /
   ## Test plan), checkbox test plans, exhaustive bullet lists, complete
   grammatically-perfect explanatory prose, precise enumeration, em-dashes
   paired with structure. Human writing skews terse, lowercase,
   abbreviation-heavy, and structurally plain. Be calibrated — return a genuine
   `confidence`, not always high.
3. For each item, call `record_ai_authorship_verdict` with `entity_type`,
   `entity_id`, `ai_assisted` (bool), `confidence` (0..1), and a 1–2 sentence
   `reasoning`. Idempotent — re-recording overwrites the prior verdict.
4. Repeat until `pendingCount` is 0.

## Step 2 — report
Summarise: total verdicts recorded this pass, AI-assisted share, the cohort of
commits/PRs reclassified vs the deterministic score (where your verdict
disagreed with the threshold). Note which entities were judged human despite a
high-ish ai_score (over-fired stylometry) and vice versa.

## Contract
Judge from the artifact text only — never use outside knowledge of the author.
A thin or empty body deserves a LOW confidence — the deterministic score then
remains effectively in charge. Verdicts feed the AI-blend metric directly, so
calibration matters: if every verdict is 0.9 the metric becomes a coin-flip.
