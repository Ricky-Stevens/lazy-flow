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
    // Per-file backfill coverage, so the headline can declare whether the value is
    // precise (every file's patch recomputed), denormalised (none backfilled), or
    // hybrid (precise where a patch exists, denorm max(add,del) elsewhere).
    let patchedFiles = 0
    let totalFiles = 0
    const perChange = []

    for (const change of inputs.changes) {
      // `diff` holds ONLY the files whose patch has been ingested (precise per-hunk
      // recompute); `fallback` carries the denormalised per-file HALOC for files
      // still awaiting backfill. Summing both makes the metric correct at ANY
      // coverage — already-backfilled patches count precisely instead of being
      // discarded by an all-or-nothing fallback.
      const result = computeHaloc(change.diff, inputs.options)
      const fb = change.fallback ?? { haloc: 0, binaryHaloc: 0, generatedHaloc: 0 }
      const changeHaloc = result.haloc + fb.haloc
      const changeBinary = result.binaryHaloc + (fb.binaryHaloc ?? 0)
      const changeGenerated = result.generatedHaloc + fb.generatedHaloc

      totalHaloc += changeHaloc
      totalBinaryHaloc += changeBinary
      totalGeneratedHaloc += changeGenerated
      patchedFiles += change.patchedCount ?? result.files.length
      totalFiles += change.fileCount ?? result.files.length

      perChange.push({
        changeId: change.id,
        haloc: changeHaloc,
        binaryHaloc: changeBinary,
        generatedHaloc: changeGenerated,
        fileCount: change.fileCount ?? result.files.length,
      })
    }

    const changeCount = inputs.changes.length
    const avgHalocPerChange = safeRatio(totalHaloc, changeCount)
    const patchCoverage = totalFiles > 0 ? patchedFiles / totalFiles : 0
    const halocSource =
      totalFiles === 0
        ? 'no_data'
        : patchedFiles === totalFiles
          ? 'recomputed_from_patch'
          : patchedFiles === 0
            ? 'denormalized_prfile_column'
            : 'hybrid_patch_and_denormalized'

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
      halocSource,
      patchCoverage,
    }
  },
}
