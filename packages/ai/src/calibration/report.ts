/**
 * Calibration report builder — WP-AI-CALIBRATION, SPEC §9.3
 *
 * `buildCalibrationReport` computes per-insight κ / macro-F1 / Spearman / ECE
 * and the ensemble-eligibility gate.
 *
 * `confidenceIsCalibrated` is a standalone check for a single ECE value.
 */

import type { AiVerdict } from '@lazy-flow/core'
import {
  canonicalLabels,
  correctionsToGoldItems,
  extractCorrections,
  extractHumanPairs,
  extractPredictedLabel,
  extractPredictedRank,
  groupByMetric,
  mergeGoldSets,
} from './goldSet.js'
import { cohenKappa, computeEce, macroF1, spearmanRho } from './metrics.js'
import type { CalibrationReport, GoldItem, InsightCalibration } from './types.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum κ gate when no human ceiling is available (SPEC §9.1 constraint 6). */
const KAPPA_FIXED_GATE = 0.6

/** Macro-F1 pass threshold (SPEC §9.3). */
const MACRO_F1_GATE = 0.7

// ─── Confidence calibration gate ─────────────────────────────────────────────

/**
 * Standalone guard: is a given ECE value within the calibrated threshold?
 *
 * The threshold is caller-supplied so teams can adopt different tolerances.
 * Per SPEC §9.3, the ensemble MUST NOT be enabled until this returns true.
 *
 * @param ece       — ECE value (0 = perfect calibration)
 * @param threshold — maximum acceptable ECE (e.g. 0.1)
 */
export function confidenceIsCalibrated(ece: number, threshold: number): boolean {
  return ece <= threshold
}

// ─── Per-insight calibration ──────────────────────────────────────────────────

/**
 * Build InsightCalibration for one metric given its gold items and the
 * corresponding ai_verdicts rows.
 *
 * Alignment:
 *   - For each subjectId in the gold set, find the matching verdict row.
 *   - Only items present in both gold set AND verdicts contribute to metrics.
 *   - Gold label is the canonical (majority-vote) label across raters.
 *
 * @param metric          — insight name
 * @param goldItems       — gold-set items for this metric (possibly multi-rater)
 * @param verdicts        — all ai_verdicts rows for this metric
 * @param eceThreshold    — ECE threshold for `confidenceCalibrated`
 */
function buildInsightCalibration(
  metric: string,
  goldItems: readonly GoldItem[],
  verdicts: readonly AiVerdict[],
  eceThreshold: number,
): InsightCalibration {
  // Build canonical label map (majority-vote per subjectId)
  const canonical = canonicalLabels(goldItems)

  // Build verdict lookup
  const verdictBySubject = new Map<string, AiVerdict>()
  for (const v of verdicts) {
    // Prefer the most recent verdict when multiple exist for the same subject
    const existing = verdictBySubject.get(v.subjectId)
    if (!existing || v.createdAt > existing.createdAt) {
      verdictBySubject.set(v.subjectId, v)
    }
  }

  // Align gold ↔ predicted
  const goldLabels: string[] = []
  const predLabels: string[] = []
  const goldRanks: number[] = []
  const predRanks: number[] = []
  const confidences: number[] = []
  const isCorrect: boolean[] = []

  for (const [subjectId, goldLabel] of canonical) {
    const verdict = verdictBySubject.get(subjectId)
    if (!verdict) continue

    const predLabel = extractPredictedLabel(verdict)
    if (predLabel === null) continue

    goldLabels.push(goldLabel)
    predLabels.push(predLabel)

    // Rank comparison: ordinal labels parsed as numbers where possible
    const goldNum = Number(goldLabel)
    const predNum = Number(predLabel)
    if (!Number.isNaN(goldNum) && !Number.isNaN(predNum)) {
      goldRanks.push(goldNum)
      predRanks.push(predNum)
    } else {
      const predRank = extractPredictedRank(verdict)
      const goldRank = goldRanks.length // fallback positional rank
      if (predRank !== null) {
        goldRanks.push(goldRank)
        predRanks.push(predRank)
      }
    }

    // Confidence calibration
    const conf = verdict.confidence
    if (conf !== null) {
      confidences.push(conf)
      isCorrect.push(predLabel === goldLabel)
    }
  }

  // κ model-vs-gold
  const modelKappa = goldLabels.length > 0 ? cohenKappa(goldLabels, predLabels) : { kappa: 0, n: 0 }

  // Macro-F1
  const modelMacroF1 =
    goldLabels.length > 0 ? macroF1(predLabels, goldLabels) : { macroF1: 0, perClass: [] }

  // Spearman ρ
  const modelSpearman =
    goldRanks.length > 1 ? spearmanRho(goldRanks, predRanks) : { rho: 0, n: goldRanks.length }

  // Human-vs-human ceiling
  const humanPairs = extractHumanPairs(goldItems)
  const humanCeilingKappa =
    humanPairs !== null ? cohenKappa(humanPairs.raterA, humanPairs.raterB) : null

  // Pass gate: min(0.6, humanCeiling) — SPEC §9.1 constraint 6
  const passGate =
    humanCeilingKappa !== null
      ? Math.min(KAPPA_FIXED_GATE, humanCeilingKappa.kappa)
      : KAPPA_FIXED_GATE

  // ECE
  const ece = confidences.length > 0 ? computeEce(confidences, isCorrect) : null

  const calibrated = ece !== null ? confidenceIsCalibrated(ece.ece, eceThreshold) : false

  return {
    metric,
    modelKappa,
    modelMacroF1,
    modelSpearman,
    humanCeilingKappa,
    passGate,
    kappaPass: modelKappa.kappa >= passGate,
    macroF1Pass: modelMacroF1.macroF1 >= MACRO_F1_GATE,
    ece,
    confidenceCalibrated: calibrated,
  }
}

