---
description: Explain a detected velocity or flow anomaly with cited, ranked, evidence-backed causes. Uses AI analysis (hybrid trust tier). Call /lazy-flow:anomaly to investigate a metric spike or dip.
---

# /lazy-flow:anomaly

Call `explain_anomaly` with the `metric` the user wants explained and the `scope` / `window_days` as requested. If the user describes a symptom ("why did cycle time spike?"), map it to the appropriate metric name before calling.

Render the tool output faithfully:

- Show each ranked cause with its `evidence_pointer` exactly as returned — do not paraphrase or extend the evidence.
- Show the `confidence` score for the overall verdict.
- Show the `trust_tier` badge: `hybrid` (deterministic detection + LLM ranking).
- Show the `audit_id` so the user can contest or correct this verdict via `/lazy-flow:contest`.
- Show `as_of` and `engine_version` from the response envelope.
- If the verdict is `"insufficient_signal"`, say so clearly — do not substitute your own analysis.

Do not attribute causes to named individuals. All recommendations must be systemic (process, tooling, flow state) not individual. Do not invent causes not present in the tool output. If the user wants to contest a verdict, direct them to `/lazy-flow:contest`.
