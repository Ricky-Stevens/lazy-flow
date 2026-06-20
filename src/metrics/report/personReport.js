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

import { classifyDrift, summarize } from '../../report/baseline/stats.js'
import { comparePersonToCohort, MIN_COHORT, selectHumanCohort } from '../person/index.js'
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

/** Metrics worth a self-baseline trend read (cheap scalars with a clear trajectory). */
export const TREND_METRICS = [
  'person.ci_green_before_merge_rate',
  'pr.review_coverage',
  'person.complexity_authored_delta',
  'person.bugfix_share',
  'pr.review_bypass_rate_received',
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
      'Coaching signal, not a scorecard. Compared to this person’s own team distribution and ' +
      'their own history — never a rank. Descriptive metrics carry no better/worse orientation. ' +
      `Peer comparison is suppressed below a cohort of ${MIN_COHORT} human peers.`,
  }
}

/**
 * On-demand self-baseline drift: split the window into trailing weekly buckets,
 * use all-but-last as the baseline distribution, classify the latest bucket.
 * Needs no pre-backfilled snapshots.
 */
async function computeSelfTrend(
  store,
  personId,
  identityIds,
  sharedExtras,
  fromDay,
  toDay,
  now,
  deps,
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
  const seriesByMetric = new Map(TREND_METRICS.map((m) => [m, []]))
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
    for (const metricId of TREND_METRICS) {
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
      if (r.value !== null && Number.isFinite(r.value)) seriesByMetric.get(metricId).push(r.value)
    }
  }

  for (const metricId of TREND_METRICS) {
    const series = seriesByMetric.get(metricId) // index 0 = most recent week
    if (series.length < 3) {
      out.push({ metric: metricId, driftStatus: 'establishing', driftZ: null, n: series.length })
      continue
    }
    const current = series[0]
    const baseline = summarize(series.slice(1))
    const { driftZ, driftStatus } = classifyDrift(current, baseline)
    out.push({
      metric: metricId,
      driftStatus,
      driftZ,
      current,
      baselineP50: baseline.p50,
      n: series.length,
    })
  }
  return out
}
