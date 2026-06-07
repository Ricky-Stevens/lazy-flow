# lazy-flow — Formula Reference

> **Auto-generated** from metric module `formulaDoc` strings.
> Do not edit by hand — run `npm run generate:formulas` to regenerate.
>
> Every metric exported from `@lazy-flow/metrics` is listed here with its
> `id`, `trustTier`, `scope`, `params`, and the full published `formulaDoc`
> string (SPEC §8.6 contract). Grouped by SPEC §8 group (A–E).

---

## Trust tiers

| Tier | Meaning |
|---|---|
| `deterministic` | Pure computation — timestamps, counts, AST walks, statistical simulations. Formula fully reproducible. |
| `hybrid` | Deterministic features + LLM judgment. LLM output is schema/enum-bounded and audited. |
| `probabilistic` | LLM-dominant, advisory. Use with appropriate uncertainty. |

---

## Group A — DORA / Delivery (`team+`)

SPEC §8.1. Four DORA keys plus supporting metrics. All scoped to `team` (team-or-higher aggregate).

---

### `dora.deployment_frequency`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `windowDays: 28`, `environment: "production"` |

**Formula:**
> Deployment Frequency (SPEC §8.1): count(prod deploys, status=success) / windowDays.
> DORA band derived from deploys/day: elite ≥1/day, high 1/week–1/month,
> medium 1/month–1/6months, low <1/6months (DORA 2025 benchmarks).

---

### `dora.lead_time`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `windowDays: 28`, `environment: "production"` |

**Formula:**
> Lead Time for Changes (SPEC §8.1, §8.6): per-commit lead time = deploy.finishedAt −
> PR.firstCommitAt (earliest commit authored_at in the PR). Commit set enumerated for each
> deployment. Reports p50/p75/p90 (type-7 linear interpolation). Squash/rebase flag raised
> when commit authored_at reset is detected. Minimum 1 sample required.

---

### `dora.change_failure_rate`

| Field | Value |
|---|---|
| **Trust tier** | `hybrid` |
| **Scope** | `team` |
| **Default params** | `environment: "production"` |

**Formula:**
> Change Failure Rate (SPEC §8.1): deploys_with_linked_incident / total_prod_deploys.
> Returns null when totalDeploys = 0 (SPEC §8.6 zero-denominator rule).
> Denominator includes all prod deployments (success + failure).
> Incident link = Jira Incident with a deploy-incident join record.

---

### `dora.recovery_time`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Failed-Deployment Recovery Time (SPEC §8.1, §8.6): median(firstResolvedAt − createdAt)
> over incidents linked to failed deployments. Anchor = FIRST Done transition
> (reopens do not move the anchor — a 1h-resolved-then-reopened incident recovers in 1h,
> not 25h). Returns null on 0 incidents. Uses type-7 percentile.

---

### `dora.incident_reopen_rate`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Incident Reopen Rate (SPEC §8.1): reopened_incidents / total_incidents.
> A reopened incident = incident with reopenCount > 0 in the window.
> Tracked separately from recovery time (reopens do not move the MTTR anchor).
> Returns null on 0 incidents.

---

### `dora.deployment_rework_rate`

| Field | Value |
|---|---|
| **Trust tier** | `hybrid` |
| **Scope** | `team` |
| **Default params** | `environment: "production"` |

**Formula:**
> Deployment Rework Rate (SPEC §8.1): unplanned_hotfix_deploys / total_prod_deploys.
> A hotfix deploy is identified by branch prefix (hotfix/, fix/), revert keyword, or
> incident linkage. Returns null on 0 deploys.

---

### `dora.reliability_proxy`

| Field | Value |
|---|---|
| **Trust tier** | `hybrid` |
| **Scope** | `team` |
| **Default params** | `windowDays: 28` |

**Formula:**
> Reliability Proxy (SPEC §8.1) — CAVEATED, NOT AUTHORITATIVE:
> 1 − (incident_count / window_days), bounded to [0, 1].
> This is a trend proxy only, not an SLA/SLO/uptime measurement.
> Use dedicated incident management tooling for authoritative reliability metrics.

---

## Group B — Flow (value stream, `team+`)

