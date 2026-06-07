---
description: Review and confirm fuzzy identity matches — GitHub logins, Jira account IDs, and commit author emails that the engine has queued for human confirmation before attributing work.
---

# /lazy-flow:identities

Call `get_code_metrics` with `scope: "identities"` and metric `"identity_queue"` to retrieve the list of pending identity matches awaiting human confirmation.

Render the tool output faithfully:

- For each queued match, show: the candidate identities (login/email pairs), the match `confidence` score, the `match_tier` (email-exact, local-part+name, fuzzy), and any `conflict_reason`.
- Show the `trust_tier` badge: `deterministic` for exact matches, `hybrid` for fuzzy matches.
- Show `as_of` and `engine_version` from the response envelope.

Guide the user to confirm or reject each match:

- Exact email / GitHub-verified matches auto-merge and do not appear here.
- Matches at the local-part+name tier (≥0.8) and fuzzy tier (≥0.5) require human confirmation before per-person metrics are attributed.
- If the user confirms a match, note the `person_id` pair they are confirming and advise them to record it in the lazy-flow config or via the identity confirmation surface when it is available.

Do not auto-merge identities on the user's behalf. Do not display or infer PII beyond what the tool returns. If a bot account appears in the queue, advise the user it should be excluded via the `is_bot` flag.
