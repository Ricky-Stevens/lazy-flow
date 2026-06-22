/**
 * Tests for the compute module — real metric computation over a seeded store.
 *
 * Seeds a minimal BunSqliteStore (in-memory) with hand-inserted entities drawn
 * from the testkit golden dataset (baseOrg / IDS), sufficient to exercise each
 * wired metric. Sprints are seeded under the Jira project id as their board id so
 * the board-discovery probe (project id → candidate board id) finds them.
 *
 * Asserts:
 *   - several wired metrics return a non-null value with dataQuality 'ok'
 *   - code.* returns no_data
 *   - person/self scope returns no_data
 *   - unknown metric ids return no_data (never throw)
 *   - backfillSnapshots writes > 0 snapshots that are readable via getSnapshots
 */

import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { setupServer } from 'msw/node'

import { BunSqliteStore, ENGINE_VERSION, migrate } from '../../core/index.js'
import { GitHubClient, syncGitHub } from '../../ingest-github/index.js'
import { baseOrg, IDS, loadScopeDataWindowed, mockGitHub } from '../../testkit/index.js'
import {
  backfillSnapshots,
  COMPUTE_METRIC_IDS,
  computeMetric,
  invalidateLookupsCache,
  loadFullScopeData,
} from './index.js'

const NOW = '2024-06-01T00:00:00.000Z'
// Sprints/boards are discovered by probing the Jira project id as a board id.
// Use the REAL agile-board id, which is a different namespace from the Jira
// project id. Agile-metric sprint discovery must enumerate sprints directly
// (listAllSprints), not probe project ids as candidate board ids — the latter
// only ever worked because fixtures aliased board id == project id.
const BOARD_ID = IDS.boardId

/** Open an in-memory store with the schema migrated. */
function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

/** Seed the store with the golden-dataset entities the wired metrics need. */
async function seed(store) {
  await store.upsertOrganisation({
    id: baseOrg.org.id,
    githubLogin: baseOrg.org.githubLogin,
    jiraCloudId: baseOrg.org.jiraCloudId,
    name: 'Acme',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  })

  // Repositories
  for (const r of baseOrg.repositories) {
    await store.upsertRepository({
      id: r.id,
      githubNodeId: r.githubNodeId,
      orgId: r.orgId,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch,
      isArchived: r.isArchived,
      isFork: r.isFork,
      deletedAt: null,
      raw: r.raw,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })
  }

  // Persons (identities FK to persons)
  for (const p of baseOrg.persons) {
    await store.upsertPerson({
      id: p.id,
      displayName: p.displayName,
      primaryAccountRef: p.primaryAccountRef,
      updatedAt: p.updatedAt,
    })
  }

  // Identities (incl. the bot)
  for (const idn of baseOrg.identities) {
    await store.upsertIdentity({
      id: idn.id,
      personId: idn.personId,
      kind: idn.kind,
      externalId: idn.externalId,
      isBot: idn.isBot,
      confidence: idn.confidence,
      raw: idn.raw,
      updatedAt: idn.updatedAt,
    })
  }

  // Commits
  for (const c of baseOrg.commits) {
    await store.upsertCommit({
      repoId: c.repoId,
      sha: c.sha,
      authorIdentityId: c.authorIdentityId,
      authoredAt: c.authoredAt,
      committedAt: c.committedAt,
      additions: c.additions,
      deletions: c.deletions,
      haloc: c.haloc,
      raw: c.raw,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })
  }

  // Pull requests
  for (const pr of baseOrg.pullRequests) {
    await store.upsertPullRequest({
      id: pr.id,
      repoId: pr.repoId,
      number: pr.number,
      authorIdentityId: pr.authorIdentityId,
      state: pr.state,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      isDraft: pr.isDraft,
      mergedViaQueue: pr.mergedViaQueue,
      createdAt: pr.createdAt,
      readyAt: pr.readyAt,
      firstCommitAt: pr.firstCommitAt,
      firstReviewAt: pr.firstReviewAt,
      approvedAt: pr.approvedAt,
      mergedAt: pr.mergedAt,
      mergedByIdentityId: pr.mergedByIdentityId,
      deletedAt: null,
      raw: pr.raw,
      updatedAt: pr.updatedAt,
    })
  }

  // PR files (per-file diffs) — feed pr.size and the code.* metrics.
  for (const f of baseOrg.prFiles) {
    await store.upsertPrFile({
      prId: f.prId,
      repoId: f.repoId,
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      haloc: f.haloc,
      status: f.status,
      patch: f.patch,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })
  }

  // Reviews + comments
  for (const rv of baseOrg.reviews) {
    await store.upsertReview({
      nodeId: rv.nodeId,
      prId: rv.prId,
      reviewerIdentityId: rv.reviewerIdentityId,
      state: rv.state,
      submittedAt: rv.submittedAt,
      raw: rv.raw,
      updatedAt: rv.updatedAt,
    })
  }
  for (const rc of baseOrg.reviewComments) {
    await store.upsertReviewComment({
      nodeId: rc.nodeId,
      prId: rc.prId,
      authorIdentityId: rc.authorIdentityId,
      createdAt: rc.createdAt,
      inReplyTo: rc.inReplyTo,
      path: rc.path,
      raw: rc.raw,
      updatedAt: rc.updatedAt,
    })
  }

  // Check runs — a passing + a failing run for pr.ci_health.
  await store.upsertCheckRun({
    nodeId: 'check-1',
    repoId: IDS.repoAlpha,
    headSha: IDS.commitA1,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2024-03-01T09:10:00Z',
    completedAt: '2024-03-01T09:20:00Z',
    raw: '{}',
    updatedAt: '2024-03-01T09:20:00Z',
  })
  await store.upsertCheckRun({
    nodeId: 'check-2',
    repoId: IDS.repoAlpha,
    headSha: IDS.commitA2,
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2024-03-02T10:10:00Z',
    completedAt: '2024-03-02T10:30:00Z',
    raw: '{}',
    updatedAt: '2024-03-02T10:30:00Z',
  })

  // Deployments
  for (const d of baseOrg.deployments) {
    await store.upsertDeployment({
      id: d.id,
      repoId: d.repoId,
      sha: d.sha,
      environment: d.environment,
      status: d.status,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      source: d.source,
      raw: d.raw,
      updatedAt: d.finishedAt,
    })
  }

  // Jira project
  await store.upsertJiraProject({
    id: baseOrg.jiraProject.id,
    key: baseOrg.jiraProject.key,
    name: baseOrg.jiraProject.name,
    jiraCloudId: baseOrg.jiraProject.jiraCloudId,
    raw: baseOrg.jiraProject.raw,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  })

  // Status category history (board-free flow boundaries read this).
  for (const s of baseOrg.jiraStatuses) {
    await store.upsertStatusCategoryHistory({
      statusId: s.id,
      category: s.category,
      validFrom: '2024-01-01T00:00:00Z',
      validTo: null,
    })
  }

  // Issues + transitions
  for (const issue of baseOrg.jiraIssues) {
    await store.upsertIssue({
      id: issue.id,
      projectId: issue.projectId,
      key: issue.key,
      type: issue.type,
      statusId: issue.statusId,
      statusCategory: issue.statusCategory,
      storyPoints: issue.storyPoints,
      storyPointsFieldId: issue.storyPointsFieldId,
      storyPointsRaw: issue.storyPointsRaw,
      parentId: issue.parentId,
      epicKey: issue.epicKey,
      isSubtask: issue.isSubtask,
      hierarchyLevel: issue.hierarchyLevel,
      assigneeIdentityId: issue.assigneeIdentityId,
      createdAt: issue.createdAt,
      resolvedAt: issue.resolvedAt,
      deletedAt: null,
      raw: issue.raw,
      updatedAt: issue.updatedAt,
    })
    const transitions = baseOrg.issueTransitions[issue.id] ?? []
    if (transitions.length > 0) {
      await store.appendIssueTransitions(
        transitions.map((t) => ({
          id: t.id,
          issueId: t.issueId,
          fromStatusId: t.fromStatusId,
          toStatusId: t.toStatusId,
          projectIdAtTransition: t.projectIdAtTransition,
          transitionedAt: t.transitionedAt,
          actorIdentityId: t.actorIdentityId,
        })),
      )
    }
  }

  // Board config + columns under the real agile-board id (distinct from project id).
  await store.upsertBoardConfig({
    boardId: BOARD_ID,
    type: 'scrum',
    updatedAt: '2024-01-01T00:00:00Z',
  })
  for (const col of baseOrg.boardColumns) {
    await store.upsertBoardColumn({
      boardId: BOARD_ID,
      columnName: col.columnName,
      statusIds: JSON.stringify(col.statusIds),
      isStartedCol: col.isStartedCol,
      isDoneCol: col.isDoneCol,
    })
  }

  // Sprint + membership events under BOARD_ID.
  for (const sp of baseOrg.sprints) {
    await store.upsertSprint({
      id: sp.id,
      boardId: BOARD_ID,
      state: sp.state,
      startAt: sp.startAt,
      endAt: sp.endAt,
      completeAt: sp.completeAt,
      updatedAt: sp.updatedAt,
    })
  }
  for (const ev of baseOrg.sprintMembershipEvents) {
    await store.appendSprintMembershipEvent({
      sprintId: ev.sprintId,
      issueId: ev.issueId,
      change: ev.change,
      pointsAtEvent: ev.pointsAtEvent,
      transitionedAt: ev.transitionedAt,
      wasPresentAtStart: ev.wasPresentAtStart,
    })
  }
}

