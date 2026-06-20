import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { BunSqliteStore, migrate } from '../../core/index.js'
import { computePersonReportLive } from '../compute/index.js'

const NOW = '2024-06-15T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

async function seed(store) {
  await store.upsertOrganisation({
    id: 'org-1',
    githubLogin: 'acme',
    jiraCloudId: null,
    name: 'Acme',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertRepository({
    id: 'repo-1',
    githubNodeId: 'node-1',
    orgId: 'org-1',
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    isArchived: false,
    isFork: false,
    deletedAt: null,
    raw: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertPerson({
    id: 'p-1',
    displayName: 'Dev One',
    primaryAccountRef: 'gh:d1',
    updatedAt: NOW,
  })
  await store.upsertIdentity({
    id: 'id-1',
    personId: 'p-1',
    kind: 'github_login',
    externalId: 'd1',
    isBot: false,
    confidence: 1,
    raw: '{}',
    updatedAt: NOW,
  })
  for (let i = 1; i <= 3; i++) {
    await store.upsertPullRequest({
      id: `pr-${i}`,
      repoId: 'repo-1',
      number: i,
      authorIdentityId: 'id-1',
      state: 'merged',
      headRef: `f${i}`,
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: `2024-06-0${i}T00:00:00.000Z`,
      readyAt: `2024-06-0${i}T00:00:00.000Z`,
      firstCommitAt: `2024-06-0${i}T00:00:00.000Z`,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: `2024-06-0${i}T06:00:00.000Z`,
      mergedByIdentityId: 'id-1',
      deletedAt: null,
      raw: '{}',
      updatedAt: NOW,
    })
  }
}

describe('computePersonReportLive', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
  })

  it('returns a structured single-person report routed through the fairness contract', async () => {
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    expect(rep.personId).toBe('p-1')
    expect(rep.displayName).toBe('Dev One')
    expect(Array.isArray(rep.metrics)).toBe(true)
    expect(rep.metrics.length).toBeGreaterThan(10)
    expect(rep.contract).toContain('confidence')
    // Single human → peer comparison is suppressed (no misleading band on n<8).
    const reviewBypass = rep.metrics.find((m) => m.metric === 'pr.review_bypass_rate_received')
    expect(reviewBypass.comparison.band).toBe('insufficient_cohort')
    expect(reviewBypass.comparison.suppressed).toBe(true)
  })

  it('returns no metrics for an unknown person', async () => {
    const rep = await computePersonReportLive(store, 'nobody', { windowDays: 30, now: NOW })
    expect(rep.error).toBeTruthy()
    expect(rep.metrics).toEqual([])
  })

  it('cohortSuppressed agrees with the per-metric bands (counts PEERS, not incl. subject)', async () => {
    // Seed 7 peers → 8 people incl. the subject, but only 7 PEERS in the
    // distribution (the subject is excluded). The per-metric comparison gates on
    // peers (7 < MIN_COHORT 8) → insufficient_cohort. Before the fix the headline
    // flag used cohort.length (8) and reported cohortSuppressed:false — directly
    // contradicting every band. It must now be true.
    await seedCohort(store, 7)
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    expect(rep.cohortSize).toBe(8) // 7 peers + subject
    expect(rep.cohortSuppressed).toBe(true)
    const size = rep.metrics.find((m) => m.metric === 'pr.size')
    expect(size.comparison.band).toBe('insufficient_cohort')
    expect(size.comparison.suppressed).toBe(true)
  })

  it('cohortSuppressed is false once peers reach MIN_COHORT (8 peers + subject)', async () => {
    await seedCohort(store, 8)
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    expect(rep.cohortSize).toBe(9) // 8 peers + subject
    expect(rep.cohortSuppressed).toBe(false)
    const size = rep.metrics.find((m) => m.metric === 'pr.size')
    expect(size.comparison.suppressed).toBe(false)
  })
})

/**
 * Count top-level store method calls made by the report. Internal store self-calls
 * (this.method) bypass the proxy, so the counts reflect ONLY the query pattern the
 * report code issues — exactly what we want to bound against N+1 regressions.
 */
function countingStore(store) {
  const counts = {}
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver)
      if (typeof val !== 'function') return val
      return (...args) => {
        counts[prop] = (counts[prop] ?? 0) + 1
        return val.apply(target, args)
      }
    },
  })
  return { proxy, counts }
}

async function seedCohort(store, humanCount) {
  for (let k = 1; k <= humanCount; k++) {
    await store.upsertPerson({
      id: `c-${k}`,
      displayName: `Cohort ${k}`,
      primaryAccountRef: `gh:c${k}`,
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: `cid-${k}`,
      personId: `c-${k}`,
      kind: 'github_login',
      externalId: `c${k}`,
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: NOW,
    })
    for (let i = 1; i <= 2; i++) {
      await store.upsertPullRequest({
        id: `cpr-${k}-${i}`,
        repoId: 'repo-1',
        number: 1000 * k + i,
        authorIdentityId: `cid-${k}`,
        state: 'merged',
        headRef: `c${k}f${i}`,
        baseRef: 'main',
        isDraft: false,
        mergedViaQueue: false,
        createdAt: `2024-06-0${i}T00:00:00.000Z`,
        readyAt: `2024-06-0${i}T00:00:00.000Z`,
        firstCommitAt: `2024-06-0${i}T00:00:00.000Z`,
        firstReviewAt: null,
        approvedAt: null,
        mergedAt: `2024-06-0${i}T06:00:00.000Z`,
        mergedByIdentityId: `cid-${k}`,
        deletedAt: null,
        raw: '{}',
        updatedAt: NOW,
      })
    }
  }
}

