/**
 * packages/core/src/flowstate — Flow State Model engine.
 *
 * Three modules, each independently importable:
 *
 *   seed     — deterministic heuristic seeding (category + name patterns +
 *              board-column cross-check). Wave 3.5 / WP-FLOWSTATE-MODEL.
 *   confirm  — human-confirm queue: list low-confidence mappings, confirm or
 *              override via effective-dated supersession.
 *   fallback — guarantee a non-empty mapping for any workflow, so Flow metrics
 *              never read an empty table.
 *
 * SPEC §1 C3, §6.2, §8.2, WP-FLOWSTATE-MODEL.
 */

export type {
  ConfirmFlowStateOptions,
  OverrideFlowStateOptions,
  PendingConfirmation,
} from './confirm.js'
// confirm
export {
  confirmFlowState,
  HIGH_CONFIDENCE_THRESHOLD,
  listPendingConfirmations,
  overrideFlowState,
} from './confirm.js'
// fallback
export type {
  EnsureFallbackMappingOptions,
  EnsureFallbackMappingResult,
} from './fallback.js'
export { ensureFallbackMapping } from './fallback.js'
// seed
export type {
  BoardColumnInput,
  ClassifyResult,
  SeedFlowStateModelOptions,
  SeedFlowStateModelResult,
  StatusInput,
} from './seed.js'
export {
  applyBoardColumnAdjustment,
  classifyStatus,
  seedFlowStateModel,
} from './seed.js'
