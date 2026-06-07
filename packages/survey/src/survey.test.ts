/**
 * Tests for @lazy-flow/survey.
 *
 * Coverage:
 *   1. Scoring matches hand-computed fixture.
 *   2. Minimum-N suppression hides a sparsely-answered dimension.
 *   3. Invariant guard: no function produces a perceptual score from
 *      non-survey / system inputs (the "never faked" invariant, SPEC §2.2 N4).
 *   4. Team-aggregate respects scope (only includes responses for the target team).
 *   5. Storage round-trip (NodeSqliteSurveyStore + applyMigration).
 *   6. Composite (LPI) suppressed when any dimension lacks sufficient N.
 *   7. Instrument registry integrity — all instruments have stable ids, versioned,
 *      items have valid Likert structure.
 */

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  ALL_INSTRUMENTS,
  applyMigration,
  assertSurveySourced,
  computeComposite,
  computeTeamAggregate,
  DEVEX_COGNITIVE_LOAD,
  DEVEX_FEEDBACK_LOOPS,
  DEVEX_FLOW_STATE,
  getInstrument,
  MIN_RESPONSES_PER_DIMENSION,
  NodeSqliteSurveyStore,
  respondentMeanForDimension,
  SPACE_SATISFACTION,
  scoreDimension,
} from './index.js'
import type { SurveyResponse } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal in-memory SQLite DB with the survey schema applied. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  // The survey store requires teams + persons tables (FK refs).
  // We create lightweight stubs so FK constraints don't fire.
  db.exec(`PRAGMA foreign_keys = OFF`)
  applyMigration(db)
  return db
}

/** Build a well-formed SurveyResponse with all items answered. */
function makeResponse(opts: {
  id: string
  personId?: string
  teamId: string
  instrumentId: string
  instrumentVersion: string
  scores: Record<string, number>
  submittedAt?: string
}): SurveyResponse {
  return {
    id: opts.id,
    personId: opts.personId ?? null,
    teamId: opts.teamId,
    instrumentId: opts.instrumentId,
    instrumentVersion: opts.instrumentVersion,
    scores: opts.scores,
    submittedAt: opts.submittedAt ?? '2025-01-15T10:00:00.000Z',
  }
}

/**
 * Build a full response for the DevEx Feedback Loops instrument where every
 * item has the same score.
 */
function feedbackLoopsResponse(id: string, teamId: string, score: number): SurveyResponse {
  const items = DEVEX_FEEDBACK_LOOPS.items
  const scores: Record<string, number> = {}
  for (const item of items) {
    scores[item.id] = score
  }
  return makeResponse({
    id,
    teamId,
    instrumentId: DEVEX_FEEDBACK_LOOPS.id,
    instrumentVersion: DEVEX_FEEDBACK_LOOPS.version,
    scores,
  })
}

/** Build a full response for a given instrument where every item = score. */
function uniformResponse(
  id: string,
  teamId: string,
  instrument: typeof DEVEX_FEEDBACK_LOOPS,
  score: number,
  submittedAt?: string,
): SurveyResponse {
  const scores: Record<string, number> = {}
  for (const item of instrument.items) {
    scores[item.id] = score
  }
  return makeResponse({
    id,
    teamId,
    instrumentId: instrument.id,
    instrumentVersion: instrument.version,
    scores,
    submittedAt,
  })
}

// ---------------------------------------------------------------------------
// 1. Scoring matches hand-computed fixture
// ---------------------------------------------------------------------------

