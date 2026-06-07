---
description: Assess ticket-work alignment for a PR — how well the diff covers each acceptance criterion, with quoted diff evidence and a per-criterion coverage score (hybrid trust tier).
---

# /lazy-flow:align

Call `ticket_work_alignment` with the `pr_number` and (if applicable) `issue_key` the user specifies. If the user only provides a PR URL, extract the PR number from it.

Render the tool output faithfully:

- For each acceptance criterion, show the `coverage_level` (ordinal 0–4), the quoted `evidence` diff hunk, and the `relevance_guard` status if present.
- Show the overall `coverage_ratio` as returned — do not recompute it.
- Show `confidence` for the overall verdict.
- Show the `trust_tier` badge: `hybrid`.
- Show the `audit_id` so the user can contest or correct via `/lazy-flow:contest`.
- Show `as_of` and `engine_version` from the response envelope.
- If a criterion has low coverage due to vague wording, note the `low_confidence` flag as returned.

Do not infer coverage from the diff yourself — only the tool output is authoritative. Do not quote diff content beyond what the tool returns. If the user wants to contest this verdict, direct them to `/lazy-flow:contest`.
