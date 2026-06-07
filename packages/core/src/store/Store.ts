/**
 * Store — the single seam between the metric engine / ingestion layer and the
 * underlying database.
 *
 * The default implementation is NodeSqliteStore over the built-in
 * node:sqlite (DatabaseSync) — zero native deps, fully bundleable (SPEC D5/§12.3).
 * This interface is also the only seam the shared-ingester / Postgres path
 * touches (SPEC §6.4 / §5.4), so a drop-in Postgres or DuckDB impl requires
 * only a new class implementing this interface.
 */

import type {
  Commit,
  Identity,
  Issue,
  IssueTransition,
  MetricScope,
  MetricSnapshot,
  Person,
  PullRequest,
  Repository,
  Review,
  Sprint,
} from '../domain/types.js'
import type { CandidateMatch } from '../identity/types.js'

// ---------------------------------------------------------------------------
// Sync-state cursor types
// ---------------------------------------------------------------------------

export interface SyncStateCursor {
  source: string
  resource: string
  scopeId: string
  cursor: string | null
  watermarkAt: string | null
  lastRunAt: string | null
  status: 'idle' | 'running' | 'error'
  error: string | null
}

// ---------------------------------------------------------------------------
// v2 entity types (tables added in the v2 schema)
// ---------------------------------------------------------------------------

export interface Organisation {
  id: string
  githubLogin: string | null
  jiraCloudId: string | null
  name: string
  createdAt: string
  updatedAt: string
}

export interface CommitAuthor {
  repoId: string
  sha: string
  identityId: string
  role: 'author' | 'committer' | 'co_author'
  source: 'api' | 'trailer'
}

export interface ReviewComment {
  nodeId: string
  prId: string
  authorIdentityId: string
  createdAt: string
  inReplyTo: string | null
  path: string | null
  raw: string
  updatedAt: string
}

export interface CheckRun {
  nodeId: string
  repoId: string
  headSha: string
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  raw: string
  updatedAt: string
}

export interface Deployment {
  id: string
  repoId: string
  sha: string
  environment: string
  status: string
  createdAt: string
  finishedAt: string | null
  source: 'deployments_api' | 'release' | 'workflow' | 'merge_proxy'
  raw: string
  updatedAt: string
}

export interface JiraProject {
  id: string
  key: string
  name: string
  jiraCloudId: string
  raw: string
  createdAt: string
  updatedAt: string
}

export interface IssueKey {
  issueId: string
  key: string
  validFrom: string
  validTo: string | null
}

export interface SprintMembershipEvent {
  sprintId: string
  issueId: string
  change: 'added' | 'removed'
  pointsAtEvent: number | null
  transitionedAt: string
  wasPresentAtStart: boolean
}

export interface BoardConfig {
  boardId: string
  type: 'scrum' | 'kanban'
  updatedAt: string
}

export interface BoardColumn {
  boardId: string
  columnName: string
  /** JSON array of numeric Jira status ids */
  statusIds: string
  isStartedCol: boolean
  isDoneCol: boolean
}

export interface Workflow {
  workflowId: string
  name: string
  updatedAt: string
}

export interface WorkflowSchemeMapping {
  projectId: string
  issueType: string
  workflowId: string
  updatedAt: string
}

export interface Team {
  id: string
  name: string
  orgId: string
  updatedAt: string
}

export interface TeamMembership {
  teamId: string
  personId: string
  validFrom: string
  validTo: string | null
}

export interface PrIssueLink {
  prId: string
  issueId: string
  linkSource: 'regex' | 'smartcommit' | 'branch' | 'llm'
  confidence: number
}

export interface AiVerdict {
  id: string
  subjectType: string
  subjectId: string
  metric: string
  promptVersion: string
  modelId: string
  modelSnapshot: string
  requestShape: string
  featureVectorJson: string
  structuredVerdictJson: string
  evidenceJson: string
  confidence: number
  createdAt: string
  correctedBy: string | null
  correctionJson: string | null
}

export interface FlowStateModel {
  workflowId: string
  statusId: string
  flowState: 'new' | 'active' | 'wait' | 'done'
  confidence: number
  confirmedBy: string | null
  confirmedAt: string | null
  validFrom: string
  validTo: string | null
}

