// Constants
export { ENGINE_VERSION } from './constants.js'

// Domain types (SPEC §6.1/§6.2)

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
// Identity stitching (SPEC §6.3 / WP-IDENTITY)

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

export { linkageRate, linkIssues } from './linking/linkIssues.js'

// Migration runner
export { currentVersion, MIGRATIONS, migrate } from './migrate/runner.js'
// Outbound-URL safety guards for token-bearing HTTP clients (SPEC §6.5)
export {
  assertSafeBaseUrl,
  assertSameOrigin,
  isPrivateHost,
} from './net/safeUrl.js'
// Scrub — ingest-time payload sanitiser (WP-SCRUB)
export { scrubFreeText, scrubRawPayload } from './scrub/index.js'
// Stats primitives (SPEC §8.6)
export { percentile, quantiles } from './stats/percentile.js'
export { createPrng } from './stats/prng.js'
export { safeRatio } from './stats/ratio.js'

export { meetsSampleFloor, SAMPLE_FLOORS, sampleFloorFor } from './stats/sample.js'
// BunSqliteStore — default Store implementation over bun:sqlite
export { BunSqliteStore } from './store/BunSqliteStore.js'
// Org-bound DB guard (SPEC §6.5) — tenant-isolation control that prevents one
// install from mixing two clients' repositories.
export { assertOrgBound } from './store/orgBound.js'
// Store interface + entity types (SPEC §6.1/§6.2)
