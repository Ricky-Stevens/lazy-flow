/**
 * @lazy-flow/survey — open, published-formula perceptual survey module.
 *
 * SPEC §2.2 N4 / SPEC D6 / RESEARCH.md Group G:
 *   Perceptual metrics (DevEx Feedback Loops, Cognitive Load, Flow State;
 *   SPACE Satisfaction & Well-being) are SURVEY-SOURCED ONLY. This module
 *   is the SOLE permitted source for any perceptual dimension score.
 *   No function in this package produces a perceptual score from system or
 *   workflow data.
 */

// Instrument definitions
export type { LikertItem, SurveyDimension, SurveyInstrument } from './instruments.js'
export {
  ALL_INSTRUMENTS,
  DEVEX_COGNITIVE_LOAD,
  DEVEX_FEEDBACK_LOOPS,
  DEVEX_FLOW_STATE,
  getInstrument,
  SPACE_SATISFACTION,
} from './instruments.js'

// Migration SQL constants (for integration with the core migration runner)
export { MIGRATION_0003_DOWN, MIGRATION_0003_UP } from './migration.js'

// Scoring — open, published-formula aggregation
export {
  assertSurveySourced,
  computeComposite,
  computeTeamAggregate,
  MIN_RESPONSES_PER_DIMENSION,
  percentile,
  respondentMeanForDimension,
  scoreDimension,
} from './scoring.js'

// Storage
export type { SurveyStore } from './store.js'
export { applyMigration, NodeSqliteSurveyStore } from './store.js'

// Domain types
export type {
  CompositeScore,
  DimensionScore,
  SurveyResponse,
  TeamSurveyAggregate,
} from './types.js'
