/**
 * @lazy-flow/ai — PR quality module public API (SPEC §9.2.6)
 */

export {
  ATOMICITY_MAX_FILES,
  ATOMICITY_MAX_HALOC,
  boolToScore,
  runDeterministicChecks,
} from './checks.js'
export {
  buildPrQualityUserMessage,
  PRQUALITY_PROMPT_VERSION,
  PRQUALITY_SYSTEM_PROMPT,
  prQualityOutputSchema,
} from './prompt.js'
export type { RunPrQualityOptions } from './runPrQuality.js'
export { runPrQuality } from './runPrQuality.js'
export type { DeterministicChecks, PrQualityResult } from './types.js'
export { DimensionScore, LlmDimension, PrQualityLlmOutput } from './types.js'
