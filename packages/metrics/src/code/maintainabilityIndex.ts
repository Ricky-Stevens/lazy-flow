/**
 * Maintainability Index (trend only) — Code Group D (SPEC §8.4)
 *
 * MI = 171 − 5.2 * ln(avgHaloc) − 0.23 * avgCyclomatic − 16.2 * ln(avgLoc)
 * (Microsoft VS variant, which differs from the original Oman et al. formula)
 *
 * SPEC §8.4: TREND ONLY.  We do not claim the absolute value is meaningful
 * across languages/repos — only the direction of change week-over-week.
 *
 * Clamped to [0, 100] for display purposes.
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   Inputs are pre-computed aggregates (avgHaloc, avgCyclomatic, avgLoc).
 *   Callers obtain these from the code analysis layer.
 *   In tests: inject fixture values.
 *
 * formulaDoc:
 *   MI = max(0, min(100, 171 − 5.2 * ln(avgHaloc+1) − 0.23 * avgCyclomatic
 *        − 16.2 * ln(avgLoc+1))).
 *   +1 in ln() to avoid ln(0).
 *   Trend only — absolute MI is not meaningful across repos/languages.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface MaintainabilityIndexInputs {
  /** Average HALOC per file (over the measurement window). */
  avgHaloc: number
  /** Average cyclomatic complexity per function. */
  avgCyclomatic: number
  /** Average LOC per file (raw line count — only for MI formula). */
  avgLoc: number
}

export interface MaintainabilityIndexResult extends MetricResult {
  /** Maintainability Index [0, 100]. For trend use only. */
  readonly mi: number
  readonly avgHaloc: number
  readonly avgCyclomatic: number
  readonly avgLoc: number
}

const FORMULA_DOC =
  'Maintainability Index (SPEC §8.4, trend only): ' +
  'MI = max(0, min(100, 171 − 5.2*ln(avgHaloc+1) − 0.23*avgCyclomatic − 16.2*ln(avgLoc+1))). ' +
  'Microsoft VS variant. +1 in ln() avoids ln(0). ' +
  'TREND ONLY — absolute value not comparable across repos/languages.'

export const maintainabilityIndex: MetricModule<
  MaintainabilityIndexInputs,
  MaintainabilityIndexResult
> = {
  id: 'code.maintainability_index',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): MaintainabilityIndexResult {
    const rawMi =
      171 -
      5.2 * Math.log(inputs.avgHaloc + 1) -
      0.23 * inputs.avgCyclomatic -
      16.2 * Math.log(inputs.avgLoc + 1)

    const mi = Math.max(0, Math.min(100, rawMi))

    return {
      id: 'code.maintainability_index',
      trustTier: 'deterministic',
      scope: 'team',
      value: mi,
      unit: 'index',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      mi,
      avgHaloc: inputs.avgHaloc,
      avgCyclomatic: inputs.avgCyclomatic,
      avgLoc: inputs.avgLoc,
    }
  },
}
