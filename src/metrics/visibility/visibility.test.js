/**
 * Tests for WP-VISIBILITY — visibility policy matrix (SPEC §11.1 v2.1).
 *
 * Coverage:
 *   1. shouldPersistPersonSnapshot — person snapshots persisted only under public.
 *   2. applyVisibilityFilter — public/team/self policy matrix at tool-read.
 *   3. assertNotRankingList — ranked individual list throws; team list does not.
 */

import { describe, expect, it } from 'bun:test'

import {
  applyVisibilityFilter,
  assertNotRankingList,
  shouldPersistPersonSnapshot,
  VISIBILITY_POLICY_NOTE,
} from './index.js'

// ---------------------------------------------------------------------------
// Helper fixtures
// ---------------------------------------------------------------------------

function makeRow(scopeType, scopeId, metric = 'test') {
  return { scopeType, scopeId, metric }
}

const TEAM_ROW = makeRow('team', 'team-alpha')
const ORG_ROW = makeRow('org', 'org-1')
const REPO_ROW = makeRow('repo', 'repo-abc')
const PERSON_A = makeRow('person', 'person-alice')
const PERSON_B = makeRow('person', 'person-bob')

// ---------------------------------------------------------------------------
// shouldPersistPersonSnapshot
// ---------------------------------------------------------------------------