SPEC §8.2. Jira-plus-GitHub fused value-stream metrics. Require board column config and per-workflow
flow state models (C3). All scoped to `team`.

---

### `flow.cycle_time`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Cycle Time (SPEC §8.2, §8.6):
> cycleTime_i = firstDoneAt_i − firstStartedAt_i (seconds).
> Start = first entry into a status in a board isStartedCol=true column (NOT status_category).
> Stop  = first entry into a status in a board isDoneCol=true column.
> Reopen policy: stop at first Done; reopens tracked as a counter (SPEC §8.6).
> Distribution: p50/p75/p85/p90/p95 via type-7 R-7 linear interpolation.
> Sample floors: n≥20 for p90, n≥30 for p95; below floor → data_quality=insufficient_sample.

---

### `flow.flow_efficiency`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `zombieThresholdDays: 90` |

**Formula:**
> Flow Efficiency (SPEC §8.2, §8.6):
> Per-issue estimator: efficiency_i = active_i / (active_i + wait_i).
> NOT pooled Σactive/Σtotal (zombie-resistant).
> Classification: effective-dated flow_state_models at each interval start.
> Distribution: p50/p75/p85/p90/p95 via R-7 linear interpolation.
> Zombie threshold: issues with total open time > zombieThresholdDays flagged.
> Sample floors: n≥20 for p90, n≥30 for p95.

---

### `flow.throughput`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Throughput (SPEC §8.2, §8.6): count of issues whose first-Done transition
> falls within [windowStart, windowEnd]. First-Done dedup per issue per window:
> reopened-and-re-completed issues count once.
> Reopen-in-window issues are flagged in reopenedInWindowIds for transparency.

---

### `flow.wip_load`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Flow Load / WIP (SPEC §8.2):
> wip = count of issues in isStartedCol=true columns at asOf.
> Little's Law sanity-check only: avgThroughput ≈ wip / avgCycleTimeDays.
> NOT a per-sprint flag. Stationarity guard: bulk-close days excluded.
> Use cycle time + throughput distributions as primary flow metrics.

---

### `flow.flow_distribution`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Flow Distribution (SPEC §8.2):
> Classify completed issues into feature/bug/debt/other buckets.
> Deterministic prior: Jira issue type field.
> LLM classifier hook: pass llmClassifications to override.
> Distribution = count/total per bucket.

---

### `flow.cfd`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> CFD (SPEC §8.2): Replay issue_transitions day-by-day.
> At end of each UTC day, count issues per status and per flow_state.
> Flow state classification uses the effective-dated flow_state_models
> (classification in effect at each transition interval).
> This ensures admin recategorisation does not retroactively rewrite history.

---

### `flow.aging_wip`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Aging WIP (SPEC §8.2): For each issue currently in WIP (isStartedCol=true column),
> ageSeconds = now − createdAt.
> Distribution: p50/p75/p85/p90/p95 via R-7.
> Issues above p85 flagged as aging alerts.
> Sample floors: n≥20 for p90, n≥30 for p95.

---

### `flow.time_in_status`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Time-in-Status (SPEC §8.2):
> For each issue, sum the duration of all intervals in each status.
> Re-entries accumulate (multiple bounces to the same status all counted).
> Distribution: p50/p75/p85/p90/p95 per status across issues.

---

### `flow.monte_carlo_forecast`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `simulations: 10000` |

**Formula:**
> Monte Carlo Forecast (SPEC §8.2, §8.6):
> Bootstrap simulation over historical weekly throughput.
> Seed + engine_version → reproducible per install.
> PRNG: mulberry32 (createPrng).
> Sample order: canonical sorted ascending (reproducible draw).
> N=10000 simulations default.
> Result: weeks until remainingItems completed, p50/p75/p85/p90/p95.
> p90 requires n≥20, p95 requires n≥30 (sample floor).

---

## Group C — PR / Review (`team+`)

SPEC §8.3. GitHub pull-request lifecycle and review-process metrics. All scoped to `team`.

---

### `pr.cycle_time`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `environment: "production"` |

