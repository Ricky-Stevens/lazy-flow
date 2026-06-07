---
description: Run a Monte Carlo delivery forecast for a backlog scope. Returns probability distribution over completion dates using historical throughput, with trust badges.
---

# /lazy-flow:forecast

Call `get_flow` with the user's `scope` and `window_days`, requesting the `monte_carlo_forecast` metric. If the user specifies a target item count or date, pass those as parameters.

Render the tool output faithfully:

- Display the probability distribution (p50, p70, p85, p95 completion dates or week counts) using only the values returned.
- Show the `trust_tier` badge. Monte Carlo forecast is `deterministic` (seeded PRNG, reproducible per `engine_version`).
- Show the `engine_version` and seed used — forecasts are reproducible per engine version and seed.
- Show `data_quality` and `coverage` — if throughput sample is below the minimum floor, note the reduced confidence.
- If `value` is `null`, state that insufficient historical throughput data is available.

Do not extrapolate beyond the returned percentile bands or invent a "most likely" date not present in the output. If the user asks what is driving forecast variance, direct them to `/lazy-flow:flow` or `/lazy-flow:anomaly`.
