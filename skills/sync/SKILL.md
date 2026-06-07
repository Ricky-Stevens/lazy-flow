---
description: Trigger a GitHub + Jira sync and report current sync freshness. Use /lazy-flow:sync to backfill or incrementally update data, then show watermark status.
---

# /lazy-flow:sync

Call `sync_status` first to report current watermark state, then call `run_sync` with `mode: "incremental"` (or `mode: "backfill"` if the user asks for a full re-ingest). After sync completes, call `sync_status` again to confirm freshness.

Render all tool outputs faithfully:

- Show the `overall_status`, `synced_at`, and a summary of what was ingested (repos synced, issues upserted, transitions appended).
- For each resource in the post-sync `sync_status`, show its `source`, `resource`, `lag_ms`, and whether it is stale.
- Always display the `trust_tier` and `as_of` fields from the response envelope.
- If `has_stale: true` after sync, surface that as a warning.

Do not compute or summarise numbers beyond what the tool returns. Quote the `engine_version` from the response.
