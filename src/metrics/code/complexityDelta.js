import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Complexity Deltas (SPEC §8.4): ' +
  'Δcyclomatic = head_cyclomatic − base_cyclomatic per function (matched by name). ' +
  'Δcognitive  = head_cognitive  − base_cognitive  per function. ' +
  'Increases/decreases count EXISTING (name-matched) functions only; new and ' +
  'removed functions are tallied separately (functionsAdded/Removed, newFunction*) ' +
  'so adding code is not reported as increased complexity of existing code. ' +
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
  const headNames = new Set(head.functions.map((f) => f.name))

  const functions = head.functions.map((hf) => {
    const bf = baseLookup.get(hf.name)
    // `isNew` distinguishes a brand-new function from an increase in EXISTING
    // complexity. A new function's full complexity must not be counted as if an
    // existing function got more complex — that systematically inflates the
    // "complexity increase" headline whenever any code is added.
    const isNew = bf === undefined
    return {
      name: hf.name,
      startLine: hf.startLine,
      isNew,
      baseCyclomatic: bf?.cyclomatic ?? null,
      headCyclomatic: hf.cyclomatic,
      baseCognitive: bf?.cognitive ?? null,
      headCognitive: hf.cognitive,
      cyclomaticDelta: hf.cyclomatic - (bf?.cyclomatic ?? 0),
      cognitiveDelta: hf.cognitive - (bf?.cognitive ?? 0),
    }
  })

  // Functions present in base but absent from head were removed — their
  // complexity left the codebase. Surface them so deletion-driven reductions
  // aren't invisible (the head-only iteration above can never see them).
  const removedFunctions = []
  if (base) {
    for (const bf of base.functions) {
      if (!headNames.has(bf.name)) {
        removedFunctions.push({
          name: bf.name,
          baseCyclomatic: bf.cyclomatic,
          baseCognitive: bf.cognitive,
        })
      }
    }
  }

  const totalCyclomaticDelta = functions.reduce((s, f) => s + f.cyclomaticDelta, 0)
  const totalCognitiveDelta = functions.reduce((s, f) => s + f.cognitiveDelta, 0)

  return { path, totalCyclomaticDelta, totalCognitiveDelta, functions, removedFunctions }
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
    // Increase/decrease counts apply to EXISTING (matched) functions only. New
    // and removed functions are tallied separately so the headline measures
    // "did existing code get more complex", not "was any code added/deleted".
    let totalCyclomaticIncrease = 0
    let totalCognitiveIncrease = 0
    let functionsIncreased = 0
    let functionsDecreased = 0
    let functionsAdded = 0
    let functionsRemoved = 0
    let newFunctionCyclomatic = 0
    let newFunctionCognitive = 0

    for (const headSnap of inputs.head) {
      const baseSnap = inputs.base.find((b) => b.path === headSnap.path)
      const delta = computeFileDelta(
        headSnap.path,
        baseSnap?.complexity ?? null,
        headSnap.complexity,
      )
      fileDeltae.push(delta)

      for (const fnDelta of delta.functions) {
        if (fnDelta.isNew) {
          // Brand-new function: its complexity is new code, NOT an increase of
          // existing complexity. Tracked separately to avoid inflating the
          // increase headline whenever any function is added.
          functionsAdded++
          newFunctionCyclomatic += fnDelta.headCyclomatic
          newFunctionCognitive += fnDelta.headCognitive
          continue
        }
        if (fnDelta.cyclomaticDelta > 0 || fnDelta.cognitiveDelta > 0) {
          functionsIncreased++
        } else if (fnDelta.cyclomaticDelta < 0 || fnDelta.cognitiveDelta < 0) {
          functionsDecreased++
        }
        if (fnDelta.cyclomaticDelta > 0) totalCyclomaticIncrease += fnDelta.cyclomaticDelta
        if (fnDelta.cognitiveDelta > 0) totalCognitiveIncrease += fnDelta.cognitiveDelta
      }
      functionsRemoved += delta.removedFunctions.length
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
      functionsAdded,
      functionsRemoved,
      newFunctionCyclomatic,
      newFunctionCognitive,
    }
  },
}
