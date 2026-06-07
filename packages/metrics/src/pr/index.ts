/**
 * PR / Review metrics — Group C (SPEC §8.3)
 */

export type { CiHealthInputs, CiHealthResult } from './ciHealth.js'
export { ciHealth } from './ciHealth.js'
export type { PhaseQuantiles, PrCycleTimeInputs, PrCycleTimeResult } from './cycleTime.js'
export { prCycleTime } from './cycleTime.js'
export type { PrSizeInputs, PrSizeResult } from './prSize.js'
export { prSize } from './prSize.js'
export type {
  CommentsPerPrResult,
  MergeWithoutReviewResult,
  ReviewCoverageInputs,
  ReviewCoverageResult,
  ReviewerLoadResult,
  ReviewersPerPrResult,
  ReviewIterationsResult,
} from './reviewCoverage.js'
export {
  commentsPerPr,
  giniCoefficient,
  mergeWithoutReviewRate,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
} from './reviewCoverage.js'
export type {
  ReviewLatencyInputs,
  ReviewLatencyResult,
  TimeToFirstReviewInputs,
  TimeToFirstReviewResult,
  TimeToMergeInputs,
  TimeToMergeResult,
} from './reviewLatency.js'
export { reviewLatency, timeToFirstReview, timeToMerge } from './reviewLatency.js'
export type { StalePrInputs, StalePrResult } from './stalePr.js'
export { stalePr } from './stalePr.js'
export type {
  CheckRunInput,
  DeployInput,
  PrInput,
  PrSizeBucket,
  ReviewCommentInput,
  ReviewInput,
} from './types.js'
export { prSizeBucket } from './types.js'
