/**
 * @lazy-flow/ai — anomaly module public API (SPEC §9.2.3)
 */

export { computeEwmaZScore, detectAnomaly, MIN_SAMPLE_SIZE } from './detector.js'
export {
  ANOMALY_PROMPT_VERSION,
  ANOMALY_SYSTEM_PROMPT,
  anomalyOutputSchema,
  buildAnomalyUserMessage,
} from './prompt.js'
export type { RunAnomalyOptions } from './runAnomaly.js'
export { runAnomaly } from './runAnomaly.js'
export type {
  AnomalyDetectionResult,
  AnomalyResult,
  AnomalySignalPack,
  CycleTimePoint,
  ThroughputPoint,
} from './types.js'
export { AnomalyCause, AnomalyLlmOutput, RankedCause } from './types.js'
