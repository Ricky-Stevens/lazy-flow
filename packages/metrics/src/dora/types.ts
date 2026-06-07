/**
 * Shared input types for DORA / Delivery metrics (Group A, SPEC §8.1).
 */

// ---------------------------------------------------------------------------
// Deployment record (minimal projection from Store.Deployment)
// ---------------------------------------------------------------------------

export interface DeployRecord {
  id: string
  repoId: string
  sha: string
  environment: string
  /** 'success' | 'failure' | 'pending' | 'error' */
  status: string
  createdAt: string
  finishedAt: string | null
  source: string
}

// ---------------------------------------------------------------------------
// Incident record — minimal Jira issue projection
// ---------------------------------------------------------------------------

export interface IncidentRecord {
  id: string
  /** Deployment id this incident is linked to (may be null if unlinked). */
  linkedDeployId: string | null
  createdAt: string
  /** ISO string of the first Done transition (null if never resolved). */
  firstResolvedAt: string | null
  /** ISO string of the final Done transition (null if never resolved). */
  finalResolvedAt: string | null
  /** Number of times the issue was reopened after a Done transition. */
  reopenCount: number
}

// ---------------------------------------------------------------------------
// PR record (minimal for lead-time commit-set anchoring)
// ---------------------------------------------------------------------------

export interface PrRecord {
  id: string
  repoId: string
  /** Earliest authored_at of any commit in the PR. */
  firstCommitAt: string | null
  mergedAt: string | null
}

// ---------------------------------------------------------------------------
// Commit record (minimal for lead-time)
// ---------------------------------------------------------------------------

export interface CommitRecord {
  repoId: string
  sha: string
  /** ISO string when the commit was authored. */
  authoredAt: string
}

// ---------------------------------------------------------------------------
// Deploy-incident link
// ---------------------------------------------------------------------------

export interface DeployIncidentLink {
  deployId: string
  incidentIssueId: string
}
