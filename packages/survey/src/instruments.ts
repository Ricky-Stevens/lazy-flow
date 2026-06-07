/**
 * Survey instrument definitions for lazy-flow perceptual metrics.
 *
 * SPEC §2.2 N4 / RESEARCH.md Group G / SPEC D6:
 *   Perceptual metrics (satisfaction, perceived ease/flow, feedback-loop
 *   friction, cognitive load, etc.) are SURVEY-SOURCED ONLY. These
 *   instruments are the SOLE permitted source for any perceptual dimension
 *   score. No system-derived "DXI" or equivalent is produced by this module.
 *
 * Framework coverage:
 *   - DevEx (Noda, Storey, Forsgren, Greiler — ACM Queue 2023): three
 *     dimensions — Feedback Loops, Cognitive Load, Flow State.
 *   - SPACE (Forsgren et al. — ACM Queue 2021): Satisfaction & Well-being.
 *   - Both frameworks mandate perceptual + workflow dual measurement; this
 *     module supplies the perceptual half.
 *
 * Versioning: each instrument carries a semver-style `version` string.
 * A response row records the instrument version so formula changes can be
 * tracked over time and old responses are never re-scored with a new formula.
 *
 * Wording principle: questions are phrased to capture the respondent's
 * *perception*, not their count of system events. All items use a 5-point
 * Likert scale (1 = Strongly Disagree … 5 = Strongly Agree) unless noted.
 * Score direction is documented per question (higher = better unless stated).
 */

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

/** A single 1-5 Likert scale item. */
export interface LikertItem {
  /** Stable question id (snake_case within the instrument). */
  readonly id: string
  /** The question wording shown to the respondent. */
  readonly wording: string
  /**
   * Scale anchors for UI rendering.
   * Default: 1 = "Strongly disagree", 5 = "Strongly agree".
   */
  readonly anchors: readonly [string, string, string, string, string]
  /**
   * True if a higher score means WORSE experience (must be reversed before
   * aggregation). Currently unused in v1 instruments (all items are
   * positive-direction), but kept for completeness.
   */
  readonly reversed: boolean
  /**
   * The DevEx / SPACE dimension this item primarily measures.
   * Used for sub-dimension breakouts.
   */
  readonly dimension: SurveyDimension
}

/**
 * The perceptual dimensions measured by this module.
 * Named after the DevEx / SPACE frameworks.
 *
 * "devex_feedback_loops"  — DevEx: speed + quality of feedback on actions
 * "devex_cognitive_load"  — DevEx: mental effort required to complete tasks
 * "devex_flow_state"      — DevEx: uninterrupted, immersive focus time
 * "space_satisfaction"    — SPACE: overall developer satisfaction & well-being
 */
export type SurveyDimension =
  | 'devex_feedback_loops'
  | 'devex_cognitive_load'
  | 'devex_flow_state'
  | 'space_satisfaction'

/**
 * A versioned survey instrument — a named collection of Likert items that
 * together measure one or more perceptual dimensions.
 */
export interface SurveyInstrument {
  /** Stable instrument id (kebab-case). */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /**
   * Semver-style version string. A survey_response row records this version
   * so changes to wording or items can be tracked over time.
   */
  readonly version: string
  readonly items: readonly LikertItem[]
  /**
   * Published description of what this instrument measures and where the
   * item wording originates from.
   */
  readonly description: string
}

// ---------------------------------------------------------------------------
// Shared scale anchors
// ---------------------------------------------------------------------------

const AGREE_ANCHORS = [
  'Strongly disagree',
  'Disagree',
  'Neither agree nor disagree',
  'Agree',
  'Strongly agree',
] as const satisfies readonly [string, string, string, string, string]

// ---------------------------------------------------------------------------
// Instrument: DevEx — Feedback Loops
// ---------------------------------------------------------------------------

