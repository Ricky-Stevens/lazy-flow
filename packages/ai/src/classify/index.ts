/**
 * @lazy-flow/ai — classify module public API (SPEC §9.2.5)
 */

export {
  applyDeterministicPrior,
  classifyByConventionalCommit,
  classifyByPathPatterns,
} from './prior.js'
export {
  buildClassifyUserMessage,
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
} from './prompt.js'
export type { RunClassifyOptions } from './runClassify.js'
export { registerCalibrationHook, runClassify } from './runClassify.js'
export type { ClassifyResult, PriorSource, WorkType } from './types.js'
export {
  ClassifyLlmOutput,
  PriorSource as PriorSourceEnum,
  WorkType as WorkTypeEnum,
} from './types.js'
