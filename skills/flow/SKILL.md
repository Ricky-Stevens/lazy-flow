---
description: Show Flow metrics (Cycle Time, Flow Efficiency, WIP/Load, Throughput, Flow Distribution, CFD, Aging WIP, Time-in-Status, Monte Carlo forecast) for a scope and window, with trust badges.
---

# /lazy-flow:flow

Call `get_flow` with the user's requested `scope` (default `"team"`) and `window_days` (default `30`).

Render the tool output faithfully:

- Display each metric with its `value`, `unit`, and percentile distribution where present.
- Show the `trust_tier` badge for every metric row. Flow metrics are `deterministic`; Flow Distribution may be `hybrid` when LLM classification is involved.
- Show `data_quality` and any `coverage` flag — if the flow state model is unconfirmed, note it and the implied low-confidence flag.
- Show `as_of` and `engine_version` from the response envelope.
- For CFD data, describe the shape (growing WIP, narrowing columns, etc.) using only the values returned.
- If `value` is `null` (e.g. zero-denominator or sample below floor), say so explicitly.

Do not recompute Flow Efficiency, Cycle Time, or any other metric from raw counts. If the user asks for a root-cause analysis of a flow bottleneck, direct them to `/lazy-flow:anomaly` or invoke the `flow-analyst` subagent.
