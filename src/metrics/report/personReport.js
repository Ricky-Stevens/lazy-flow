/**
 * Per-person insight report (PREREQ-2/3 integration). Ties the per-person metric
 * engine to the FAIR-comparison layer and the anti-weaponization contract:
 *
 *  - computes each supported metric for the person AND for the human cohort,
 *    then places the person via robust-z + percentile (comparePersonToCohort),
 *  - computes an on-demand SELF-baseline drift for headline metrics over trailing
 *    weekly buckets (no pre-backfilled snapshots required),
 *  - NEVER returns a sorted multi-person list (assertNotRankingList enforced),
 *  - suppresses peer comparison below the cohort floor.
 *
 * One scope-data load is shared across the whole cohort (computeMetric accepts a
 * `preloaded` dataset), so a report is a handful of loads, not N×metrics loads.
 */

import { summarize } from '../../report/baseline/stats.js'
import {
  comparePersonToCohort,
  MIN_COHORT,
  momentumVsTeam,
  selectHumanCohort,
  selfBaselineDrift,
} from '../person/index.js'
import { assertNotRankingList } from '../visibility/index.js'

/**
 * Metrics surfaced in the report, with comparison polarity.
 * polarity: +1 higher-is-healthier, -1 lower-is-healthier, 0 descriptive (no
 * better/worse — shown as position only, never oriented).
 *
 * `requiresBucketing: true` flags a metric whose pure-module formulaDoc states
 * the peer baseline must be segmented (by language, role, etc.) before any
 * cross-person comparison is fair. Bucketing is not yet implemented; until it
 * is, those metrics are emitted as descriptive + self-baseline trend ONLY, with
 * `comparison.band = 'requires_bucketing'` instead of a raw peer placement.
 */
export const REPORT_METRICS = [
  { id: 'person.review_reciprocity', polarity: 0, question: 'Collaboration' },
  { id: 'pr.review_coverage', polarity: 1, question: 'Q5' },
  { id: 'pr.review_bypass_rate_received', polarity: -1, question: 'Q5/Q6' },
  { id: 'person.ci_green_before_merge_rate', polarity: 1, question: 'Q5' },
  { id: 'person.ticket_linkage_rate', polarity: 1, question: 'Q5' },
  { id: 'person.test_inclusion_rate', polarity: 1, question: 'Q5' },
  { id: 'person.wip_small_pr_discipline', polarity: 1, question: 'Q5' },
  { id: 'pr.changes_requested_rate_received', polarity: 0, question: 'Q6' },
  { id: 'pr.review_iterations', polarity: 0, question: 'Q6' },
  { id: 'pr.comments_per_pr', polarity: 0, question: 'Q6' },
  // Descriptive (polarity 0), NOT lower-is-better: the underlying sample is the
  // review-to-review round-trip cadence (the next review arriving after a
  // changes_requested), which is gated by when the REVIEWER returns — it is not
  // a clean measure of how fast the IC addressed feedback. Treating it as
  // lower-is-better would penalise an author for a slow reviewer. Surface it as
  // a stuck/overload prompt only, with no better/worse orientation.
  { id: 'pr.feedback_response_latency', polarity: 0, question: 'Q6' },
  { id: 'person.complexity_authored_delta', polarity: 0, question: 'Q1', requiresBucketing: true },
  { id: 'person.high_complexity_file_share', polarity: 0, question: 'Q1', requiresBucketing: true },
  { id: 'person.pr_conceptual_surface', polarity: 0, question: 'Q4', requiresBucketing: true },
  { id: 'pr.size', polarity: 0, question: 'Q4' },
  { id: 'person.worktype_mix', polarity: 0, question: 'Q2' },
  { id: 'person.bugfix_share', polarity: 0, question: 'Q2' },
  {
    id: 'person.skill_domain_footprint',
    polarity: 0,
    question: 'Differentiator',
    requiresBucketing: true,
  },
  { id: 'person.knowledge_ownership_index', polarity: 0, question: 'Differentiator' },
  { id: 'person.ai_blend_rework_coupling', polarity: 0, question: 'Differentiator' },
  // Probabilistic — populated once in-session verdicts exist (else no_data).
  { id: 'person.design_bearing_ratio', polarity: 0, question: 'Q1' },
  { id: 'person.pr_review_difficulty', polarity: 0, question: 'Q4' },
  { id: 'person.pr_description_quality', polarity: 1, question: 'Q5' },
  { id: 'person.convention_adherence', polarity: 1, question: 'Q5' },
  { id: 'pr.feedback_severity_mix_received', polarity: 0, question: 'Q6' },
  { id: 'person.review_depth_mentorship', polarity: 0, question: 'Differentiator' },
]

