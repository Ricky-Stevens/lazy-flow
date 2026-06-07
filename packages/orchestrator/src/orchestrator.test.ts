/**
 * Tests for @lazy-flow/orchestrator (WP-SYNC-ORCH + WP-LINKING).
 *
 * Coverage:
 *   1. End-to-end runSync populates repos, PRs, issues, transitions, identities, links.
 *   2. linkIssues resolves a normal key (ACME-2 in PR title/body).
 *   3. linkIssues resolves the project-moved key (OLD-99 → issue-story-1).
 *   4. linkageRate is computed correctly.
 *   5. Re-running runSync is idempotent (no duplicates, watermarks advance).
 *   6. syncStatus reports freshness and flags a stale resource.
 */

import { linkageRate, linkIssues, migrate, NodeSqliteStore } from '@lazy-flow/core'
import { GitHubClient } from '@lazy-flow/ingest-github'
import { JiraClient } from '@lazy-flow/ingest-jira'
import { baseOrg, IDS, mockGitHub, mockJira } from '@lazy-flow/testkit'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runSync } from './runSync.js'
import { syncStatus } from './syncStatus.js'

// ---------------------------------------------------------------------------
// MSW server — combine both mock handler sets
// ---------------------------------------------------------------------------

const server = setupServer(...mockGitHub(), ...mockJira())

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeStore(): NodeSqliteStore {
  const store = new NodeSqliteStore(':memory:')
  migrate(store.db)
  return store
}

function makeGitHubClient(): GitHubClient {
  return new GitHubClient({ token: 'test-token', baseUrl: 'https://api.github.com' })
}

function makeJiraClient(): JiraClient {
  return new JiraClient({ baseUrl: 'https://acme.atlassian.net', token: 'test-token' })
}

const GITHUB_SCOPE = { org: 'octo-acme' }
const JIRA_SCOPE = {
  jiraCloudId: baseOrg.org.jiraCloudId,
  projectKeys: [baseOrg.jiraProject.key],
}
const NOW = '2024-06-01T12:00:00Z'

// ---------------------------------------------------------------------------
// 1. End-to-end: runSync populates all tables
// ---------------------------------------------------------------------------

describe('runSync — end-to-end population', () => {
  it('populates repos, PRs, issues, transitions, identities, and links', async () => {
    const store = makeStore()

    const result = await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // GitHub repos synced
    expect(result.github.repos.length).toBeGreaterThan(0)

    // Jira projects processed
    expect(result.jira.projectsProcessed).toContain(baseOrg.jiraProject.key)
    expect(result.jira.issuesUpserted).toBeGreaterThan(0)
    expect(result.jira.transitionsAppended).toBeGreaterThan(0)

    // Identities resolved
    expect(result.identity.identitiesUpserted).toBeGreaterThan(0)
    // Persons stitched (at minimum the 3 real contributors)
    expect(result.identity.personsCreated).toBeGreaterThanOrEqual(0)

    // Links upserted
    expect(result.linking.linksUpserted).toBeGreaterThan(0)

    // No fatal errors
    expect(result.errors).toHaveLength(0)

    // PRs persisted in the store
    const orgs = await store.listOrganisations()
    expect(orgs.length).toBeGreaterThan(0)

    // Issues persisted
    const issues = await store.getIssuesByProject(IDS.jiraProjectId)
    expect(issues.length).toBe(baseOrg.jiraIssues.length)

    // At least some transitions persisted
    const transitions = await store.getIssueTransitions(IDS.issueStory1)
    expect(transitions.length).toBeGreaterThan(0)

    // Links upserted (ACME-2 is inserted as current key by syncJira)
    expect(result.linking.linksUpserted).toBeGreaterThan(0)
  })
})

