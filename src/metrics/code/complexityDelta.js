import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Complexity Deltas (SPEC §8.4): ' +
  'Δcyclomatic = head_cyclomatic − base_cyclomatic per function (matched by name). ' +
  'Δcognitive  = head_cognitive  − base_cognitive  per function. ' +
  'Aggregates: sum of positive (increases) and negative (decreases) deltas. ' +
  'Inputs: pre-computed FileComplexity from analyzeComplexity (tree-sitter). ' +
  'Descriptive only — do not rank individuals.'

// ---------------------------------------------------------------------------
// Delta computation from two FileComplexity objects
// ---------------------------------------------------------------------------

function computeFileDelta(path, base, head) {
  const baseLookup = new Map()
  if (base) {
    for (const fn of base.functions) {
      baseLookup.set(fn.name, { cyclomatic: fn.cyclomatic, cognitive: fn.cognitive })
    }
  }

  const functions = head.functions.map((hf) => {
    const bf = baseLookup.get(hf.name)
    return {
      name: hf.name,
      startLine: hf.startLine,
      baseCyclomatic: bf?.cyclomatic ?? null,
      headCyclomatic: hf.cyclomatic,
      baseCognitive: bf?.cognitive ?? null,
      headCognitive: hf.cognitive,
      cyclomaticDelta: hf.cyclomatic - (bf?.cyclomatic ?? 0),
      cognitiveDelta: hf.cognitive - (bf?.cognitive ?? 0),
    }
  })

  const totalCyclomaticDelta = functions.reduce((s, f) => s + f.cyclomaticDelta, 0)
  const totalCognitiveDelta = functions.reduce((s, f) => s + f.cognitiveDelta, 0)

  return { path, totalCyclomaticDelta, totalCognitiveDelta, functions }
}

// ---------------------------------------------------------------------------
// Metric module
// ---------------------------------------------------------------------------

export const complexityDelta = {
  id: 'code.complexity_delta',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const fileDeltae = []
    let totalCyclomaticIncrease = 0
    let totalCognitiveIncrease = 0
    let functionsIncreased = 0
    let functionsDecreased = 0

    for (const headSnap of inputs.head) {
      const baseSnap = inputs.base.find((b) => b.path === headSnap.path)
      const delta = computeFileDelta(
        headSnap.path,
        baseSnap?.complexity ?? null,
        headSnap.complexity,
      )
      fileDeltae.push(delta)

      for (const fnDelta of delta.functions) {
        if (fnDelta.cyclomaticDelta > 0 || fnDelta.cognitiveDelta > 0) {
          functionsIncreased++
        } else if (fnDelta.cyclomaticDelta < 0 || fnDelta.cognitiveDelta < 0) {
          functionsDecreased++
        }
        if (fnDelta.cyclomaticDelta > 0) totalCyclomaticIncrease += fnDelta.cyclomaticDelta
        if (fnDelta.cognitiveDelta > 0) totalCognitiveIncrease += fnDelta.cognitiveDelta
      }
    }

    return {
      id: 'code.complexity_delta',
      trustTier: 'deterministic',
      scope: 'team',
      value: totalCyclomaticIncrease,
      unit: 'complexity_points',
      dataQuality: inputs.head.length === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      fileDeltae,
      totalCyclomaticIncrease,
      totalCognitiveIncrease,
      functionsIncreased,
      functionsDecreased,
    }
  },
}
