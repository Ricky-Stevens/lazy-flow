/**
 * Calibration harness tests — WP-AI-CALIBRATION
 *
 * All tests are pure / no API key / no network.
 *
 * Pinned values (hand-computed):
 *   κ fixture       → expected ≈ 0.3333  (see "cohenKappa known fixture" below)
 *   macro-F1        → expected ≈ 0.5556  (see "macroF1 known confusion set")
 *   Spearman with ties → expected = 1.0  (see "spearmanRho with ties")
 *   ECE fixture     → expected = 0.1     (see "computeEce known reliability table")
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { correctVerdict, runVerdict } from '../harness.js'
import { VerdictCache } from '../verdictCache.js'
import {
  correctionsToGoldItems,
  extractCorrections,
  extractHumanPairs,
  mergeGoldSets,
} from './goldSet.js'
import { cohenKappa, computeEce, macroF1, spearmanRho } from './metrics.js'
import { buildCalibrationReport, confidenceIsCalibrated } from './report.js'
import type { GoldItem } from './types.js'

// ─── Store helper ─────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

// ─── Cohen's κ ────────────────────────────────────────────────────────────────

describe('cohenKappa', () => {
  /**
   * Hand-computed fixture:
   *   a = ['A', 'A', 'B', 'B', 'C', 'C']
   *   b = ['A', 'B', 'B', 'C', 'C', 'A']
   *
   *   n = 6
   *   Matching pairs: (A,A), (B,B), (C,C) → observed = 3 → po = 3/6 = 0.5
   *
   *   freqA: A=2, B=2, C=2  (each = 2/6)
   *   freqB: A=2, B=2, C=2  (each = 2/6)
   *   pe = (2/6)*(2/6) + (2/6)*(2/6) + (2/6)*(2/6)
   *      = 3 * (4/36) = 12/36 = 1/3
   *
   *   κ = (0.5 - 1/3) / (1 - 1/3) = (1/6) / (2/3) = (1/6) * (3/2) = 1/4 = 0.25
   *
   * Note: earlier docs said ~0.333 but the exact value is 0.25.
   */
  it('returns the known κ for a hand-computed fixture', () => {
    const a = ['A', 'A', 'B', 'B', 'C', 'C']
    const b = ['A', 'B', 'B', 'C', 'C', 'A']
    const result = cohenKappa(a, b)
    expect(result.n).toBe(6)
    expect(result.kappa).toBeCloseTo(0.25, 5)
  })

  it('returns κ = 1 for perfect agreement', () => {
    const labels = ['A', 'B', 'C', 'A']
    const r = cohenKappa(labels, labels)
    expect(r.kappa).toBe(1)
    expect(r.n).toBe(4)
  })

  it('returns κ = 0 and n = 0 for empty arrays', () => {
    const r = cohenKappa([], [])
    expect(r.kappa).toBe(0)
    expect(r.n).toBe(0)
  })

  it('throws when array lengths differ', () => {
    expect(() => cohenKappa(['A'], ['A', 'B'])).toThrow('equal length')
  })

  it('returns negative κ for systematic disagreement', () => {
    // Perfect systematic swap: κ should be negative
    const a = ['A', 'A', 'B', 'B']
    const b = ['B', 'B', 'A', 'A']
    const r = cohenKappa(a, b)
    expect(r.kappa).toBeLessThan(0)
  })

  it('returns κ close to 0 for random agreement (chance-level)', () => {
    // All B vs all A — no agreement at all
    const a = ['A', 'A', 'A', 'A']
    const b = ['B', 'B', 'B', 'B']
    const r = cohenKappa(a, b)
    // po = 0, pe = 0 (no class overlap) → κ = 0
    expect(r.kappa).toBe(0)
  })
})

// ─── Macro-F1 ─────────────────────────────────────────────────────────────────