describe('computeMetric', () => {
  let store

  beforeEach(async () => {
    store = freshStore()
    await seed(store)
  })

  // Window spanning the whole dataset (2024-01 .. 2024-06).
  const FROM = '2024-01-01'
  const TO = '2024-05-31'

  async function compute(metricId, scope = 'team') {
    return computeMetric(store, scope, IDS.org, metricId, FROM, TO, NOW)
  }

  it('dora.deployment_frequency → ok with a non-null rate', async () => {
    const r = await compute('dora.deployment_frequency')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThan(0)
    expect(r.unit).toBe('deploys/day')
  })

  it('dora.lead_time → ok with a non-null p50', async () => {
    const r = await compute('dora.lead_time')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('deploy-count DORA metrics carry dataSource "real" when deploys are from a real feed', async () => {
    // The golden dataset's deployments are all source=deployments_api (real).
    const df = await compute('dora.deployment_frequency')
    const lt = await compute('dora.lead_time')
    expect(df.dataSource).toBe('real')
    expect(lt.dataSource).toBe('real')
  })

  it('deploy-count DORA metrics downgrade to "proxy" when any backing deploy is merge_proxy', async () => {
    // Add a NEW merge-to-default (heuristic) deploy inside the window alongside
    // the real-feed fixture deploys. A single proxy deploy in the aggregate
    // downgrades the whole metric to proxy (conservative).
    const real = baseOrg.deployments[0]
    if (real === undefined) throw new Error('fixture missing a deployment')
    await store.upsertDeployment({
      id: 'deploy-merge-proxy',
      repoId: real.repoId,
      sha: real.sha,
      environment: 'production',
      status: 'success',
      createdAt: '2024-04-15T10:00:00Z',
      finishedAt: '2024-04-15T10:05:00Z',
      source: 'merge_proxy',
      raw: '{}',
      updatedAt: '2024-04-15T10:05:00Z',
    })
    const df = await compute('dora.deployment_frequency')
    expect(df.dataSource).toBe('proxy')
  })

  it('incident-linked DORA metrics are always dataSource "proxy" (proximity linkage)', async () => {
    // CFR/MTTR/reopen/reliability rest on the temporal-proximity deploy↔incident
    // linkage — a heuristic, never an authoritative join — so they stay proxy
    // even though the deploy feed itself is real.
    for (const id of [
      'dora.change_failure_rate',
      'dora.recovery_time',
      'dora.incident_reopen_rate',
      'dora.reliability_proxy',
      'dora.deployment_rework_rate',
    ]) {
      const r = await compute(id)
      expect(r.dataSource, id).toBe('proxy')
    }
  })

  it('dora.recovery_time → ok, anchored on FIRST Done transition (not final/reopen)', async () => {
    // incident-1: created 11:00, first Done 12:00 → 3600s (NOT the 22h-later final
    //   Done at 2024-03-03T09:00 — proves the first-Done anchor, not resolvedAt).
    // incident-2: created 12:00, first Done 14:00 → 7200s.
    // type-7 p50 of [3600, 7200] = 5400s.
    const r = await compute('dora.recovery_time')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(5400)
    const mttr = r
    expect(mttr.p50Seconds).toBe(5400)
    expect(mttr.sampleSize).toBe(2)
  })

  it('dora.incident_reopen_rate → ok, counts the reopened incident', async () => {
    // incident-1 reopened once (Done → In Progress → Done), incident-2 not.
    const r = await compute('dora.incident_reopen_rate')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(0.5)
    const rr = r
    expect(rr.reopenedCount).toBe(1)
    expect(rr.totalIncidents).toBe(2)
  })

  it('dora.reliability_proxy → ok with a [0,1] score from incident frequency', async () => {
    const r = await compute('dora.reliability_proxy')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThanOrEqual(0)
    expect(r.value).toBeLessThanOrEqual(1)
    const rel = r
    expect(rel.incidentCount).toBe(2)
  })

  it('flow.cycle_time → ok with a non-null p50', async () => {
    const r = await compute('flow.cycle_time')
    expect(r.value).not.toBeNull()
    // n is small so the percentile floors leave dataQuality at insufficient_sample,
    // but a p50 value is still produced from the started→done boundary.
    expect(['ok', 'insufficient_sample']).toContain(r.dataQuality)
    expect(r.id).toBe('flow.cycle_time')
  })

  it('flow.throughput → ok with a positive count', async () => {
    const r = await compute('flow.throughput')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeGreaterThan(0)
  })

  it("flow.wip_load wires a derived cycle time (Little's Law not hardcoded dead)", async () => {
    // Regression: the dispatch hardcoded avgCycleTimeDays: null, so
    // littlesLawThroughputPerDay/stationarityWarning could never fire. The
    // result must carry the field (number when WIP>0 and cycle time exists,
    // null only when there is no WIP or no cycle-time sample) — and never crash.
    const r = await compute('flow.wip_load')
    expect(r.id).toBe('flow.wip_load')
    expect('littlesLawThroughputPerDay' in r).toBe(true)
    if (r.wip > 0 && r.littlesLawThroughputPerDay !== null) {
      expect(r.littlesLawThroughputPerDay).toBeGreaterThan(0)
    }
  })

  it('flow.flow_distribution → ok with a positive total', async () => {
    const r = await compute('flow.flow_distribution')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeGreaterThan(0)
  })

  it('flow.time_in_status → ok with a per-status distribution', async () => {
    const r = await compute('flow.time_in_status')
    expect(r.id).toBe('flow.time_in_status')
    expect(r.dataQuality).toBe('ok')
    // value = number of issues with at least one tracked status interval.
    expect(r.value).toBeGreaterThan(0)
    const tis = r
    expect(tis.distribution.length).toBeGreaterThan(0)
    // Every status the dataset's issues passed through has at least one sample.
    expect(tis.distribution.every((d) => d.sampleSize > 0)).toBe(true)
  })

  it('flow.cfd → ok with one entry per day across the window', async () => {
    const r = await compute('flow.cfd')
    expect(r.id).toBe('flow.cfd')
    expect(r.dataQuality).toBe('ok')
    const cfdRes = r

    // 2024-01-01 .. 2024-05-31 inclusive = 152 days.
    expect(cfdRes.days.length).toBe(152)
    // The done category is reached by the resolved issues by the end of the window.
    const lastDay = cfdRes.days[cfdRes.days.length - 1]
    expect((lastDay?.byFlowState.done ?? 0) > 0).toBe(true)
    expect(cfdRes.statusIds.length).toBeGreaterThan(0)
  })

  it('flow.monte_carlo_forecast → real p50 weeks from throughput history + open WIP', async () => {
    // The dataset has completed issues (weekly throughput samples) AND an Epic
    // still in an indeterminate (started) status → open WIP to forecast. The
    // forecast is reproducible (seed derived from the window + engine version).
    const r = await compute('flow.monte_carlo_forecast')
    expect(r.id).toBe('flow.monte_carlo_forecast')
    expect(r.unit).toBe('weeks')
    const mc = r

    // Weekly samples span the window; remaining WIP > 0 ⇒ a real p50 is produced.
    expect(mc.sampleSize).toBeGreaterThan(0)
    expect(mc.simulationCount).toBeGreaterThan(0)
    expect(mc.p50Weeks).not.toBeNull()
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThan(0)
  })

  it('flow.monte_carlo_forecast → reproducible for the same window (deterministic seed)', async () => {
    const a = await compute('flow.monte_carlo_forecast')
    const b = await compute('flow.monte_carlo_forecast')
    expect(a.value).toBe(b.value)
  })

  it('pr.time_to_first_review → ok with a non-null p50', async () => {
    const r = await compute('pr.time_to_first_review')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('pr.cycle_time → ok', async () => {
    const r = await compute('pr.cycle_time')
    expect(r.dataQuality).toBe('ok')
  })

  it('pr.size → ok with a non-null median haloc', async () => {
    const r = await compute('pr.size')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('pr.ci_health → ok with a pass rate', async () => {
    const r = await compute('pr.ci_health')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('pr.merge_without_review_rate → ok', async () => {
    const r = await compute('pr.merge_without_review_rate')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('pr.review_coverage → 1/3 (only pr-1 of 3 merged PRs has a non-author review)', async () => {
    // Merged PRs in window: pr-1 (alice, reviewed by bob), pr-2 (bob, no review),
    // pr-4 (bob, no review). Coverage = 1 with-review / 3 merged = 0.333…
    const r = await compute('pr.review_coverage')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('pr.review_coverage')
    expect(r.value).toBeCloseTo(1 / 3, 10)
    const cov = r
    expect(cov.prsWithReview).toBe(1)
    expect(cov.totalMergedPrs).toBe(3)
  })

  it('pr.reviewers_per_pr → 1/3 (one unique non-author reviewer across 3 merged PRs)', async () => {
    // pr-1 has one unique non-author reviewer (bob); pr-2 and pr-4 have none.
    // Mean = 1 reviewer / 3 merged = 0.333…
    const r = await compute('pr.reviewers_per_pr')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeCloseTo(1 / 3, 10)
    const rev = r
    expect(rev.sampleSize).toBe(3)
  })

  it('pr.comments_per_pr → 1/3 (one review comment on pr-1 across 3 merged PRs)', async () => {
    // pr-1 has a single review comment (carol); pr-2/pr-4 have none.
    // Mean = 1 comment / 3 merged = 0.333…
    const r = await compute('pr.comments_per_pr')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeCloseTo(1 / 3, 10)
    const c = r
    expect(c.sampleSize).toBe(3)
  })

  it('pr.review_iterations → 1/3 (pr-1 has one changes_requested round)', async () => {
    // pr-1 reviews: changes_requested then approved → one completed round.
    // pr-2/pr-4 have no reviews. Mean = 1 / 3 merged = 0.333…
    const r = await compute('pr.review_iterations')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeCloseTo(1 / 3, 10)
    const it = r
    expect(it.sampleSize).toBe(3)
  })

  it('agile.say_do → ok with a non-null ratio (sprint completed in window)', async () => {
    const r = await compute('agile.say_do')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    // Full coverage in the base dataset: every in-window sprint has data.
    expect(r.sprintCoverage).toBe(1)
    expect(r.coverageNote).toBeUndefined()
  })

  it('agile.say_do flags partial sprint coverage when a report was unavailable', async () => {
    // Regression: a sprint whose report was unavailable at sync time (no
    // membership events ingested) was silently folded in as a 0/0 sprint and the
    // aggregate read confident. It is now excluded and the result carries a
    // coverage signal so the consumer knows the value is partial.
    await store.upsertSprint({
      id: 'sprint-noreport',
      boardId: BOARD_ID,
      state: 'closed',
      startAt: '2024-04-01T00:00:00Z',
      endAt: '2024-04-14T00:00:00Z',
      completeAt: '2024-04-15T00:00:00Z',
      updatedAt: '2024-04-15T00:00:00Z',
    })
    const r = await compute('agile.say_do')
    expect(r.sprintsConsidered).toBeGreaterThan(r.sprintsWithData)
    expect(r.sprintCoverage).toBeLessThan(1)
    expect(r.coverageNote).toContain('no usable data')
    // The real sprint still produced a ratio — flagged, not suppressed.
    expect(r.value).not.toBeNull()
  })

  it('agile.sprint_velocity → ok with a non-null completed total', async () => {
    const r = await compute('agile.sprint_velocity')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
  })

  it('agile.sprint_velocity headline is honestly scoped to the LATEST sprint, not the window', async () => {
    // The headline `value` is a single sprint's completed points. It must say so:
    // sprintCount (how many sprints fell in the window), the sprint identity, an
    // explicit isLatestSprintOnly flag, and a window average so a consumer never
    // reads one sprint as the period's velocity.
    const r = await compute('agile.sprint_velocity')
    expect(typeof r.sprintCount).toBe('number')
    expect(r.sprintCount).toBeGreaterThanOrEqual(1)
    expect(r.isLatestSprintOnly).toBe(true)
    expect(r.sprintId).toBeTruthy()
    // windowAvgCompleted is the across-sprint average; equals the headline only
    // when there is exactly one in-window sprint.
    expect(r.windowAvgCompleted).not.toBeNull()
    if (r.sprintCount === 1) expect(r.windowAvgCompleted).toBe(r.completed)
  })

  it('pr.stale surfaces a long-open PR created BEFORE the window (event-appropriate loading)', async () => {
    // Regression: a PR opened well before the window and never updated is the
    // definition of stale, yet a created_at-only window would drop it entirely.
    // The metric loader must include still-open PRs as of the window end.
    await store.upsertPullRequest({
      id: 'pr-long-open',
      repoId: IDS.repoAlpha,
      number: 9001,
      authorIdentityId: IDS.identityAliceGh,
      state: 'open',
      headRef: 'feat/ancient',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: '2023-11-01T00:00:00Z', // before FROM (2024-01-01)
      readyAt: '2023-11-01T00:00:00Z',
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: null,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: '2023-11-01T00:00:00Z', // no activity since → stale vs NOW
    })
    const r = await compute('pr.stale')
    expect(r.dataQuality).toBe('ok')
    expect(r.openPrCount).toBeGreaterThanOrEqual(1)
    expect(r.stalePrIds).toContain('pr-long-open')
  })

  it('dora.change_failure_rate → ok with a REAL rate from proximity-linked incidents', async () => {
    // 3 prod deploys: deploy-1 (alpha, 03-02), deploy-2 (beta, 04-01),
    //   deploy-3 (alpha failure, 05-01, no following incident).
    // Proximity linkage (most-recent preceding prod deploy within 7d):
    //   incident-1 (created 03-02T11:00) → deploy-1 (03-02T10:30).
    //   incident-2 (created 04-01T12:00) → deploy-2 (04-01T11:30).
    //   deploy-3 has no following incident → unlinked.
    // Failed (linked) deploys = {deploy-1, deploy-2} = 2 / 3 total = 0.6666…
    const r = await compute('dora.change_failure_rate')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('dora.change_failure_rate')
    expect(r.value).toBeCloseTo(2 / 3, 10)
    const cfr = r
    expect(cfr.deploysWithIncident).toBe(2)
    expect(cfr.totalDeploys).toBe(3)
  })

  it('dora.change_failure_rate → no_data when there are zero prod deploys in window', async () => {
    // Window before any deploy exists (all deploys are 2024-03 onward).
    const r = await computeMetric(
      store,
      'team',
      IDS.org,
      'dora.change_failure_rate',
      '2024-01-01',
      '2024-02-01',
      NOW,
    )
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
  })

  it('dora.change_failure_rate → proximity window excludes a too-distant deploy', async () => {
    // Window covering only incident-2 (04-01) and deploy-2/deploy-3, NOT deploy-1.
    // incident-1 falls outside this window so is not built. deploy-2 (04-01T11:30)
    // precedes incident-2 (04-01T12:00) within 7d → linked. deploy-3 (05-01) has no
    // following incident. Rate = 1 linked / 2 prod deploys = 0.5.
    const r = await computeMetric(
      store,
      'team',
      IDS.org,
      'dora.change_failure_rate',
      '2024-03-15',
      '2024-05-31',
      NOW,
    )
    expect(r.dataQuality).toBe('ok')
    const cfr = r
    expect(cfr.totalDeploys).toBe(2)
    expect(cfr.deploysWithIncident).toBe(1)
    expect(r.value).toBeCloseTo(0.5, 10)
  })

  it('dora.deployment_rework_rate → ok, hotfix proxy driven by incident linkage', async () => {
    // Incident-linked prod deploys (deploy-1, deploy-2) are the hotfix proxy set.
    // 2 hotfix / 3 prod deploys = 0.6666…
    const r = await compute('dora.deployment_rework_rate')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBeCloseTo(2 / 3, 10)
    const rwork = r
    expect(rwork.hotfixDeploys).toBe(2)
    expect(rwork.totalDeploys).toBe(3)
  })

  it('code.haloc_aggregate → ok with REAL aggregate HALOC from ingested pr_files', async () => {
    // pr-1 (alpha) files: widget.ts HALOC 5 + widget.test.ts HALOC 3 = 8.
    // pr-4 (beta)  files: gadget.go HALOC 11. Window total = 19.
    const r = await compute('code.haloc_aggregate')
    expect(r.dataQuality).toBe('ok')
    expect(r.id).toBe('code.haloc_aggregate')
    expect(r.value).toBe(19)
    // The HalocAggregateResult surfaces the per-change breakdown.
    const detailed = r

    expect(detailed.totalHaloc).toBe(19)
    expect(detailed.changeCount).toBe(2)
    const byId = new Map(detailed.perChange.map((c) => [c.changeId, c.haloc]))
    expect(byId.get(IDS.pr1)).toBe(8)
    expect(byId.get(IDS.pr4)).toBe(11)
    // Provenance: value came from re-parsing the stored patch.
    expect(r.halocSource).toBe('recomputed_from_patch')
  })

  it('code.haloc_aggregate → falls back to denormalised column when patches are NULL', async () => {
    // Reproduce the post-GraphQL state: per-file HALOC is denormalised but
    // pr_files.patch is NULL, so the diff-recompute sums to 0. The metric must
    // fall back to the denormalised column (= 19) instead of reporting a
    // confident 0 at ok quality.
    for (const f of baseOrg.prFiles) {
      await store.upsertPrFile({
        prId: f.prId,
        repoId: f.repoId,
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        haloc: f.haloc,
        status: f.status,
        patch: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      })
    }
    const r = await compute('code.haloc_aggregate')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(19)
    expect(r.totalHaloc).toBe(19)
    expect(r.halocSource).toBe('denormalized_prfile_column')
  })

  it('code.haloc_aggregate → PARTIAL backfill is a per-file HYBRID: precise patches + denorm for the rest (no undercount, no discard)', async () => {
    // The post-sync auto-backfill populates patches incrementally, so the steady
    // state is PARTIAL. The metric must count each file at its BEST available
    // fidelity: precise per-hunk HALOC where a patch exists, denormalised
    // max(add,del) where it does not. Null the patch on ONE file (gadget.go,
    // denorm HALOC 11), leaving pr-1's two files patched (precise recompute 8).
    // Total = 8 (precise) + 11 (denorm) = 19, correctly labelled hybrid — neither
    // a silent undercount (the old all-or-nothing recompute of 8) nor a discard of
    // the backfilled patches (the old all-or-nothing fallback to pure denorm).
    const partial = baseOrg.prFiles.find((f) => f.path.endsWith('gadget.go'))
    await store.upsertPrFile({
      prId: partial.prId,
      repoId: partial.repoId,
      path: partial.path,
      additions: partial.additions,
      deletions: partial.deletions,
      haloc: partial.haloc,
      status: partial.status,
      patch: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })
    const r = await compute('code.haloc_aggregate')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(19) // 8 precise (patched) + 11 denorm (unpatched)
    expect(r.totalHaloc).toBe(19)
    expect(r.halocSource).toBe('hybrid_patch_and_denormalized')
    expect(r.patchCoverage).toBeGreaterThan(0)
    expect(r.patchCoverage).toBeLessThan(1)
  })

  it('code.nagappan_ball → ok with a REAL relative-churn M1 from window HALOC', async () => {
    // No pr_files before the window, so priorHaloc = 0 → M1 = haloc/(0+haloc) = 1.
    const r = await compute('code.nagappan_ball')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).toBe(1)
    const nb = r
    // M2 = haloc(19) / windowDays — real churn rate, strictly positive.
    expect(nb.m2ChurnRate).not.toBeNull()
    expect(nb.m2ChurnRate).toBeGreaterThan(0)
  })

  it('nagappan_ball M1 prior-HALOC term excludes generated/vendored files', async () => {
    // Regression: the window numerator (totalWindowHaloc) filters generated
    // files, but the prior rolling-HALOC denominator term did not. A prior
    // lockfile regeneration would inflate priorHaloc and crush M1 =
    // haloc/(priorHaloc+haloc) toward 0, understating relative churn by an
    // arbitrary factor. Insert a prior PR whose only file is generated; M1 must
    // be unchanged from the no-prior case (= 1 for the golden window HALOC of 19).
    await store.upsertPullRequest({
      id: 'pr-prior-generated',
      repoId: IDS.repoAlpha,
      number: 9001,
      authorIdentityId: IDS.identityAliceGh,
      state: 'merged',
      headRef: 'chore/lockfile',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: '2023-12-01T00:00:00Z', // BEFORE the window start (FROM=2024-01-01)
      readyAt: '2023-12-01T00:00:00Z',
      firstCommitAt: '2023-12-01T00:00:00Z',
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: '2023-12-02T00:00:00Z',
      mergedByIdentityId: IDS.identityAliceGh,
      deletedAt: null,
      raw: '{}',
      updatedAt: '2023-12-02T00:00:00Z',
    })
    await store.upsertPrFile({
      prId: 'pr-prior-generated',
      repoId: IDS.repoAlpha,
      path: 'package-lock.json',
      additions: 5000,
      deletions: 5000,
      haloc: 10000,
      status: 'modified',
      patch: null,
      isGenerated: true,
      createdAt: '2023-12-01T00:00:00Z',
      updatedAt: '2023-12-01T00:00:00Z',
    })

    const r = await compute('code.nagappan_ball')
    // Prior generated churn is excluded → priorHaloc = 0 → M1 = 19/(0+19) = 1.
    // With the bug, M1 would be 19/(10000+19) ≈ 0.0019.
    expect(r.value).toBe(1)
    expect(r.m1RelativeChurn).toBe(1)
  })

  it('code.change_impact → ok with a REAL deterministic impact score', async () => {
    const r = await compute('code.change_impact')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThan(0)
    expect(r.value).toBeLessThanOrEqual(1)
  })

  it('code.complexity_delta → honest no_data naming whole-file ASTs', async () => {
    const r = await compute('code.complexity_delta')
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
    expect(r.formulaDoc.toLowerCase()).toContain('whole-file')
  })

  it('code.maintainability_index → honest no_data naming whole-file ASTs', async () => {
    const r = await compute('code.maintainability_index')
    expect(r.dataQuality).toBe('no_data')
    expect(r.formulaDoc.toLowerCase()).toContain('whole-file')
  })

  it('code.rework_churn → honest no_data naming git blame', async () => {
    const r = await compute('code.rework_churn')
    expect(r.dataQuality).toBe('no_data')
    expect(r.formulaDoc.toLowerCase()).toContain('blame')
  })

  it('code.complexity_delta → ok with REAL deltas once file complexity is ingested (G5)', async () => {
    // pr-1 (in window) touched src/widget.ts. Seed its base+head complexity.
    await store.upsertPrRef({
      prId: IDS.pr1,
      repoId: IDS.repoAlpha,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      updatedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'base-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 40,
      totalCyclomatic: 3,
      functionCount: 1,
      functions: [{ name: 'render', cyclomatic: 3, cognitive: 2 }],
      computedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 52,
      totalCyclomatic: 6,
      functionCount: 1,
      functions: [{ name: 'render', cyclomatic: 6, cognitive: 5 }],
      computedAt: NOW,
    })

    const r = await compute('code.complexity_delta')
    expect(r.dataQuality).toBe('ok')
    // render's cyclomatic rose 3 → 6 = +3.
    expect(r.totalCyclomaticIncrease).toBe(3)
  })

  it('code.maintainability_index → ok once head file complexity is ingested (G5)', async () => {
    await store.upsertPrRef({
      prId: IDS.pr1,
      repoId: IDS.repoAlpha,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      updatedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 52,
      totalCyclomatic: 6,
      functionCount: 2,
      functions: [
        { name: 'render', cyclomatic: 4, cognitive: 3 },
        { name: 'mount', cyclomatic: 2, cognitive: 1 },
      ],
      computedAt: NOW,
    })

    const r = await compute('code.maintainability_index')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThanOrEqual(0)
    expect(r.value).toBeLessThanOrEqual(100)
  })

  it('pr.size → REAL median HALOC > 0 from ingested pr_files', async () => {
    // Merged PRs in window: pr-1 (HALOC 8), pr-2 (no files → size 0), pr-4 (HALOC 11).
    // Sorted sizes {0, 8, 11} → median 8 (odd count). This is the load-bearing
    // assertion that toPrInput now uses REAL pr_files volume, not a hardcoded 0
    // (which would make every size 0 and the median 0).
    const r = await compute('pr.size')
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    expect(r.value).toBeGreaterThan(0)
    const sized = r
    expect(sized.medianHaloc).toBe(8)
  })

  it('person scope computes the per-person subset (PRs the person authored)', async () => {
    // alice authored merged pr-1 → pr.cycle_time has a real per-person value.
    const r = await computeMetric(store, 'person', IDS.personAlice, 'pr.cycle_time', FROM, TO, NOW)
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    // 'self' is an alias for the same per-identity attribution.
    const self = await computeMetric(store, 'self', IDS.personAlice, 'pr.size', FROM, TO, NOW)
    expect(self.dataQuality).toBe('ok')
  })

  it('person scope computes Q5/Q6 feedback metrics on the person’s authored PRs', async () => {
    // These reuse the team modules narrowed to alice's authored PRs, so they
    // report review coverage / feedback RECEIVED on the work she shipped.
    for (const metricId of [
      'pr.review_coverage',
      'pr.merge_without_review_rate',
      'pr.reviewers_per_pr',
      'pr.comments_per_pr',
      'pr.review_iterations',
    ]) {
      const r = await computeMetric(store, 'person', IDS.personAlice, metricId, FROM, TO, NOW)
      expect(r.dataQuality).toBe('ok')
      expect(r.value).not.toBeNull()
    }
    // review_coverage is a [0,1] rate.
    const cov = await computeMetric(
      store,
      'person',
      IDS.personAlice,
      'pr.review_coverage',
      FROM,
      TO,
      NOW,
    )
    expect(cov.value).toBeGreaterThanOrEqual(0)
    expect(cov.value).toBeLessThanOrEqual(1)
  })

  it('person.review_reciprocity computes give/receive balance at person scope', async () => {
    const r = await computeMetric(
      store,
      'person',
      IDS.personAlice,
      'person.review_reciprocity',
      FROM,
      TO,
      NOW,
    )
    // alice has review activity in the golden dataset (authored + reviewed PRs).
    // Below the interaction sample floor the ratio is still computed but honestly
    // flagged insufficient_sample (a few reviews are not a stable balance), so that
    // is a valid quality here alongside ok/no_data.
    expect(r.scope).toBe('person')
    expect(['ok', 'insufficient_sample', 'no_data']).toContain(r.dataQuality)
    if (r.dataQuality !== 'no_data') {
      expect(r.value).toBeGreaterThanOrEqual(0)
      expect(r.reviewsGiven + r.reviewsReceived).toBeGreaterThan(0)
    }
    // Team scope must NOT fabricate a value for a person-only metric.
    const team = await computeMetric(
      store,
      'team',
      IDS.org,
      'person.review_reciprocity',
      FROM,
      TO,
      NOW,
    )
    expect(team.dataQuality).toBe('no_data')
  })

  it('person scope returns no_data for team-only metrics (no per-head fabrication)', async () => {
    const dora = await computeMetric(
      store,
      'person',
      IDS.personAlice,
      'dora.deployment_frequency',
      FROM,
      TO,
      NOW,
    )
    expect(dora.dataQuality).toBe('no_data')
    const dist = await computeMetric(
      store,
      'person',
      IDS.personAlice,
      'flow.flow_distribution',
      FROM,
      TO,
      NOW,
    )
    expect(dist.dataQuality).toBe('no_data')
  })

  it('person scope for an unknown person → no_data (no identities)', async () => {
    const r = await computeMetric(store, 'person', 'person-nobody', 'pr.cycle_time', FROM, TO, NOW)
    expect(r.dataQuality).toBe('no_data')
  })

  it('unknown metric id → no_data, never throws', async () => {
    const r = await compute('does.not.exist')
    expect(r.dataQuality).toBe('no_data')
    expect(r.value).toBeNull()
    expect(r.id).toBe('does.not.exist')
  })

  it('COMPUTE_METRIC_IDS lists every wired metric', () => {
    expect(COMPUTE_METRIC_IDS).toContain('flow.cycle_time')
    expect(COMPUTE_METRIC_IDS).toContain('agile.say_do')
    expect(COMPUTE_METRIC_IDS).toContain('code.haloc_aggregate')
    expect(COMPUTE_METRIC_IDS).toContain('code.nagappan_ball')
    // DORA stability surface now fully wired (CFR/MTTR + companions).
    expect(COMPUTE_METRIC_IDS).toContain('dora.change_failure_rate')
    expect(COMPUTE_METRIC_IDS).toContain('dora.recovery_time')
    expect(COMPUTE_METRIC_IDS).toContain('dora.deployment_rework_rate')
    expect(COMPUTE_METRIC_IDS).toContain('dora.reliability_proxy')
    expect(COMPUTE_METRIC_IDS).toContain('dora.incident_reopen_rate')
    // Collaboration metrics now wired (WS-6).
    expect(COMPUTE_METRIC_IDS).toContain('pr.review_coverage')
    expect(COMPUTE_METRIC_IDS).toContain('pr.reviewers_per_pr')
    expect(COMPUTE_METRIC_IDS).toContain('pr.comments_per_pr')
    expect(COMPUTE_METRIC_IDS).toContain('pr.review_iterations')
    // Previously-unreachable flow views now wired (WS-7).
    expect(COMPUTE_METRIC_IDS).toContain('flow.cfd')
    expect(COMPUTE_METRIC_IDS).toContain('flow.time_in_status')
    expect(COMPUTE_METRIC_IDS).toContain('flow.monte_carlo_forecast')
    expect(COMPUTE_METRIC_IDS.length).toBeGreaterThanOrEqual(20)
  })

  // -------------------------------------------------------------------------
  // Anti-gaming annotation (WS-7) — detectors attach gamingFlags / goodhartWarning
  // to the MetricResult without altering the value. Clean data raises none.
  // -------------------------------------------------------------------------

  it('clean dataset raises NO gaming flags on flow.flow_efficiency', async () => {
    const r = await compute('flow.flow_efficiency')
    // The golden transitions are normal forward flow — no status juggling.
    expect(r.gamingFlags ?? []).toEqual([])
  })

  it('clean dataset raises NO gaming flags on dora.deployment_frequency', async () => {
    // All golden deploys are production and days apart — no inflation signal.
    const r = await compute('dora.deployment_frequency')
    expect(r.gamingFlags ?? []).toEqual([])
  })

  it('status juggling raises a status_juggling flag on flow.flow_efficiency', async () => {
    // Craft an issue that bounces In-Progress ⇄ In-Review twice within minutes.
    await store.upsertIssue({
      id: 'issue-juggled',
      projectId: IDS.jiraProjectId,
      key: 'ACME-999',
      type: 'Story',
      statusId: IDS.statusInProgress,
      statusCategory: 'indeterminate',
      storyPoints: null,
      storyPointsFieldId: null,
      storyPointsRaw: null,
      parentId: null,
      epicKey: null,
      isSubtask: false,
      hierarchyLevel: 1,
      assigneeIdentityId: null,
      createdAt: '2024-03-10T09:00:00Z',
      resolvedAt: null,
      deletedAt: null,
      raw: '{}',
      updatedAt: '2024-03-10T09:30:00Z',
    })
    await store.appendIssueTransitions([
      {
        id: 'jug-1',
        issueId: 'issue-juggled',
        fromStatusId: IDS.statusInProgress,
        toStatusId: IDS.statusInReview,
        projectIdAtTransition: IDS.jiraProjectId,
        transitionedAt: '2024-03-10T09:05:00Z',
        actorIdentityId: null,
      },
      {
        id: 'jug-2',
        issueId: 'issue-juggled',
        fromStatusId: IDS.statusInReview,
        toStatusId: IDS.statusInProgress,
        projectIdAtTransition: IDS.jiraProjectId,
        transitionedAt: '2024-03-10T09:10:00Z',
        actorIdentityId: null,
      },
      {
        id: 'jug-3',
        issueId: 'issue-juggled',
        fromStatusId: IDS.statusInProgress,
        toStatusId: IDS.statusInReview,
        projectIdAtTransition: IDS.jiraProjectId,
        transitionedAt: '2024-03-10T09:15:00Z',
        actorIdentityId: null,
      },
      {
        id: 'jug-4',
        issueId: 'issue-juggled',
        fromStatusId: IDS.statusInReview,
        toStatusId: IDS.statusInProgress,
        projectIdAtTransition: IDS.jiraProjectId,
        transitionedAt: '2024-03-10T09:20:00Z',
        actorIdentityId: null,
      },
    ])

    const r = await compute('flow.flow_efficiency')
    const flags = r.gamingFlags ?? []
    expect(flags.some((f) => f.flag === 'status_juggling')).toBe(true)
    expect(flags.find((f) => f.flag === 'status_juggling')?.reason).toMatch(/issue-juggled/)
  })

  it('non-production deploy raises deploy_frequency_inflated on dora.deployment_frequency', async () => {
    await store.upsertDeployment({
      id: 'deploy-staging',
      repoId: IDS.repoAlpha,
      sha: IDS.commitA2,
      environment: 'staging', // non-prod counted in the window
      status: 'success',
      createdAt: '2024-03-15T10:00:00Z',
      finishedAt: '2024-03-15T10:05:00Z',
      source: 'deployments_api',
      raw: '{}',
      updatedAt: '2024-03-15T10:05:00Z',
    })
    const r = await compute('dora.deployment_frequency')
    const flags = r.gamingFlags ?? []
    expect(flags.some((f) => f.flag === 'deploy_frequency_inflated')).toBe(true)
    // The value is annotated, not penalised — still a real rate.
    expect(r.value).not.toBeNull()
  })

  it('attaches a goodhartWarning to pin-target-sensitive metrics', async () => {
    const r = await compute('dora.deployment_frequency')
    expect(r.goodhartWarning).toBeDefined()
    expect(r.goodhartWarning).toMatch(/Goodhart/)
  })

  it('does NOT attach a goodhartWarning to non-sensitive metrics', async () => {
    const r = await compute('pr.review_coverage')
    expect(r.goodhartWarning).toBeUndefined()
  })
})

describe('backfillSnapshots', () => {
  let store

  beforeEach(async () => {
    store = freshStore()
    await seed(store)
  })

  it('writes snapshots that are readable via getSnapshots', async () => {
    const metricIds = ['flow.throughput', 'pr.time_to_first_review', 'agile.say_do']
    const written = await backfillSnapshots(store, {
      scopeType: 'team',
      scopeId: IDS.org,
      metricIds,
      fromDay: '2024-03-01',
      toDay: '2024-03-03',
      windowDays: 90,
      now: NOW,
      ingestWatermarkVersion: 'wm-1',
      coverageFingerprint: 'fp-test',
    })

    // 3 days × 3 metrics
    expect(written).toBe(9)

    const snaps = await store.getSnapshots(
      'team',
      IDS.org,
      'flow.throughput',
      '2024-03-01',
      '2024-03-03',
    )
    expect(snaps.length).toBe(3)
    for (const s of snaps) {
      expect(s.window).toBe('90d')
      expect(s.engineVersion).toBe(ENGINE_VERSION)
      expect(s.ingestWatermarkVersion).toBe('wm-1')
      expect(s.coverageFingerprint).toBe('fp-test')
      expect(s.isStale).toBe(false)
      expect(s.computedAt).toBe(NOW)
    }
  })

  it('clocks each day to that day, not opts.now (point-in-time metrics vary over the backfill)', async () => {
    // Regression: aging_wip is computed as-of `now`. If backfill reused a single
    // opts.now for every day, every historical snapshot would be identical to
    // today's. Clocking each day to its own end makes a persistently-open WIP
    // item age across the series — so the snapshots must NOT all be equal, and
    // an earlier day must read younger than a later one.
    await backfillSnapshots(store, {
      scopeType: 'team',
      scopeId: IDS.org,
      metricIds: ['flow.aging_wip'],
      fromDay: '2024-03-01',
      toDay: '2024-05-01',
      windowDays: 90,
      now: NOW,
      ingestWatermarkVersion: 'wm-1',
      coverageFingerprint: 'fp-test',
    })
    const snaps = (
      await store.getSnapshots('team', IDS.org, 'flow.aging_wip', '2024-03-01', '2024-05-01')
    ).filter((s) => s.value !== null)
    expect(snaps.length).toBeGreaterThan(1)
    const values = snaps.map((s) => s.value)
    const allEqual = values.every((v) => v === values[0])
    expect(allEqual).toBe(false)
    // computedAt is still the real compute time, not the per-day clock.
    for (const s of snaps) expect(s.computedAt).toBe(NOW)
    // Earliest day reads younger than the latest day (age grows over time).
    const byDay = [...snaps].sort((a, b) => a.day.localeCompare(b.day))
    expect(byDay[0].value).toBeLessThan(byDay[byDay.length - 1].value)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: a real GitHub sync (via MSW) persists check_runs, and
// pr.ci_health then computes a REAL pass rate from them (not no_data / not a
// fabricated 1.0). This proves the check_runs ingestion wired in WS-6 reaches
// the metric, end to end.
// ---------------------------------------------------------------------------

describe('pr.ci_health end-to-end from a real sync', () => {
  const server = setupServer(...mockGitHub())
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  // Repo ids as persisted by syncGitHub (owner/name → owner-name).
  const SYNCED_REPO_ALPHA = 'octo-acme-alpha-service'

  it('computes a real pass rate from synced check runs', async () => {
    const store = freshStore()
    const client = new GitHubClient({ token: 't', baseUrl: 'https://api.github.com' })
    await syncGitHub(store, client, { org: 'octo-acme' }, 'backfill')

    // Sanity: the sync actually persisted check runs (build pass + test fail on
    // pr-1, build pass on pr-4) — 3 runs total, 2 successes.
    const alphaRuns = await store.getCheckRunsByRepo(SYNCED_REPO_ALPHA)
    expect(alphaRuns.length).toBe(2)

    // Window covering all synced check runs (2024-03 .. 2024-04).
    const r = await computeMetric(
      store,
      'team',
      IDS.org,
      'pr.ci_health',
      '2024-03-01',
      '2024-04-30',
      NOW,
    )
    expect(r.dataQuality).toBe('ok')
    expect(r.value).not.toBeNull()
    // 2 passing of 3 completed runs across both repos = 0.666… pass rate.
    // The exact headline depends on the ciHealth formula, but it must be a real
    // ratio in (0, 1) — not 1.0 (would imply no failures) and not no_data.
    expect(r.value).toBeGreaterThan(0)
    expect(r.value).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------
// Equivalence: the bulk load-once + in-memory window slice
// (loadFullScopeData/sliceScopeData) must produce IDENTICAL metric values to the
// original per-window SQL loader (loadScopeDataWindowed oracle) for every metric
// over every window. This is the safety net for the snapshot-backfill perf
// rewrite — if any slice predicate diverges from its SQL counterpart, a metric
// value differs here.
// ---------------------------------------------------------------------------

describe('sliceScopeData ≡ loadScopeDataWindowed (perf-rewrite equivalence)', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
  })

  // Windows spanning the seeded data plus an empty future window.
  const WINDOWS = [
    ['2024-01-01', '2024-03-31'],
    ['2024-02-01', '2024-03-02'],
    ['2024-03-02', '2024-03-31'],
    ['2024-05-02', '2024-05-31'],
    ['2024-01-01', '2024-06-01'],
    ['2025-01-01', '2025-01-30'], // no data — exercises empty slices
  ]

  for (const [from, to] of WINDOWS) {
    for (const scopeType of ['org', 'team']) {
      it(`matches the SQL oracle for every metric over ${from}..${to} (${scopeType})`, async () => {
        const oracle = await loadScopeDataWindowed(store, from, to)
        for (const metricId of COMPUTE_METRIC_IDS) {
          const viaSlice = await computeMetric(store, scopeType, scopeType, metricId, from, to, NOW)
          const viaOracle = await computeMetric(
            store,
            scopeType,
            scopeType,
            metricId,
            from,
            to,
            NOW,
            oracle,
          )
          expect({ id: metricId, value: viaSlice.value }).toEqual({
            id: metricId,
            value: viaOracle.value,
          })
          expect(viaSlice.trustTier).toBe(viaOracle.trustTier)
          expect(viaSlice.dataQuality).toBe(viaOracle.dataQuality)
        }
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Backfill N+1 kill: code.complexity_delta and code.maintainability_index used
// to call `store.getPrRef(prId)` and `store.getFileComplexity(...)` INSIDE the
// per-PR/per-file loop on every day of the backfill. Both are now read from
// bulk maps that the loader populates ONCE via store.getAllPrRefs +
// store.getAllFileComplexity. The point-query fallback is preserved for callers
// that build `data` without the maps — this test pins both paths produce
// byte-identical metric values.
// ---------------------------------------------------------------------------

describe('complexity_delta / maintainability_index — bulk-map ≡ point-query fallback', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
    // Seed pr_refs + file_complexity so the metrics produce 'ok' results
    // through both the bulk-map path and the point-query fallback.
    await store.upsertPrRef({
      prId: IDS.pr1,
      repoId: IDS.repoAlpha,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      updatedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'base-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 40,
      totalCyclomatic: 3,
      functionCount: 1,
      functions: [{ name: 'render', cyclomatic: 3, cognitive: 2 }],
      computedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 52,
      totalCyclomatic: 6,
      functionCount: 2,
      functions: [
        { name: 'render', cyclomatic: 4, cognitive: 3 },
        { name: 'mount', cyclomatic: 2, cognitive: 1 },
      ],
      computedAt: NOW,
    })
  })

  // A window where pr-1 is in scope.
  const FROM = '2024-02-01'
  const TO = '2024-03-31'

  for (const metricId of ['code.complexity_delta', 'code.maintainability_index']) {
    it(`${metricId} — bulk-map value === point-query fallback value`, async () => {
      // (a) Normal path — loadScopeDataWindowed bulk-loads prRefById /
      //     fileComplexityByKey and the metric reads from the maps.
      const withMaps = await loadScopeDataWindowed(store, FROM, TO)
      // Sanity: the loader attached the bulk maps the metric reads from.
      expect(withMaps.prRefById).toBeInstanceOf(Map)
      expect(withMaps.fileComplexityByKey).toBeInstanceOf(Map)
      expect(withMaps.prRefById.size).toBeGreaterThan(0)
      expect(withMaps.fileComplexityByKey.size).toBeGreaterThan(0)
      const viaMaps = await computeMetric(store, 'org', 'org', metricId, FROM, TO, NOW, withMaps)

      // (b) Fallback path — strip the maps so the metric MUST call
      //     store.getPrRef / store.getFileComplexity for each PR / file.
      const withoutMaps = { ...withMaps, prRefById: undefined, fileComplexityByKey: undefined }
      const viaPointQuery = await computeMetric(
        store,
        'org',
        'org',
        metricId,
        FROM,
        TO,
        NOW,
        withoutMaps,
      )

      expect(viaMaps.dataQuality).toBe('ok')
      expect(viaPointQuery.dataQuality).toBe('ok')
      expect(viaMaps.value).toBe(viaPointQuery.value)
    })
  }
})

// Regression: the global-lookups memo is keyed on the (long-lived) store, so in
// a persistent MCP server a SECOND sync's recompute must not read lookups cached
// before that sync's ingestion writes. backfillSnapshots (and the engine-bump
// rederive) must invalidate the memo so freshly-ingested file_complexity /
// pr_refs / status categories are seen. Fails before the invalidateLookupsCache
// wiring; passes after.
describe('global-lookups memo — invalidated by recompute entry points', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
    await store.upsertPrRef({
      prId: IDS.pr1,
      repoId: IDS.repoAlpha,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      updatedAt: NOW,
    })
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/widget.ts',
      language: 'typescript',
      loc: 52,
      totalCyclomatic: 6,
      functionCount: 2,
      functions: [{ name: 'render', cyclomatic: 4, cognitive: 3 }],
      computedAt: NOW,
    })
  })

  it('a new file_complexity row is invisible until the memo is invalidated', async () => {
    // Prime the memo (simulates a get_* / prior backfill populating it).
    const before = await loadFullScopeData(store)
    const baseSize = before.fileComplexityByKey.size
    expect(baseSize).toBeGreaterThan(0)

    // A later "sync" ingests a new complexity row.
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/added-after-memo.ts',
      language: 'typescript',
      loc: 10,
      totalCyclomatic: 2,
      functionCount: 1,
      functions: [{ name: 'added', cyclomatic: 2, cognitive: 1 }],
      computedAt: NOW,
    })

    // Without invalidation the memo is stale — the new row is not yet visible.
    const stale = await loadFullScopeData(store)
    expect(stale.fileComplexityByKey.size).toBe(baseSize)

    // Explicit invalidation surfaces it.
    invalidateLookupsCache(store)
    const fresh = await loadFullScopeData(store)
    expect(fresh.fileComplexityByKey.size).toBe(baseSize + 1)
  })

  it('invalidateLookupsCache after pr_files.haloc update surfaces new values (backfill regression)', async () => {
    // Simulates what backfill_pr_patches does: it writes pr_files.haloc then the
    // MCP handler calls invalidateLookupsCache so the next get_* sees fresh data.
    await loadFullScopeData(store)

    // Upsert a pr_file with an updated haloc (simulating patch backfill).
    await store.upsertPrFile({
      prId: IDS.pr1,
      repoId: IDS.repoAlpha,
      path: 'src/memo-regression.ts',
      additions: 5,
      deletions: 2,
      haloc: 7,
      patch: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
      isGenerated: false,
      createdAt: NOW,
      updatedAt: NOW,
    })

    // Without invalidation, memo is stale — new file is NOT visible.
    const stale = await loadFullScopeData(store)
    const staleFiles = [...(stale.filesByPr.get(IDS.pr1) ?? [])]
    expect(staleFiles.some((f) => f.path === 'src/memo-regression.ts')).toBe(false)

    // After invalidation (what the server handler does), fresh load reflects it.
    invalidateLookupsCache(store)
    const fresh = await loadFullScopeData(store)
    const freshFiles = [...(fresh.filesByPr.get(IDS.pr1) ?? [])]
    expect(freshFiles.some((f) => f.path === 'src/memo-regression.ts')).toBe(true)
  })

  it('backfillSnapshots invalidates the memo so the recompute reads post-write state', async () => {
    // Prime the memo, then ingest a new complexity row AFTER it is cached.
    const before = await loadFullScopeData(store)
    const baseSize = before.fileComplexityByKey.size
    await store.upsertFileComplexity({
      repoId: IDS.repoAlpha,
      sha: 'head-sha',
      path: 'src/added-before-backfill.ts',
      language: 'typescript',
      loc: 12,
      totalCyclomatic: 3,
      functionCount: 1,
      functions: [{ name: 'fn', cyclomatic: 3, cognitive: 2 }],
      computedAt: NOW,
    })

    // A backfill (always runs after a sync's ingestion) must refresh the memo.
    await backfillSnapshots(store, {
      scopeType: 'org',
      scopeId: 'org',
      metricIds: ['code.maintainability_index'],
      fromDay: '2024-06-01',
      toDay: '2024-06-01',
      windowDays: 1,
      now: NOW,
      ingestWatermarkVersion: '1',
      coverageFingerprint: 'test',
    })

    const fresh = await loadFullScopeData(store)
    expect(fresh.fileComplexityByKey.size).toBe(baseSize + 1)
  })
})
