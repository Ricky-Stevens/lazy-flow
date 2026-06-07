/**
 * @lazy-flow/metrics — deterministic metric engine
 *
 * Groups implemented:
 *   A — DORA / Delivery (dora/)
 *   C — PR / Review     (pr/)
 *   E — Agile / Jira    (agile/)
 *
 * Groups B (Flow) and D (Code) are added by a subsequent agent.
 */

// Group E — Agile / Jira
export type {
  EstimationAccuracyInputs,
  EstimationAccuracyResult,
  EstimationPair,
  IssueRecord,
  PredictabilityInputs,
  PredictabilityResult,
  PredictabilitySprintRecord,
  SayDoInputs,
  SayDoResult,
  SprintMembershipEventRecord,
  SprintRecord,
  SprintVelocityInputs,
  SprintVelocityResult,
} from './agile/index.js'
export {
  estimationAccuracy,
  isSpearmanSignificant,
  sayDo,
  sprintPredictability,
  sprintVelocity,
  tiedSpearman,
} from './agile/index.js'
// Anti-gaming — data-quality detectors + Goodhart warning (WP-ANTIGAMING, SPEC §10)
export type {
  CfrSuppressionInput,
  DeployInflationInput,
  GamingDetectionResult,
  GamingFlag,
  GoodhartWarning,
  LeadTimeResetInput,
  StatusJugglingInput,
  TrivialPrSplittingInput,
} from './antigaming/index.js'
export {
  assertNoCompositeProductivityNumber,
  detectCfrSuppression,
  detectDeployInflation,
  detectLeadTimeReset,
  detectStatusJuggling,
  detectTrivialPrSplitting,
  GOODHART_SENSITIVE_METRICS,
  goodhartWarning,
} from './antigaming/index.js'
// Group D — Code
export type {
  CodeChangeImpactInputs,
  CodeChangeImpactResult,
  CodeChangeRecord,
  ComplexityDeltaInputs,
  ComplexityDeltaResult,
  ComplexitySnapshot,
  HalocAggregateInputs,
  HalocAggregateResult,
  ImpactFactors,
  MaintainabilityIndexInputs,
  MaintainabilityIndexResult,
  NagappanBallInputs,
  NagappanBallResult,
  PerChangeHaloc,
  PerFileDelta,
  PerFunctionDelta,
  ReworkChurnInputs,
  ReworkChurnResult,
} from './code/index.js'
export {
  codeChangeImpact,
  complexityDelta,
  halocAggregate,
  maintainabilityIndex,
  nagappanBall,
  reworkChurn,
} from './code/index.js'
// Group A — DORA
export type {
  ChangeFailureRateInputs,
  ChangeFailureRateResult,
  CommitRecord,
  DeployIncidentLink,
  DeploymentFrequencyInputs,
  DeploymentFrequencyResult,
  DeploymentReworkRateInputs,
  DeploymentReworkRateResult,
  DeployRecord,
  DoraBand,
  IncidentRecord,
  LeadTimeInputs,
  LeadTimeResult,
  PrRecord,
  RecoveryTimeInputs,
  RecoveryTimeResult,
  ReliabilityProxyInputs,
  ReliabilityProxyResult,
  ReopenRateInputs,
  ReopenRateResult,
} from './dora/index.js'
export {
  changeFailureRate,
  deploymentFrequency,
  deploymentReworkRate,
  doraBandFromRate,
  incidentReopenRate,
  leadTime,
  recoveryTime,
  reliabilityProxy,
} from './dora/index.js'
// Group B — Flow
export type {
  AgingWipInputs,
  AgingWipItem,
  AgingWipResult,
  CfdDayEntry,
  CfdInputs,
  CfdResult,
  CycleTimeInputs,
  CycleTimeResult,
  FlowBoardColumn,
  FlowDistributionBucket,
  FlowDistributionInputs,
  FlowDistributionResult,
  FlowEfficiencyInputs,
  FlowEfficiencyResult,
  FlowIssueRecord,
  FlowState,
  FlowWorkType,
  MonteCarloInputs,
  MonteCarloResult,
  PerIssueCycleTime,
  PerIssueEfficiency,
  ThroughputInputs,
  ThroughputResult,
  TimeInStatusInputs,
  TimeInStatusPerIssue,
  TimeInStatusResult,
  TransitionRecord,
  WipLoadInputs,
  WipLoadResult,
} from './flow/index.js'
export {
  agingWip,
  cfd,
  classifyIssueType,
  computePerIssueCycleTime,
  computePerIssueEfficiency,
  cycleTime,
  flowDistribution,
  flowEfficiency,
  monteCarlo,
  throughput,
  timeInStatus,
  wipLoad,
} from './flow/index.js'
// Group C — PR / Review
export type {
  CheckRunInput,
  CiHealthInputs,
  CiHealthResult,
  CommentsPerPrResult,
  DeployInput,
  MergeWithoutReviewResult,
  PhaseQuantiles,
  PrCycleTimeInputs,
  PrCycleTimeResult,
  PrInput,
  PrSizeBucket,
  PrSizeInputs,
  PrSizeResult,
  ReviewCommentInput,
  ReviewCoverageInputs,
  ReviewCoverageResult,
  ReviewerLoadResult,
  ReviewersPerPrResult,
  ReviewInput,
  ReviewIterationsResult,
  ReviewLatencyInputs,
  ReviewLatencyResult,
  StalePrInputs,
  StalePrResult,
  TimeToFirstReviewInputs,
  TimeToFirstReviewResult,
  TimeToMergeInputs,
  TimeToMergeResult,
} from './pr/index.js'
export {
  ciHealth,
  commentsPerPr,
  giniCoefficient,
  mergeWithoutReviewRate,
  prCycleTime,
  prSize,
  prSizeBucket,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
  reviewLatency,
  stalePr,
  timeToFirstReview,
  timeToMerge,
} from './pr/index.js'
// Rederive — engine-version re-derivation + mixed-version guard (WP-REDERIVE)
export type {
  GuardMixedVersionsOptions,
  RederiveOptions,
  RederiveResult,
} from './rederive/index.js'
export {
  guardMixedVersionSeries,
  MixedEngineVersionError,
  markStaleAndRederive,
  rederiveStaleSnapshots,
} from './rederive/index.js'
// Rollup — team → org aggregate distributions (WP-ROLLUP)
export type {
  OrgRollupOptions,
  OrgRollupResult,
  RollupDistribution,
  TeamRollupEntry,
} from './rollup/index.js'
export {
  buildTeamEntriesFromSnapshots,
  computeOrgRollup,
  computeRollupDistribution,
} from './rollup/index.js'
// Snapshots — versioned daily metric_snapshots writer (WP-SNAPSHOTS)
export type { ComputeDayFn, SnapshotWriteResult, SnapshotWriterOptions } from './snapshots/index.js'
export {
  buildCoverageFingerprint,
  computeSnapshotDay,
  computeSnapshotRange,
  DEFAULT_GRACE_PERIOD_MS,
  enumerateDays,
  isWindowClosed,
} from './snapshots/index.js'
// Shared
export type { MetricModule, MetricResult } from './types.js'
// Visibility — presentation policy switch (WP-VISIBILITY, SPEC §11.1)
export type { Visibility, VisibilityFilterResult } from './visibility/index.js'
export {
  applyVisibilityFilter,
  assertNotRankingList,
  shouldPersistPersonSnapshot,
  VISIBILITY_POLICY_NOTE,
} from './visibility/index.js'