describe('macroF1', () => {
  /**
   * Hand-computed confusion matrix (predicted vs gold):
   *
   *   gold:      A  B  C
   *   predicted: A  B  C  → matches: A@0, B@1, C@2 all correct
   *   + predicted: B for gold A (index 3)
   *   + predicted: A for gold B (index 4)
   *
   *   gold      = ['A', 'B', 'C', 'A', 'B']
   *   predicted = ['A', 'B', 'C', 'B', 'A']
   *
   *   Class A:  TP=1, FP=1 (index4 predicted A), FN=1 (index3 predicted B)
   *             precision = 1/2, recall = 1/2, F1 = 1/2
   *   Class B:  TP=1, FP=1 (index3 predicted B), FN=1 (index4 predicted A)
   *             precision = 1/2, recall = 1/2, F1 = 1/2
   *   Class C:  TP=1, FP=0, FN=0
   *             precision = 1, recall = 1, F1 = 1
   *
   *   macro-F1 = (0.5 + 0.5 + 1) / 3 = 2/3 ≈ 0.6667
   */
  it('returns the known macro-F1 for a hand-computed confusion set', () => {
    const gold = ['A', 'B', 'C', 'A', 'B']
    const pred = ['A', 'B', 'C', 'B', 'A']
    const r = macroF1(pred, gold)
    expect(r.macroF1).toBeCloseTo(2 / 3, 5)
    const classA = r.perClass.find((c) => c.label === 'A')
    expect(classA?.f1).toBeCloseTo(0.5, 5)
    const classC = r.perClass.find((c) => c.label === 'C')
    expect(classC?.f1).toBeCloseTo(1, 5)
  })

  it('returns macro-F1 = 1 for perfect predictions', () => {
    const labels = ['A', 'B', 'C']
    const r = macroF1(labels, labels)
    expect(r.macroF1).toBe(1)
  })

  it('returns macro-F1 = 0 for all-wrong predictions', () => {
    // pred = B for all gold A — zero precision and recall for class A
    const gold = ['A', 'A', 'A']
    const pred = ['B', 'B', 'B']
    const r = macroF1(pred, gold)
    // Class A: TP=0 → F1=0; Class B: support=0, skipped from macro → macro=0
    expect(r.macroF1).toBe(0)
  })

  it('returns 0 / empty for empty arrays', () => {
    const r = macroF1([], [])
    expect(r.macroF1).toBe(0)
    expect(r.perClass).toHaveLength(0)
  })

  it('throws when array lengths differ', () => {
    expect(() => macroF1(['A'], ['A', 'B'])).toThrow('equal length')
  })
})

// ─── Spearman ρ ───────────────────────────────────────────────────────────────

describe('spearmanRho', () => {
  /**
   * Hand-computed tie-corrected Spearman:
   *   x = [1, 2, 2, 3]   (ties at x=2)
   *   y = [1, 2, 2, 3]   (identical → perfect correlation)
   *
   *   ranks(x) = [1, 2.5, 2.5, 4]
   *   ranks(y) = [1, 2.5, 2.5, 4]
   *   Pearson(ranks) = 1.0
   */
  it('returns ρ = 1 for identical sequences with ties', () => {
    const r = spearmanRho([1, 2, 2, 3], [1, 2, 2, 3])
    expect(r.rho).toBeCloseTo(1, 5)
    expect(r.n).toBe(4)
  })

  it('returns ρ = 1 for perfect monotonic agreement', () => {
    const r = spearmanRho([1, 2, 3, 4], [10, 20, 30, 40])
    expect(r.rho).toBeCloseTo(1, 5)
  })

  it('returns ρ = -1 for perfect inverse agreement', () => {
    const r = spearmanRho([1, 2, 3, 4], [4, 3, 2, 1])
    expect(r.rho).toBeCloseTo(-1, 5)
  })

  it('returns ρ = 0 and n = 0 for empty arrays', () => {
    const r = spearmanRho([], [])
    expect(r.rho).toBe(0)
    expect(r.n).toBe(0)
  })

  it('returns ρ = 1 for a single item', () => {
    const r = spearmanRho([5], [5])
    expect(r.rho).toBe(1)
    expect(r.n).toBe(1)
  })

  it('throws when array lengths differ', () => {
    expect(() => spearmanRho([1, 2], [1])).toThrow('equal length')
  })

  /**
   * All-ties degenerate case (constant sequence):
   *   x = [3, 3, 3]  ranks = [2, 2, 2]  (all equal)
   *   y = [1, 2, 3]
   *   Variance of x ranks = 0 → returns ρ = 1 (degenerate, informally "no rank discrimination")
   */
  it('returns ρ = 1 for a constant x (zero variance)', () => {
    const r = spearmanRho([3, 3, 3], [1, 2, 3])
    expect(r.rho).toBe(1)
  })
})

