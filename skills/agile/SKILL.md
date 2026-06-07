---
description: Show Agile/sprint metrics (velocity, say/do ratio, sprint predictability, estimation accuracy) for a scope and window, with trust badges.
---

# /lazy-flow:agile

Call `get_agile_metrics` with the user's requested `scope` (default `"team"`) and `window_days` (default `30`). If the user specifies a Jira project or sprint range, pass as `scope`.

Render the tool output faithfully:

- Display each metric with its `value` and `unit`.
- Show the `trust_tier` badge for every metric row. Agile metrics are `deterministic`.
- Show `data_quality` and `coverage` — velocity is based on committed-at-start snapshot vs completed; note if sprint data is partial.
- Show `as_of` and `engine_version` from the response envelope.
- For `estimation_accuracy`, show both bias (systematic over/under-estimation) and Spearman correlation if returned.
- If `value` is `null`, state that the sample is insufficient (e.g. fewer sprints than the minimum floor).

Do not recompute velocity or say/do from raw story-point counts. If the user asks why a sprint underdelivered, direct them to `/lazy-flow:anomaly`.
