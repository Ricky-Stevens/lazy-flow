---
description: Generate a preset delivery report (self-contained HTML, Markdown, CSV, or JSON) for a team/org/person scope and period — sprint, weekly, monthly, quarterly, or annual. Use /lazy-flow:report to produce an exported artifact you can present or attach.
---

# /lazy-flow:report

lazy-flow produces **exported report artifacts** — a local tool generates a file you share/present; nothing is sent anywhere automatically.

1. If the user is unsure which report they want, call `list_report_presets` and show the available presets (key, audience, cadence, scope).
2. Call `generate_report` with:
   - `preset` — e.g. `monthly:team`, `quarterly:dept`, `annual:company`, `sprint:team`, `weekly:team`, `annual:person`.
   - `scope` + `scope_type` — the team/org/person id and its scope type (default `team`).
   - `period_end` — anchor day `YYYY-MM-DD` (default: today). The report resolves the right calendar window.
   - `format` — `html` (default, self-contained, emailable), `markdown` (board-pack), `csv`, or `json`.
   - `out_path` — optional absolute path to also write the artifact to disk.

Render the result faithfully:

- Report the `title`, `audience`, `period_label`, `format`, and `bytes`. If `out_path` is set, tell the user where the file was written; otherwise note that the full artifact is in the tool result `content`.
- Surface the `trust_tier`, `data_quality`, and `coverage` from the envelope.
- If `person_scope` is true, remind the user this is a **private self-view** — not for appraisal or cross-person comparison.
- Do NOT recompute or re-summarise the metrics yourself; the report already carries deterministic values, baselines, charts, and an advisory narrative.

The most recently generated HTML report is also available as the MCP resource `lazy-flow://report/latest`.
