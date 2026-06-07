/**
 * HALOC Aggregation — Code Group D (SPEC §8.4)
 *
 * Aggregates HALOC (Hunk-Adjusted Lines of Code) across multiple changes.
 * Delegates to `@lazy-flow/code-analysis` `computeHaloc` per change.
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   `inputs.changes[].diff` must be a real unified diff string.
 *   In production: obtained from git diff / stored diff artifact.
 *   In tests: fixture diff strings.
 *
 * formulaDoc:
 *   HALOC = Σ_hunk max(insertions, deletions) per non-binary non-generated file.
 *   Binary and generated file volumes are surfaced separately (never zeroed).
 *   Per SPEC §1 C2 and §8.4 HALOC normalisation rules.
 */

import type { HalocOptions, HalocResult } from '@lazy-flow/code-analysis'
import { computeHaloc } from '@lazy-flow/code-analysis'
import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { CodeChangeRecord } from './types.js'

export interface HalocAggregateInputs {
  changes: readonly CodeChangeRecord[]
  options?: HalocOptions
}

export interface PerChangeHaloc {
  changeId: string
  haloc: number
  binaryHaloc: number
  generatedHaloc: number
  fileCount: number
}

export interface HalocAggregateResult extends MetricResult {
  /** Total HALOC from non-binary, non-generated files across all changes. */
  readonly totalHaloc: number
  readonly totalBinaryHaloc: number
  readonly totalGeneratedHaloc: number
  readonly changeCount: number
  readonly perChange: readonly PerChangeHaloc[]
  /** Average HALOC per change. */
  readonly avgHalocPerChange: number | null
}

const FORMULA_DOC =
  'HALOC Aggregation (SPEC §8.4, §1 C2): ' +
  'HALOC = Σ_hunk max(insertions, deletions). ' +
  'Binary/generated files surfaced separately, never silently zeroed. ' +
  'Rename-with-edits: only edit hunks count. ' +
  'Whitespace-insensitive mode available (mirrors git diff -w).'

export const halocAggregate: MetricModule<HalocAggregateInputs, HalocAggregateResult> = {
  id: 'code.haloc_aggregate',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): HalocAggregateResult {
    let totalHaloc = 0
    let totalBinaryHaloc = 0
    let totalGeneratedHaloc = 0
    const perChange: PerChangeHaloc[] = []

    for (const change of inputs.changes) {
      const result: HalocResult = computeHaloc(change.diff, inputs.options)
      totalHaloc += result.haloc
      totalBinaryHaloc += result.binaryHaloc
      totalGeneratedHaloc += result.generatedHaloc

      perChange.push({
        changeId: change.id,
        haloc: result.haloc,
        binaryHaloc: result.binaryHaloc,
        generatedHaloc: result.generatedHaloc,
        fileCount: result.files.length,
      })
    }

    const changeCount = inputs.changes.length
    const avgHalocPerChange = safeRatio(totalHaloc, changeCount)

    return {
      id: 'code.haloc_aggregate',
      trustTier: 'deterministic',
      scope: 'team',
      value: totalHaloc,
      unit: 'haloc',
      dataQuality: changeCount === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      totalHaloc,
      totalBinaryHaloc,
      totalGeneratedHaloc,
      changeCount,
      perChange,
      avgHalocPerChange,
    }
  },
}
