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

export {
  estimationAccuracy,
  isSpearmanSignificant,
  sayDo,
  sprintPredictability,
  sprintVelocity,
  tiedSpearman,
} from './agile/index.js'
// Anti-gaming — data-quality detectors + Goodhart warning (WP-ANTIGAMING, SPEC §10)

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

export {
  codeChangeImpact,
  complexityDelta,
  halocAggregate,
  maintainabilityIndex,
  nagappanBall,
  reworkChurn,
} from './code/index.js'
// Compute — real metric computation over the SQLite store (WP-COMPUTE)

export {
  backfillSnapshots,
  COMPUTE_METRIC_IDS,
  computeMetric,
  computePersonReportLive,
} from './compute/index.js'
// Group A — DORA

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

export {
  guardMixedVersionSeries,
  MixedEngineVersionError,
  markStaleAndRederive,
  rederiveStaleEngineSnapshots,
  rederiveStaleSnapshots,
} from './rederive/index.js'
// Rollup — team → org aggregate distributions (WP-ROLLUP)

export {
  buildTeamEntriesFromSnapshots,
  computeOrgRollup,
  computeRollupDistribution,
} from './rollup/index.js'
// Snapshots — versioned daily metric_snapshots writer (WP-SNAPSHOTS)

export {
  buildCoverageFingerprint,
  computeSnapshotDay,
  computeSnapshotRange,
  DEFAULT_GRACE_PERIOD_MS,
  enumerateDays,
  isWindowClosed,
} from './snapshots/index.js'
// Shared

// Visibility — presentation policy switch (WP-VISIBILITY, SPEC §11.1)

export {
  applyVisibilityFilter,
  assertNotRankingList,
  shouldPersistPersonSnapshot,
  VISIBILITY_POLICY_NOTE,
} from './visibility/index.js'
