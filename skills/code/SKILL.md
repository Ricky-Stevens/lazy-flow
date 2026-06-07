---
description: Show code health metrics (HALOC, work-type split, rework/churn, complexity deltas, Nagappan-Ball M1/M2/M3, Maintainability Index) for a scope and window, with trust badges.
---

# /lazy-flow:code

Call `get_code_metrics` with the user's requested `scope` (default `"team"`) and `window_days` (default `30`).

Render the tool output faithfully:

- Display each metric with its `value`, `unit`, and any `formula_doc` excerpt where informative.
- Show the `trust_tier` badge for every metric row. Code metrics are `deterministic`; Impact rationale (if present) is `hybrid`.
- Show `data_quality` and `coverage` — note if complexity analysis is partial (e.g. unsupported language).
- Show `as_of` and `engine_version` from the response envelope.
- For work-type distribution (New / Legacy-Refactor / Help-Others / Rework), render as a percentage breakdown using only the values returned.
- If `value` is `null`, state that the denominator was zero or data is insufficient.

Do not re-derive LOC, churn rates, or complexity scores. These are descriptive metrics — never frame them as productivity scores. If the user asks for AI-level insight about a specific change's impact, direct them to `explain_metric` or `explain_anomaly`.
