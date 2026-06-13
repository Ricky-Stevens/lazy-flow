---
description: Review fuzzy identity matches the engine queued for human confirmation — GitHub logins, Jira account ids and commit emails it could not auto-merge. Query the local lazy-flow DB directly; there is no dedicated identity-queue tool.
---

# /lazy-flow:identities

There is no built-in identity-queue tool. The pending matches live in the
`candidate_matches` table of the local SQLite store — query them with `query_db`.

## 1. Read the schema first

Read the `lazy-flow://schema` resource before writing SQL. It documents the
`identities`, `persons` and `candidate_matches` tables and how `person_id` links
accounts to people.

## 2. List the pending queue

`candidate_matches` pairs two identities the engine thinks are the same person
but could not auto-merge (`status = 'pending'`). `reason` is 'local_part_name' or
'fuzzy_name'; `confidence` is the match score.

```sql
SELECT cm.id,
       a.kind AS kind_a, a.external_id AS account_a,
       b.kind AS kind_b, b.external_id AS account_b,
       cm.reason, cm.confidence
FROM candidate_matches cm
JOIN identities a ON a.id = cm.identity_id_a
JOIN identities b ON b.id = cm.identity_id_b
WHERE cm.status = 'pending'
ORDER BY cm.confidence DESC;
```

## Rendering rules

- For each pending match show: the two candidate accounts (kind + external_id),
  the `reason`, and the `confidence`. Treat fuzzy-name matches as lower trust than
  local-part+name matches.
- Exact email / GitHub-verified matches auto-merge and never appear here.
- Do NOT auto-merge identities or write to the DB — `query_db` is read-only and
  this skill is review-only. If the user wants to confirm a match, note the
  identity pair and advise recording the decision via the identity-confirmation
  surface when available.
- Surface only what the query returns. The store is local and single-user, so the
  account handles shown are the user's own data — but do not infer further PII
  beyond the rows.
- If a bot account appears, advise excluding it via the `identities.is_bot` flag.
