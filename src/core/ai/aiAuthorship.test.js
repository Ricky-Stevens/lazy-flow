/**
 * AI-authorship detection — tool-agnostic stylometry + markers + agent author.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { migrate } from '../migrate/runner.js'
import { BunSqliteStore } from '../store/BunSqliteStore.js'
import { detectAiAuthorship, scoreAiText } from './aiAuthorship.js'

const NOW = '2026-06-20T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

describe('scoreAiText', () => {
  it('flags an em dash (the validated tool-agnostic tell)', () => {
    const r = scoreAiText('Refactor the parser — split into stages')
    expect(r.signals).toContain('em_dash')
    expect(r.score).toBeGreaterThanOrEqual(0.5)
  })

  it('does NOT flag a plain human message with hyphens', () => {
    const r = scoreAiText('fix bug in user-service login flow (re: PR-123)')
    expect(r.signals).toEqual([])
    expect(r.score).toBe(0)
  })

  it('flags explicit AI markers (vendor-spanning) and combines signals (noisy-OR)', () => {
    const r = scoreAiText('Add caching — see notes\n\nGenerated with Claude Code')
    expect(r.signals).toContain('ai_marker')
    expect(r.signals).toContain('em_dash')
    // Two independent signals → higher than either alone.
    expect(r.score).toBeGreaterThan(0.85)
  })

  it('treats an AI agent author as definitive', () => {
    const r = scoreAiText('routine dependency bump', { isAiBotAuthor: true })
    expect(r.signals).toContain('ai_bot_author')
    expect(r.score).toBe(1)
  })

  it('catches a stripped-trailer co-author marker (Codex/Copilot/Gemini)', () => {
    expect(scoreAiText('x\nCo-authored-by: Codex <codex@openai.com>').signals).toContain(
      'ai_marker',
    )
    expect(scoreAiText('x\nCo-authored-by: Copilot <bot@github.com>').signals).toContain(
      'ai_marker',
    )
  })

  it('flags the AI PR-template structure (## Summary / ## Test plan + checklist)', () => {
    const body =
      'fix(ci): restrict trigger\n\n## Summary\n\n- tightens the trigger\n\n## Test plan\n\n- [ ] push a tag'
    const r = scoreAiText(body)
    expect(r.signals).toContain('md_header')
    expect(r.signals).toContain('task_checklist')
    expect(r.score).toBeGreaterThan(0.5)
  })

  it('flags polished structured prose with no em-dash (the missed-PR case)', () => {
    const body =
      'docs: fix stale paths after refactor\n\n' +
      'Updated 10 references across 5 files to reflect the new modular directory ' +
      'structure. The refactor moved shared code from src/lib to src/shared and ' +
      'reorganized routes under module directories. This corrects developer confusion ' +
      'when navigating the codebase after the reorganization landed last week.'
    const r = scoreAiText(body)
    expect(r.signals).toContain('prose_body')
    expect(r.signals).toContain('conventional_commit')
    expect(r.score).toBeGreaterThan(0.5)
  })

  it('does NOT flag an automation bot (dependabot) as human-AI', () => {
    const r = scoreAiText('Bumps left-pad from 1.0 to 1.1\n\n## Release notes\n- [x] done', {
      isAutomationBot: true,
    })
    expect(r.signals).toEqual(['automation_bot'])
    expect(r.score).toBe(0)
  })
})

describe('detectAiAuthorship', () => {
  async function seed(store) {
    await store.upsertOrganisation({
      id: 'org-1',
      githubLogin: 'acme',
      jiraCloudId: 'c',
      name: 'Acme',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertRepository({
      id: 'repo-1',
      githubNodeId: 'n',
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
    // Human author + an AI agent bot author.
    for (const [id, login, bot] of [
      ['github_login:dev', 'dev', false],
      ['github_login:copilot', 'copilot', true],
    ]) {
      await store.upsertIdentity({
        id,
        personId: null,
        kind: 'github_login',
        externalId: login,
        isBot: bot,
        confidence: 1,
        raw: JSON.stringify({ login }),
        updatedAt: NOW,
      })
    }
    // commit A: em dash (AI tell). commit B: plain human.
    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'aaa',
      authorIdentityId: 'github_login:dev',
      authoredAt: '2026-05-01T00:00:00Z',
      committedAt: '2026-05-01T00:00:00Z',
      additions: 5,
      deletions: 1,
      haloc: 5,
      raw: JSON.stringify({ commit: { message: 'Add retry — exponential backoff' } }),
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertCommit({
      repoId: 'repo-1',
      sha: 'bbb',
      authorIdentityId: 'github_login:dev',
      authoredAt: '2026-05-02T00:00:00Z',
      committedAt: '2026-05-02T00:00:00Z',
      additions: 2,
      deletions: 0,
      haloc: 2,
      raw: JSON.stringify({ commit: { message: 'fix typo in readme' } }),
      createdAt: NOW,
      updatedAt: NOW,
    })
    // PR authored by the AI agent bot.
    await store.upsertPullRequest({
      id: 'repo-1-pr-1',
      repoId: 'repo-1',
      number: 1,
      authorIdentityId: 'github_login:copilot',
      state: 'merged',
      headRef: 'f',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: '2026-05-03T00:00:00Z',
      readyAt: null,
      firstCommitAt: null,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: NOW,
      mergedByIdentityId: null,
      deletedAt: null,
      raw: JSON.stringify({ title: 'Bump deps', body: 'automated' }),
      updatedAt: NOW,
    })
  }

  it('scores commits + PRs, flags AI tells, and is incremental', async () => {
    const store = freshStore()
    await seed(store)

    const first = await detectAiAuthorship(store, { now: NOW })
    expect(first.scored).toBe(3) // 2 commits + 1 PR

    const score = (type, id) =>
      store.db
        .query(
          'SELECT ai_score, signals_json FROM ai_authorship WHERE entity_type=? AND entity_id=?',
        )
        .get(type, id)

    const emDashCommit = score('commit', 'repo-1:aaa')
    expect(emDashCommit.ai_score).toBeGreaterThanOrEqual(0.5)
    expect(emDashCommit.signals_json).toContain('em_dash')

    const humanCommit = score('commit', 'repo-1:bbb')
    expect(humanCommit.ai_score).toBe(0)

    const botPr = score('pull_request', 'repo-1-pr-1')
    expect(botPr.ai_score).toBe(1) // AI agent author
    expect(botPr.signals_json).toContain('ai_bot_author')

    // Incremental: a second pass scores nothing new.
    const second = await detectAiAuthorship(store, { now: NOW })
    expect(second.scored).toBe(0)
  })
})