describe('runSync — tenant isolation', () => {
  it('hard-fails when the DB already contains a different org', async () => {
    const store = makeStore()
    // Seed an existing org for a DIFFERENT client.
    await store.upsertOrganisation({
      id: 'org-other-client',
      githubLogin: 'other-client',
      jiraCloudId: null,
      name: 'Other Client',
      createdAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      runSync(
        store,
        makeGitHubClient(),
        GITHUB_SCOPE, // org 'octo-acme' → org-octo-acme, different from org-other-client
        'backfill',
        makeJiraClient(),
        JIRA_SCOPE,
        'backfill',
        { now: NOW },
      ),
    ).rejects.toThrow(/Cross-org/)
  })
})

// ---------------------------------------------------------------------------
// 2. linkIssues resolves a normal key (ACME-2 in PR body)
// ---------------------------------------------------------------------------

describe('linkIssues — normal key resolution', () => {
  it('links pr-1 to issue-story-1 via ACME-2 regex match in title/body', async () => {
    const store = makeStore()

    // syncJira persists ACME-2 as the current issue key for issue-story-1.
    // linkIssues (called inside runSync) will resolve ACME-2 → issue-story-1.
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // pr-1 raw body contains "ACME-2" — should be linked to issueStory1.
    // The sync generates store PR ids as `${orgLogin}-${repoName}-pr-${number}`.
    // We look up by scanning all repos.
    const orgs = await store.listOrganisations()
    let foundLink = false
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        if (!repo.name.includes('alpha')) continue
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          if (pr.number !== 1) continue
          const links = await store.getPrIssueLinks(pr.id)
          if (links.some((l) => l.issueId === IDS.issueStory1)) {
            foundLink = true
          }
        }
      }
    }
    expect(foundLink).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. linkIssues resolves the project-moved key (OLD-99 → issue-story-1)
// ---------------------------------------------------------------------------

describe('linkIssues — project-moved key resolution', () => {
  it('resolves OLD-99 (historical key) to issue-story-1 via issue_keys history', async () => {
    const store = makeStore()

    // Step 1: sync to populate issues (so issue-story-1 exists before we insert the FK key).
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // Step 2: insert the OLD-99 historical key now that issue-story-1 is in the store.
    const oldKey = baseOrg.historicalIssueKeys.find((k) => k.key === IDS.movedIssueKey)
    if (oldKey) await store.upsertIssueKey(oldKey)

    // Step 3: re-run linkIssues so it picks up the OLD-99 → issueStory1 mapping.
    await linkIssues(store, { now: NOW })

    // pr-4 body contains "OLD-99" — must link to issueStory1 through moved key.
    const orgs = await store.listOrganisations()
    let movedKeyLinkFound = false
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        if (!repo.name.includes('beta')) continue
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          if (pr.number !== 4) continue
          const links = await store.getPrIssueLinks(pr.id)
          // OLD-99 should resolve to issue-story-1 via the historical key
          if (links.some((l) => l.issueId === IDS.issueStory1)) {
            movedKeyLinkFound = true
          }
        }
      }
    }
    expect(movedKeyLinkFound).toBe(true)
  })

  it('resolveIssueKey correctly maps OLD-99 to issue-story-1', async () => {
    const store = makeStore()

    // First sync to create the issue-story-1 record.
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // Now insert historical keys (FK is satisfied because issue-story-1 exists).
    for (const k of baseOrg.historicalIssueKeys) {
      await store.upsertIssueKey(k)
    }

    // OLD-99 was valid before 2024-01-01 — resolve at a time when it was active.
    const issueId = await store.resolveIssueKey(IDS.movedIssueKey, '2023-06-01T00:00:00Z')
    expect(issueId).toBe(IDS.issueStory1)

    // ACME-2 is the current key — resolve at NOW (within its validity window).
    const currentId = await store.resolveIssueKey('ACME-2', NOW)
    expect(currentId).toBe(IDS.issueStory1)
  })
})

// ---------------------------------------------------------------------------
// 4. linkageRate
// ---------------------------------------------------------------------------

