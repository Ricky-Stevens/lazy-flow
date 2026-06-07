/**
 * @lazy-flow/testkit — public API
 *
 * Re-exports everything a downstream test file needs:
 *   - baseOrg dataset + all named shapes/interfaces
 *   - MSW mock factories for GitHub and Jira
 *   - Test harness utilities (fakeClock, seed, withMockServer)
 */

export type {
  BaseOrg,
  BoardColumnShape,
  BoardConfigShape,
  CoAuthoredCommitShape,
  CommitShape,
  DeployIncidentLinkShape,
  DeploymentShape,
  IdentityShape,
  IssueKeyShape,
  IssueShape,
  JiraProjectShape,
  OrgShape,
  PersonShape,
  PrIssueLinkShape,
  PrShape,
  RepoShape,
  ReviewCommentShape,
  ReviewShape,
  SprintMembershipEventShape,
  SprintShape,
  StatusShape,
  TransitionShape,
  WorkflowSchemeMappingShape,
  WorkflowShape,
} from './dataset/baseOrg.js'

export { baseOrg, IDS } from './dataset/baseOrg.js'

export { fakeClock, seed, withMockServer } from './harness.js'
export { mockGitHub } from './mocks/github.js'
export { mockJira } from './mocks/jira.js'
