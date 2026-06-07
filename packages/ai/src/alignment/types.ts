/**
 * Ticket-Work Alignment types — SPEC §9.2.1, WP-AI-ALIGNMENT
 *
 * Every bounded discrete value is a zod enum (never a numeric range).
 * coverage_ratio is derived in code; final = min(ordinal-band, coverage-ratio band).
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// Enums (§9.1.4 — bounded values must be enum-encoded)
// ---------------------------------------------------------------------------

export const AlignmentOrdinal = z.enum(['0', '1', '2', '3', '4'])
export type AlignmentOrdinal = z.infer<typeof AlignmentOrdinal>

export const CoverageStatus = z.enum(['yes', 'no', 'unclear'])
export type CoverageStatus = z.infer<typeof CoverageStatus>
/** Alias for the CoverageStatus zod schema value (for importing alongside the type). */
export const CoverageStatusEnum = CoverageStatus

// ---------------------------------------------------------------------------
// Feature pack inputs
// ---------------------------------------------------------------------------

/** A relevance-ranked diff hunk with a score in [0, 1]. */
export interface DiffHunk {
  /** File path the hunk comes from. */
  filePath: string
  /** Raw diff text of the hunk. */
  content: string
  /** Relevance score in [0, 1] — computed deterministically (e.g. TF/keyword overlap). */
  relevanceScore: number
}

/** A parsed acceptance criterion from the Jira ticket. */
export interface AcceptanceCriterion {
  /** Stable index / label for the criterion. */
  index: number
  /** The raw criterion text. */
  text: string
}

/** Feature pack for ticket-work alignment. */
export interface AlignmentFeaturePack {
  /** Stable issue key (e.g. "PROJ-123"). */
  issueKey: string
  /** Jira issue type (e.g. "Story", "Bug"). */
  issueType: string
  /** Jira summary line. */
  issueSummary: string
  /** Jira description (raw text). */
  issueDescription: string
  /** Parsed acceptance criteria. */
  criteria: AcceptanceCriterion[]
  /** PR title. */
  prTitle: string
  /** PR body. */
  prBody: string
  /** Commit messages included in the PR. */
  commitMessages: string[]
  /**
   * Relevance-ranked diff hunks (descending by relevanceScore).
   * Never silently truncated — callers must pass the full ranked set.
   */
  diffHunks: DiffHunk[]
}

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

/** Per-criterion coverage result from the LLM (pointwise). */
export const CriterionCoverage = z.object({
  /** Which criterion this covers (by index). */
  index: z.number().int(),
  covered: CoverageStatus,
  /**
   * Quoted diff hunk that supports the claim.
   * Must be non-empty when covered === 'yes'.
   * Empty string / absent is acceptable for 'no' or 'unclear'.
   */
  evidence: z.string(),
})
export type CriterionCoverage = z.infer<typeof CriterionCoverage>

/** Full LLM output schema for alignment. */
export const AlignmentLlmOutput = z.object({
  /** Ordinal band 0–4, enum-encoded per §9.1.4. */
  ordinal: AlignmentOrdinal,
  /** Per-criterion coverage (one entry per criterion). */
  criteria: z.array(CriterionCoverage),
  /**
   * Self-reported model confidence in [0, 1].
   * Used for audit; final score uses coverage_ratio cross-check.
   */
  confidence: z.number(),
})
export type AlignmentLlmOutput = z.infer<typeof AlignmentLlmOutput>

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------

/** Final alignment result after deterministic post-processing. */
export interface AlignmentResult {
  /** Min of ordinal-band and coverage-ratio band (§9.2.1 min-rule). */
  ordinal: AlignmentOrdinal
  /** Raw LLM ordinal before min-rule adjustment. */
  rawOrdinal: AlignmentOrdinal
  /** Per-criterion coverage with evidence-relevance guard applied. */
  criteria: CriterionCoverage[]
  /**
   * Fraction of criteria marked 'yes' after the evidence-relevance guard,
   * computed deterministically in code (never by the LLM).
   */
  coverageRatio: number
  /** Model self-reported confidence (stored in audit; may not be calibrated). */
  confidence: number
}
