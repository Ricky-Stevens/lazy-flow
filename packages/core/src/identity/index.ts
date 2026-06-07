/**
 * Identity stitching module — SPEC §6.3 / WP-IDENTITY.
 *
 * Public API:
 *   resolveIdentities  — resolution pass: upsert identities, backfill NULL FKs
 *   parseCommitAuthors — parse Co-authored-by trailers → commit_authors rows
 *   stitchPersons      — match ladder: create persons, auto-merge or queue
 *   listCandidateMatches / confirmCandidateMatch / rejectCandidateMatch / unmergeIdentities
 */

export type { ParseCommitAuthorsOptions, ParseCommitAuthorsResult } from './coauthors.js'
export { parseCommitAuthors, parseTrailers } from './coauthors.js'
export type { QueueListOptions } from './queue.js'
export {
  confirmCandidateMatch,
  listCandidateMatches,
  rejectCandidateMatch,
  unmergeIdentities,
} from './queue.js'
export type { ResolveIdentitiesOptions, ResolveIdentitiesResult } from './resolve.js'
export { buildIdentityId, resolveIdentities } from './resolve.js'
export type { StitchPersonsOptions, StitchPersonsResult } from './stitch.js'
export { stitchPersons } from './stitch.js'
export type { CandidateMatch } from './types.js'