**Formula:**
> PR Cycle Time 4-phase (SPEC §8.3):
> Coding = readyAt − firstCommitAt;
> Pickup = firstReviewAt − readyAt;
> Review = mergedAt − firstReviewAt;
> Deploy = deployFinishedAt − mergedAt.
> Only merged PRs. Reports p50/p75/p85/p90/p95 (type-7).
> p90/p95 suppressed below sample floor (n<20/n<30).

---

### `pr.size`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> PR Size (SPEC §8.3, SPEC C2): uses HALOC (Hunk-Adjusted LOC = Σ_hunk max(ins,del))
> when available; falls back to additions+deletions.
> Buckets: XS ≤10, S ≤50, M ≤200, L ≤500, XL >500 HALOC.
> Reports bucket distribution and median HALOC for merged PRs.

---

### `pr.review_coverage`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Review Coverage (SPEC §8.3): merged PRs with at least one non-author review / total merged PRs.
> Bots excluded from reviewer counts.

---

### `pr.reviewers_per_pr`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Reviewers-per-PR (SPEC §8.3): mean unique non-author reviewers per merged PR.
> Bots excluded.

---

### `pr.reviewer_load_gini`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Reviewer Load Distribution (SPEC §8.3): Gini coefficient of non-author review counts.
> Gini = 0: perfectly equal load. Gini = 1: all reviews by one reviewer.
> Reviewer identities are anonymized in display (team-aggregate only).
> Formula: G = (2 * Σ(rank_i * x_i) / (n * Σx_i)) − (n+1)/n.

---

### `pr.comments_per_pr`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Comments-per-PR (SPEC §8.3): mean review comments per merged PR.

---

### `pr.review_iterations`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Review Iterations (SPEC §8.3): mean number of changes_requested rounds per merged PR.
> A round = a changes_requested review followed by at least one more review event.

---

### `pr.merge_without_review_rate`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Merge-Without-Review Rate (SPEC §8.3):
> merged PRs with no non-author review / total merged PRs.
> Returns null on 0 merged PRs.

---

### `pr.review_latency`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Review Latency Decomposition (SPEC §8.3):
> First-Response = first review submittedAt − readyAt.
> Rework = time from changes_requested to next review event.
> Idle = total latency − first_response − rework.
> Reports p50 (type-7). Only merged PRs with at least one review.

---

### `pr.time_to_first_review`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Time-to-First-Review (SPEC §8.3): firstReviewAt − readyAt (or createdAt).
> Only merged PRs with a first review. Reports p50/p75/p90 (type-7).

---

### `pr.time_to_merge`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Time-to-Merge (SPEC §8.3): mergedAt − readyAt (or createdAt).
> Only merged PRs. Reports p50/p75/p90 (type-7).

---

### `pr.stale`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `thresholdDays: 14` |

**Formula:**
> Stale PR Detection (SPEC §8.3): open non-draft PRs with no meaningful activity
> (review, comment, or update) for > thresholdDays (default 14).
> staleRate = stalePrCount / openPrCount. Returns null on 0 open PRs.

---

### `pr.ci_health`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> CI/Check-Run Health (SPEC §8.3):
> passRate = success_runs / total_completed_runs.
> Latency = completedAt − startedAt (p50/p90).
> Flakiness proxy = fraction of (sha, name) pairs with >1 run.
> p90 suppressed below sample floor (n<20).

---

## Group D — Code (`team+`, descriptive only, gaming-prone)

SPEC §8.4. Code-quality metrics derived from diffs, blame, and AST analysis.
**Descriptive only — do not use to rank individuals.** All scoped to `team`.

---

### `code.haloc_aggregate`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> HALOC Aggregation (SPEC §8.4, §1 C2):
> HALOC = Σ_hunk max(insertions, deletions).
> Binary/generated files surfaced separately, never silently zeroed.
> Rename-with-edits: only edit hunks count.
> Whitespace-insensitive mode available (mirrors git diff -w).

---

### `code.rework_churn`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `churnWindowDays: 30` |

**Formula:**
> Rework/Churn % (SPEC §8.4, D7):
> Classify changed lines by blame age + authorship.
> Rework: author re-touching own code within churnWindowDays.
> reworkPercent = (Rework / total) * 100.
> efficiency = 100 − reworkPercent.
> Window default: 30 days (D7).
> STORE-VS-FIXTURE: blameRecords from git blame adapter or test fixtures.