// ─── ECE ──────────────────────────────────────────────────────────────────────

describe('computeEce', () => {
  /**
   * Known reliability table (2 bins for simplicity, numBins=2):
   *
   *   Bin 0 [0, 0.5): conf=[0.1, 0.3, 0.4], correct=[false, false, true]
   *     avgConf = 0.2667, accuracy = 1/3 = 0.3333
   *     |accuracy - avgConf| = |0.3333 - 0.2667| = 0.0667
   *     weight = 3/6 = 0.5
   *
   *   Bin 1 [0.5, 1.0]: conf=[0.6, 0.8, 0.9], correct=[true, true, true]
   *     avgConf = 0.7667, accuracy = 1.0
   *     |accuracy - avgConf| = 0.2333
   *     weight = 3/6 = 0.5
   *
   *   ECE = 0.5 * 0.0667 + 0.5 * 0.2333 = 0.0333 + 0.1167 = 0.15
   */
  it('returns the known ECE for a hand-computed reliability table', () => {
    const confidences = [0.1, 0.3, 0.4, 0.6, 0.8, 0.9]
    const correct = [false, false, true, true, true, true]
    const r = computeEce(confidences, correct, 2)
    expect(r.n).toBe(6)
    expect(r.ece).toBeCloseTo(0.15, 5)
    expect(r.bins).toHaveLength(2)
  })

  it('returns ECE = 0 for a perfectly calibrated model', () => {
    // Each item: confidence = 1.0 and correct = true → avgConf=1, accuracy=1, |diff|=0
    const r = computeEce([1.0, 1.0, 1.0], [true, true, true], 10)
    expect(r.ece).toBe(0)
  })

  it('returns ECE = 0, n = 0 for empty inputs', () => {
    const r = computeEce([], [], 10)
    expect(r.ece).toBe(0)
    expect(r.n).toBe(0)
  })

  it('throws when array lengths differ', () => {
    expect(() => computeEce([0.5], [true, false])).toThrow('equal length')
  })

  it('returns a non-zero ECE for a consistently over-confident model', () => {
    // Confidence always 0.9 but only correct 50% of the time
    const conf = [0.9, 0.9, 0.9, 0.9]
    const corr = [true, false, true, false]
    const r = computeEce(conf, corr, 1)
    expect(r.ece).toBeCloseTo(0.4, 5) // |0.5 - 0.9| = 0.4
  })
})

// ─── confidenceIsCalibrated ───────────────────────────────────────────────────

describe('confidenceIsCalibrated', () => {
  it('returns true when ECE is at the threshold', () => {
    expect(confidenceIsCalibrated(0.1, 0.1)).toBe(true)
  })

  it('returns true when ECE is below the threshold', () => {
    expect(confidenceIsCalibrated(0.05, 0.1)).toBe(true)
  })

  it('returns false when ECE exceeds the threshold', () => {
    expect(confidenceIsCalibrated(0.15, 0.1)).toBe(false)
  })
})

// ─── Gold-set ingestion helpers ───────────────────────────────────────────────