// ─── Public report builder ────────────────────────────────────────────────────

export interface BuildCalibrationReportOptions {
  /**
   * Static gold items (pre-loaded from a file or in-memory fixture).
   * Corrections from verdicts are merged in automatically.
   */
  staticGoldItems: readonly GoldItem[]
  /**
   * All ai_verdicts rows to evaluate — the harness queries these against the
   * gold set.  Include at minimum the verdicts whose subjects appear in the
   * gold set.
   */
  verdicts: readonly AiVerdict[]
  /**
   * ECE threshold for `confidenceCalibrated` (default 0.1).
   * The ensemble gate flips only when ECE ≤ threshold for all insights.
   */
  eceThreshold?: number
}

/**
 * Build a full CalibrationReport.
 *
 * Sequencing per SPEC §9.3:
 *   - Corrections from verdicts are ingested as additional gold labels.
 *   - Human ceiling κ is reported first; pass gate = min(0.6, ceiling).
 *   - `ensembleEligible` is true only when ALL insight with gold items have
 *     `confidenceCalibrated = true` — the D8 ensemble gate.
 */
export function buildCalibrationReport(options: BuildCalibrationReportOptions): CalibrationReport {
  const { staticGoldItems, verdicts, eceThreshold = 0.1 } = options

  // Ingest corrections as additional gold labels
  const corrections = extractCorrections(verdicts)
  const correctionGoldItems = correctionsToGoldItems(corrections)
  const mergedGold = mergeGoldSets(staticGoldItems, correctionGoldItems)

  // Group gold by metric
  const goldByMetric = groupByMetric(mergedGold)

  // Group verdicts by metric
  const verdictsByMetric = new Map<string, AiVerdict[]>()
  for (const v of verdicts) {
    const arr = verdictsByMetric.get(v.metric)
    if (arr) {
      arr.push(v)
    } else {
      verdictsByMetric.set(v.metric, [v])
    }
  }

  // Compute per-insight calibration
  const insights: InsightCalibration[] = []
  for (const [metric, goldItems] of goldByMetric) {
    const metricVerdicts = verdictsByMetric.get(metric) ?? []
    insights.push(buildInsightCalibration(metric, goldItems, metricVerdicts, eceThreshold))
  }

  // Ensemble gate: ALL insights must be confidence-calibrated
  const ensembleEligible = insights.length > 0 && insights.every((i) => i.confidenceCalibrated)

  return {
    generatedAt: new Date().toISOString(),
    insights,
    ensembleEligible,
  }
}
