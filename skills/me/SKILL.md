---
description: Show personal delivery metrics for the current user (self scope): PR cycle time, review participation, work-type distribution, effort trends. Private by default.
---

# /lazy-flow:me

Call `get_pr_metrics`, `get_code_metrics`, and (if Jira is configured) `get_agile_metrics` with `scope: "self"` and the user's requested `window_days` (default `30`).

Render all tool outputs faithfully:

- Display each metric with its `value`, `unit`, and `trust_tier` badge.
- Show `data_quality` and `coverage` — self-scope metrics are gated by the `visibility` config; if `visibility` is `team` or `public`, note that these are visible to the team.
- Show `as_of` and `engine_version` from the response envelope.
- Frame all output as growth/trend context, not evaluation. These are descriptive metrics.
- If `value` is `null`, state the reason (insufficient data, below sample floor).

Do not compare the user's metrics against other individuals. Do not compute percentile rankings or relative standings. If the user asks for context on their metrics relative to team norms, direct them to `/lazy-flow:team`.
