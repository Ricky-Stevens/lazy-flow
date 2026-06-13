---
description: Show personal delivery metrics for the current user (self scope) by querying the local lazy-flow DB directly — PR cycle time, review participation, commit/work volume, recent activity. Local and descriptive, not evaluative.
---

# /lazy-flow:me

This skill answers "how am I doing?" by querying the local lazy-flow SQLite store
directly with the `query_db` tool. There is no dedicated per-person tool — you
write the SQL.

## 1. Read the schema first

Read the `lazy-flow://schema` resource before writing any SQL. It documents the
tables, how to resolve a person via the `identities` table, and where precomputed
metrics live. Do not guess column names.

## 2. Resolve the current user's identity

The user's work is attributed to one or more rows in `identities` (a GitHub login,
a commit email, a Jira account), each linked to a `persons` row via
`identities.person_id`. Ask the user which GitHub login / email is theirs if it is
not already known, then resolve it:

```sql
SELECT person_id FROM identities WHERE kind = 'github_login' AND external_id = ?;
```

Bind the handle as a positional `?` param — never interpolate it into the SQL string.

## 3. Aggregate their work (self scope)

Once you have the `person_id` (or the set of `identity` ids), aggregate over the
window the user asked for (default 30 days). Examples — adapt columns to what the
live schema shows:

```sql
-- PRs authored & merged by this person in the window
SELECT pr.state, COUNT(*) AS n,
       AVG(julianday(pr.merged_at) - julianday(pr.created_at)) AS avg_open_days
FROM pull_requests pr
JOIN identities i ON i.id = pr.author_identity_id
WHERE i.person_id = ?
  AND pr.created_at >= ?            -- ISO date, window start
  AND pr.deleted_at IS NULL
GROUP BY pr.state;
```

```sql
-- Reviews this person submitted in the window
SELECT COUNT(*) AS reviews_given
FROM reviews r
JOIN identities i ON i.id = r.reviewer_identity_id
WHERE i.person_id = ? AND r.submitted_at >= ?;
```

```sql
-- Commit volume (HALOC) authored in the window
SELECT COUNT(*) AS commits, SUM(c.haloc) AS total_haloc
FROM commits c
JOIN identities i ON i.id = c.author_identity_id
WHERE i.person_id = ? AND c.authored_at >= ?;
```

Prefer `metric_snapshots` (scope_type='self' or 'person') when a precomputed
value exists for the metric the user asked about — it carries `trust_tier` and
`data_quality` you should surface.

## Rendering rules

- Report only values returned by `query_db`. If a query returns no rows, say so
  plainly (insufficient data in the window) — do not invent numbers.
- Frame everything as growth/trend context, not evaluation.
- Do NOT compare the user against other named individuals or compute percentile
  rankings. For team-relative context, direct them to `/lazy-flow:team`.
- This store is local and single-user; the data (including identities) is the
  user's own.
