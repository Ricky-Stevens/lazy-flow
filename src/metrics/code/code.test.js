/**
 * Golden tests for Code metrics (Group D).
 *
 * Tests use fixture diff/blame inputs (no live git required).
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   All blame/diff data is injected as fixture values.
 *   Production callers would obtain these from the git blame adapter
 *   (gitBlameRecords() in code-analysis — deferred in WP-CODE-ANALYSIS).
 *
 * Key test cases per SPEC WP-METRICS-CODE DoD:
 *   - HALOC via code-analysis fixture diffs
 *   - Rework/Churn via fixture blame records
 *   - Nagappan-Ball M1/M2/M3 with known inputs
 *   - Complexity delta via fixture FileComplexity
 *   - Maintainability Index (trend only — formula test)
 *   - Code Change Impact deterministic blend
 */

import { describe, expect, it } from 'bun:test'

import { ENGINE_VERSION } from '../../core/index.js'
import {
  codeChangeImpact,
  complexityDelta,
  halocAggregate,
  maintainabilityIndex,
  nagappanBall,
  reworkChurn,
} from './index.js'

const AS_OF = '2024-06-01T12:00:00Z'
const NOW = AS_OF

// ---------------------------------------------------------------------------
// Fixture diffs — minimal unified diff strings for HALOC testing
// ---------------------------------------------------------------------------

const SIMPLE_DIFF = `diff --git a/src/widget.ts b/src/widget.ts
index 1234567..abcdefg 100644
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -1,3 +1,5 @@
 export function widget() {
+  const x = 1
+  const y = 2
-  return null
+  return x + y
 }
`
// Insertions: 3, Deletions: 1
// HALOC for this hunk = max(3,1) = 3

const BINARY_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
index 1234567..abcdefg 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const GENERATED_DIFF = `diff --git a/package-lock.json b/package-lock.json
index 1234567..abcdefg 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,100 @@
+lots of generated content
`

const MULTI_FILE_DIFF = `diff --git a/src/alpha.ts b/src/alpha.ts
index 1234567..abcdefg 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,2 +1,4 @@
 function alpha() {
+  const a = 1
+  const b = 2
-  return 0
+  return a + b
 }
diff --git a/src/beta.ts b/src/beta.ts
index 1234567..abcdefg 100644
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -1,1 +1,3 @@
 function beta() {
+  // new implementation
+  return 42
 }
`

// ---------------------------------------------------------------------------
// HALOC Aggregate
// ---------------------------------------------------------------------------

describe('halocAggregate', () => {
  it('computes HALOC from a simple diff', () => {
    const changes = [
      {
        id: 'commit-1',
        author: 'alice',
        changedAt: '2024-03-01T09:00:00Z',
        diff: SIMPLE_DIFF,
        filePaths: ['src/widget.ts'],
      },
    ]
    const result = halocAggregate.compute({ changes }, AS_OF)

    expect(result.id).toBe('code.haloc_aggregate')
    expect(result.trustTier).toBe('deterministic')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.changeCount).toBe(1)
    // hunk: 3 ins, 1 del → HALOC = max(3,1) = 3
    expect(result.totalHaloc).toBe(3)
    expect(result.totalBinaryHaloc).toBe(0)
    expect(result.totalGeneratedHaloc).toBe(0)
  })

  it('binary files tracked in binaryHaloc, not haloc', () => {
    const changes = [
      {
        id: 'commit-binary',
        author: 'alice',
        changedAt: '2024-03-01T09:00:00Z',
        diff: BINARY_DIFF,
        filePaths: ['assets/logo.png'],
      },
    ]
    const result = halocAggregate.compute({ changes }, AS_OF)
    expect(result.totalHaloc).toBe(0)
    expect(result.totalBinaryHaloc).toBeGreaterThan(0)
  })

  it('generated files tracked in generatedHaloc, not haloc', () => {
    const changes = [
      {
        id: 'commit-gen',
        author: 'alice',
        changedAt: '2024-03-01T09:00:00Z',
        diff: GENERATED_DIFF,
        filePaths: ['package-lock.json'],
      },
    ]
    const result = halocAggregate.compute({ changes }, AS_OF)
    expect(result.totalHaloc).toBe(0)
    expect(result.totalGeneratedHaloc).toBeGreaterThan(0)
  })

  it('aggregates across multiple changes', () => {
    const changes = [
      {
        id: 'c1',
        author: 'alice',
        changedAt: '2024-03-01T00:00:00Z',
        diff: MULTI_FILE_DIFF,
        filePaths: ['src/alpha.ts', 'src/beta.ts'],
      },
      {
        id: 'c2',
        author: 'bob',
        changedAt: '2024-03-02T00:00:00Z',
        diff: SIMPLE_DIFF,
        filePaths: ['src/widget.ts'],
      },
    ]
    const result = halocAggregate.compute({ changes }, AS_OF)
    expect(result.changeCount).toBe(2)
    expect(result.totalHaloc).toBeGreaterThan(0)
    expect(result.avgHalocPerChange).not.toBeNull()
    expect(result.avgHalocPerChange).toBeCloseTo(result.totalHaloc / 2, 5)
  })

  it('empty changes → no_data', () => {
    const result = halocAggregate.compute({ changes: [] }, AS_OF)
    expect(result.value).toBe(0)
    expect(result.dataQuality).toBe('no_data')
    expect(result.totalHaloc).toBe(0)
    expect(result.avgHalocPerChange).toBeNull() // zero denominator → null
  })
})

