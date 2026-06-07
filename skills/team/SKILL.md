---
description: Show team-level delivery metrics across DORA, Flow, PR, Code, and Agile dimensions for a team scope and window, with trust badges.
---

# /lazy-flow:team

Call `get_dora`, `get_flow`, `get_pr_metrics`, `get_code_metrics`, and `get_agile_metrics` with `scope: "team"` and the user's requested `window_days` (default `30`). If the user specifies a team name, pass it as the `scope`.

Render all tool outputs faithfully:

- For each metric group, display values with `trust_tier` badges, `data_quality`, and `coverage`.
- Show `as_of` and `engine_version` from the response envelope.
- Highlight any `dora_band` regressions, stale PRs, or flow efficiency below 50% as they are returned — do not invent thresholds.
- If any metric is `null`, state the reason.

Do not produce individual rankings or comparisons between team members. Recommendations must be systemic (process, tooling, flow) not individual. If the user wants a deeper explanation of a trend, direct them to `/lazy-flow:anomaly` or `/lazy-flow:explain`.
