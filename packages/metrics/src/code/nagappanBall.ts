/**
 * Nagappan-Ball M1/M2/M3 — Code Group D (SPEC §8.4)
 *
 * Nagappan & Ball (2005) identified three code-churn metrics predictive
 * of post-release defects:
 *
 *   M1 = relative churn = HALOC / (prior HALOC + current HALOC)
 *        (how "churny" this change is relative to the accumulated codebase)
 *
 *   M2 = churn rate = HALOC / windowDays
 *        (rate of code change over the measurement window)
 *
 *   M3 = defect density proxy = reworkLines / (totalLines + 1)
 *        (rework density; +1 to avoid zero denominator)
 *
 * These are descriptive-only (SPEC §8.4: "never rank individuals").
 * They surface as team-level aggregates.
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   `priorHaloc` must be obtained from the store (prior rolling HALOC).
 *   In tests: pass a fixture value.
 *
 * formulaDoc:
 *   M1 = haloc / (priorHaloc + haloc) — relative churn [0,1].
 *   M2 = haloc / windowDays — churn rate (haloc/day).
 *   M3 = reworkLines / (totalLines + 1) — rework density.
 *   All null on zero-denominator per SPEC §8.6.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface NagappanBallInputs {
  /** Current HALOC for this window. */
  haloc: number
  /** Prior HALOC (rolling cumulative before this window). */
  priorHaloc: number
  /** Window in days over which HALOC was measured. */
  windowDays: number
  /** Lines classified as Rework in this window. */
  reworkLines: number
  /** Total lines classified in this window. */
  totalLines: number
}

export interface NagappanBallResult extends MetricResult {
  /** M1: relative churn [0,1]. Null when priorHaloc+haloc=0. */
  readonly m1RelativeChurn: number | null
  /** M2: churn rate (haloc/day). Null when windowDays=0. */
  readonly m2ChurnRate: number | null
  /** M3: rework density. Never null (denominator = totalLines+1). */
  readonly m3ReworkDensity: number
}

const FORMULA_DOC =
  'Nagappan-Ball M1/M2/M3 (SPEC §8.4): ' +
  'M1 = haloc / (priorHaloc + haloc) — relative churn [0,1]. ' +
  'M2 = haloc / windowDays — churn rate (haloc/day). ' +
  'M3 = reworkLines / (totalLines + 1) — rework density. ' +
  'Descriptive-only; do not rank individuals. ' +
  'Zero-denominator → null (SPEC §8.6).'

export const nagappanBall: MetricModule<NagappanBallInputs, NagappanBallResult> = {
  id: 'code.nagappan_ball',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): NagappanBallResult {
    const m1 = safeRatio(inputs.haloc, inputs.priorHaloc + inputs.haloc)
    const m2 = safeRatio(inputs.haloc, inputs.windowDays)
    // M3 denominator = totalLines + 1 (never zero)
    const m3 = inputs.reworkLines / (inputs.totalLines + 1)

    return {
      id: 'code.nagappan_ball',
      trustTier: 'deterministic',
      scope: 'team',
      value: m1,
      unit: 'ratio',
      dataQuality: inputs.haloc === 0 && inputs.priorHaloc === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      m1RelativeChurn: m1,
      m2ChurnRate: m2,
      m3ReworkDensity: m3,
    }
  },
}