---

### `code.nagappan_ball`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Nagappan-Ball M1/M2/M3 (SPEC §8.4):
> M1 = haloc / (priorHaloc + haloc) — relative churn [0,1].
> M2 = haloc / windowDays — churn rate (haloc/day).
> M3 = reworkLines / (totalLines + 1) — rework density.
> Descriptive-only; do not rank individuals.
> Zero-denominator → null (SPEC §8.6).

---

### `code.complexity_delta`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Complexity Deltas (SPEC §8.4):
> Δcyclomatic = head_cyclomatic − base_cyclomatic per function (matched by name).
> Δcognitive  = head_cognitive  − base_cognitive  per function.
> Aggregates: sum of positive (increases) and negative (decreases) deltas.
> Inputs: pre-computed FileComplexity from analyzeComplexity (tree-sitter).
> Descriptive only — do not rank individuals.

---

### `code.maintainability_index`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Maintainability Index (SPEC §8.4, trend only):
> MI = max(0, min(100, 171 − 5.2*ln(avgHaloc+1) − 0.23*avgCyclomatic − 16.2*ln(avgLoc+1))).
> Microsoft VS variant. +1 in ln() avoids ln(0).
> TREND ONLY — absolute value not comparable across repos/languages.

---

### `code.change_impact`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `weights: { editDiversity: 0.3, halocNorm: 0.25, fileCountNorm: 0.2, changeEntropy: 0.15, oldCodePct: 0.1 }` |

**Formula:**
> Code-Change Impact (SPEC §8.4, §9.2.7):
> Deterministic blend:
> edit_diversity=distinct files changed / 20 (capped 1);
> haloc_norm=haloc/(haloc+100);
> file_count_norm=min(1,files/20);
> change_entropy=Shannon entropy of file-path dirs;
> old_code_pct=legacyRefactorLines/totalLines.
> impact = Σ weight_i * factor_i.
> All weights configurable.
> LLM rationale hook (Wave 5): llmRationale field.

---

## Group E — Agile / Jira (`team+`)

SPEC §8.5. Sprint-level agile metrics. All scoped to `team`.

---

### `agile.sprint_velocity`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `countLevel: 1` |

**Formula:**
> Sprint Velocity (SPEC §8.5, §8.6):
> committed = sum of points for issues present at sprint start (wasPresentAtStart=true).
> completed = sum of points for issues with statusCategory=done at sprint end.
> Points counted at ONE hierarchy level (default: level 1 stories/tasks).
> Subtask points roll up to parent: if parent has points, count parent;
> if parent has no points, count subtask. Never double-count.
> Returns null (not 0) when story-point field is unmapped.
> Kanban boards return null — use throughput/cycle-time instead.

---

### `agile.say_do`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | _(none)_ |

**Formula:**
> Say/Do Ratio (SPEC §8.5): completed_points / committed_points.
> Returns null when committed = 0 or when points are unmapped (null).
> A ratio of 1.0 = delivered exactly what was committed.
> >1.0 = over-delivered; <1.0 = under-delivered.

---

### `agile.sprint_predictability`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `toleranceFraction: 0.2` |

**Formula:**
> Sprint Predictability (SPEC §8.5): share of sprints where
> |completed − committed| / committed ≤ toleranceFraction (default ±20%).
> Bounded to [0, 1]. Requires n ≥ 2 sprints and mean committed > 0.
> Sprints with committed = 0 are excluded from the denominator.
> The raw 1−CV estimator is rejected (unbounded-below, renders negative %).

---

### `agile.estimation_accuracy`

| Field | Value |
|---|---|
| **Trust tier** | `deterministic` |
| **Scope** | `team` |
| **Default params** | `minN: 5`, `alpha: 0.05` |

**Formula:**
> Estimation Accuracy (SPEC §8.5): tie-corrected Spearman rank correlation
> between story points and actual cycle time.
> Excludes reopened issues and 0-point issues.
> Minimum n = 5; suppressed when not significant (t-test, α=0.05).
> Tie-correction applied: T = 1 − (Σt³−t)/(12*n*(n²−1)) for each tied group.

---

*39 metrics total. Generated from source: `packages/metrics/src/`.*
