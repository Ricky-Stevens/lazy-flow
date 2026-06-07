/**
 * PR Quality Score types — SPEC §9.2.6, WP-AI-PRQUALITY
 *
 * Every bounded value is a zod enum (§9.1.4).
 * Rubric is about substance, not eloquence — no Anglophone-prose bias.
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// 0–2 score enum per dimension
// ---------------------------------------------------------------------------

/**
 * 0 = absent / missing,
 * 1 = partial / present but incomplete,
 * 2 = clear and substantive
 */
export const DimensionScore = z.enum(['0', '1', '2'])
export type DimensionScore = z.infer<typeof DimensionScore>

// ---------------------------------------------------------------------------
// Deterministic checks (no LLM needed)
// ---------------------------------------------------------------------------

export interface DeterministicChecks {
  /** PR body is non-empty and longer than 10 characters. */
  has_description: boolean
  /** PR body or title references an issue key (e.g. PROJ-123 or #123). */
  linked_issue: boolean
  /** Files changed include a test file pattern (*.test.*, *.spec.*, *_test.*). */
  has_tests: boolean
  /**
   * Atomicity proxy: PR changes ≤ 10 files and ≤ 400 HALOC.
   * Large values indicate potential scope-creep.
   */
  is_atomic: boolean
}

// ---------------------------------------------------------------------------
// LLM dimension output (0–2 enum + quoted evidence)
// ---------------------------------------------------------------------------

export const LlmDimension = z.object({
  /** Numeric score 0–2 as enum. */
  score: DimensionScore,
  /**
   * Verbatim quote from the PR body / diff that supports this score.
   * For score=0, this should be a short note explaining what is missing.
   * Must NOT be a paraphrase — substance evidence only.
   */
  evidence: z.string(),
})
export type LlmDimension = z.infer<typeof LlmDimension>

export const PrQualityLlmOutput = z.object({
  /** Does the PR body explain WHY the change is made (not just what)? */
  explains_why: LlmDimension,
  /** Does the body content match the actual diff (no mismatch / stale copy-paste)? */
  matches_diff: LlmDimension,
  /**
   * Risk flags: does the change touch security-sensitive areas, migrations,
   * config changes, API contracts, or other high-blast-radius paths?
   * Score: 0=no risks noted, 1=some risks noted, 2=risks clearly documented with mitigations.
   */
  risk_flags: LlmDimension,
})
export type PrQualityLlmOutput = z.infer<typeof PrQualityLlmOutput>

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface PrQualityResult {
  /** Deterministic dimension scores. */
  deterministic: DeterministicChecks
  /** LLM-scored dimensions with quoted evidence. */
  llm?: PrQualityLlmOutput
  /**
   * Overall quality signal: sum of all dimension scores (max = 10).
   * Deterministic booleans count as 0 or 2; LLM dimensions use their score.
   */
  overallScore: number
}
