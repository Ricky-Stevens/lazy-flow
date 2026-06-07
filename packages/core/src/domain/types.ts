/**
 * Core domain types for lazy-flow, derived from SPEC §6.1/§6.2.
 * All timestamps are ISO 8601 strings (UTC).
 */

import type { DataQuality } from '../stats/index.js'

// ---------------------------------------------------------------------------
// Shared enums / unions
// ---------------------------------------------------------------------------

/** Trust tier on every metric per SPEC §8.6. */
export type TrustTier = 'deterministic' | 'hybrid' | 'probabilistic'

/** Scope of a metric or snapshot per SPEC §6.2. */
export type MetricScope = 'repo' | 'team' | 'org' | 'person' | 'self'

/** Visibility policy — presentation switch, not a security control (SPEC §11.1). */
export type Visibility = 'public' | 'team' | 'self'

// ---------------------------------------------------------------------------
// Identity & persons (SPEC §6.3)
// ---------------------------------------------------------------------------

/** A canonical human, anchored on a stable account id. */
export interface Person {
  id: string
  displayName: string
  /** Stable reference: GitHub user id, Jira accountId, etc. */
  primaryAccountRef: string
  updatedAt: string
}

/** An identity record linking a platform account to a Person. */
export interface Identity {
  id: string
  personId: string | null
  kind: 'github_login' | 'commit_email' | 'jira_account'
  externalId: string
  /** True for bots (GitHub type==Bot, [bot] suffix, App author, or configurable allowlist). */
  isBot: boolean
  /** Confidence in the person<→identity link [0, 1]. */
  confidence: number
  /** Raw upstream payload. */
  raw: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Repositories & commits
// ---------------------------------------------------------------------------

/** A GitHub repository. */
export interface Repository {
  id: string
  githubNodeId: string
  orgId: string
  owner: string
  name: string
  defaultBranch: string
  isArchived: boolean
  /** Forks are excluded from human-work aggregates by default. */
  isFork: boolean
  /** ISO string; set when the repo is soft-deleted (404 on known node_id). */
  deletedAt: string | null
  raw: string
  createdAt: string
  updatedAt: string
}

/**
 * A commit, keyed on (repo_id, sha) — git SHAs are unique only per repo.
 * A global sha PK would collide across mirrors/forks.
 */
export interface Commit {
  repoId: string
  sha: string
  authorIdentityId: string
  authoredAt: string
  committedAt: string
  additions: number
  deletions: number
  /** HALOC = Σ_hunk max(insertions, deletions) — the canonical change-unit per SPEC C2. */
  haloc: number
  raw: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Pull requests & reviews
// ---------------------------------------------------------------------------

/** A pull request with denormalized stage timestamps for 4-phase cycle time. */
export interface PullRequest {
  id: string
  repoId: string
  number: number
  authorIdentityId: string
  state: 'open' | 'closed' | 'merged'
  headRef: string
  baseRef: string
  isDraft: boolean
  /** True when merged by a merge queue bot; attribute to the approving reviewer. */
  mergedViaQueue: boolean
  createdAt: string
  /** Time the PR was marked ready-for-review (draft→ready transition). */
  readyAt: string | null
  /** Earliest authored_at of any commit included in this PR. */
  firstCommitAt: string | null
  firstReviewAt: string | null
  approvedAt: string | null
  mergedAt: string | null
  mergedByIdentityId: string | null
  /** ISO string; set when the PR is soft-deleted. */
  deletedAt: string | null
  raw: string
  updatedAt: string
}

/** A review on a pull request. */
export interface Review {
  nodeId: string
  prId: string
  reviewerIdentityId: string
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
  submittedAt: string
  raw: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Issues & transitions
// ---------------------------------------------------------------------------

/** A Jira issue. */
export interface Issue {
  id: string
  projectId: string
  key: string
  type: string
  statusId: string
  statusCategory: 'new' | 'indeterminate' | 'done'
  storyPoints: number | null
  /** The Jira custom field id that holds story points for this project. */
  storyPointsFieldId: string | null
  /** Raw story-points field value before normalisation. */
  storyPointsRaw: string | null
  /** Parent issue id for subtasks / hierarchy. */
  parentId: string | null
  epicKey: string | null
  isSubtask: boolean
  /** 0 = epic, 1 = story/task, 2 = subtask. */
  hierarchyLevel: number
  assigneeIdentityId: string | null
  createdAt: string
  resolvedAt: string | null
  deletedAt: string | null
  raw: string
  updatedAt: string
}

/** A single status transition from the Jira changelog (append-only, sorted). */
export interface IssueTransition {
  id: string
  issueId: string
  fromStatusId: string
  toStatusId: string
  /** The project id at the time of the transition (may differ after a project move). */
  projectIdAtTransition: string
  transitionedAt: string
  actorIdentityId: string | null
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export interface Sprint {
  id: string
  boardId: string
  state: 'active' | 'closed' | 'future'
  startAt: string | null
  endAt: string | null
  completeAt: string | null
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Metric snapshots & results
// ---------------------------------------------------------------------------

/**
 * A versioned daily metric snapshot (SPEC §6.2).
 * Keyed on (scopeType, scopeId, metric, day, watermarkVersion).
 * Not immutable — marked stale and recomputed on late/reconciled data.
 */
export interface MetricSnapshot {
  scopeType: MetricScope
  scopeId: string
  metric: string
  day: string
  value: number | null
  window: string
  trustTier: TrustTier
  dataQuality: DataQuality
  /** Engine version that computed this snapshot — tools refuse to plot across versions. */
  engineVersion: string
  /** Sync watermark version at compute time. */
  ingestWatermarkVersion: string
  /** Hash of credential scope so cross-install comparison can be refused when fingerprints differ. */
  coverageFingerprint: string
  computedAt: string
  /** True when a reconciliation event has marked this snapshot stale for recompute. */
  isStale: boolean
}

/**
 * The output of a metric compute() call per SPEC §8.6.
 * Pure functions return this; it is not persisted directly (snapshots are).
 */
export interface MetricResult {
  id: string
  trustTier: TrustTier
  scope: MetricScope
  value: number | null
  unit: string
  dataQuality: DataQuality
  engineVersion: string
  /** ISO string for the point in time the result covers. */
  asOf: string
  /** Published "how is this computed?" string for in-product transparency. */
  formulaDoc: string
}
