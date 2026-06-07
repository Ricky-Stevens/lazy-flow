/**
 * @lazy-flow/ingest-github — public API
 *
 * Exports the GitHub REST+GraphQL client and the 3-phase sync function.
 */

export type {
  GitHubClientOptions,
  GqlCommentNode,
  GqlCommitNode,
  GqlPageInfo,
  GqlPullRequest,
  GqlRateLimit,
  GqlReviewNode,
  GqlTimelineNode,
  PrGraph,
  RawCheckRun,
  RawCommit,
  RawDeployment,
  RawPullRequest,
  RawRelease,
  RawRepository,
  RawReview,
  RawReviewComment,
} from './client.js'
export { GitHubClient } from './client.js'
export type { SyncMode, SyncResult, SyncScope } from './sync.js'
export { syncGitHub } from './sync.js'
