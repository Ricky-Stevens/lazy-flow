import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Estimation Accuracy (SPEC §8.5): tie-corrected Spearman rank correlation ' +
  'between story points and actual cycle time. ' +
  'Excludes reopened issues and 0-point issues. ' +
  'Minimum n = 5; suppressed when not significant (t-test, α=0.05). ' +
  'Tie-correction applied: T = 1 − (Σt³−t)/(12*n*(n²−1)) for each tied group.'

/**
 * Compute tie-corrected Spearman ρ.
 * Formula: ρ = 1 − (6 * Σd²) / (n(n²−1)) is the untied version.
 * Tie-corrected formula uses fractional ranks and Pearson's r on the ranks.
 */
export function tiedSpearman(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  if (xs.length !== ys.length) return null

  function tiedRanks(values) {
    const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const ranks = new Array(n)
    let i = 0
    while (i < n) {
      let j = i
      while (j < n && (indexed[j]?.v ?? 0) === (indexed[i]?.v ?? 0)) j++
      const avgRank = (i + j - 1) / 2
      for (let k = i; k < j; k++) {
        const item = indexed[k]
        if (item) ranks[item.i] = avgRank
      }
      i = j
    }
    return ranks
  }

  const rx = tiedRanks(xs)
  const ry = tiedRanks(ys)

  // Pearson's r on the ranks
  let sumRx = 0
  let sumRy = 0
  for (let i = 0; i < n; i++) {
    sumRx += rx[i] ?? 0
    sumRy += ry[i] ?? 0
  }
  const meanRx = sumRx / n
  const meanRy = sumRy / n

  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    const dx = (rx[i] ?? 0) - meanRx
    const dy = (ry[i] ?? 0) - meanRy
    cov += dx * dy
    varX += dx * dx
    varY += dy * dy
  }

  if (varX === 0 || varY === 0) return null
  return cov / Math.sqrt(varX * varY)
}

/**
 * t-statistic for Spearman significance test.
 * t = r * sqrt(n−2) / sqrt(1 − r²)
 *
 * Two-tailed critical t values per df, for the supported α levels. Large-df rows
 * fall back to the normal z quantile (the t→z limit).
 */
const T_CRITICAL = {
  0.1: { 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.86, 9: 1.833, 10: 1.812 },
  0.05: { 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 },
  0.01: { 3: 5.841, 4: 4.604, 5: 4.032, 6: 3.707, 7: 3.499, 8: 3.355, 9: 3.25, 10: 3.169 },
}

/** Normal (large-df) two-tailed critical z for each supported α. */
const Z_CRITICAL = { 0.1: 1.645, 0.05: 1.96, 0.01: 2.576 }

function tableKey(alpha) {
  const key = String(alpha)
  if (!(key in Z_CRITICAL)) {
    throw new RangeError(
      `estimationAccuracy: unsupported alpha ${alpha}; supported: 0.1, 0.05, 0.01`,
    )
  }
  return key
}

function tCritical(df, alpha) {
  if (df <= 0) return Number.POSITIVE_INFINITY
  const key = tableKey(alpha)
  if (df <= 10) {
    const z = Z_CRITICAL[key] ?? 1.96
    return T_CRITICAL[key]?.[df] ?? z
  }
  // Approach the normal quantile as df grows, with a small finite-df correction.
  const z = Z_CRITICAL[key] ?? 1.96
  return z + (z * (z * z + 1)) / (4 * df)
}

export function isSpearmanSignificant(rho, n, alpha = 0.05) {
  if (n < 4) return false // df < 2
  const df = n - 2
  const denominator = 1 - rho * rho
  if (denominator <= 0) return true // perfect correlation
  const t = Math.abs(rho) * Math.sqrt(df / denominator)
  return t >= tCritical(df, alpha)
}

export const estimationAccuracy = {
  id: 'agile.estimation_accuracy',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { minN: 5, alpha: 0.05 },

  compute(inputs, asOf) {
    const minN = inputs.minN ?? 5
    const alpha = inputs.alpha ?? 0.05

    // Filter: exclude reopened and 0-point
    const eligible = inputs.pairs.filter((p) => !p.wasReopened && p.storyPoints > 0)
    const n = eligible.length

    if (n < minN) {
      return {
        id: 'agile.estimation_accuracy',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'correlation',
        dataQuality: n === 0 ? 'no_data' : 'insufficient_sample',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        spearman: null,
        sampleSize: n,
        isSignificant: null,
        suppressed: true,
        suppressReason: `n=${n} < minN=${minN}`,
      }
    }

    const points = eligible.map((p) => p.storyPoints)
    const cycleTimes = eligible.map((p) => p.cycleTimeSeconds)

    const rho = tiedSpearman(points, cycleTimes)

    if (rho === null) {
      return {
        id: 'agile.estimation_accuracy',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'correlation',
        dataQuality: 'insufficient_sample',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        spearman: null,
        sampleSize: n,
        isSignificant: null,
        suppressed: true,
        suppressReason: 'Insufficient variance in ranks (all points or cycle times identical)',
      }
    }

    const significant = isSpearmanSignificant(rho, n, alpha)

    if (!significant) {
      return {
        id: 'agile.estimation_accuracy',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'correlation',
        dataQuality: 'ok',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        spearman: null,
        sampleSize: n,
        isSignificant: false,
        suppressed: true,
        suppressReason: `Not statistically significant at α=${alpha}`,
      }
    }

    return {
      id: 'agile.estimation_accuracy',
      trustTier: 'deterministic',
      scope: 'team',
      value: rho,
      unit: 'correlation',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      spearman: rho,
      sampleSize: n,
      isSignificant: true,
      suppressed: false,
      suppressReason: null,
    }
  },
}