describe('computePersonReportLive — query pattern (N+1 regression guard)', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
    await seedCohort(store, 9) // ≥ MIN_COHORT humans → cohort distribution runs
  })

  it('does NOT N+1: identity/full-load/verdict reads are O(1), not O(metrics × cohort)', async () => {
    const { proxy, counts } = countingStore(store)
    const rep = await computePersonReportLive(proxy, 'p-1', { windowDays: 30, now: NOW })

    // The cohort genuinely ran (≥8 humans, not suppressed) — so the bounds below are
    // proven against the real M × P path, not a short-circuited one.
    expect(rep.cohortSize).toBeGreaterThanOrEqual(8)
    expect(rep.cohortSuppressed).toBe(false)

    // ① identities resolved ONCE (the unknown-person guard) — seeded memo serves the
    //    person's own metrics, all cohort peers, and the trend. NOT one per (metric × person).
    expect(counts.getIdentitiesByPerson ?? 0).toBe(1)

    // ② full-dataset bulk loads bounded: one for the cohort window + one for the
    //    trend's full load — NOT one per (metric × week).
    expect(counts.getAllPullRequests ?? 0).toBeLessThanOrEqual(2)

    // ③ ai_verdicts read at most once per verdict metric (memoised on data), NOT
    //    once per (verdict metric × cohort person).
    expect(counts.getAiVerdictsByMetric ?? 0).toBeLessThanOrEqual(7)

    // ④ the unbounded extras tables (file_complexity is the biggest at scale) are
    //    scanned ONCE for the whole report — shared across the cohort data AND every
    //    trend week-slice — NOT once per week and NOT per (metric × week).
    expect(counts.getAllFileComplexity ?? 0).toBeLessThanOrEqual(2)
    expect(counts.getAllPrRefs ?? 0).toBeLessThanOrEqual(2)
    expect(counts.getAllAiAuthorship ?? 0).toBeLessThanOrEqual(2)
  })

  it('still computes a real cohort comparison when the floor is met', async () => {
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    // pr.size has a finite value for every author with a merged PR → enough finite
    // cohort values to place the person (not suppressed). Proves the short-circuit
    // didn't break legitimate comparison.
    const size = rep.metrics.find((m) => m.metric === 'pr.size')
    expect(size.comparison.suppressed).toBe(false)
    expect(size.comparison.cohortN).toBeGreaterThanOrEqual(8)
  })

  it('excludes the subject from their own cohort distribution', async () => {
    // The subject p-1 has merged PRs in the window. A cohort of 9 peers also has
    // merged PRs. If self-reference leaked in, cohortN for pr.size would equal
    // the number of finite cohort values INCLUDING the subject — i.e. >= 10.
    // After the fix it must equal the number of peers only.
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    const size = rep.metrics.find((m) => m.metric === 'pr.size')
    // 9 cohort peers (seedCohort) — the subject must NOT be included.
    expect(size.comparison.cohortN).toBe(9)
  })

  it('excludes peers below their metric sample floor from the cohort distribution', async () => {
    // Each seeded cohort peer authored only 2 PRs. pr.changes_requested_rate_received
    // has SAMPLE_FLOOR=8, so every peer returns a FINITE value (0) but flagged
    // dataQuality:'insufficient_sample'. Before the fix, personReport folded any
    // finite value into the cohort distribution regardless of dataQuality, so
    // cohortN would be 9 and the person would be placed against a baseline built
    // entirely from values the metric declared untrustworthy. After the fix, only
    // dataQuality:'ok' peers seed the baseline → no qualifying peers → suppressed.
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    const cr = rep.metrics.find((m) => m.metric === 'pr.changes_requested_rate_received')
    expect(cr).toBeTruthy()
    // The peers existed (9 of them) but none cleared the floor → none seed the cohort.
    expect(cr.comparison.cohortN).toBe(0)
    expect(cr.comparison.suppressed).toBe(true)
    expect(cr.comparison.band).toBe('insufficient_cohort')
  })

  it('feedback_response_latency is descriptive (no better/worse orientation) — not weaponizable', async () => {
    // The sample is a reviewer-gated round-trip cadence, so it must NOT be a
    // lower-is-better author score: the report must mark it descriptive and (via
    // comparePersonToCohort) never leak a percentile/direction for it.
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    const fb = rep.metrics.find((m) => m.metric === 'pr.feedback_response_latency')
    expect(fb).toBeTruthy()
    expect(fb.descriptive).toBe(true)
    expect(fb.comparison.percentile).toBeNull()
    expect(fb.comparison.direction).toBeNull()
  })

  it('suppresses peer comparison for metrics that require language/role bucketing', async () => {
    // complexity_authored_delta / high_complexity_file_share / pr_conceptual_surface /
    // skill_domain_footprint document a bucketing requirement we have not yet
    // implemented. Their comparison must be suppressed with band='requires_bucketing'
    // so the report never displays an unfair cross-domain peer placement; the raw
    // descriptive value still rides through for self-trend.
    const rep = await computePersonReportLive(store, 'p-1', { windowDays: 30, now: NOW })
    for (const id of [
      'person.complexity_authored_delta',
      'person.high_complexity_file_share',
      'person.pr_conceptual_surface',
      'person.skill_domain_footprint',
    ]) {
      const m = rep.metrics.find((x) => x.metric === id)
      expect(m).toBeTruthy()
      expect(m.comparison.band).toBe('requires_bucketing')
      expect(m.comparison.suppressed).toBe(true)
      expect(m.comparison.reason).toBe('requires_bucketing')
      expect(m.comparison.robustZ).toBeNull()
      expect(m.comparison.percentile).toBeNull()
    }
  })
})