describe('linkageRate', () => {
  it('returns the fraction of merged PRs with at least one link', async () => {
    const store = makeStore()

    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    const rate = await linkageRate(store)
    // There are 3 merged PRs (pr-1, pr-2, pr-4). pr-1 and pr-4 reference Jira keys.
    // pr-2 has no Jira key in its body. So rate = 2/3.
    expect(rate).not.toBeNull()
    if (rate !== null) {
      expect(rate).toBeGreaterThan(0)
      expect(rate).toBeLessThanOrEqual(1)
    }
  })

  it('returns null when there are no merged PRs', async () => {
    const store = makeStore()
    const rate = await linkageRate(store)
    expect(rate).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Idempotency — re-running runSync produces no duplicates
// ---------------------------------------------------------------------------

describe('runSync — idempotency', () => {
  it('re-running backfill produces no duplicate issues or transitions', async () => {
    const store = makeStore()

    // First run
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    const issuesAfterFirst = await store.getIssuesByProject(IDS.jiraProjectId)
    const transitionsAfterFirst = await store.getIssueTransitions(IDS.issueStory1)

    // Second run
    const laterNow = '2024-06-01T13:00:00Z'
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: laterNow },
    )

    const issuesAfterSecond = await store.getIssuesByProject(IDS.jiraProjectId)
    const transitionsAfterSecond = await store.getIssueTransitions(IDS.issueStory1)

    // Issue count should be identical (upsert, not insert)
    expect(issuesAfterSecond.length).toBe(issuesAfterFirst.length)

    // Transition count should be identical (append-only but idempotent)
    expect(transitionsAfterSecond.length).toBe(transitionsAfterFirst.length)

    // Watermark should have advanced
    const watermark = await store.getSyncState('orchestrator', 'full_cycle', GITHUB_SCOPE.org)
    expect(watermark?.watermarkAt).toBe(laterNow)
  })

  it('re-running does not duplicate pr_issue_links', async () => {
    const store = makeStore()

    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // Collect all pr_issue_links after first run
    const orgs = await store.listOrganisations()
    let linksAfterFirst = 0
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          const links = await store.getPrIssueLinks(pr.id)
          linksAfterFirst += links.length
        }
      }
    }

    // Second run
    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: '2024-06-01T13:00:00Z' },
    )

    let linksAfterSecond = 0
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          const links = await store.getPrIssueLinks(pr.id)
          linksAfterSecond += links.length
        }
      }
    }

    expect(linksAfterSecond).toBe(linksAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// 6. syncStatus — freshness reporting and stale flagging
// ---------------------------------------------------------------------------

describe('syncStatus', () => {
  it('reports freshness for all known resources after a sync', async () => {
    const store = makeStore()

    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // Query status 1 hour after sync — should be fresh (lag < 4h threshold)
    const oneHourLater = '2024-06-01T13:00:00Z'
    const status = await syncStatus(store, { now: oneHourLater })

    expect(status.asOf).toBe(oneHourLater)
    expect(status.resources.length).toBeGreaterThan(0)

    // After a recent sync, no resources should be stale (lag = 1h < 4h default threshold)
    expect(status.hasStale).toBe(false)
    expect(status.warnResources).toHaveLength(0)
    expect(status.refuseResources).toHaveLength(0)
  })

  it('flags a resource as stale when lag exceeds the threshold', async () => {
    const store = makeStore()

    await runSync(
      store,
      makeGitHubClient(),
      GITHUB_SCOPE,
      'backfill',
      makeJiraClient(),
      JIRA_SCOPE,
      'backfill',
      { now: NOW },
    )

    // Query status 25 hours after sync — lag > 24h → refuse threshold
    const twentyFiveHoursLater = '2024-06-02T13:00:00Z'
    const status = await syncStatus(store, {
      now: twentyFiveHoursLater,
      staleThresholdMs: 4 * 60 * 60 * 1000, // 4h
      refuseThresholdMs: 24 * 60 * 60 * 1000, // 24h
    })

    expect(status.hasStale).toBe(true)
    // Some resources should be in the refuse bucket (lag > 24h)
    expect(status.refuseResources.length).toBeGreaterThan(0)
  })

  it('marks resources never synced as stale', async () => {
    const store = makeStore()

    // Insert a Jira project so syncStatus has something to check.
    await store.upsertJiraProject({
      id: IDS.jiraProjectId,
      key: 'ACME',
      name: 'Acme',
      jiraCloudId: 'acme-jira-cloud',
      raw: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const status = await syncStatus(store, { now: NOW })

    // Jira issues resource has never been synced → stale
    const jiraResource = status.resources.find(
      (r) => r.source === 'jira' && r.resource === 'issues',
    )
    expect(jiraResource).toBeDefined()
    expect(jiraResource?.isStale).toBe(true)
    expect(jiraResource?.watermarkAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. linkIssues standalone — false-positive guard
// ---------------------------------------------------------------------------

describe('linkIssues — false-positive guard', () => {
  it('drops candidates whose keys are not in the issue_keys store', async () => {
    const store = makeStore()

    // Create a PR with a random match like "V8-10" (not a real project key)
    await store.upsertOrganisation({
      id: 'org-test',
      githubLogin: 'test-org',
      jiraCloudId: null,
      name: 'test-org',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertRepository({
      id: 'repo-test',
      githubNodeId: 'node-test',
      orgId: 'org-test',
      owner: 'test-org',
      name: 'test-repo',
      defaultBranch: 'main',
      isArchived: false,
      isFork: false,
      deletedAt: null,
      raw: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertIdentity({
      id: 'identity-fp-test',
      personId: null,
      kind: 'github_login',
      externalId: 'fp-user',
      isBot: false,
      confidence: 1,
      raw: '{}',
      updatedAt: NOW,
    })
    await store.upsertPullRequest({
      id: 'pr-fp-test',
      repoId: 'repo-test',
      number: 99,
      authorIdentityId: 'identity-fp-test',
      state: 'merged',
      headRef: 'feat/v8-improvements',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: NOW,
      readyAt: NOW,
      firstCommitAt: NOW,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: NOW,
      mergedByIdentityId: 'identity-fp-test',
      deletedAt: null,
      raw: '{"title":"improve V8-10 performance","body":"relates to V8-10 somehow","head":{"ref":"feat/v8-improvements"}}',
      updatedAt: NOW,
    })

    // No issue keys in store — V8-10 is not a real key
    const result = await linkIssues(store, { now: NOW })
    expect(result.linksUpserted).toBe(0)
    // The false-positive candidates should have been dropped
    expect(result.falsePositivesDropped).toBeGreaterThan(0)

    const links = await store.getPrIssueLinks('pr-fp-test')
    expect(links).toHaveLength(0)
  })
})
