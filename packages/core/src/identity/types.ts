/**
 * Types for the identity-stitching module (SPEC §6.3 / WP-IDENTITY).
 *
 * CandidateMatch represents a pending human-confirm queue entry where two
 * identities are candidate matches but confidence is below the auto-merge
 * threshold (< 1.0 verified).
 */

export interface CandidateMatch {
  /** Stable primary key for this queue entry. */
  id: string
  identityIdA: string
  identityIdB: string
  /**
   * Reason code driving the match proposal.
   * - 'local_part_name': local-part of email + name similarity (0.8 tier — NEVER auto-merged)
   * - 'fuzzy_name': name-only fuzzy match (0.5 tier — queued)
   */
  reason: 'local_part_name' | 'fuzzy_name'
  /** Confidence score [0, 1]. */
  confidence: number
  /** 'pending' until a human decision; 'confirmed' merges the pair; 'rejected' suppresses. */
  status: 'pending' | 'confirmed' | 'rejected'
  /** ISO timestamp of the decision, null if pending. */
  decidedAt: string | null
  /** Who made the decision (identity id or user handle), null if pending. */
  decidedBy: string | null
  createdAt: string
  updatedAt: string
}
