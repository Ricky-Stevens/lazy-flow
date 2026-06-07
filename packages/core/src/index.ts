// Constants
export { ENGINE_VERSION } from './constants.js'

// Domain types (SPEC §6.1/§6.2)
export type {
  Commit,
  Identity,
  Issue,
  IssueTransition,
  MetricResult,
  MetricScope,
  MetricSnapshot,
  Person,
  PullRequest,
  Repository,
  Review,
  Sprint,
  TrustTier,
  Visibility,
} from './domain/types.js'
export type {
  BoardColumnInput,
  ClassifyResult,
  ConfirmFlowStateOptions,
  EnsureFallbackMappingOptions,
  EnsureFallbackMappingResult,
  OverrideFlowStateOptions,
  PendingConfirmation,
  SeedFlowStateModelOptions,
  SeedFlowStateModelResult,
  StatusInput,
} from './flowstate/index.js'
// Flow State Model — per-workflow active/wait map (SPEC §1 C3, §6.2, WP-FLOWSTATE-MODEL)
export {
  applyBoardColumnAdjustment,
  classifyStatus,
  confirmFlowState,
  ensureFallbackMapping,
  HIGH_CONFIDENCE_THRESHOLD,
  listPendingConfirmations,
  overrideFlowState,
  seedFlowStateModel,
} from './flowstate/index.js'
// GDPR scaffolding (WP-GDPR-SCAFFOLD) — subject erasure, pseudonymisation,
// org-bound guard, retention config + pruning, adopter doc generators.
export type { DpiaTemplateOptions, ErasePersonResult, RetentionConfig } from './gdpr/index.js'
export {
  assertOrgBound,
  erasePerson,
  generateDpiaTemplate,
  generateLiaTemplate,
  generateTransparencyNotice,
  pruneOlderThan,
  pseudonymize,
} from './gdpr/index.js'
// Identity stitching (SPEC §6.3 / WP-IDENTITY)
export type {
  CandidateMatch,
  ParseCommitAuthorsOptions,
  ParseCommitAuthorsResult,
  QueueListOptions,
  ResolveIdentitiesOptions,
  ResolveIdentitiesResult,
  StitchPersonsOptions,
  StitchPersonsResult,
} from './identity/index.js'
export {
  buildIdentityId,
  confirmCandidateMatch,
  listCandidateMatches,
  parseCommitAuthors,
  parseTrailers,
  rejectCandidateMatch,
  resolveIdentities,
  stitchPersons,
  unmergeIdentities,
} from './identity/index.js'
// PR ↔ Jira issue linking (SPEC WP-LINKING)
export type { LinkIssuesOptions, LinkIssuesResult } from './linking/linkIssues.js'
export { linkageRate, linkIssues } from './linking/linkIssues.js'
export type { Migration } from './migrate/runner.js'
// Migration runner
export { currentVersion, MIGRATIONS, migrate } from './migrate/runner.js'
// Outbound-URL safety guards for token-bearing HTTP clients (SPEC §6.5)
export {
  assertSafeBaseUrl,
  assertSameOrigin,
  isPrivateHost,
  type SafeUrlOptions,
} from './net/safeUrl.js'
// Scrub — ingest-time payload sanitiser (WP-SCRUB)
export { scrubFreeText, scrubRawPayload } from './scrub/index.js'
// Stats primitives (SPEC §8.6)
export { percentile, quantiles } from './stats/percentile.js'
export { createPrng } from './stats/prng.js'
export { safeRatio } from './stats/ratio.js'
export type { DataQuality } from './stats/sample.js'
export { meetsSampleFloor, SAMPLE_FLOORS, sampleFloorFor } from './stats/sample.js'
// NodeSqliteStore — default Store implementation over node:sqlite
export { NodeSqliteStore } from './store/NodeSqliteStore.js'
// Store interface + entity types (SPEC §6.1/§6.2)
export type {
  AiVerdict,
  BoardColumn,
  BoardConfig,
  CheckRun,
  CommitAuthor,
  Deployment,
  FlowStateModel,
  IssueKey,
  JiraProject,
  Organisation,
  PrIssueLink,
  ReviewComment,
  SprintMembershipEvent,
  StatusCategoryHistory,
  Store,
  SyncStateCursor,
  Team,
  TeamMembership,
  Workflow,
  WorkflowSchemeMapping,
} from './store/Store.js'