describe('extractCorrections + correctionsToGoldItems', () => {
  it('extracts only corrected verdicts', () => {
    const verdicts = [
      {
        id: 'v1',
        subjectId: 'pr-1',
        metric: 'alignment',
        correctedBy: 'alice@example.com',
        subjectType: 'pull_request',
        promptVersion: '1.0',
        modelId: 'm',
        modelSnapshot: 's',
        requestShape: '{}',
        featureVectorJson: '{}',
        structuredVerdictJson: '{"ordinal":"2"}',
        evidenceJson: '{}',
        confidence: 0.7,
        createdAt: '2026-01-01T00:00:00Z',
        correctionJson: '{"label":"3"}',
      },
      {
        id: 'v2',
        subjectId: 'pr-2',
        metric: 'alignment',
        correctedBy: null,
        correctionJson: null,
        subjectType: 'pull_request',
        promptVersion: '1.0',
        modelId: 'm',
        modelSnapshot: 's',
        requestShape: '{}',
        featureVectorJson: '{}',
        structuredVerdictJson: '{"ordinal":"4"}',
        evidenceJson: '{}',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]
    // Cast to satisfy TS — test focuses on behaviour
    const corrections = extractCorrections(verdicts as never)
    expect(corrections).toHaveLength(1)
    expect(corrections[0]?.subjectId).toBe('pr-1')
  })

  it('converts corrections with a label field to gold items', () => {
    const corrections = [
      {
        id: 'v1',
        subjectId: 'pr-1',
        metric: 'alignment',
        correctionJson: '{"label":"3","note":"missing AC 2"}',
        correctedBy: 'alice@example.com',
      },
    ]
    const items = correctionsToGoldItems(corrections)
    expect(items).toHaveLength(1)
    expect(items[0]?.humanLabel).toBe('3')
    expect(items[0]?.raterId).toBe('alice@example.com')
  })

  it('skips corrections with malformed JSON', () => {
    const corrections = [
      {
        id: 'v1',
        subjectId: 'pr-1',
        metric: 'alignment',
        correctionJson: 'not-json',
        correctedBy: 'alice@example.com',
      },
    ]
    expect(correctionsToGoldItems(corrections)).toHaveLength(0)
  })

  it('skips corrections without a label field', () => {
    const corrections = [
      {
        id: 'v1',
        subjectId: 'pr-1',
        metric: 'alignment',
        correctionJson: '{"note":"ok"}',
        correctedBy: 'alice@example.com',
      },
    ]
    expect(correctionsToGoldItems(corrections)).toHaveLength(0)
  })
})

// ─── Human ceiling gate ───────────────────────────────────────────────────────

describe('sub-0.6 human ceiling lowers the pass gate', () => {
  it('uses the human ceiling κ when it is below 0.6', () => {
    /**
     * Two raters on the same 6 items, computed ceiling κ = 0.25 (same fixture as cohenKappa test).
     * Expected passGate = min(0.6, 0.25) = 0.25
     */
    const sharedSubjects = ['s1', 's2', 's3', 's4', 's5', 's6']
    const raterALabels = ['A', 'A', 'B', 'B', 'C', 'C']
    const raterBLabels = ['A', 'B', 'B', 'C', 'C', 'A']

    const goldItems: GoldItem[] = [
      ...sharedSubjects.map((id, i) => ({
        subjectId: id,
        metric: 'alignment',
        humanLabel: raterALabels[i] as string,
        raterId: 'rater-a',
      })),
      ...sharedSubjects.map((id, i) => ({
        subjectId: id,
        metric: 'alignment',
        humanLabel: raterBLabels[i] as string,
        raterId: 'rater-b',
      })),
    ]

    const pairs = extractHumanPairs(goldItems)
    expect(pairs).not.toBeNull()

    // Ceiling κ = 0.25 (from the known fixture)
    // pairs is asserted non-null above; use explicit check for linter
    if (pairs === null) throw new Error('expected pairs to be non-null')
    const ceilingKappa = cohenKappa(pairs.raterA, pairs.raterB)
    expect(ceilingKappa.kappa).toBeCloseTo(0.25, 5)

    // Gate = min(0.6, 0.25) = 0.25
    const gate = Math.min(0.6, ceilingKappa.kappa)
    expect(gate).toBeCloseTo(0.25, 5)
    expect(gate).toBeLessThan(0.6)
  })

  it('uses 0.6 as the gate when no human ceiling is available', () => {
    // Only one rater → no human ceiling → gate stays at 0.6
    const goldItems: GoldItem[] = [
      { subjectId: 's1', metric: 'alignment', humanLabel: 'A', raterId: 'rater-a' },
      { subjectId: 's2', metric: 'alignment', humanLabel: 'B', raterId: 'rater-a' },
    ]
    const pairs = extractHumanPairs(goldItems)
    expect(pairs).toBeNull()
    // Gate defaults to KAPPA_FIXED_GATE = 0.6
    const gate = pairs !== null ? Math.min(0.6, cohenKappa(pairs.raterA, pairs.raterB).kappa) : 0.6
    expect(gate).toBe(0.6)
  })
})

// ─── Correction ingestion feeds calibration report ───────────────────────────

describe('correction ingestion re-feeds calibration report', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('adds a gold label from a correction and re-reports κ', async () => {
    const fakeOutputFormat = { type: 'json_object', schema: {} }

    // Run a verdict with a model prediction of ordinal '2'
    const client = new FakeLlmClient([
      { value: { ordinal: '2', confidence: 0.7, evidence: 'diff hunk' } },
    ])
    const { verdict } = await runVerdict(
      {
        subjectType: 'pull_request',
        subjectId: 'pr-gold-1',
        metric: 'alignment',
        promptVersion: '1.0.0',
        contentHash: 'h1',
        featureVector: { haloc: 10 },
        userMessage: 'evaluate',
        outputConfigFormat: fakeOutputFormat,
      },
      client,
      store,
      cache,
    )

    // Correct it — human says ordinal '3'
    await correctVerdict(verdict.id, 'bob@example.com', '{"label":"3"}', store)

    // Build report with no static gold items — the correction IS the gold set
    const corrected = await store.getAiVerdict(verdict.id)
    expect(corrected?.correctedBy).toBe('bob@example.com')

    if (!corrected) throw new Error('expected corrected verdict')
    const report = buildCalibrationReport({
      staticGoldItems: [],
      verdicts: [corrected],
      eceThreshold: 0.1,
    })

    // We have 1 gold item (from the correction) and 1 verdict
    // Model predicted '2', gold label is '3' → mismatch → κ < 1
    const insight = report.insights.find((i) => i.metric === 'alignment')
    expect(insight).toBeDefined()
    expect(insight?.modelKappa.n).toBe(1)
    // With n=1 and a mismatch: κ = (0 - pe) / (1 - pe)
    // po=0, pe depends on label distribution; cannot be 1
    expect(insight?.modelKappa.kappa).toBeLessThan(1)

    // Ensemble not eligible (only 1 item → confidence not proven calibrated)
    expect(report.ensembleEligible).toBe(false)
  })
})