/**
 * DevEx Feedback Loops instrument (v1.0.0).
 *
 * Source: Noda, Storey, Forsgren, Greiler — "DevEx: What Actually Drives
 * Productivity" (ACM Queue Vol 21 No 2, 2023 / CACM 2023). The Feedback Loops
 * dimension covers the speed and quality of responses a developer receives
 * to their actions — CI results, code review turnaround, deployment
 * verification, tool responsiveness.
 *
 * All items: 5-point Likert, higher = better (positive direction).
 */
export const DEVEX_FEEDBACK_LOOPS: SurveyInstrument = {
  id: 'devex-feedback-loops',
  name: 'DevEx — Feedback Loops',
  version: '1.0.0',
  description:
    'Measures the perceived speed and quality of feedback a developer receives ' +
    'on their actions (CI, code review, deployment). Based on the Feedback Loops ' +
    'dimension of the DevEx framework (Noda et al., ACM Queue 2023). ' +
    'Higher scores = faster / higher-quality perceived feedback loops.',
  items: [
    {
      id: 'fl_ci_speed',
      wording: 'I receive CI / build results quickly enough to stay focused on my work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_feedback_loops',
    },
    {
      id: 'fl_review_turnaround',
      wording: 'Pull request reviews are returned to me in a reasonable timeframe.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_feedback_loops',
    },
    {
      id: 'fl_deploy_confidence',
      wording:
        'After deploying a change, I quickly learn whether it is working correctly in production.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_feedback_loops',
    },
    {
      id: 'fl_tool_responsiveness',
      wording:
        'The tools and systems I use (IDE, test runner, build system) respond quickly enough ' +
        'to keep me in a productive flow.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_feedback_loops',
    },
    {
      id: 'fl_overall',
      wording: 'Overall, I am satisfied with the speed of feedback I receive when I make changes.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_feedback_loops',
    },
  ],
}

// ---------------------------------------------------------------------------
// Instrument: DevEx — Cognitive Load
// ---------------------------------------------------------------------------

/**
 * DevEx Cognitive Load instrument (v1.0.0).
 *
 * Source: Noda et al. (ACM Queue 2023). Cognitive Load covers the mental
 * effort required to understand the codebase, navigate tooling, and complete
 * tasks — documentation clarity, codebase complexity, onboarding friction.
 *
 * All items: 5-point Likert, higher = better (positive direction).
 */
export const DEVEX_COGNITIVE_LOAD: SurveyInstrument = {
  id: 'devex-cognitive-load',
  name: 'DevEx — Cognitive Load',
  version: '1.0.0',
  description:
    'Measures the perceived mental effort required to complete development tasks. ' +
    'Based on the Cognitive Load dimension of the DevEx framework (Noda et al., ACM Queue 2023). ' +
    'Higher scores = lower perceived cognitive load (easier to understand & navigate).',
  items: [
    {
      id: 'cl_codebase_understandable',
      wording:
        'I can understand the areas of the codebase I work in without excessive mental effort.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_cognitive_load',
    },
    {
      id: 'cl_docs_findable',
      wording: 'Documentation and context I need to do my work are easy to find.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_cognitive_load',
    },
    {
      id: 'cl_tooling_simple',
      wording:
        'The tooling and processes I must follow do not add unnecessary complexity to my work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_cognitive_load',
    },
    {
      id: 'cl_change_confidence',
      wording: 'I feel confident making changes without worrying about unexpected side-effects.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_cognitive_load',
    },
    {
      id: 'cl_overall',
      wording:
        'Overall, I can focus on solving the problem at hand rather than fighting the codebase or tooling.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_cognitive_load',
    },
  ],
}

// ---------------------------------------------------------------------------
// Instrument: DevEx — Flow State
// ---------------------------------------------------------------------------

