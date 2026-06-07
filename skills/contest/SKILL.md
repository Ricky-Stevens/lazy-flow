---
description: Contest or correct an AI verdict (ticket alignment, effort, anomaly explanation, PR quality). Appends an append-only correction to the audit trail and feeds the calibration harness.
---

# /lazy-flow:contest

Call `correct_verdict` with the `verdict_id` (the `audit_id` from the original AI tool output) and the user's correction.

Required parameters:
- `verdict_id`: the `audit_id` from the verdict being contested (shown in `/lazy-flow:align`, `/lazy-flow:anomaly`, etc.)
- `correction`: the user's correction as a structured object — what was wrong and what the correct assessment is.
- `reason`: a brief human-readable explanation of why the original verdict was incorrect.

Render the tool output faithfully:

- Show the `correction_id` assigned to this correction.
- Show that the correction is `append_only` — it does not delete the original verdict but adds a correction record.
- Show that this correction will feed the calibration harness (improving future verdict quality).
- Show `trust_tier: "n/a"` (corrections are meta-records, not metric verdicts).
- Show `as_of` and `engine_version` from the response envelope.

Before calling the tool, confirm with the user what the correct assessment should be. Do not fabricate a correction on the user's behalf. After submitting, direct the user to `/lazy-flow:align` or `/lazy-flow:anomaly` to see the updated verdict with the correction attached.
