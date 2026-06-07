/**
 * @lazy-flow/ai — public API
 *
 * Exports the AI harness (WP-AI-HARNESS):
 *   - LlmClient interface + AnthropicLlmClient + FakeLlmClient
 *   - requestShape adapter
 *   - Prompt registry
 *   - VerdictCache
 *   - runVerdict / correctVerdict harness
 *   - Model constants
 */

// ─── Alignment (WP-AI-ALIGNMENT, SPEC §9.2.1) ────────────────────────────────
export type {
  AcceptanceCriterion,
  AlignmentFeaturePack,
  AlignmentOrdinal,
  AlignmentResult,
  CoverageStatus,
  CriterionCoverage,
  DiffHunk,
  RunAlignmentOptions,
} from './alignment/index.js'
export {
  ALIGNMENT_PROMPT_VERSION,
  ALIGNMENT_SYSTEM_PROMPT,
  AlignmentLlmOutput,
  alignmentOutputSchema,
  applyEvidenceGuard,
  applyMinRule,
  buildAlignmentFeaturePack,
  buildAlignmentUserMessage,
  CoverageStatusEnum,
  computeCoverageRatio,
  coverageRatioToOrdinal,
  parseAcceptanceCriteria,
  RELEVANCE_THRESHOLD,
  rankDiffHunks,
  runAlignment,
  scoreHunkRelevance,
} from './alignment/index.js'
// ─── Velocity Anomaly Explanation (WP-AI-ANOMALY, SPEC §9.2.3) ───────────────
export type {
  AnomalyDetectionResult,
  AnomalyResult,
  AnomalySignalPack,
  CycleTimePoint,
  RunAnomalyOptions,
  ThroughputPoint,
} from './anomaly/index.js'
export {
  ANOMALY_PROMPT_VERSION,
  ANOMALY_SYSTEM_PROMPT,
  AnomalyCause,
  AnomalyLlmOutput,
  anomalyOutputSchema,
  buildAnomalyUserMessage,
  computeEwmaZScore,
  detectAnomaly,
  MIN_SAMPLE_SIZE,
  RankedCause,
  runAnomaly,
} from './anomaly/index.js'
// ─── Calibration harness (WP-AI-CALIBRATION, SPEC §9.3) ──────────────────────
export type {
  BuildCalibrationReportOptions,
  CalibrationReport,
  ClassMetrics,
  CorrectionRecord,
  EceResult,
  GoldItem,
  InsightCalibration,
  KappaResult,
  MacroF1Result,
  ReliabilityBin,
  SpearmanResult,
} from './calibration/index.js'
export {
  buildCalibrationReport,
  canonicalLabels,
  cohenKappa,
  computeEce,
  confidenceIsCalibrated,
  correctionsToGoldItems,
  extractCorrections,
  extractHumanPairs,
  extractPredictedLabel,
  extractPredictedRank,
  groupByMetric,
  loadCorrectedVerdicts,
  macroF1,
  mergeGoldSets,
  spearmanRho,
} from './calibration/index.js'
// ─── Work-type Classification (WP-AI-CLASSIFY, SPEC §9.2.5) ──────────────────
export type { ClassifyResult, PriorSource, RunClassifyOptions, WorkType } from './classify/index.js'
export {
  applyDeterministicPrior,
  buildClassifyUserMessage,
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
  ClassifyLlmOutput,
  classifyByConventionalCommit,
  classifyByPathPatterns,
  PriorSourceEnum,
  registerCalibrationHook,
  runClassify,
  WorkTypeEnum,
} from './classify/index.js'
export type { AnthropicLlmClientOptions } from './client/AnthropicLlmClient.js'
export { AnthropicLlmClient } from './client/AnthropicLlmClient.js'
export type { FakeResponse } from './client/FakeLlmClient.js'
export { FakeLlmClient } from './client/FakeLlmClient.js'
// Client interface + implementations
export type { LlmClient, LlmParseRequest, LlmParseResult } from './client/LlmClient.js'
// Constants
export { DEFAULT_MODEL, ENSEMBLE_MODEL } from './constants.js'
// ─── Effort Proportionality (WP-AI-EFFORT, SPEC §9.2.2) ──────────────────────
export type {
  EffortBand,
  EffortDistribution,
  EffortResult,
  EffortVector,
  InsufficientHistory,
  RunEffortOptions,
} from './effort/index.js'
export {
  adjustConfidenceForDisagreement,
  buildEffortUserMessage,
  computeCycleTimeZScore,
  computeLogRatio,
  detectDisagreement,
  EFFORT_MIN_HISTORY_N,
  EFFORT_PROMPT_VERSION,
  EFFORT_SYSTEM_PROMPT,
  EffortBandEnum,
  EffortLlmOutput,
  EXEMPT_ISSUE_TYPES,
  INSUFFICIENT_HISTORY,
  logRatioToEffortBand,
  runEffort,
  zScoreToEffortBand,
} from './effort/index.js'
export type { RunVerdictOptions, RunVerdictResult } from './harness.js'
// Harness
export { correctVerdict, runVerdict } from './harness.js'
// ─── Explainable Code-Change Impact (WP-AI-IMPACT, SPEC §9.2.7) ──────────────
export type { ImpactResult, RunImpactOptions } from './impact/index.js'
export {
  buildImpactUserMessage,
  IMPACT_PROMPT_VERSION,
  IMPACT_SYSTEM_PROMPT,
  ImpactRationaleOutput,
  impactOutputSchema,
  runImpact,
} from './impact/index.js'
export type { PromptEntry } from './prompts/registry.js'
// Prompt registry
export { getPrompt, listPrompts, registerPrompt } from './prompts/registry.js'
// ─── PR Quality Score (WP-AI-PRQUALITY, SPEC §9.2.6) ─────────────────────────
export type {
  DeterministicChecks,
  PrQualityResult,
  RunPrQualityOptions,
} from './prquality/index.js'
export {
  ATOMICITY_MAX_FILES,
  ATOMICITY_MAX_HALOC,
  boolToScore,
  buildPrQualityUserMessage,
  DimensionScore,
  LlmDimension,
  PRQUALITY_PROMPT_VERSION,
  PRQUALITY_SYSTEM_PROMPT,
  PrQualityLlmOutput,
  prQualityOutputSchema,
  runDeterministicChecks,
  runPrQuality,
} from './prquality/index.js'
export type { RequestShape, RequestShapeOptions } from './requestShape.js'
// Request-shape adapter
export { requestShape } from './requestShape.js'
export type { CacheKey } from './verdictCache.js'
// Verdict cache
export { VerdictCache } from './verdictCache.js'
