/**
 * Agreement metrics — pure, unit-tested, no I/O.
 *
 * Exports:
 *   cohenKappa    — Cohen's κ (multi-class, observed/expected agreement)
 *   macroF1       — macro-averaged F1 (multi-class)
 *   spearmanRho   — Spearman ρ (tie-corrected fractional ranks)
 *   computeEce    — Expected Calibration Error (reliability diagram)
 */

import type {
  ClassMetrics,
  EceResult,
  KappaResult,
  MacroF1Result,
  ReliabilityBin,
  SpearmanResult,
} from './types.js'

// ─── Cohen's κ ────────────────────────────────────────────────────────────────

/**
 * Compute Cohen's κ between two equally-length label sequences.
 *
 * Formula:
 *   po  = observed agreement = (# matching pairs) / n
 *   pe  = expected agreement = Σ_c (freq_a(c) * freq_b(c)) / n²
 *   κ   = (po − pe) / (1 − pe)
 *
 * Returns κ = 0 and n = 0 when the arrays are empty.
 * Returns κ = 0 and n when po = pe = 1 (perfect agreement on one class).
 */
export function cohenKappa(a: readonly string[], b: readonly string[]): KappaResult {
  if (a.length !== b.length) {
    throw new Error(`cohenKappa: arrays must have equal length (got ${a.length} vs ${b.length})`)
  }
  const n = a.length
  if (n === 0) return { kappa: 0, n: 0 }

  // Collect all unique labels
  const labels = Array.from(new Set([...a, ...b]))

  // Frequency maps
  const freqA = new Map<string, number>()
  const freqB = new Map<string, number>()
  for (const label of labels) {
    freqA.set(label, 0)
    freqB.set(label, 0)
  }

  let observed = 0
  for (let i = 0; i < n; i++) {
    // noUncheckedIndexedAccess: a[i] and b[i] are safe here because i < n
    const ai = a[i] as string
    const bi = b[i] as string
    if (ai === bi) observed++
    freqA.set(ai, (freqA.get(ai) ?? 0) + 1)
    freqB.set(bi, (freqB.get(bi) ?? 0) + 1)
  }

  const po = observed / n

  // Expected agreement
  let pe = 0
  for (const label of labels) {
    pe += ((freqA.get(label) ?? 0) * (freqB.get(label) ?? 0)) / (n * n)
  }

  // Degenerate: both raters always agree on one label (pe = 1)
  if (pe >= 1) return { kappa: 1, n }

  return { kappa: (po - pe) / (1 - pe), n }
}

// ─── Macro-F1 ─────────────────────────────────────────────────────────────────

/**
 * Compute per-class precision/recall/F1, then return the unweighted (macro) mean F1.
 *
 * `predicted` and `gold` must be the same length and contain string labels.
 * Classes with zero support in `gold` are included in the per-class output but
 * contribute 0 to the macro average (they cannot be "missed").
 */