describe('shouldPersistPersonSnapshot', () => {
  it('returns true for team scope regardless of policy', () => {
    expect(shouldPersistPersonSnapshot('team', 'public')).toBe(true)
    expect(shouldPersistPersonSnapshot('team', 'team')).toBe(true)
    expect(shouldPersistPersonSnapshot('team', 'self')).toBe(true)
  })

  it('returns true for org scope regardless of policy', () => {
    expect(shouldPersistPersonSnapshot('org', 'public')).toBe(true)
    expect(shouldPersistPersonSnapshot('org', 'team')).toBe(true)
    expect(shouldPersistPersonSnapshot('org', 'self')).toBe(true)
  })

  it('returns true for repo scope regardless of policy', () => {
    expect(shouldPersistPersonSnapshot('repo', 'public')).toBe(true)
    expect(shouldPersistPersonSnapshot('repo', 'team')).toBe(true)
    expect(shouldPersistPersonSnapshot('repo', 'self')).toBe(true)
  })

  it('returns true for person scope under public (default)', () => {
    expect(shouldPersistPersonSnapshot('person', 'public')).toBe(true)
  })

  it('returns false for person scope under team', () => {
    expect(shouldPersistPersonSnapshot('person', 'team')).toBe(false)
  })

  it('returns false for person scope under self', () => {
    expect(shouldPersistPersonSnapshot('person', 'self')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyVisibilityFilter — public (default)
// ---------------------------------------------------------------------------

describe('applyVisibilityFilter — public', () => {
  it('passes all rows through (team, org, repo, person)', () => {
    const rows = [TEAM_ROW, ORG_ROW, REPO_ROW, PERSON_A, PERSON_B]
    const result = applyVisibilityFilter(rows, 'public', null)
    expect(result.rows).toHaveLength(5)
    expect(result.policyNote).toBeUndefined()
  })

  it('person rows are surfaced under public', () => {
    const result = applyVisibilityFilter([PERSON_A, PERSON_B], 'public', null)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.some((r) => r.scopeId === 'person-alice')).toBe(true)
    expect(result.rows.some((r) => r.scopeId === 'person-bob')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyVisibilityFilter — team
// ---------------------------------------------------------------------------

describe('applyVisibilityFilter — team', () => {
  it('removes person-scope rows', () => {
    const rows = [TEAM_ROW, ORG_ROW, PERSON_A, PERSON_B]
    const result = applyVisibilityFilter(rows, 'team', null)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r) => r.scopeType !== 'person')).toBe(true)
  })

  it('passes team and org rows through', () => {
    const result = applyVisibilityFilter([TEAM_ROW, ORG_ROW, REPO_ROW], 'team', null)
    expect(result.rows).toHaveLength(3)
    expect(result.policyNote).toBeUndefined()
  })

  it('sets policyNote when person rows were hidden', () => {
    const result = applyVisibilityFilter([TEAM_ROW, PERSON_A], 'team', null)
    expect(result.policyNote).toBe(VISIBILITY_POLICY_NOTE)
  })

  it('does not set policyNote when no person rows were present', () => {
    const result = applyVisibilityFilter([TEAM_ROW, ORG_ROW], 'team', null)
    expect(result.policyNote).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applyVisibilityFilter — self
// ---------------------------------------------------------------------------

describe('applyVisibilityFilter — self', () => {
  it('passes team/org/repo rows through for any requestingPersonId', () => {
    const rows = [TEAM_ROW, ORG_ROW, REPO_ROW]
    const result = applyVisibilityFilter(rows, 'self', 'person-alice')
    expect(result.rows).toHaveLength(3)
    expect(result.policyNote).toBeUndefined()
  })

  it("passes requestingPerson's own person row through", () => {
    const rows = [TEAM_ROW, PERSON_A, PERSON_B]
    const result = applyVisibilityFilter(rows, 'self', 'person-alice')
    expect(result.rows).toHaveLength(2)
    expect(result.rows.some((r) => r.scopeId === 'person-alice')).toBe(true)
    expect(result.rows.some((r) => r.scopeId === 'person-bob')).toBe(false)
  })

  it("removes other people's person rows", () => {
    const result = applyVisibilityFilter([PERSON_A, PERSON_B], 'self', 'person-alice')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.scopeId).toBe('person-alice')
  })

  it('sets policyNote when person rows were hidden', () => {
    const result = applyVisibilityFilter([PERSON_A, PERSON_B], 'self', 'person-alice')
    expect(result.policyNote).toBe(VISIBILITY_POLICY_NOTE)
  })

  it('returns an empty list when requesting person has no rows and other person rows are hidden', () => {
    const result = applyVisibilityFilter([PERSON_A], 'self', 'person-bob')
    expect(result.rows).toHaveLength(0)
    expect(result.policyNote).toBe(VISIBILITY_POLICY_NOTE)
  })

  it('handles null requestingPersonId (hides all person rows)', () => {
    const result = applyVisibilityFilter([TEAM_ROW, PERSON_A], 'self', null)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.scopeType).toBe('team')
  })
})

// ---------------------------------------------------------------------------
// assertNotRankingList — ranked individual list should throw
// ---------------------------------------------------------------------------

describe('assertNotRankingList', () => {
  it('does not throw for a single-person row even when sorted', () => {
    expect(() => assertNotRankingList([PERSON_A], true)).not.toThrow()
  })

  it('does not throw for multi-person rows when NOT sorted by metric', () => {
    expect(() => assertNotRankingList([PERSON_A, PERSON_B], false)).not.toThrow()
  })

  it('throws when multiple person rows are sorted by metric (ranking list)', () => {
    expect(() => assertNotRankingList([PERSON_A, PERSON_B], true)).toThrow(
      /stack-ranked individual lists/,
    )
  })

  it('does not throw for team/org rows sorted by metric (ranking is ok for aggregates)', () => {
    expect(() => assertNotRankingList([TEAM_ROW, ORG_ROW], true)).not.toThrow()
  })

  it('does not throw for mixed rows with one person row, sorted', () => {
    expect(() => assertNotRankingList([TEAM_ROW, PERSON_A], true)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Policy matrix: snapshot-write + tool-read integration
// ---------------------------------------------------------------------------

describe('policy matrix — snapshot-write + tool-read combined', () => {
  it('public: person snapshot persisted + person rows visible in tool-read', () => {
    expect(shouldPersistPersonSnapshot('person', 'public')).toBe(true)
    const result = applyVisibilityFilter([TEAM_ROW, PERSON_A], 'public', null)
    expect(result.rows).toHaveLength(2)
    expect(result.policyNote).toBeUndefined()
  })

  it('team: person snapshot NOT persisted + person rows hidden in tool-read', () => {
    expect(shouldPersistPersonSnapshot('person', 'team')).toBe(false)
    const result = applyVisibilityFilter([TEAM_ROW, PERSON_A], 'team', null)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.scopeType).toBe('team')
    expect(result.policyNote).toBeDefined()
  })

  it('self: person snapshot NOT persisted + only own person rows visible', () => {
    expect(shouldPersistPersonSnapshot('person', 'self')).toBe(false)
    const result = applyVisibilityFilter([TEAM_ROW, PERSON_A, PERSON_B], 'self', 'person-alice')
    expect(result.rows).toHaveLength(2)
    expect(result.rows.some((r) => r.scopeId === 'person-alice')).toBe(true)
    expect(result.rows.some((r) => r.scopeId === 'person-bob')).toBe(false)
  })
})
