---
description: Show DORA metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, Failed-Deployment Recovery Time) for a scope and window, with DORA band classification and trust badges.
---

# /lazy-flow:dora

Call `get_dora` with the user's requested `scope` (default `"team"`) and `window_days` (default `30`). If the user specifies a repo or team, pass it as `scope`.

Render the tool output faithfully:

- Display each metric with its `value`, `unit`, and `dora_band` (elite / high / medium / low).
- Show the `trust_tier` badge for every metric row. DORA metrics are `deterministic`.
- Show `data_quality` and any `coverage` flag — if coverage is partial, surface that prominently.
- Show `as_of` and `engine_version` from the response envelope.
- If `value` is `null`, explain that the denominator was zero or the sample was below the minimum floor — do not infer or substitute a value.

Do not compute percentages, bands, or comparisons beyond what the tool returns. If the user asks "why is our lead time high?", direct them to `/lazy-flow:explain` or `/lazy-flow:anomaly`.