export function macroF1(predicted: readonly string[], gold: readonly string[]): MacroF1Result {
  if (predicted.length !== gold.length) {
    throw new Error(
      `macroF1: arrays must have equal length (got ${predicted.length} vs ${gold.length})`,
    )
  }
  if (predicted.length === 0) {
    return { macroF1: 0, perClass: [] }
  }

  const labels = Array.from(new Set([...predicted, ...gold]))

  const perClass: ClassMetrics[] = labels.map((label) => {
    let tp = 0
    let fp = 0
    let fn = 0
    let support = 0
    for (let i = 0; i < gold.length; i++) {
      const g = gold[i] as string
      const p = predicted[i] as string
      if (g === label) support++
      if (p === label && g === label) tp++
      else if (p === label && g !== label) fp++
      else if (p !== label && g === label) fn++
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return { label, precision, recall, f1, support }
  })

  // Macro: unweighted mean over classes present in gold (support > 0)
  const activeClasses = perClass.filter((c) => c.support > 0)
  const macro =
    activeClasses.length === 0
      ? 0
      : activeClasses.reduce((sum, c) => sum + c.f1, 0) / activeClasses.length

  return { macroF1: macro, perClass }
}

// ─── Spearman ρ (tie-corrected fractional ranks) ─────────────────────────────

/**
 * Assign fractional (average) ranks to an array of values, handling ties.
 *
 * E.g. [3, 1, 1, 2] → [4, 1.5, 1.5, 3]
 */
function fractionalRanks(values: readonly number[]): number[] {
  const n = values.length
  // Create sorted index list
  const indexed = values.map((v, i) => ({ v, i }))
  indexed.sort((a, b) => a.v - b.v)

  const ranks = new Array<number>(n).fill(0)
  let j = 0
  while (j < n) {
    let k = j
    // Find end of tie group
    while (k + 1 < n && (indexed[k + 1]?.v ?? NaN) === (indexed[j]?.v ?? NaN)) k++
    // Assign average rank (1-based)
    const avgRank = (j + k) / 2 + 1
    for (let m = j; m <= k; m++) {
      const entry = indexed[m]
      if (entry !== undefined) ranks[entry.i] = avgRank
    }
    j = k + 1
  }
  return ranks
}

/**
 * Compute tie-corrected Spearman ρ between two numeric sequences.
 *
 * Uses the Pearson correlation of the fractional (average) ranks rather than the
 * d² shortcut, which gives the correct result in the presence of ties.
 */
export function spearmanRho(x: readonly number[], y: readonly number[]): SpearmanResult {
  if (x.length !== y.length) {
    throw new Error(`spearmanRho: arrays must have equal length (got ${x.length} vs ${y.length})`)
  }
  const n = x.length
  if (n === 0) return { rho: 0, n: 0 }
  if (n === 1) return { rho: 1, n: 1 }

  const rx = fractionalRanks(x)
  const ry = fractionalRanks(y)

  const meanRx = rx.reduce((s, v) => s + v, 0) / n
  const meanRy = ry.reduce((s, v) => s + v, 0) / n

  let num = 0
  let denX = 0
  let denY = 0
  for (let i = 0; i < n; i++) {
    const dxi = (rx[i] as number) - meanRx
    const dyi = (ry[i] as number) - meanRy
    num += dxi * dyi
    denX += dxi * dxi
    denY += dyi * dyi
  }

  // Degenerate: zero variance in one or both sequences
  if (denX === 0 || denY === 0) return { rho: 1, n }

  return { rho: num / Math.sqrt(denX * denY), n }
}

// ─── ECE (Expected Calibration Error) ────────────────────────────────────────

/**
 * Compute the Expected Calibration Error from paired (confidence, isCorrect) data.
 *
 * Items are bucketed into `numBins` equal-width bins of [0, 1].
 * ECE = Σ_b (|b| / n) × |accuracy_b − confidence_b|
 *
 * @param confidences — model confidence values in [0, 1]
 * @param correct     — whether the model was correct for each item (true/false)
 * @param numBins     — number of equal-width bins (default 10)
 */
export function computeEce(
  confidences: readonly number[],
  correct: readonly boolean[],
  numBins = 10,
): EceResult {
  if (confidences.length !== correct.length) {
    throw new Error(
      `computeEce: arrays must have equal length (got ${confidences.length} vs ${correct.length})`,
    )
  }
  const n = confidences.length
  if (n === 0) return { ece: 0, n: 0, bins: [] }

  // Initialise bins
  const binSumConf = new Array<number>(numBins).fill(0)
  const binSumCorr = new Array<number>(numBins).fill(0)
  const binCount = new Array<number>(numBins).fill(0)

  for (let i = 0; i < n; i++) {
    const rawConf = confidences[i] as number
    const isCorrect = correct[i] as boolean
    // Actually clamp to [0, 1] (the old code only capped the upper end, so a
    // negative confidence produced a negative bin index → out-of-bounds writes
    // that silently corrupted the ECE result), then map to a bin (last bin
    // catches conf === 1.0).
    const conf = Math.min(1, Math.max(0, rawConf))
    const binIdx = Math.min(Math.floor(conf * numBins), numBins - 1)
    binSumConf[binIdx] = (binSumConf[binIdx] ?? 0) + conf
    binSumCorr[binIdx] = (binSumCorr[binIdx] ?? 0) + (isCorrect ? 1 : 0)
    binCount[binIdx] = (binCount[binIdx] ?? 0) + 1
  }

  const bins: ReliabilityBin[] = []
  let ece = 0

  for (let b = 0; b < numBins; b++) {
    const count = binCount[b] ?? 0
    if (count === 0) continue
    const avgConf = (binSumConf[b] ?? 0) / count
    const accuracy = (binSumCorr[b] ?? 0) / count
    const midpoint = (b + 0.5) / numBins
    bins.push({ midpoint, avgConfidence: avgConf, accuracy, count })
    ece += (count / n) * Math.abs(accuracy - avgConf)
  }

  return { ece, n, bins }
}
