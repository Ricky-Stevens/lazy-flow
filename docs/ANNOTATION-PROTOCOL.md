# Annotation Protocol — lazy-flow AI Calibration

**Status:** v1 · **Owner:** Team lead  
**Reference:** SPEC §9.1 constraint 6, §9.3, WP-AI-CALIBRATION

---

## Purpose

This document operationalises the gold-set labelling process that feeds the
calibration harness (`packages/ai/src/calibration/`).  Every AI insight module
(alignment, effort, classify, anomaly, prquality, impact) MUST have a gold set
before its κ can be reported — and κ reporting MUST precede ensemble enablement.

---

## Who Labels

| Role | Responsibility |
|---|---|
| **Primary rater** | Domain expert most familiar with the ticket/PR in question.  For alignment/effort/prquality this is typically the author's team lead or a senior peer. |
| **Secondary rater** | A second expert who labels independently, without seeing the primary rater's labels.  Required to compute the human-ceiling κ. |
| **Calibration owner** | Runs `buildCalibrationReport()`, reviews the report, and decides whether to iterate the rubric or proceed to ensemble enablement. |

---

## Item Count Target

| Insight | Minimum gold items | Recommended |
|---|---|---|
| alignment | 30 | 60 |
| effort | 30 | 60 |
| classify | 40 | 80 |
| anomaly | 20 | 40 |
| prquality | 30 | 60 |
| impact | 30 | 60 |

Items are sampled to cover the full range of the output scale (e.g. all five
ordinal bands for alignment) and to include edge cases (empty PRs, huge diffs,
trivial fixes, clearly misaligned tickets).

---

## Inter-rater Target

The calibration harness computes human-vs-human κ when ≥2 raters have labelled
the same items.  Target:

- **κ_human ≥ 0.6** before the gold set is considered stable.
- If κ_human < 0.6 the rubric MUST be revised and the items re-labelled until
  the target is reached.
- The model pass gate is `min(0.6, κ_human)` — a subjective task with a 0.5
  human ceiling legitimately sets the gate at 0.5.

**Report human-ceiling κ first in every calibration run.** Do not compare
model κ against the fixed 0.6 gate without checking the human ceiling.

---

## Label Format

Each gold item is a JSON object written to the gold-set file for the team:

```jsonc
{
  "subjectId": "pr-12345",     // must match ai_verdicts.subject_id
  "metric":    "alignment",   // insight name
  "humanLabel": "3",          // string; ordinal for ordinal tasks, work-type for classify, etc.
  "raterId":   "alice@example.com"
}
```

For **correction-sourced gold labels** (via `correctVerdict`), the
`correction_json` must include a `"label"` key:

```json
{ "label": "2", "note": "PR only addresses ACs 1 and 2, not 3" }
```

---

## Process

1. **Sample** — select items covering the full output scale.
2. **Label independently** — primary and secondary raters label without
   consulting each other.
3. **Run the harness** — `buildCalibrationReport({ staticGoldItems, verdicts })`.
4. **Check human ceiling** — if κ_human < 0.6, revise the rubric and repeat.
5. **Check model κ** — compare against `min(0.6, κ_human)`.  If below gate,
   iterate the prompt, rubric, or feature pack.
6. **Check ECE** — confidence must be calibrated (ECE ≤ 0.1 by default) before
   `ensembleEligible` flips to `true`.
7. **Enable ensemble** — only when `ensembleEligible === true` in the report.

---

## Maintenance

- Re-run the harness whenever a prompt version bumps.
- Ingest `correctVerdict` corrections into the gold set automatically (the
  harness calls `extractCorrections()` on every run).
- Archive old gold sets with a version tag when the rubric changes materially.
