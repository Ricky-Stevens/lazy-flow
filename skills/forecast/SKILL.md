---
description: Forecast delivery for a backlog scope from historical throughput by querying the local lazy-flow DB directly. There is no built-in Monte Carlo metric — you compute the forecast from real throughput pulled via query_db.
---

# /lazy-flow:forecast

There is no dedicated forecast tool/metric in lazy-flow. Build the forecast
yourself from the historical throughput in the local SQLite store via the
`query_db` tool.

## 1. Read the schema first

Read the `lazy-flow://schema` resource before writing SQL — it documents the
tables and how scopes/identities work. Do not guess column names.

## 2. Pull historical throughput

Throughput = completed work items per period. Pull a per-week (or per-day) count
of items reaching a terminal state over a trailing window the user specifies
(default: trailing 12 weeks). For Jira-backed flow, completed issues by week:

```sql
SELECT strftime('%Y-%W', i.resolved_at) AS week, COUNT(*) AS done
FROM issues i
WHERE i.resolved_at IS NOT NULL
  AND i.resolved_at >= ?            -- ISO date, window start (bound, not interpolated)
GROUP BY week
ORDER BY week;
```

If the team works PR-first, use merged PRs per week instead (`pull_requests`,
`state = 'merged'`, `merged_at`). Check `metric_snapshots` for a precomputed
`flow.throughput` series first and prefer it when present.

## 3. Compute the forecast (transparently)

Using ONLY the per-period counts you retrieved, run a simple Monte Carlo (sample
historical weekly throughputs with replacement to "burn down" the user's target
item count) or report the empirical percentile bands of weeks-to-complete. State
explicitly:

- the sample window and number of periods used,
- the p50 / p70 / p85 / p95 outcome (completion weeks or date),
- that this is computed from the user's own historical throughput, reproducible
  from the same data.

## Rendering rules

- Show the throughput sample size; if it is small (e.g. < 6 periods) flag the
  forecast as low-confidence.
- Do not invent a single "most likely" date outside the percentile bands.
- If `query_db` returns no throughput rows, say there is insufficient history to
  forecast — do not fabricate a distribution.
- For what is driving variance, direct the user to `/lazy-flow:flow`.
