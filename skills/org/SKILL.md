---
description: Show org-level delivery metrics aggregated across all configured teams — DORA posture, velocity distribution, investment balance — with trust badges.
---

# /lazy-flow:org

Call `get_dora`, `get_flow`, `get_code_metrics`, and `get_agile_metrics` with `scope: "org"` and the user's requested `window_days` (default `90` for org-level views).

Render all tool outputs faithfully:

- Display aggregate metrics with `trust_tier` badges, `data_quality`, and `coverage`.
- Show DORA band distribution across teams if returned.
- Show `as_of` and `engine_version` from the response envelope.
- For investment balance (work-type distribution), render the percentages from the returned values only.
- If coverage is partial (some teams not yet synced), surface the coverage flag prominently.
- If `value` is `null`, state the reason.

Do not rank teams against each other or produce a "best/worst team" view — the product ships no forced-curve or leaderboard UI by design. Aggregate insights only. For team-level detail, direct the user to `/lazy-flow:team`.
