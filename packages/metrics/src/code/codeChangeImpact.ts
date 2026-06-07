/**
 * Code-Change Impact (deterministic blend) — Code Group D (SPEC §8.4, §9.2.7)
 *
 * Deterministic explainable blend of:
 *   1. edit_diversity   = distinct files changed / total files in repo proxy
 *   2. haloc_norm       = haloc / (haloc + 100)  [normalised 0→1]
 *   3. file_count_norm  = min(1, files / 20)      [capped at 20 files = 1.0]
 *   4. change_entropy   = Shannon entropy of file-path directory distribution
 *   5. old_code_pct     = legacyRefactorLines / totalLines (null when 0)
 *
 * Impact score = weighted sum (default weights below).
 * All weights configurable.  LLM rationale string = Wave 5 hook (not implemented here).
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   `haloc`, `files`, `reworkLines`, `totalLines` come from prior metrics.
 *   `filePaths` for entropy: from the code change record.
 *   In production: obtain from halocAggregate + reworkChurn results.
 *   In tests: inject fixture values.
 *
 * formulaDoc:
 *   impact = w1*edit_diversity + w2*haloc_norm + w3*file_count_norm
 *            + w4*change_entropy + w5*old_code_pct
 *   Default weights: w1=0.25, w2=0.25, w3=0.20, w4=0.15, w5=0.15.
 *   LLM rationale string hook: pass llmRationale (Wave 5 item).
 *   All factors and weights are visible and configurable (SPEC §9.2.7).
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface CodeChangeImpactInputs {
  /** HALOC for this change. */
  haloc: number
  /** File paths changed. */
  filePaths: readonly string[]
  /** Lines classified as Rework (old code touched). */
  legacyRefactorLines: number
  /** Total lines classified. */
  totalLines: number
  /**
   * Optional weight overrides.
   * Keys: editDiversity, halocNorm, fileCountNorm, changeEntropy, oldCodePct.
   * Missing keys fall back to defaults.
   */
  weightOverrides?: Partial<Record<string, number>>
  /**
   * Wave 5 hook: LLM rationale string.
   * When provided, included in the result for transparency.
   * The deterministic impact score is computed regardless.
   */
  llmRationale?: string
}

export interface ImpactFactors {
  editDiversity: number
  halocNorm: number
  fileCountNorm: number
  changeEntropy: number
  oldCodePct: number | null
}

export interface CodeChangeImpactResult extends MetricResult {
  /** Deterministic impact score [0, 1]. */
  readonly impactScore: number
  readonly factors: ImpactFactors
  readonly weights: Record<string, number>
  /** LLM rationale string (Wave 5 hook — null until AI layer implemented). */
  readonly llmRationale: string | null
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  editDiversity: 0.25,
  halocNorm: 0.25,
  fileCountNorm: 0.2,
  changeEntropy: 0.15,
  oldCodePct: 0.15,
}

const FORMULA_DOC =
  'Code-Change Impact (SPEC §8.4, §9.2.7): ' +
  'Deterministic blend: ' +
  'edit_diversity=distinct files changed / 20 (capped 1); ' +
  'haloc_norm=haloc/(haloc+100); ' +
  'file_count_norm=min(1,files/20); ' +
  'change_entropy=Shannon entropy of file-path dirs; ' +
  'old_code_pct=legacyRefactorLines/totalLines. ' +
  'impact = Σ weight_i * factor_i. ' +
  'All weights configurable. ' +
  'LLM rationale hook (Wave 5): llmRationale field.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shannon entropy of directory distribution in file paths. */
function computeChangeEntropy(filePaths: readonly string[]): number {
  if (filePaths.length === 0) return 0
  const dirCounts = new Map<string, number>()
  for (const p of filePaths) {
    const lastSlash = p.lastIndexOf('/')
    const dir = lastSlash >= 0 ? p.slice(0, lastSlash) : '.'
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }
  const total = filePaths.length
  let entropy = 0
  for (const count of dirCounts.values()) {
    const p = count / total
    entropy -= p * Math.log2(p)
  }
  // Normalise to [0,1] by dividing by max entropy (log2(n dirs))
  const maxEntropy = Math.log2(dirCounts.size)
  return maxEntropy > 0 ? entropy / maxEntropy : 0
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const codeChangeImpact: MetricModule<CodeChangeImpactInputs, CodeChangeImpactResult> = {
  id: 'code.change_impact',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { weights: DEFAULT_WEIGHTS },

  compute(inputs, asOf): CodeChangeImpactResult {
    const weights: Record<string, number> = { ...DEFAULT_WEIGHTS }
    if (inputs.weightOverrides) {
      for (const [k, v] of Object.entries(inputs.weightOverrides)) {
        if (v !== undefined) weights[k] = v
      }
    }

    const fileCount = inputs.filePaths.length

    // Distinct directories touched — the *spread* of the change, which is a
    // different signal from the raw file count (10 files in one dir vs across
    // ten dirs). Previously editDiversity duplicated fileCountNorm verbatim,
    // double-weighting file count and contributing nothing of its own.
    const distinctDirs = new Set(
      inputs.filePaths.map((p) => {
        const i = p.lastIndexOf('/')
        return i >= 0 ? p.slice(0, i) : '.'
      }),
    ).size

    const factors: ImpactFactors = {
      // editDiversity: normalised count of distinct directories touched (cap 10 → 1.0)
      editDiversity: Math.min(1, safeRatio(distinctDirs, 10) ?? 0),
      // halocNorm: asymptotic normalisation, HALOC=0→0, HALOC=∞→1
      halocNorm: safeRatio(inputs.haloc, inputs.haloc + 100) ?? 0,
      // fileCountNorm: normalised file count (capped at 20 → 1.0)
      fileCountNorm: Math.min(1, safeRatio(fileCount, 20) ?? 0),
      // changeEntropy: Shannon entropy of directory distribution
      changeEntropy: computeChangeEntropy(inputs.filePaths),
      // oldCodePct: fraction of lines touching old code
      oldCodePct: safeRatio(inputs.legacyRefactorLines, inputs.totalLines),
    }

    const impactScore = Math.min(
      1,
      (weights.editDiversity ?? 0) * factors.editDiversity +
        (weights.halocNorm ?? 0) * factors.halocNorm +
        (weights.fileCountNorm ?? 0) * factors.fileCountNorm +
        (weights.changeEntropy ?? 0) * factors.changeEntropy +
        (weights.oldCodePct ?? 0) * (factors.oldCodePct ?? 0),
    )

    return {
      id: 'code.change_impact',
      trustTier: 'deterministic',
      scope: 'team',
      value: impactScore,
      unit: 'score',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      impactScore,
      factors,
      weights,
      llmRationale: inputs.llmRationale ?? null,
    }
  },
}