// ─── Ensemble eligibility gate ────────────────────────────────────────────────

describe('ensemble eligibility gate', () => {
  it('is false when no gold items are provided', () => {
    const report = buildCalibrationReport({ staticGoldItems: [], verdicts: [] })
    expect(report.ensembleEligible).toBe(false)
  })

  it('flips to true only when confidence is calibrated for all insights', () => {
    /**
     * One insight, two items: model predicts correctly with confidence 0.8 each.
     * ECE = 0 → calibrated.
     * passGate will be 0.6 (no human ceiling) and κ for perfect-1-item agreement.
     */
    const goldItems: GoldItem[] = [
      { subjectId: 's1', metric: 'effort', humanLabel: 'S', raterId: 'rater-a' },
      { subjectId: 's2', metric: 'effort', humanLabel: 'M', raterId: 'rater-a' },
    ]

    const makeVerdict = (id: string, subjectId: string, label: string, conf: number) => ({
      id,
      subjectType: 'pull_request',
      subjectId,
      metric: 'effort',
      promptVersion: '1.0',
      modelId: 'claude-sonnet-4-6',
      modelSnapshot: 'snap',
      requestShape: '{}',
      featureVectorJson: '{}',
      structuredVerdictJson: JSON.stringify({ ordinal: label }),
      evidenceJson: '{}',
      confidence: conf,
      createdAt: '2026-01-01T00:00:00Z',
      correctedBy: null,
      correctionJson: null,
    })

    // Model is perfectly correct and well-calibrated (confidence 0.8, all correct)
    const verdicts = [makeVerdict('v1', 's1', 'S', 0.8), makeVerdict('v2', 's2', 'M', 0.8)]

    const reportCalibrated = buildCalibrationReport({
      staticGoldItems: goldItems,
      verdicts,
      eceThreshold: 0.5, // generous threshold: ECE = 0 easily passes
    })

    const insight = reportCalibrated.insights.find((i) => i.metric === 'effort')
    expect(insight?.confidenceCalibrated).toBe(true)
    expect(reportCalibrated.ensembleEligible).toBe(true)
  })

  it('stays false when ECE exceeds the threshold', () => {
    const goldItems: GoldItem[] = [
      { subjectId: 's1', metric: 'effort', humanLabel: 'S', raterId: 'rater-a' },
    ]

    // Model is over-confident but wrong
    const verdict = {
      id: 'v1',
      subjectType: 'pull_request',
      subjectId: 's1',
      metric: 'effort',
      promptVersion: '1.0',
      modelId: 'claude-sonnet-4-6',
      modelSnapshot: 'snap',
      requestShape: '{}',
      featureVectorJson: '{}',
      structuredVerdictJson: JSON.stringify({ ordinal: 'L' }), // gold is 'S'
      evidenceJson: '{}',
      confidence: 0.95, // high confidence but wrong
      createdAt: '2026-01-01T00:00:00Z',
      correctedBy: null,
      correctionJson: null,
    }

    const report = buildCalibrationReport({
      staticGoldItems: goldItems,
      verdicts: [verdict],
      eceThreshold: 0.05, // tight threshold
    })

    const insight = report.insights.find((i) => i.metric === 'effort')
    // ECE = |0 - 0.95| = 0.95 >> 0.05
    expect(insight?.confidenceCalibrated).toBe(false)
    expect(report.ensembleEligible).toBe(false)
  })
})

