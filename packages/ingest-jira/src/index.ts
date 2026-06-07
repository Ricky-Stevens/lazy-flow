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

export type { BoardConfigSyncResult } from './boardconfig.js'
export { ingestBoardConfig, ingestBoardConfigFromRaw } from './boardconfig.js'

export type { ParseChangelogResult, StatusCategoryMap } from './changelog.js'
export {
  buildStatusCategoryHistory,
  buildStatusCategoryMap,
  parseChangelog,
} from './changelog.js'
export type {
  JiraClientOptions,
  RawBoard,
  RawBoardConfiguration,
  RawChangelogHistory,
  RawChangelogItem,
  RawChangelogPage,
  RawField,
  RawIssue,
  RawSprint,
  RawSprintReport,
  RawStatus,
  RawWorkflow,
  RawWorkflowScheme,
  SearchResult,
} from './client.js'
export { JiraClient } from './client.js'
export type { JiraSyncMode, JiraSyncResult, JiraSyncScope } from './sync.js'
export { syncJira } from './sync.js'
export type { WorkflowSyncResult } from './workflow.js'
export { ingestWorkflows, ingestWorkflowsFromDataset } from './workflow.js'
