/**
 * Sprint Predictability — Agile Group E (SPEC §8.5)
 *
 * Measures how consistently a team delivers relative to commitment.
 * Preferred estimator: share of sprints within ±X% of commitment.
 * (The raw 1−CV is unbounded-below and renders as negative %, rejected per SPEC §8.5.)
 *
 * Rules:
 *   - Bounded to [0, 1].
 *   - Requires n ≥ 2 sprints (null on n < 2).
 *   - Requires mean > 0 (null if all sprints had 0 committed).
 *   - Default tolerance: ±20% of committed.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface PredictabilitySprintRecord {
  sprintId: string
  committed: number
  completed: number
}

export interface PredictabilityInputs {
  /** Historical sprint records (committed + completed). Must include at least n≥2. */
  sprints: readonly PredictabilitySprintRecord[]
  /** Tolerance as a fraction (default 0.2 = ±20%). */
  toleranceFraction?: number
}

export interface PredictabilityResult extends MetricResult {
  /** Share of sprints within ±toleranceFraction of committed. */
  readonly predictabilityScore: number | null
  readonly sprintsWithinTolerance: number
  readonly totalSprints: number
  readonly toleranceFraction: number
}

const FORMULA_DOC =
  'Sprint Predictability (SPEC §8.5): share of sprints where ' +
  '|completed − committed| / committed ≤ toleranceFraction (default ±20%). ' +
  'Bounded to [0, 1]. Requires n ≥ 2 sprints and mean committed > 0. ' +
  'Sprints with committed = 0 are excluded from the denominator. ' +
  'The raw 1−CV estimator is rejected (unbounded-below, renders negative %).'

export const sprintPredictability: MetricModule<PredictabilityInputs, PredictabilityResult> = {
  id: 'agile.sprint_predictability',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { toleranceFraction: 0.2 },

  compute(inputs, asOf): PredictabilityResult {
    const tolerance = inputs.toleranceFraction ?? 0.2

    // Filter out sprints with 0 committed (excluded per §8.5)
    const validSprints = inputs.sprints.filter((s) => s.committed > 0)

    if (validSprints.length < 2) {
      return {
        id: 'agile.sprint_predictability',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: validSprints.length === 0 ? 'no_data' : 'insufficient_sample',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        predictabilityScore: null,
        sprintsWithinTolerance: 0,
        totalSprints: validSprints.length,
        toleranceFraction: tolerance,
      }
    }

    let withinTolerance = 0
    for (const s of validSprints) {
      const deviation = Math.abs(s.completed - s.committed) / s.committed
      if (deviation <= tolerance) withinTolerance++
    }

    const score = safeRatio(withinTolerance, validSprints.length)
    // Clamp to [0, 1] (should already be, but defensive)
    const boundedScore = score !== null ? Math.max(0, Math.min(1, score)) : null

    return {
      id: 'agile.sprint_predictability',
      trustTier: 'deterministic',
      scope: 'team',
      value: boundedScore,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      predictabilityScore: boundedScore,
      sprintsWithinTolerance: withinTolerance,
      totalSprints: validSprints.length,
      toleranceFraction: tolerance,
    }
  },
}