// ---------------------------------------------------------------------------
// Rework / Churn
// ---------------------------------------------------------------------------

describe('reworkChurn', () => {
  const NOW_DATE = new Date(NOW)
  const recentMs = NOW_DATE.getTime() - 10 * 24 * 60 * 60 * 1000 // 10 days ago

  // Fixture blame records
  const blameRecords = [
    // Alice's own recent code (line 1) → Rework
    { line: 1, lastChangedAt: recentMs, author: 'alice' },
    // Bob's recent code (line 2) → Help-Others
    { line: 2, lastChangedAt: recentMs, author: 'bob' },
    // Alice's old code (line 3, 60 days ago) → Legacy-Refactor
    { line: 3, lastChangedAt: NOW_DATE.getTime() - 60 * 24 * 60 * 60 * 1000, author: 'alice' },
  ]

  it('classifies Rework, Help-Others, Legacy-Refactor correctly', () => {
    const result = reworkChurn.compute(
      {
        author: 'alice',
        blameRecords,
        lines: [1, 2, 3],
        now: NOW,
        churnWindowDays: 30,
      },
      AS_OF,
    )

    expect(result.id).toBe('code.rework_churn')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.totalLines).toBe(3)
    expect(result.reworkLines).toBe(1) // line 1: alice's own recent → Rework
    expect(result.helpOthersLines).toBe(1) // line 2: bob's recent → Help-Others
    expect(result.legacyRefactorLines).toBe(1) // line 3: alice's old → Legacy-Refactor
    expect(result.reworkPercent).toBeCloseTo((1 / 3) * 100, 1)
    expect(result.efficiency).toBeCloseTo(100 - (1 / 3) * 100, 1)
  })

  it('new file (no blame records) → all New lines', () => {
    const result = reworkChurn.compute(
      {
        author: 'alice',
        blameRecords: [],
        lines: [1, 2, 3],
        now: NOW,
      },
      AS_OF,
    )
    expect(result.newLines).toBe(3)
    expect(result.reworkLines).toBe(0)
    expect(result.reworkPercent).toBe(0)
    expect(result.efficiency).toBe(100)
  })

  it('zero total lines → no_data, null reworkPercent', () => {
    const result = reworkChurn.compute(
      { author: 'alice', blameRecords: [], lines: [], now: NOW },
      AS_OF,
    )
    expect(result.dataQuality).toBe('no_data')
    expect(result.reworkPercent).toBeNull()
    expect(result.efficiency).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Nagappan-Ball M1/M2/M3
// ---------------------------------------------------------------------------

describe('nagappanBall', () => {
  it('computes M1/M2/M3 correctly', () => {
    const result = nagappanBall.compute(
      {
        haloc: 100,
        priorHaloc: 400,
        windowDays: 30,
        reworkLines: 20,
        totalLines: 100,
      },
      AS_OF,
    )

    expect(result.id).toBe('code.nagappan_ball')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    // M1 = 100 / (400 + 100) = 100/500 = 0.2
    expect(result.m1RelativeChurn).toBeCloseTo(0.2, 5)
    // M2 = 100 / 30 ≈ 3.33
    expect(result.m2ChurnRate).toBeCloseTo(100 / 30, 5)
    // M3 = 20 / (100 + 1) ≈ 0.198
    expect(result.m3ReworkDensity).toBeCloseTo(20 / 101, 5)
  })

  it('zero haloc and priorHaloc → M1 null (zero denominator), no_data', () => {
    const result = nagappanBall.compute(
      { haloc: 0, priorHaloc: 0, windowDays: 30, reworkLines: 0, totalLines: 0 },
      AS_OF,
    )
    expect(result.m1RelativeChurn).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    // M3 denominator is totalLines+1=1 → 0/1=0
    expect(result.m3ReworkDensity).toBe(0)
  })

  it('zero windowDays → M2 null (zero denominator)', () => {
    const result = nagappanBall.compute(
      { haloc: 50, priorHaloc: 100, windowDays: 0, reworkLines: 5, totalLines: 50 },
      AS_OF,
    )
    expect(result.m2ChurnRate).toBeNull()
    expect(Number.isNaN(result.m2ChurnRate)).toBe(false)
  })

  it('reworkLines null (blame unavailable) → M3 null ("not measured"), NOT a misleading 0', () => {
    // The pipeline passes reworkLines: null because git blame is not ingested.
    // M3 must report null so a consumer cannot mistake "not measured" for "no
    // rework" — the rest of the result (M1/M2) is still real.
    const result = nagappanBall.compute(
      { haloc: 100, priorHaloc: 400, windowDays: 30, reworkLines: null, totalLines: 100 },
      AS_OF,
    )
    expect(result.m3ReworkDensity).toBeNull()
    expect(result.m1RelativeChurn).toBeCloseTo(0.2, 5)
  })

  it('M3 is never NaN even when inputs are undefined (safeRatio guard)', () => {
    const result = nagappanBall.compute({ haloc: 100, priorHaloc: 400, windowDays: 30 }, AS_OF)
    // reworkLines undefined → treated as not-measured → null (never NaN).
    expect(result.m3ReworkDensity).toBeNull()
    expect(Number.isNaN(result.m3ReworkDensity)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Complexity Delta — via fixture FileComplexity
// ---------------------------------------------------------------------------

describe('complexityDelta', () => {
  // Fixture FileComplexity values (from code-analysis types)
  const baseComplexity = {
    language: 'typescript',
    functions: [
      {
        name: 'widget',
        startLine: 1,
        endLine: 5,
        cyclomatic: 2,
        cognitive: 1,
      },
    ],
    totalCyclomatic: 2,
    totalCognitive: 1,
  }

  const headComplexity = {
    language: 'typescript',
    functions: [
      {
        name: 'widget',
        startLine: 1,
        endLine: 10,
        cyclomatic: 5, // increased by 3
        cognitive: 4, // increased by 3
      },
    ],
    totalCyclomatic: 5,
    totalCognitive: 4,
  }

  const baseSnap = { path: 'src/widget.ts', complexity: baseComplexity }
  const headSnap = { path: 'src/widget.ts', complexity: headComplexity }

  it('computes cyclomatic and cognitive deltas from fixture snapshots', () => {
    const result = complexityDelta.compute({ base: [baseSnap], head: [headSnap] }, AS_OF)

    expect(result.id).toBe('code.complexity_delta')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    // Cyclomatic increased by 3 (5-2)
    expect(result.totalCyclomaticIncrease).toBe(3)
    // Cognitive increased by 3 (4-1)
    expect(result.totalCognitiveIncrease).toBe(3)
    expect(result.functionsIncreased).toBe(1)
    expect(result.functionsDecreased).toBe(0)
  })

  it('new file (no base) → counted as NEW code, not increase of existing complexity', () => {
    const result = complexityDelta.compute({ base: [], head: [headSnap] }, AS_OF)
    // A brand-new function must NOT inflate the "increase" headline — its full
    // complexity is new code, tracked under newFunction*/functionsAdded instead.
    expect(result.totalCyclomaticIncrease).toBe(0)
    expect(result.totalCognitiveIncrease).toBe(0)
    expect(result.functionsAdded).toBe(1)
    expect(result.functionsIncreased).toBe(0)
    expect(result.newFunctionCyclomatic).toBe(5)
    expect(result.newFunctionCognitive).toBe(4)
  })

  it('removed function (in base, gone from head) is surfaced, not silently dropped', () => {
    const base = [
      {
        path: 'a.js',
        complexity: {
          functions: [
            { name: 'gone', startLine: 1, cyclomatic: 7, cognitive: 6 },
            { name: 'kept', startLine: 20, cyclomatic: 2, cognitive: 1 },
          ],
        },
      },
    ]
    const head = [
      {
        path: 'a.js',
        complexity: {
          functions: [{ name: 'kept', startLine: 20, cyclomatic: 2, cognitive: 1 }],
        },
      },
    ]
    const result = complexityDelta.compute({ base, head }, AS_OF)
    expect(result.functionsRemoved).toBe(1)
    expect(result.fileDeltae[0].removedFunctions[0].name).toBe('gone')
  })

  it('empty head → no_data', () => {
    const result = complexityDelta.compute({ base: [], head: [] }, AS_OF)
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// Maintainability Index
// ---------------------------------------------------------------------------

describe('maintainabilityIndex', () => {
  it('computes MI within [0, 100]', () => {
    const result = maintainabilityIndex.compute(
      { avgHaloc: 50, avgCyclomatic: 5, avgLoc: 100 },
      AS_OF,
    )
    expect(result.id).toBe('code.maintainability_index')
    expect(result.mi).toBeGreaterThanOrEqual(0)
    expect(result.mi).toBeLessThanOrEqual(100)
    expect(result.mi).not.toBeNaN()
  })

  it('very high complexity → MI clamped to 0', () => {
    const result = maintainabilityIndex.compute(
      { avgHaloc: 10000, avgCyclomatic: 1000, avgLoc: 50000 },
      AS_OF,
    )
    expect(result.mi).toBe(0)
  })

  it('trivial file (1 haloc, 1 cyclomatic, 1 loc) → high MI', () => {
    const result = maintainabilityIndex.compute({ avgHaloc: 1, avgCyclomatic: 1, avgLoc: 1 }, AS_OF)
    expect(result.mi).toBeGreaterThan(80)
  })

  // Regression: a missing/NaN input must yield no_data, NOT { value: NaN,
  // dataQuality: 'ok' } — a NaN headline would propagate silently through any
  // aggregation as if it were a real index.
  it('missing/NaN inputs → no_data with null value, never NaN at ok quality', () => {
    for (const bad of [
      { avgHaloc: undefined, avgCyclomatic: 5, avgLoc: 100 },
      { avgHaloc: 50, avgCyclomatic: Number.NaN, avgLoc: 100 },
      { avgHaloc: 50, avgCyclomatic: 5, avgLoc: null },
      {},
    ]) {
      const r = maintainabilityIndex.compute(bad, AS_OF)
      expect(r.value).toBeNull()
      expect(r.mi).toBeNull()
      expect(r.dataQuality).toBe('no_data')
    }
  })
})

// ---------------------------------------------------------------------------
// Code Change Impact
// ---------------------------------------------------------------------------

describe('codeChangeImpact', () => {
  it('computes a non-NaN impact score in [0,1]', () => {
    const result = codeChangeImpact.compute(
      {
        haloc: 150,
        filePaths: ['src/auth/login.ts', 'src/auth/session.ts', 'src/api/routes.ts'],
        legacyRefactorLines: 30,
        totalLines: 150,
      },
      AS_OF,
    )
    expect(result.id).toBe('code.change_impact')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.impactScore).toBeGreaterThanOrEqual(0)
    expect(result.impactScore).toBeLessThanOrEqual(1)
    expect(Number.isNaN(result.impactScore)).toBe(false)
    expect(result.llmRationale).toBeNull() // no AI in deterministic layer
  })

  it('LLM rationale hook passes through when provided', () => {
    const result = codeChangeImpact.compute(
      {
        haloc: 100,
        filePaths: ['src/auth/middleware.ts'],
        legacyRefactorLines: 10,
        totalLines: 100,
        llmRationale: 'Touched auth middleware — high blast radius.',
      },
      AS_OF,
    )
    expect(result.llmRationale).toBe('Touched auth middleware — high blast radius.')
  })

  it('zero files → editDiversity=0, impact still valid', () => {
    const result = codeChangeImpact.compute(
      { haloc: 0, filePaths: [], legacyRefactorLines: 0, totalLines: 0 },
      AS_OF,
    )
    expect(result.impactScore).toBe(0)
    expect(Number.isNaN(result.impactScore)).toBe(false)
  })

  it('custom weight overrides respected', () => {
    const resultDefault = codeChangeImpact.compute(
      { haloc: 100, filePaths: ['src/a.ts', 'src/b.ts'], legacyRefactorLines: 0, totalLines: 10 },
      AS_OF,
    )
    const resultHighHaloc = codeChangeImpact.compute(
      {
        haloc: 100,
        filePaths: ['src/a.ts', 'src/b.ts'],
        legacyRefactorLines: 0,
        totalLines: 10,
        weightOverrides: {
          halocNorm: 0.9,
          editDiversity: 0.025,
          fileCountNorm: 0.025,
          changeEntropy: 0.025,
          oldCodePct: 0.025,
        },
      },
      AS_OF,
    )
    // Higher halocNorm weight → higher impact score (haloc dominates)
    expect(resultHighHaloc.impactScore).toBeGreaterThanOrEqual(resultDefault.impactScore)
  })

  it('all factors and weights are visible', () => {
    const result = codeChangeImpact.compute(
      { haloc: 50, filePaths: ['src/a.ts'], legacyRefactorLines: 5, totalLines: 50 },
      AS_OF,
    )
    // All weights visible
    expect(result.weights.halocNorm).toBeDefined()
    expect(result.weights.editDiversity).toBeDefined()
    // All factors visible
    expect(typeof result.factors.halocNorm).toBe('number')
    expect(typeof result.factors.editDiversity).toBe('number')
    expect(typeof result.factors.changeEntropy).toBe('number')
  })
})
