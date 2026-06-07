/**
 * Rework / Churn % + Efficiency — Code Group D (SPEC §8.4)
 *
 * Uses `@lazy-flow/code-analysis` `classifyWorkType` to classify
 * changed lines into New / Legacy-Refactor / Help-Others / Rework.
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   `blameRecords` must come from the git blame adapter
 *   (gitBlameRecords() in code-analysis, deferred in WP-CODE-ANALYSIS).
 *   In tests: inject fixture BlameRecord arrays.
 *
 * formulaDoc:
 *   reworkPercent = (Rework lines / total lines) * 100
 *   efficiency    = 100 − reworkPercent
 *   Window: churnWindowDays (default 30, D7).
 *   Classification per line: New / Legacy-Refactor / Help-Others / Rework.
 */

import type { BlameRecord } from '@lazy-flow/code-analysis'
import { classifyWorkType } from '@lazy-flow/code-analysis'
import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface ReworkChurnInputs {
  /**
   * Author whose changes we are classifying.
   * Must match BlameRecord.author exactly.
   */
  author: string
  /**
   * Blame records for the changed lines.
   * STORE-VS-FIXTURE: inject fixture BlameRecord[] in tests;
   * use gitBlameRecords() adapter in production.
   */
  blameRecords: readonly BlameRecord[]
  /**
   * Lines to classify (1-based line numbers from the diff).
   * If omitted, all lines in blameRecords are classified.
   */
  lines?: readonly number[]
  /** Churn window in days (default 30, SPEC D7). */
  churnWindowDays?: number
  /**
   * Reference now (ISO-8601). Injected — never Date.now().
   */
  now: string
}

export interface ReworkChurnResult extends MetricResult {
  readonly totalLines: number
  readonly reworkLines: number
  readonly newLines: number
  readonly legacyRefactorLines: number
  readonly helpOthersLines: number
  readonly reworkPercent: number | null
  /** efficiency = 100 − reworkPercent (null when total=0). */
  readonly efficiency: number | null
}

const FORMULA_DOC =
  'Rework/Churn % (SPEC §8.4, D7): ' +
  'Classify changed lines by blame age + authorship. ' +
  'Rework: author re-touching own code within churnWindowDays. ' +
  'reworkPercent = (Rework / total) * 100. ' +
  'efficiency = 100 − reworkPercent. ' +
  'Window default: 30 days (D7). ' +
  'STORE-VS-FIXTURE: blameRecords from git blame adapter or test fixtures.'

export const reworkChurn: MetricModule<ReworkChurnInputs, ReworkChurnResult> = {
  id: 'code.rework_churn',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { churnWindowDays: 30 },

  compute(inputs, asOf): ReworkChurnResult {
    const result = classifyWorkType({
      author: inputs.author,
      blameRecords: [...inputs.blameRecords],
      now: new Date(inputs.now),
      lines: inputs.lines ? [...inputs.lines] : undefined,
      windowDays: inputs.churnWindowDays ?? 30,
    })

    return {
      id: 'code.rework_churn',
      trustTier: 'deterministic',
      scope: 'team',
      value: result.reworkPercent,
      unit: 'percent',
      dataQuality: result.total === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      totalLines: result.total,
      reworkLines: result.counts.Rework,
      newLines: result.counts.New,
      legacyRefactorLines: result.counts['Legacy-Refactor'],
      helpOthersLines: result.counts['Help-Others'],
      reworkPercent: result.reworkPercent,
      efficiency: result.efficiency,
    }
  },
}