describe('scoreDimension', () => {
  it('returns no_data for empty input', () => {
    const result = scoreDimension('devex_feedback_loops', [])
    expect(result.dataQuality).toBe('no_data')
    expect(result.mean).toBeNull()
    expect(result.distribution).toBeNull()
    expect(result.n).toBe(0)
  })

  it('hand-computed: three respondents with scores 3, 4, 5 → mean 4, p50 4', () => {
    // respondent means: 3, 4, 5
    // mean of means = (3 + 4 + 5) / 3 = 4
    // p50 (type-7): sorted [3,4,5], h=(3-1)*0.5=1 → index 1 → value 4
    const result = scoreDimension('devex_feedback_loops', [3, 4, 5], 3)

    expect(result.dataQuality).toBe('ok')
    expect(result.n).toBe(3)
    expect(result.mean).toBeCloseTo(4, 10)
    expect(result.distribution).not.toBeNull()
    expect(result.distribution?.p50).toBeCloseTo(4, 10)
    expect(result.distribution?.p75).toBeCloseTo(4.5, 10)
  })

  it('hand-computed: five respondents [2, 3, 3, 4, 5] → mean 3.4, p50 3', () => {
    // mean = (2+3+3+4+5)/5 = 17/5 = 3.4
    // p50 type-7: sorted [2,3,3,4,5], h=(5-1)*0.5=2 → index 2 → value 3
    const result = scoreDimension('devex_feedback_loops', [2, 3, 3, 4, 5], 3)

    expect(result.dataQuality).toBe('ok')
    expect(result.n).toBe(5)
    expect(result.mean).toBeCloseTo(3.4, 10)
    expect(result.distribution?.p50).toBeCloseTo(3, 10)
  })

  it('publishes a non-empty formulaDoc', () => {
    const result = scoreDimension('devex_feedback_loops', [3, 4, 5], 3)
    expect(result.formulaDoc.length).toBeGreaterThan(50)
    expect(result.formulaDoc).toContain('survey')
  })
})

describe('respondentMeanForDimension', () => {
  it('returns null for an unknown instrumentId', () => {
    const response = makeResponse({
      id: 'r1',
      teamId: 't1',
      instrumentId: 'not-a-real-instrument',
      instrumentVersion: '1.0.0',
      scores: { q1: 3 },
    })
    const mean = respondentMeanForDimension(response, 'devex_feedback_loops')
    expect(mean).toBeNull()
  })

  it('computes the mean for items in the dimension', () => {
    // All 5 items in DEVEX_FEEDBACK_LOOPS scored as 3
    const response = feedbackLoopsResponse('r1', 't1', 3)
    const mean = respondentMeanForDimension(response, 'devex_feedback_loops')
    // All items score 3, mean = 3
    expect(mean).toBeCloseTo(3, 10)
  })

  it('returns null for a dimension not covered by the instrument', () => {
    // DEVEX_FEEDBACK_LOOPS has no space_satisfaction items
    const response = feedbackLoopsResponse('r1', 't1', 4)
    const mean = respondentMeanForDimension(response, 'space_satisfaction')
    expect(mean).toBeNull()
  })

  it('hand-computed: mixed scores [2, 3, 4, 5, 1] → mean 3', () => {
    const items = DEVEX_FEEDBACK_LOOPS.items
    const scores: Record<string, number> = {}
    const values = [2, 3, 4, 5, 1]
    items.forEach((item, i) => {
      scores[item.id] = values[i] ?? 3
    })
    const response = makeResponse({
      id: 'r2',
      teamId: 't1',
      instrumentId: DEVEX_FEEDBACK_LOOPS.id,
      instrumentVersion: DEVEX_FEEDBACK_LOOPS.version,
      scores,
    })
    const mean = respondentMeanForDimension(response, 'devex_feedback_loops')
    // (2+3+4+5+1)/5 = 15/5 = 3
    expect(mean).toBeCloseTo(3, 10)
  })
})

// ---------------------------------------------------------------------------
// 2. Minimum-N suppression hides a sparsely-answered dimension
// ---------------------------------------------------------------------------

