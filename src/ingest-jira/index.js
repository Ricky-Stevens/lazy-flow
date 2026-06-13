/**
 * @lazy-flow/ingest-jira — public API
 *
 * Jira Cloud REST v3 + Agile ingest:
 *   - JiraClient (client.ts): typed API wrapper over native fetch
 *   - parseChangelog (changelog.ts): C1-correct changelog parser (keystone)
 *   - ingestBoardConfig (boardconfig.ts): board column boundaries
 *   - ingestWorkflows (workflow.ts): workflow + scheme discovery
 *   - syncJira (sync.ts): full sync orchestrator
 */

export { ingestBoardConfig, ingestBoardConfigFromRaw } from './boardconfig.js'

export {
  buildStatusCategoryHistory,
  buildStatusCategoryMap,
  parseChangelog,
} from './changelog.js'

export { JiraClient } from './client.js'

export { syncJira } from './sync.js'

export { ingestWorkflows, ingestWorkflowsFromDataset } from './workflow.js'