/**
 * Metrics worth a self-baseline trend read (cheap scalars with a clear trajectory).
 * `polarity` orients momentum_vs_team: +1 higher-better, -1 lower-better, 0
 * descriptive (no orientation → momentum_vs_team is reported with the unsigned
 * difference and is interpreted descriptively). Sourced FROM REPORT_METRICS so the
 * two surfaces never disagree on whether a metric is higher- or lower-better.
 */
export const TREND_METRICS = [
  { id: 'person.ci_green_before_merge_rate', polarity: 1 },
  { id: 'pr.review_coverage', polarity: 1 },
  { id: 'person.complexity_authored_delta', polarity: 0 },
  { id: 'person.bugfix_share', polarity: 0 },
  { id: 'pr.review_bypass_rate_received', polarity: -1 },
]

const DAY = 86_400_000
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * Build the report. `deps` = { computeMetric, loadScopeData, loadFullScopeData,
 * sliceScopeData } injected from the compute module (avoids a circular import).
 */
export async function computePersonReport(store, personId, opts, deps) {
  const windowDays = opts?.windowDays ?? 90
  const now = opts?.now ?? new Date().toISOString()
  const toDay = now.slice(0, 10)
  const fromDay = dayStr(Date.parse(toDay) - (windowDays - 1) * DAY)

  const identities = await store.getIdentitiesByPerson(personId)
  if (identities.length === 0) {
    return { personId, error: 'unknown person (no identities)', metrics: [] }
  }
  const persons = await store.listPersons()
  const cohort = selectHumanCohort(persons)
  const target = persons.find((p) => p.id === personId)
  const displayName = target?.displayName ?? personId

  // One shared window load drives the person AND every cohort member.
  const data = await deps.loadScopeData(store, fromDay, toDay)

  // Build the window-INDEPENDENT person extras (pr_refs / file_complexity / links /
  // ai_authorship) ONCE for the whole report and inject them into the cohort data
  // AND every trend week-slice, so the big tables (file_complexity especially) are
  // scanned once — not once per cohort-data and once per trend week.
  const sharedExtras = await deps.loadSharedPersonExtras(store)
  data.__sharedPersonExtras = sharedExtras

  // Seed the identity memo from listPersons() — every cohort member's identity ids
  // are ALREADY in memory here, so the computeMetric calls below pay ZERO
  // per-(metric × person) identity queries.
  const identityMemo = new Map()
  for (const p of persons) identityMemo.set(p.id, new Set(p.identities.map((i) => i.id)))
  identityMemo.set(personId, new Set(identities.map((i) => i.id)))
  data.__identityIdsByPerson = identityMemo

  // Peer comparison is only meaningful at/above the cohort floor. Below it, every
  // metric would suppress to 'insufficient_cohort' anyway — so skip the entire
  // cohort distribution (M × P computeMetric calls) instead of computing values we
  // are guaranteed to throw away.
  const cohortViable = cohort.length >= MIN_COHORT

  const metrics = []
  for (const { id, polarity, question, requiresBucketing = false } of REPORT_METRICS) {
    const personResult = await deps.computeMetric(
      store,
      'person',
      personId,
      id,
      fromDay,
      toDay,
      now,
      data,
    )
    // Cohort distribution for the SAME metric (shared preloaded data, no reload).
    // Exclude the subject themselves — including the person in the distribution
    // they are compared against pulls the median toward their own value and
    // suppresses any deviation; the comparison must be "this person vs everyone
    // ELSE on the team", not "this person vs a distribution that contains them".
    const cohortValues = []
    // Skip cohort gather when bucketing-required (we never emit a peer placement
    // for those metrics) — saves M × P computes that would be thrown away.
    if (cohortViable && !requiresBucketing) {
      for (const peer of cohort) {
        if (peer.id === personId) continue
        const r = await deps.computeMetric(store, 'person', peer.id, id, fromDay, toDay, now, data)
        // Only peers whose value cleared the metric's OWN sample floor may seed the
        // baseline. ~18 person metrics deliberately still return a finite value when
        // below their floor but flag it `insufficient_sample` (or `no_data`); folding
        // those into the cohort distribution rebuilds the median/MAD the subject is
        // judged against out of values the metric itself declared untrustworthy —
        // defeating the very floor that exists to stop confident bands on noise.
        if (r.value !== null && Number.isFinite(r.value) && r.dataQuality === 'ok') {
          cohortValues.push(r.value)
        }
      }
    }
    const comparison = requiresBucketing
      ? {
          value: Number.isFinite(personResult.value) ? personResult.value : null,
          percentile: null,
          robustZ: null,
          band: 'requires_bucketing',
          cohortN: cohortValues.length,
          suppressed: true,
          direction: null,
          reason: 'requires_bucketing',
        }
      : comparePersonToCohort(personResult.value, cohortValues, { polarity })
    metrics.push({
      metric: id,
      question,
      value: personResult.value,
      dataQuality: personResult.dataQuality,
      descriptive: polarity === 0,
      // Promote heuristic-vs-verified provenance to the top-level row so a
      // label-inferred value (e.g. bugfix_share computed from a 'proxy' source)
      // is visibly distinguished from a content-verified one — otherwise it's
      // buried in `detail` and an evaluator can mistake a guess for a fact.
      dataSource: personResult.dataSource ?? null,
      comparison,
      detail: personResult,
    })
  }

  // assertion: this is a SINGLE person's report — never a ranked multi-person list.
  assertNotRankingList(
    metrics.map((m) => ({ scopeType: 'person', scopeId: personId, value: m.value })),
    false,
  )

  const trend = await computeSelfTrend(
    store,
    personId,
    identityMemo.get(personId),
    sharedExtras,
    fromDay,
    toDay,
    now,
    deps,
    cohort,
  )

  return {
    personId,
    displayName,
    window: { from: fromDay, to: toDay, days: windowDays },
    cohortSize: cohort.length,
    // The peer distribution EXCLUDES the subject (see line ~143), so the gate
    // must be on peers-excluding-subject vs MIN_COHORT — matching the per-metric
    // comparePersonToCohort suppression. Using cohort.length here disagreed with
    // the bands by one (a team of exactly MIN_COHORT incl. subject reported
    // not-suppressed while every band said insufficient_cohort).
    cohortSuppressed: cohort.length - 1 < MIN_COHORT,
    metrics,
    trend,
    contract:
      'Evaluation, with confidence attached. Compared to this person’s own history and the team ' +
      'distribution; every comparative claim carries its sample size and confidence, and a ' +
      `comparison below a cohort of ${MIN_COHORT} human peers is suppressed (read the ` +
      'self-baseline trend instead). Interpret descriptive metrics in context rather than as raw scores.',
  }
}

