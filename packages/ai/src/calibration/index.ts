/**
 * @lazy-flow/ai — calibration module public API (WP-AI-CALIBRATION, SPEC §9.3)
 */

// Gold-set ingestion
export {
  canonicalLabels,
  correctionsToGoldItems,
  extractCorrections,
  extractHumanPairs,
  extractPredictedLabel,
  extractPredictedRank,
  groupByMetric,
  loadCorrectedVerdicts,
  mergeGoldSets,
} from './goldSet.js'
// Metrics (pure functions)
export { cohenKappa, computeEce, macroF1, spearmanRho } from './metrics.js'
// Types
export type { BuildCalibrationReportOptions } from './report.js'
// Report builder + gate
export { buildCalibrationReport, confidenceIsCalibrated } from './report.js'
export type {
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
} from './types.js'
