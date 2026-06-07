/**
 * Code metrics — Group D (SPEC §8.4)
 *
 * Descriptive-only — flag, never rank individuals.
 */

export type {
  CodeChangeImpactInputs,
  CodeChangeImpactResult,
  ImpactFactors,
} from './codeChangeImpact.js'
export { codeChangeImpact } from './codeChangeImpact.js'
export type {
  ComplexityDeltaInputs,
  ComplexityDeltaResult,
  PerFileDelta,
  PerFunctionDelta,
} from './complexityDelta.js'
export { complexityDelta } from './complexityDelta.js'
export type {
  HalocAggregateInputs,
  HalocAggregateResult,
  PerChangeHaloc,
} from './halocAggregate.js'
export { halocAggregate } from './halocAggregate.js'
export type {
  MaintainabilityIndexInputs,
  MaintainabilityIndexResult,
} from './maintainabilityIndex.js'
export { maintainabilityIndex } from './maintainabilityIndex.js'
export type { NagappanBallInputs, NagappanBallResult } from './nagappanBall.js'
export { nagappanBall } from './nagappanBall.js'
export type { ReworkChurnInputs, ReworkChurnResult } from './reworkChurn.js'
export { reworkChurn } from './reworkChurn.js'

// Types
export type { CodeChangeRecord, ComplexitySnapshot } from './types.js'
