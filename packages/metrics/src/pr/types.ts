/**
 * Shared input types for PR / Review metrics (Group C, SPEC §8.3).
 */

// ---------------------------------------------------------------------------
// PR record with all stage timestamps
// ---------------------------------------------------------------------------

export interface PrInput {
  id: string
  repoId: string
  authorIdentityId: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  /** Earliest commit authored_at in the PR. */
  firstCommitAt: string | null
  createdAt: string
  /** Time the PR was marked ready-for-review (draft→ready). null if was never draft. */
  readyAt: string | null
  firstReviewAt: string | null
  approvedAt: string | null
  mergedAt: string | null
  /** ISO string when the PR was last updated. */
  updatedAt: string
  /** Additions + deletions from the GitHub diff summary (for size fallback). */
  additions: number
  deletions: number
  /** HALOC if available (precomputed from code-analysis). null → fall back to additions+deletions. */
  haloc: number | null
}

// ---------------------------------------------------------------------------
// Review record
// ---------------------------------------------------------------------------

export interface ReviewInput {
  nodeId: string
  prId: string
  reviewerIdentityId: string
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
  submittedAt: string
}

// ---------------------------------------------------------------------------
// Review comment record
// ---------------------------------------------------------------------------

export interface ReviewCommentInput {
  nodeId: string
  prId: string
  authorIdentityId: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Check run record
// ---------------------------------------------------------------------------

export interface CheckRunInput {
  nodeId: string
  repoId: string
  headSha: string
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

// ---------------------------------------------------------------------------
// Deployment record (for deploy phase of cycle time)
// ---------------------------------------------------------------------------

export interface DeployInput {
  id: string
  repoId: string
  sha: string
  environment: string
  status: string
  createdAt: string
  finishedAt: string | null
}

// ---------------------------------------------------------------------------
// PR size bucket (HALOC-based)
// ---------------------------------------------------------------------------

export type PrSizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL'

/**
 * HALOC-based PR size thresholds (SPEC §8.3).
 * XS: 0–10, S: 11–50, M: 51–200, L: 201–500, XL: >500
 */
export function prSizeBucket(haloc: number): PrSizeBucket {
  if (haloc <= 10) return 'XS'
  if (haloc <= 50) return 'S'
  if (haloc <= 200) return 'M'
  if (haloc <= 500) return 'L'
  return 'XL'
}
