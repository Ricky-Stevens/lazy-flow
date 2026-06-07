---
description: Explain how a specific metric is computed — return the formula, inputs, trust tier, and engine version. Use /lazy-flow:explain <metric_name> to get the full methodology.
---

# /lazy-flow:explain

Call `explain_metric` with the `metric` name the user specified. If the user has not specified a metric, ask which metric they want explained before calling the tool.

Render the tool output faithfully:

- Show the `formula_doc` in full — this is the published formula the engine uses.
- Show the `trust_tier` badge: `deterministic`, `hybrid`, or `probabilistic`.
- Show the `inputs` list (data fields the metric reads from).
- Show `engine_version` — all formula interpretations are version-pinned.
- Show `as_of` from the response envelope.

Do not paraphrase or simplify the formula beyond what `formula_doc` contains. Do not add formulas from memory — only what the tool returns is authoritative. If the user wants to see a specific metric's current value, direct them to the appropriate metric skill.
