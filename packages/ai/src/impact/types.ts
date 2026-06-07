/**
 * Explainable Code-Change Impact types — SPEC §9.2.7, WP-AI-IMPACT
 *
 * The deterministic score comes from @lazy-flow/metrics codeChangeImpact.
 * The LLM adds an explanation that references actual changed paths/symbols.
 */

import * as z from 'zod/v4'

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

export const ImpactRationaleOutput = z.object({
  /**
   * Human-readable rationale referencing actual changed paths.
   * Example: "touched auth middleware + a migration; high blast radius"
   * The LLM must cite the specific paths, NOT invent impact magnitude.
   */
  rationale: z.string(),
})
export type ImpactRationaleOutput = z.infer<typeof ImpactRationaleOutput>

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface ImpactResult {
  /**
   * Deterministic impact score in [0, 1] from the metrics blend.
   * The LLM does NOT alter this value.
   */
  impactScore: number
  /**
   * Per-factor breakdown (editDiversity, halocNorm, fileCountNorm, changeEntropy, oldCodePct).
   * Visible for transparency (SPEC §9.2.7).
   */
  factors: Record<string, number>
  /**
   * Factor weights used in the blend.
   * Configurable via weightOverrides.
   */
  weights: Record<string, number>
  /**
   * LLM-generated rationale referencing the actual changed paths/symbols.
   * Null if the LLM call failed or was not made.
   */
  rationale: string | null
}
