/**
 * @lazy-flow/ingest-github — public API
 *
 * Exports the GitHub GraphQL client and the 3-phase sync function.
 */

export { DEFAULT_AI_MARKERS, ingestRepoAiSignals } from './aiSignals.js'
export { backfillPrPatches } from './backfillPatches.js'
export { GitHubClient } from './client.js'
export { syncGitHub } from './sync.js'
