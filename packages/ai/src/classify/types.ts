/**
 * Work-type Classification types — SPEC §9.2.5, WP-AI-CLASSIFY
 *
 * Work type for Flow Distribution & investment balance.
 * Every bounded value is a zod enum.
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// Work type enum (§9.1.4)
// ---------------------------------------------------------------------------

export const WorkType = z.enum(['feature', 'bugfix', 'refactor', 'test', 'docs', 'chore'])
export type WorkType = z.infer<typeof WorkType>

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

export const ClassifyLlmOutput = z.object({
  workType: WorkType,
  /** Short reasoning (one sentence, stored in audit). */
  reasoning: z.string(),
  /** Model self-reported confidence in [0, 1]. */
  confidence: z.number(),
})
export type ClassifyLlmOutput = z.infer<typeof ClassifyLlmOutput>

// ---------------------------------------------------------------------------
// Prior source (for transparency / calibration hook)
// ---------------------------------------------------------------------------

export const PriorSource = z.enum(['conventional_commit', 'path_pattern', 'llm', 'blame_fallback'])
export type PriorSource = z.infer<typeof PriorSource>

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  workType: WorkType
  /** How the classification was derived. */
  source: PriorSource
  /** Confidence from model (or 1.0 for deterministic prior). */
  confidence: number
  /**
   * The deterministic prior result before LLM (if applicable).
   * Null when no prior was available.
   */
  priorWorkType: WorkType | null
}
