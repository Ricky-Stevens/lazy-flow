/**
 * Complexity Deltas — Code Group D (SPEC §8.4)
 *
 * Surfaces cyclomatic and cognitive complexity deltas between base and head
 * FileComplexity snapshots (from `@lazy-flow/code-analysis` `analyzeComplexity`).
 *
 * STORE-VS-FIXTURE BOUNDARY:
 *   `base` and `head` FileComplexity values come from running `analyzeComplexity`
 *   on the base/head source code (tree-sitter AST analysis).
 *   The parser must be initialised (`initParser`) before calling analyzeComplexity.
 *   In tests: inject fixture `FileComplexity` values.
 *   In production: call `analyzeComplexity` on the base/head file source.
 *
 *   This module computes deltas from pre-computed FileComplexity objects,
 *   matching functions by name.  It does NOT call analyzeComplexity itself —
 *   that async step is the caller's responsibility.
 *
 * formulaDoc:
 *   Δcyclomatic_i = head_cyclomatic_i − base_cyclomatic_i per function.
 *   Δcognitive_i  = head_cognitive_i  − base_cognitive_i  per function.
 *   Aggregate: sum of positive deltas (complexity increases only).
 *   Descriptive only — do not rank individuals (SPEC §8.4).
 */

import type { FileComplexity } from '@lazy-flow/code-analysis'
import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { ComplexitySnapshot } from './types.js'

export interface ComplexityDeltaInputs {
  /**
   * Base complexity snapshots (before the change).
   * STORE-VS-FIXTURE: from analyzeComplexity on base file source.
   */
  base: readonly ComplexitySnapshot[]
  /**
   * Head complexity snapshots (after the change).
   */
  head: readonly ComplexitySnapshot[]
}

export interface PerFunctionDelta {
  name: string
  startLine: number
  baseCyclomatic: number | null
  headCyclomatic: number
  baseCognitive: number | null
  headCognitive: number
  cyclomaticDelta: number
  cognitiveDelta: number
}

export interface PerFileDelta {
  path: string
  totalCyclomaticDelta: number
  totalCognitiveDelta: number
  functions: readonly PerFunctionDelta[]
}

export interface ComplexityDeltaResult extends MetricResult {
  /** Per-file complexity deltas. */
  readonly fileDeltae: readonly PerFileDelta[]
  /** Sum of all positive cyclomatic delta (increases only). */
  readonly totalCyclomaticIncrease: number
  /** Sum of all positive cognitive delta (increases only). */
  readonly totalCognitiveIncrease: number
  /** Number of functions that saw a complexity increase. */
  readonly functionsIncreased: number
  /** Number of functions that saw a complexity decrease. */
  readonly functionsDecreased: number
}

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

function computeFileDelta(
  path: string,
  base: FileComplexity | null,
  head: FileComplexity,
): PerFileDelta {
  const baseLookup = new Map<string, { cyclomatic: number; cognitive: number }>()
  if (base) {
    for (const fn of base.functions) {
      baseLookup.set(fn.name, { cyclomatic: fn.cyclomatic, cognitive: fn.cognitive })
    }
  }

  const functions: PerFunctionDelta[] = head.functions.map((hf) => {
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

export const complexityDelta: MetricModule<ComplexityDeltaInputs, ComplexityDeltaResult> = {
  id: 'code.complexity_delta',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): ComplexityDeltaResult {
    const fileDeltae: PerFileDelta[] = []
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
