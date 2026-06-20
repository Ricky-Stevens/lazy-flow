// HALOC — Hunk-Adjusted Lines of Code (SPEC §1 C2, §8.4)

// Complexity — Cyclomatic + Cognitive via web-tree-sitter (SPEC §8.4, §8.6)

export {
  analyzeComplexity,
  computeComplexityDelta,
  initParser,
  setGrammarDir,
} from './complexity.js'
export { synthesizeUnifiedDiff } from './diff.js'
export { computeHaloc } from './haloc.js'

// Work-type / churn split (SPEC §8.4)

export { classifyWorkType } from './worktype.js'
