import { computeHaloc } from '../../code-analysis/index.js'

import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'HALOC Aggregation (SPEC §8.4, §1 C2): ' +
  'HALOC = Σ_hunk max(insertions, deletions). ' +
  'Binary/generated files surfaced separately, never silently zeroed. ' +
  'Rename-with-edits: only edit hunks count. ' +
  'Whitespace-insensitive mode available (mirrors git diff -w).'

export const halocAggregate = {
  id: 'code.haloc_aggregate',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    let totalHaloc = 0
    let totalBinaryHaloc = 0
    let totalGeneratedHaloc = 0
    const perChange = []

    for (const change of inputs.changes) {
      const result = computeHaloc(change.diff, inputs.options)
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