export interface StatusCategoryHistory {
  statusId: string
  category: 'new' | 'indeterminate' | 'done'
  validFrom: string
  validTo: string | null
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface Store {
  /**
   * Run `fn` inside a single database transaction, batching all writes into one
   * durable commit. Used to make bulk ingest loops one commit instead of one
   * per row. Rolls back if `fn` throws.
   */
  transaction<T>(fn: () => Promise<T> | T): Promise<T>

  // --- Organisations --------------------------------------------------------

  upsertOrganisation(org: Organisation): Promise<void>
  getOrganisation(id: string): Promise<Organisation | null>
  listOrganisations(): Promise<Organisation[]>

  // --- Persons & identities ------------------------------------------------

  upsertPerson(person: Person): Promise<void>
  getPerson(id: string): Promise<Person | null>

  upsertIdentity(identity: Identity): Promise<void>
  getIdentitiesByPerson(personId: string): Promise<Identity[]>
  /** Find an identity by kind + externalId (e.g. 'github_login' + 'alice'). */
  findIdentityByExternalId(kind: Identity['kind'], externalId: string): Promise<Identity | null>
  /** List all identities (for stitching pass). */
  listAllIdentities(): Promise<Identity[]>

  // --- Repositories --------------------------------------------------------

  upsertRepository(repo: Repository): Promise<void>
  getRepository(id: string): Promise<Repository | null>
  getRepositoriesByOrg(orgId: string): Promise<Repository[]>

  // --- Commits -------------------------------------------------------------

  upsertCommit(commit: Commit): Promise<void>
  getCommitsByRepo(repoId: string, since?: string, until?: string): Promise<Commit[]>

  upsertCommitAuthor(author: CommitAuthor): Promise<void>
  getCommitAuthors(repoId: string, sha: string): Promise<CommitAuthor[]>

  // --- Pull requests -------------------------------------------------------

  upsertPullRequest(pr: PullRequest): Promise<void>
  getPullRequest(id: string): Promise<PullRequest | null>
  getPullRequestsByRepo(repoId: string, since?: string, until?: string): Promise<PullRequest[]>

  // --- Reviews & comments --------------------------------------------------

  upsertReview(review: Review): Promise<void>
  getReviewsByPullRequest(prId: string): Promise<Review[]>

  upsertReviewComment(comment: ReviewComment): Promise<void>
  getReviewCommentsByPullRequest(prId: string): Promise<ReviewComment[]>

  // --- Check runs ----------------------------------------------------------

  upsertCheckRun(checkRun: CheckRun): Promise<void>
  getCheckRunsByRepo(repoId: string, headSha?: string): Promise<CheckRun[]>

  // --- Deployments ---------------------------------------------------------

  upsertDeployment(deployment: Deployment): Promise<void>
  getDeploymentsByRepo(repoId: string, since?: string, until?: string): Promise<Deployment[]>

  // --- Jira projects -------------------------------------------------------

  upsertJiraProject(project: JiraProject): Promise<void>
  getJiraProject(id: string): Promise<JiraProject | null>
  /** List all Jira projects (for identity resolution pass). */
  listJiraProjects(): Promise<JiraProject[]>

  // --- Issues & transitions ------------------------------------------------

  upsertIssue(issue: Issue): Promise<void>
  getIssue(id: string): Promise<Issue | null>
  getIssuesByProject(projectId: string): Promise<Issue[]>
  /**
   * Backfill the assignee_identity_id column on a single issue.
   * Used by the identity-resolution pass after upsertIdentity.
   */
  setIssueAssigneeIdentity(issueId: string, identityId: string): Promise<void>

  upsertIssueKey(issueKey: IssueKey): Promise<void>
  getIssueKeys(issueId: string): Promise<IssueKey[]>
  /** Resolve a Jira issue key (including historical keys) to the current issue id. */
  resolveIssueKey(key: string, at?: string): Promise<string | null>

  /**
   * Append issue transitions (append-only log, sorted by transitionedAt on
   * ingest per SPEC C1). Does not replace existing transitions for the issue.
   */
  appendIssueTransitions(transitions: IssueTransition[]): Promise<void>
  getIssueTransitions(issueId: string): Promise<IssueTransition[]>
  /**
   * Backfill the actor_identity_id column on a single issue transition.
   * Used by the identity-resolution pass after upsertIdentity.
   */
  setTransitionActorIdentity(transitionId: string, identityId: string): Promise<void>

  // --- Sprints & membership ------------------------------------------------

  upsertSprint(sprint: Sprint): Promise<void>
  getSprint(id: string): Promise<Sprint | null>
  getSprintsByBoard(boardId: string): Promise<Sprint[]>

  appendSprintMembershipEvent(event: SprintMembershipEvent): Promise<void>
  getSprintMembershipEvents(sprintId: string): Promise<SprintMembershipEvent[]>

  // --- Board config --------------------------------------------------------

  upsertBoardConfig(config: BoardConfig): Promise<void>
  getBoardConfig(boardId: string): Promise<BoardConfig | null>

  upsertBoardColumn(column: BoardColumn): Promise<void>
  getBoardColumns(boardId: string): Promise<BoardColumn[]>

  // --- Workflows -----------------------------------------------------------

  upsertWorkflow(workflow: Workflow): Promise<void>
  getWorkflow(workflowId: string): Promise<Workflow | null>

  upsertWorkflowSchemeMapping(mapping: WorkflowSchemeMapping): Promise<void>
  getWorkflowSchemeMappings(projectId: string): Promise<WorkflowSchemeMapping[]>

  // --- Teams ---------------------------------------------------------------

  upsertTeam(team: Team): Promise<void>
  getTeam(id: string): Promise<Team | null>
  getTeamsByOrg(orgId: string): Promise<Team[]>

  upsertTeamMembership(membership: TeamMembership): Promise<void>
  getTeamMembers(teamId: string, at?: string): Promise<TeamMembership[]>

  // --- PR ↔ Issue links ----------------------------------------------------

  upsertPrIssueLink(link: PrIssueLink): Promise<void>
  getPrIssueLinks(prId: string): Promise<PrIssueLink[]>
  getIssuePrLinks(issueId: string): Promise<PrIssueLink[]>
  /** Distinct PR ids that have at least one issue link (one query, for linkage-rate). */
  getLinkedPrIds(): Promise<string[]>

  // --- Soft deletes --------------------------------------------------------

  /**
   * Soft-delete a row by setting deleted_at = now() on the given table.
   * The entity is excluded from all metric queries after this call.
   */
  softDelete(table: string, id: string): Promise<void>

  // --- Metric snapshots ----------------------------------------------------

  putSnapshot(snapshot: MetricSnapshot): Promise<void>

  getSnapshots(
    scopeType: MetricScope,
    scopeId: string,
    metric: string,
    from: string,
    to: string,
  ): Promise<MetricSnapshot[]>

  /**
   * Mark snapshots for the given scope/metric/day as stale so WP-REDERIVE
   * can recompute them on the next pass.
   */
  markSnapshotsStale(
    scopeType: MetricScope,
    scopeId: string,
    metric: string,
    day: string,
  ): Promise<void>

  // --- AI verdicts ---------------------------------------------------------

  insertAiVerdict(verdict: AiVerdict): Promise<void>
  getAiVerdict(id: string): Promise<AiVerdict | null>
  /** Append a correction to an existing verdict (contestability surface). */
  correctAiVerdict(id: string, correctedBy: string, correctionJson: string): Promise<void>

  // --- Flow state models ---------------------------------------------------

  upsertFlowStateModel(model: FlowStateModel): Promise<void>
  /** Return the flow-state classification in effect for a workflow+status at a given timestamp. */
  getFlowStateModel(
    workflowId: string,
    statusId: string,
    at?: string,
  ): Promise<FlowStateModel | null>
  getFlowStateModelsByWorkflow(workflowId: string): Promise<FlowStateModel[]>

  // --- Status category history ---------------------------------------------

  upsertStatusCategoryHistory(history: StatusCategoryHistory): Promise<void>
  /** Return the category in effect for a status at a given timestamp. */
  getStatusCategory(statusId: string, at?: string): Promise<'new' | 'indeterminate' | 'done' | null>

  // --- Candidate match queue (human-confirm queue for identity stitching) ---

  /**
   * Append a candidate match to the human-confirm queue.
   * Idempotent on (identityIdA, identityIdB, reason) — deduplicates by
   * ordered pair so (A,B) and (B,A) are the same match.
   */
  appendCandidateMatch(match: CandidateMatch): Promise<void>
  getCandidateMatch(id: string): Promise<CandidateMatch | null>
  /** List candidate matches, optionally filtered by status. */
  getCandidateMatches(status?: CandidateMatch['status']): Promise<CandidateMatch[]>
  /**
   * Resolve a pending candidate match (confirm or reject).
   * Confirming performs the merge: sets identity.person_id on both identities to
   * the same person (the merge is recorded as an audit entry).
   */
  resolveCandidateMatch(
    id: string,
    status: 'confirmed' | 'rejected',
    decidedBy: string,
    decidedAt: string,
  ): Promise<void>

  // --- Sync-state cursors --------------------------------------------------

  getSyncState(source: string, resource: string, scopeId: string): Promise<SyncStateCursor | null>
  /** Return every sync_state row in one query (avoids an N+1 of point lookups). */
  listSyncStates(): Promise<SyncStateCursor[]>
  putSyncState(cursor: SyncStateCursor): Promise<void>

  // --- GDPR / erasure (WP-GDPR-SCAFFOLD) -----------------------------------

  /**
   * Subject erasure (GDPR Art. 17).
   *
   * Cascade-removes the person's identity rows and nullifies/removes their
   * attributable rows (person_id FKs). Non-destructive to team aggregates
   * already snapshotted as aggregate-scope rows.
   *
   * Returns the list of identity IDs that were erased.
   */
  erasePerson(personId: string): Promise<{ erasedIdentityIds: string[] }>

  /**
   * Org-bound guard.
   *
   * Hard-errors if the store already contains data for a different org than
   * `orgId`. Prevents one install mixing two clients' repos (SPEC §6.5).
   */
  assertOrgBound(orgId: string): Promise<void>

  /**
   * Retention pruning helper.
   *
   * Soft-deletes (or hard-deletes for append-only tables without deleted_at)
   * raw rows whose primary timestamp is strictly older than `cutoffIso`.
   * Metric snapshots with `computed_at < cutoffIso` are deleted.
   * Returns the number of rows removed per table.
   */
  pruneOlderThan(cutoffIso: string): Promise<Record<string, number>>
}