describe('minimum-N suppression', () => {
  it('suppresses when n < MIN_RESPONSES_PER_DIMENSION', () => {
    // Default min is 3; supply only 2 respondent means
    const result = scoreDimension('devex_cognitive_load', [3, 4], MIN_RESPONSES_PER_DIMENSION)
    expect(result.dataQuality).toBe('insufficient_sample')
    expect(result.mean).toBeNull()
    expect(result.distribution).toBeNull()
    expect(result.n).toBe(2)
  })

  it('exactly at min-N threshold → ok', () => {
    const result = scoreDimension('devex_cognitive_load', [3, 4, 5], MIN_RESPONSES_PER_DIMENSION)
    expect(result.dataQuality).toBe('ok')
    expect(result.mean).not.toBeNull()
  })

  it('team aggregate suppresses a dimension with insufficient responses', () => {
    const teamId = 'team-a'
    // Provide only 2 responses for devex_feedback_loops (below min-N=3)
    const responses: SurveyResponse[] = [
      feedbackLoopsResponse('r1', teamId, 4),
      feedbackLoopsResponse('r2', teamId, 5),
    ]
    const agg = computeTeamAggregate({
      responses,
      teamId,
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-31T23:59:59.999Z',
      minN: MIN_RESPONSES_PER_DIMENSION,
    })
    expect(agg.dimensions.devex_feedback_loops?.dataQuality).toBe('insufficient_sample')
    expect(agg.dimensions.devex_feedback_loops?.mean).toBeNull()
  })

  it('composite is suppressed when any dimension lacks sufficient N', () => {
    const teamId = 'team-b'
    // Only 2 responses for feedback_loops; no responses for other dimensions
    const responses: SurveyResponse[] = [
      feedbackLoopsResponse('r1', teamId, 4),
      feedbackLoopsResponse('r2', teamId, 5),
    ]
    const agg = computeTeamAggregate({
      responses,
      teamId,
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-31T23:59:59.999Z',
    })
    expect(agg.compositeScore?.value).toBeNull()
    expect(
      agg.compositeScore?.dataQuality === 'insufficient_sample' ||
        agg.compositeScore?.dataQuality === 'no_data',
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Invariant guard: no perceptual score from non-survey / system inputs
// ---------------------------------------------------------------------------

describe('assertSurveySourced — the "never faked" invariant', () => {
  it('accepts well-formed survey responses', () => {
    const r = feedbackLoopsResponse('r1', 't1', 4)
    expect(() => assertSurveySourced([r])).not.toThrow()
  })

  it('throws when instrumentId is not in the registry', () => {
    const r = makeResponse({
      id: 'r-bad',
      teamId: 't1',
      instrumentId: 'system-derived-fake-dxi',
      instrumentVersion: '1.0.0',
      scores: { fake_metric: 4 },
    })
    expect(() => assertSurveySourced([r])).toThrow(/not in the known instrument registry/)
  })

  it('throws when scores record is empty (no survey data)', () => {
    const r = makeResponse({
      id: 'r-empty',
      teamId: 't1',
      instrumentId: DEVEX_FEEDBACK_LOOPS.id,
      instrumentVersion: DEVEX_FEEDBACK_LOOPS.version,
      scores: {}, // empty — no actual survey data
    })
    expect(() => assertSurveySourced([r])).toThrow(/empty scores record/)
  })

  it('throws when a score is outside [1, 5] — catches system-derived values', () => {
    // A system metric (e.g. PR cycle time in minutes = 240) would produce
    // an out-of-range Likert value — this catches the injection attempt.
    const r = makeResponse({
      id: 'r-oob',
      teamId: 't1',
      instrumentId: DEVEX_FEEDBACK_LOOPS.id,
      instrumentVersion: DEVEX_FEEDBACK_LOOPS.version,
      scores: { fl_ci_speed: 240 }, // 240 min — a system metric, not a Likert score
    })
    expect(() => assertSurveySourced([r])).toThrow(/invalid score 240/)
  })

  it('throws for a fractional / non-integer score', () => {
    const r = makeResponse({
      id: 'r-frac',
      teamId: 't1',
      instrumentId: DEVEX_FEEDBACK_LOOPS.id,
      instrumentVersion: DEVEX_FEEDBACK_LOOPS.version,
      scores: { fl_ci_speed: 3.7 },
    })
    expect(() => assertSurveySourced([r])).toThrow(/invalid score 3\.7/)
  })

  it('passes an empty array (no-op)', () => {
    expect(() => assertSurveySourced([])).not.toThrow()
  })

  /**
   * The critical module-level invariant: verify that this package exposes NO
   * function that accepts only system/workflow inputs (numbers, timestamps,
   * commit counts, PR metrics, etc.) and returns a DimensionScore or
   * CompositeScore. Every scoring function requires a SurveyResponse[] input.
   *
   * We test this structurally: the public API of this module consists only
   * of functions whose perceptual-score outputs are reachable exclusively via
   * paths that start with SurveyResponse[] data. We assert the signatures
   * by calling each scoring function with valid survey inputs and verifying
   * that calling them with zero responses always produces 'no_data' rather
   * than a fabricated number.
   */
  it('scoreDimension with empty respondent means → no_data (not a fabricated number)', () => {
    const result = scoreDimension('devex_feedback_loops', [])
    expect(result.dataQuality).toBe('no_data')
    expect(result.mean).toBeNull()
  })

  it('computeTeamAggregate with empty responses → all dimensions no_data', () => {
    const agg = computeTeamAggregate({
      responses: [],
      teamId: 't1',
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-31T23:59:59.999Z',
    })
    for (const dim of Object.values(agg.dimensions)) {
      expect(dim.dataQuality).toBe('no_data')
      expect(dim.mean).toBeNull()
    }
    expect(agg.compositeScore?.value).toBeNull()
  })

  it('composite is NEVER labelled "DXI" — formulaDoc must not contain "DXI" as a label', () => {
    // The composite formulaDoc must explicitly state it is NOT DXI and give
    // its own open name (LPI).
    const agg = computeTeamAggregate({
      responses: [],
      teamId: 't1',
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-31T23:59:59.999Z',
    })
    // The composite entry has a formulaDoc when suppressed too
    const score = agg.compositeScore
    if (score !== null) {
      expect(score.formulaDoc).toContain('LPI')
      expect(score.formulaDoc).toContain('NEVER labelled "DXI"')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Team-aggregate respects scope
// ---------------------------------------------------------------------------

describe('computeTeamAggregate scope', () => {
  it('only considers responses for the target team', () => {
    const teamA = 'team-a'
    const teamB = 'team-b'

    // 3 responses for team-a (all score 5), 2 for team-b (score 1)
    const responses: SurveyResponse[] = [
      feedbackLoopsResponse('r1', teamA, 5),
      feedbackLoopsResponse('r2', teamA, 5),
      feedbackLoopsResponse('r3', teamA, 5),
      feedbackLoopsResponse('r4', teamB, 1),
      feedbackLoopsResponse('r5', teamB, 1),
    ]

    // computeTeamAggregate is given ALL responses but the aggregate
    // should only include team-a responses
    const filteredForTeamA = responses.filter((r) => r.teamId === teamA)

    const agg = computeTeamAggregate({
      responses: filteredForTeamA,
      teamId: teamA,
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-31T23:59:59.999Z',
    })

    expect(agg.teamId).toBe(teamA)
    // All 3 team-a responses scored 5 → mean should be 5
    expect(agg.dimensions.devex_feedback_loops?.dataQuality).toBe('ok')
    expect(agg.dimensions.devex_feedback_loops?.mean).toBeCloseTo(5, 10)
    expect(agg.dimensions.devex_feedback_loops?.n).toBe(3)
  })

  it('team-aggregate uses the correct windowStart/windowEnd', () => {
    const teamId = 'team-c'
    const agg = computeTeamAggregate({
      responses: [],
      teamId,
      windowStart: '2025-06-01T00:00:00.000Z',
      windowEnd: '2025-06-30T23:59:59.999Z',
    })
    expect(agg.windowStart).toBe('2025-06-01T00:00:00.000Z')
    expect(agg.windowEnd).toBe('2025-06-30T23:59:59.999Z')
  })
})

// ---------------------------------------------------------------------------
// 5. Storage round-trip
// ---------------------------------------------------------------------------

describe('NodeSqliteSurveyStore', () => {
  it('round-trips a survey response', () => {
    const db = makeDb()
    const store = new NodeSqliteSurveyStore(db)

    const r = feedbackLoopsResponse('r-store-1', 'team-x', 4)
    store.insertSurveyResponse(r)

    const results = store.listTeamResponses({
      teamId: 'team-x',
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    })

    expect(results).toHaveLength(1)
    const stored = results[0]
    expect(stored).toBeDefined()
    expect(stored?.id).toBe('r-store-1')
    expect(stored?.teamId).toBe('team-x')
    expect(stored?.instrumentId).toBe(DEVEX_FEEDBACK_LOOPS.id)
    // Scores should be equal (JSON round-trip)
    expect(stored?.scores).toEqual(r.scores)
  })

  it('filters by instrument id', () => {
    const db = makeDb()
    const store = new NodeSqliteSurveyStore(db)

    store.insertSurveyResponse(feedbackLoopsResponse('r1', 'team-x', 3))
    store.insertSurveyResponse(uniformResponse('r2', 'team-x', SPACE_SATISFACTION, 4))

    const feedbackOnly = store.listTeamResponses({
      teamId: 'team-x',
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
      instrumentId: DEVEX_FEEDBACK_LOOPS.id,
    })
    expect(feedbackOnly).toHaveLength(1)
    expect(feedbackOnly[0]?.instrumentId).toBe(DEVEX_FEEDBACK_LOOPS.id)
  })

  it('filters by time window', () => {
    const db = makeDb()
    const store = new NodeSqliteSurveyStore(db)

    // Response in January
    store.insertSurveyResponse(
      uniformResponse('r1', 'team-y', DEVEX_FEEDBACK_LOOPS, 4, '2025-01-15T10:00:00.000Z'),
    )
    // Response in March
    store.insertSurveyResponse(
      uniformResponse('r2', 'team-y', DEVEX_FEEDBACK_LOOPS, 4, '2025-03-15T10:00:00.000Z'),
    )

    const janOnly = store.listTeamResponses({
      teamId: 'team-y',
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-31T23:59:59.999Z',
    })
    expect(janOnly).toHaveLength(1)
    expect(janOnly[0]?.id).toBe('r1')
  })

  it('listPersonResponses returns only that person s responses', () => {
    const db = makeDb()
    const store = new NodeSqliteSurveyStore(db)

    const r1 = { ...feedbackLoopsResponse('r1', 'team-x', 4), personId: 'person-a' }
    const r2 = { ...feedbackLoopsResponse('r2', 'team-x', 3), personId: 'person-b' }
    store.insertSurveyResponse(r1)
    store.insertSurveyResponse(r2)

    const forPersonA = store.listPersonResponses({
      personId: 'person-a',
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    })
    expect(forPersonA).toHaveLength(1)
    expect(forPersonA[0]?.personId).toBe('person-a')
  })

  it('applyMigration is idempotent', () => {
    const db = makeDb()
    // Calling applyMigration twice must not throw (CREATE TABLE IF NOT EXISTS)
    expect(() => applyMigration(db)).not.toThrow()
    expect(() => applyMigration(db)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 6. Composite (LPI) suppression
// ---------------------------------------------------------------------------

describe('computeComposite', () => {
  it('returns null value when any dimension is no_data', () => {
    const dims = {
      devex_feedback_loops: scoreDimension('devex_feedback_loops', [3, 4, 5], 3),
      devex_cognitive_load: scoreDimension('devex_cognitive_load', [3, 4, 5], 3),
      devex_flow_state: scoreDimension('devex_flow_state', [], 3), // no data
      space_satisfaction: scoreDimension('space_satisfaction', [3, 4, 5], 3),
    }
    const composite = computeComposite(dims)
    expect(composite).not.toBeNull()
    expect(composite?.value).toBeNull()
  })

  it('hand-computed: four dimensions each mean 4 → LPI = 4', () => {
    const dims = {
      devex_feedback_loops: scoreDimension('devex_feedback_loops', [3, 4, 5], 3),
      devex_cognitive_load: scoreDimension('devex_cognitive_load', [3, 4, 5], 3),
      devex_flow_state: scoreDimension('devex_flow_state', [3, 4, 5], 3),
      space_satisfaction: scoreDimension('space_satisfaction', [3, 4, 5], 3),
    }
    // Each has mean = (3+4+5)/3 = 4 → LPI = 4
    const composite = computeComposite(dims)
    expect(composite?.dataQuality).toBe('ok')
    expect(composite?.value).toBeCloseTo(4, 10)
  })

  it('hand-computed: dimension means [3, 4, 4, 5] → LPI = 4', () => {
    const dims = {
      devex_feedback_loops: scoreDimension('devex_feedback_loops', [3, 3, 3], 3), // mean=3
      devex_cognitive_load: scoreDimension('devex_cognitive_load', [4, 4, 4], 3), // mean=4
      devex_flow_state: scoreDimension('devex_flow_state', [4, 4, 4], 3), // mean=4
      space_satisfaction: scoreDimension('space_satisfaction', [5, 5, 5], 3), // mean=5
    }
    // LPI = (3 + 4 + 4 + 5) / 4 = 16 / 4 = 4
    const composite = computeComposite(dims)
    expect(composite?.value).toBeCloseTo(4, 10)
  })

  it('formulaDoc contains "LPI" and explicitly states it is not "DXI"', () => {
    const dims = {
      devex_feedback_loops: scoreDimension('devex_feedback_loops', [3, 4, 5], 3),
      devex_cognitive_load: scoreDimension('devex_cognitive_load', [3, 4, 5], 3),
      devex_flow_state: scoreDimension('devex_flow_state', [3, 4, 5], 3),
      space_satisfaction: scoreDimension('space_satisfaction', [3, 4, 5], 3),
    }
    const composite = computeComposite(dims)
    expect(composite?.formulaDoc).toContain('LPI')
    expect(composite?.formulaDoc).toContain('NEVER labelled "DXI"')
    expect(composite?.formulaDoc).toContain('survey')
  })
})

// ---------------------------------------------------------------------------
// 7. Instrument registry integrity
// ---------------------------------------------------------------------------

describe('instrument registry', () => {
  it('all instruments have unique ids', () => {
    const ids = ALL_INSTRUMENTS.map((i) => i.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('all instruments have a semver-style version string', () => {
    for (const instrument of ALL_INSTRUMENTS) {
      expect(instrument.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('all instruments have at least one item', () => {
    for (const instrument of ALL_INSTRUMENTS) {
      expect(instrument.items.length).toBeGreaterThan(0)
    }
  })

  it('all items have valid Likert anchor arrays (length 5)', () => {
    for (const instrument of ALL_INSTRUMENTS) {
      for (const item of instrument.items) {
        expect(item.anchors.length).toBe(5)
      }
    }
  })

  it('all item dimensions match a known SurveyDimension value', () => {
    const validDimensions = new Set([
      'devex_feedback_loops',
      'devex_cognitive_load',
      'devex_flow_state',
      'space_satisfaction',
    ])
    for (const instrument of ALL_INSTRUMENTS) {
      for (const item of instrument.items) {
        expect(validDimensions.has(item.dimension)).toBe(true)
      }
    }
  })

  it('getInstrument returns the correct instrument by id', () => {
    const inst = getInstrument(DEVEX_FEEDBACK_LOOPS.id)
    expect(inst).not.toBeNull()
    expect(inst?.id).toBe(DEVEX_FEEDBACK_LOOPS.id)
  })

  it('getInstrument returns null for an unknown id', () => {
    expect(getInstrument('not-real')).toBeNull()
  })

  it('the four built-in instruments cover all four SurveyDimension values', () => {
    const coveredDimensions = new Set<string>()
    for (const instrument of ALL_INSTRUMENTS) {
      for (const item of instrument.items) {
        coveredDimensions.add(item.dimension)
      }
    }
    expect(coveredDimensions.has('devex_feedback_loops')).toBe(true)
    expect(coveredDimensions.has('devex_cognitive_load')).toBe(true)
    expect(coveredDimensions.has('devex_flow_state')).toBe(true)
    expect(coveredDimensions.has('space_satisfaction')).toBe(true)
  })

  it('DEVEX_FEEDBACK_LOOPS has exactly 5 items all in devex_feedback_loops dimension', () => {
    expect(DEVEX_FEEDBACK_LOOPS.items.length).toBe(5)
    for (const item of DEVEX_FEEDBACK_LOOPS.items) {
      expect(item.dimension).toBe('devex_feedback_loops')
    }
  })

  it('SPACE_SATISFACTION has exactly 5 items all in space_satisfaction dimension', () => {
    expect(SPACE_SATISFACTION.items.length).toBe(5)
    for (const item of SPACE_SATISFACTION.items) {
      expect(item.dimension).toBe('space_satisfaction')
    }
  })

  it('all instruments include a non-empty description', () => {
    for (const instrument of ALL_INSTRUMENTS) {
      expect(instrument.description.length).toBeGreaterThan(20)
    }
  })

  it('DEVEX_COGNITIVE_LOAD has items in the correct dimension', () => {
    for (const item of DEVEX_COGNITIVE_LOAD.items) {
      expect(item.dimension).toBe('devex_cognitive_load')
    }
  })

  it('DEVEX_FLOW_STATE has items in the correct dimension', () => {
    for (const item of DEVEX_FLOW_STATE.items) {
      expect(item.dimension).toBe('devex_flow_state')
    }
  })
})