/**
 * On-demand self-baseline drift: split the window into trailing weekly buckets,
 * use all-but-last as the baseline distribution, classify the latest bucket via
 * the registered `selfBaselineDrift` module. For each metric we ALSO compute the
 * team's weekly series over the same buckets and run `momentumVsTeam` to produce
 * a difference-in-differences signal (is the person's trajectory out-pacing /
 * tracking / lagging the team's?). Needs no pre-backfilled snapshots.
 *
 * Drift floor: the report carries a minN of 2 baseline points (series.length ≥ 3
 * → "establishing" otherwise). That's intentionally below the module's default
 * MIN_N of 5 — the trend is only ever 2–13 buckets, so the module floor would
 * leave it permanently establishing.
 */
const TREND_MIN_BASELINE_N = 2

async function computeSelfTrend(
  store,
  personId,
  identityIds,
  sharedExtras,
  fromDay,
  toDay,
  now,
  deps,
  cohort,
) {
  const out = []
  const startMs = Date.parse(fromDay)
  const endMs = Date.parse(toDay)
  const weeks = Math.max(2, Math.min(13, Math.floor((endMs - startMs) / (7 * DAY))))
  if (weeks < 3) return out // too short to establish a baseline

  // Load the full dataset ONCE, then slice each trailing week in memory and compute
  // ALL trend metrics off that single slice (weeks-outer / metrics-inner). Was: a
  // full DB bulk-load per (metric × week) — up to 65 — reloading the same week 5×.
  const full = await deps.loadFullScopeData(store)
  // Drop the team-momentum pass entirely when the cohort is below the peer-
  // comparison floor: with a single (or near-single) person, the "team" series is
  // structurally the same as the person's and the difference-in-differences is
  // mathematically degenerate. The momentum line in `out` is omitted in that case.
  const cohortViable = (cohort?.length ?? 0) - 1 >= MIN_COHORT
  const personSeriesByMetric = new Map(TREND_METRICS.map((m) => [m.id, []]))
  const teamSeriesByMetric = cohortViable ? new Map(TREND_METRICS.map((m) => [m.id, []])) : null

  for (let w = 0; w < weeks; w++) {
    const wTo = dayStr(endMs - w * 7 * DAY)
    const wFrom = dayStr(endMs - (w + 1) * 7 * DAY + DAY)
    const weekData = deps.sliceScopeData(full, wFrom, wTo)
    // Pre-seed the identity memo so the per-metric computes pay no identity query;
    // __personExtras/__personSliceByIds are then built once per week, not per metric.
    weekData.__identityIdsByPerson = new Map([[personId, identityIds]])
    // Reuse the window-independent extras (built once for the whole report) so the
    // big tables are NOT re-scanned per week — only per-week check-runs/issues.
    weekData.__sharedPersonExtras = sharedExtras
    for (const { id: metricId } of TREND_METRICS) {
      const r = await deps.computeMetric(
        store,
        'person',
        personId,
        metricId,
        wFrom,
        wTo,
        now,
        weekData,
      )
      if (r.value !== null && Number.isFinite(r.value)) {
        personSeriesByMetric.get(metricId).push(r.value)
      }
      // Team-scope value for the same metric / same window — built off the SAME
      // preloaded weekData so no extra DB load. team-only/no-data results are
      // skipped (the team series stays empty → momentum reports no_data).
      if (teamSeriesByMetric) {
        const t = await deps.computeMetric(
          store,
          'team',
          'team',
          metricId,
          wFrom,
          wTo,
          now,
          weekData,
        )
        if (t.value !== null && Number.isFinite(t.value)) {
          teamSeriesByMetric.get(metricId).push(t.value)
        }
      }
    }
  }

  for (const { id: metricId, polarity } of TREND_METRICS) {
    const series = personSeriesByMetric.get(metricId) // index 0 = most recent week
    // Drive the drift read through the registered module so the path documented
    // by `explain_metric` (person.self_baseline_drift) is exactly the path that
    // executes. Module returns `establishing` below the baseline floor; the
    // report's existing contract — `driftStatus: 'establishing'`, `driftZ: null`,
    // `n: series.length` when the series is too short — is preserved verbatim.
    // selfBaselineDrift's "establishing" path needs a non-null current sample to
    // emit (otherwise it returns no_data). The report's contract is that a series
    // below the floor reads 'establishing' regardless of whether the latest week
    // produced a sample, so default to 0 for the establishing classification when
    // the current sample is missing — purely to drive the module past its
    // no_data gate; the row carries no derived `value` in that case.
    const baseline = series.length >= 2 ? summarize(series.slice(1)) : null
    const currentForModule = series.length > 0 ? series[0] : 0
    const drift = selfBaselineDrift.compute(
      {
        currentP50: currentForModule,
        baseline,
        baselineN: baseline?.n ?? 0,
        minN: TREND_MIN_BASELINE_N,
      },
      now,
    )
    const baseRow = {
      metric: metricId,
      driftStatus: drift.driftStatus,
      driftZ: drift.driftZ,
      n: series.length,
    }
    if (drift.dataQuality === 'ok') {
      baseRow.current = series[0]
      baseRow.baselineP50 = baseline?.p50 ?? null
    }
    out.push(baseRow)

    // Momentum vs team (difference-in-differences): compare the person's drift-z
    // against the team's drift-z over the SAME weekly windows. Skipped entirely
    // when the cohort is below the peer-comparison floor (a 1-person "team" is
    // not a meaningful reference) and surfaced as no_data when either series is
    // too short to derive a drift-z.
    if (!teamSeriesByMetric) continue
    const teamSeries = teamSeriesByMetric.get(metricId)
    const teamBaseline = teamSeries.length >= 2 ? summarize(teamSeries.slice(1)) : null
    const teamDrift = selfBaselineDrift.compute(
      {
        currentP50: teamSeries.length > 0 ? teamSeries[0] : null,
        baseline: teamBaseline,
        baselineN: teamBaseline?.n ?? 0,
        minN: TREND_MIN_BASELINE_N,
      },
      now,
    )
    const momentum = momentumVsTeam.compute(
      {
        personDriftZ: drift.driftZ,
        teamDriftZ: teamDrift.driftZ,
        polarity,
      },
      now,
    )
    out.push({
      metric: metricId,
      kind: 'momentum_vs_team',
      value: momentum.value,
      dataQuality: momentum.dataQuality,
      interpretation: momentum.interpretation,
      personDriftZ: momentum.personDriftZ,
      teamDriftZ: momentum.teamDriftZ,
      personN: series.length,
      teamN: teamSeries.length,
    })
  }
  return out
}
