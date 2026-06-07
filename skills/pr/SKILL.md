---
description: Show PR and review health metrics (4-phase cycle time, review latency, review coverage, time-to-first-review, stale PRs, reviewer load) for a scope and window, with trust badges.
---

# /lazy-flow:pr

Call `get_pr_metrics` with the user's requested `scope` (default `"team"`) and `window_days` (default `30`).

Render the tool output faithfully:

- Display each metric with its `value` and `unit` (durations in hours or the unit specified).
- Show the `trust_tier` badge for every metric row. PR metrics are `deterministic`.
- Show `data_quality` and `coverage` — bot PRs are excluded by default; note if coverage is partial.
- Show `as_of` and `engine_version` from the response envelope.
- Highlight `merge_without_review` and `stale_pr_count` if non-zero, as these are risk signals.
- If `value` is `null`, state that the sample was insufficient.

Do not compute derived ratios (e.g. review coverage %) beyond what the tool returns. For AI-powered PR quality analysis on a specific PR, direct the user to `/lazy-flow:align` or use the `pr_quality` tool directly.