/**
 * DevEx Flow State instrument (v1.0.0).
 *
 * Source: Noda et al. (ACM Queue 2023). Flow State covers the ability to
 * experience uninterrupted, immersive focus — deep work time, freedom from
 * context-switching, and perceived sense of momentum.
 *
 * All items: 5-point Likert, higher = better (positive direction).
 */
export const DEVEX_FLOW_STATE: SurveyInstrument = {
  id: 'devex-flow-state',
  name: 'DevEx — Flow State',
  version: '1.0.0',
  description:
    'Measures the perceived ability to achieve uninterrupted, immersive focus. ' +
    'Based on the Flow State dimension of the DevEx framework (Noda et al., ACM Queue 2023). ' +
    'Higher scores = more frequent and sustained flow state.',
  items: [
    {
      id: 'fs_deep_work',
      wording: 'I regularly have stretches of uninterrupted time to focus deeply on my work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_flow_state',
    },
    {
      id: 'fs_interruption_low',
      wording:
        'Interruptions (meetings, review requests, Slack messages) do not frequently ' +
        'break my concentration during focused work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_flow_state',
    },
    {
      id: 'fs_context_switch_low',
      wording: 'I rarely need to switch between multiple unrelated tasks on the same day.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_flow_state',
    },
    {
      id: 'fs_momentum',
      wording: 'I frequently experience a sense of momentum and engagement while coding.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_flow_state',
    },
    {
      id: 'fs_overall',
      wording: 'Overall, the way my team works supports my ability to focus and get into flow.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'devex_flow_state',
    },
  ],
}

// ---------------------------------------------------------------------------
// Instrument: SPACE — Satisfaction & Well-being
// ---------------------------------------------------------------------------

/**
 * SPACE Satisfaction & Well-being instrument (v1.0.0).
 *
 * Source: Forsgren, Storey, Maddila, Zimmermann, Houck, Butler —
 * "The SPACE of Developer Productivity" (ACM Queue 2021 / CACM 2021).
 * The Satisfaction dimension covers how fulfilled and engaged developers feel,
 * including eNPS, perceived rate of delivery, and well-being signals.
 *
 * All items: 5-point Likert, higher = better (positive direction),
 * except eNPS which is a standalone 0-10 scale.
 */
export const SPACE_SATISFACTION: SurveyInstrument = {
  id: 'space-satisfaction',
  name: 'SPACE — Satisfaction & Well-being',
  version: '1.0.0',
  description:
    'Measures developer satisfaction, sense of effectiveness, and well-being. ' +
    'Based on the Satisfaction dimension of the SPACE framework (Forsgren et al., ' +
    'ACM Queue 2021). Higher scores = higher satisfaction and well-being.',
  items: [
    {
      id: 'sw_job_satisfaction',
      wording: 'I find my work as a software developer meaningful and satisfying.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'space_satisfaction',
    },
    {
      id: 'sw_delivery_rate',
      wording: 'I feel I am able to deliver value to users at a pace I am proud of.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'space_satisfaction',
    },
    {
      id: 'sw_team_support',
      wording: 'My team and organisation provide the support and resources I need to do good work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'space_satisfaction',
    },
    {
      id: 'sw_burnout_low',
      wording: 'I do not feel burnt out or exhausted by my work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'space_satisfaction',
    },
    {
      id: 'sw_recommend',
      wording:
        'I would recommend this team / organisation as a great place for developers to work.',
      anchors: AGREE_ANCHORS,
      reversed: false,
      dimension: 'space_satisfaction',
    },
  ],
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All built-in survey instruments. */
export const ALL_INSTRUMENTS: readonly SurveyInstrument[] = [
  DEVEX_FEEDBACK_LOOPS,
  DEVEX_COGNITIVE_LOAD,
  DEVEX_FLOW_STATE,
  SPACE_SATISFACTION,
]

/** Look up an instrument by id. */
export function getInstrument(id: string): SurveyInstrument | null {
  return ALL_INSTRUMENTS.find((i) => i.id === id) ?? null
}
