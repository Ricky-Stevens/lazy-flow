// HALOC — Hunk-Adjusted Lines of Code (SPEC §1 C2, §8.4)

// Complexity — Cyclomatic + Cognitive via web-tree-sitter (SPEC §8.4, §8.6)
export type {
  ComplexityDelta,
  FileComplexity,
  FileDelta,
  FunctionComplexity,
  SupportedLanguage,
} from './complexity.js'
export {
  analyzeComplexity,
  computeComplexityDelta,
  initParser,
  setGrammarDir,
} from './complexity.js'
export type { FileHalocResult, HalocOptions, HalocResult } from './haloc.js'
export { computeHaloc } from './haloc.js'

// Work-type / churn split (SPEC §8.4)
export type {
  BlameRecord,
  LineWorkType,
  WorkType,
  WorkTypeOptions,
  WorkTypeResult,
} from './worktype.js'
export { classifyWorkType } from './worktype.js'