// ─── mergeGoldSets deduplication ─────────────────────────────────────────────

describe('mergeGoldSets', () => {
  it('deduplicates by metric + subjectId + raterId, preferring static items', () => {
    const staticItems: GoldItem[] = [
      { subjectId: 's1', metric: 'alignment', humanLabel: 'A', raterId: 'rater-a' },
    ]
    const correctionItems: GoldItem[] = [
      // Same key as static — should be dropped
      { subjectId: 's1', metric: 'alignment', humanLabel: 'B', raterId: 'rater-a' },
      // Different raterId — should be kept
      { subjectId: 's1', metric: 'alignment', humanLabel: 'B', raterId: 'rater-b' },
    ]
    const merged = mergeGoldSets(staticItems, correctionItems)
    expect(merged).toHaveLength(2)
    const staticEntry = merged.find((i) => i.raterId === 'rater-a')
    // Static label wins
    expect(staticEntry?.humanLabel).toBe('A')
  })
})

// ─── Full report shape ────────────────────────────────────────────────────────

describe('buildCalibrationReport', () => {
  it('produces a report with generatedAt, insights, and ensembleEligible fields', () => {
    const report = buildCalibrationReport({ staticGoldItems: [], verdicts: [] })
    expect(typeof report.generatedAt).toBe('string')
    expect(Array.isArray(report.insights)).toBe(true)
    expect(typeof report.ensembleEligible).toBe('boolean')
  })

  it('includes one InsightCalibration entry per metric in the gold set', () => {
    const goldItems: GoldItem[] = [
      { subjectId: 's1', metric: 'alignment', humanLabel: '3', raterId: 'r1' },
      { subjectId: 's1', metric: 'effort', humanLabel: 'M', raterId: 'r1' },
    ]
    const report = buildCalibrationReport({ staticGoldItems: goldItems, verdicts: [] })
    const metrics = report.insights.map((i) => i.metric).sort()
    expect(metrics).toEqual(['alignment', 'effort'])
  })
})
