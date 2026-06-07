/**
 * @lazy-flow/ai — alignment module public API (SPEC §9.2.1)
 */

export {
  applyEvidenceGuard,
  applyMinRule,
  computeCoverageRatio,
  coverageRatioToOrdinal,
  RELEVANCE_THRESHOLD,
} from './evidenceGuard.js'
export {
  buildAlignmentFeaturePack,
  parseAcceptanceCriteria,
  rankDiffHunks,
  scoreHunkRelevance,
} from './featurePack.js'
export {
  ALIGNMENT_PROMPT_VERSION,
  ALIGNMENT_SYSTEM_PROMPT,
  alignmentOutputSchema,
  buildAlignmentUserMessage,
} from './prompt.js'
export type { RunAlignmentOptions } from './runAlignment.js'
export { runAlignment } from './runAlignment.js'
export type {
  AcceptanceCriterion,
  AlignmentFeaturePack,
  AlignmentOrdinal,
  AlignmentResult,
  CoverageStatus,
  CriterionCoverage,
  DiffHunk,
} from './types.js'
export { AlignmentLlmOutput, CoverageStatusEnum } from './types.js'
