/**
 * Deterministic, deep-frozen synthetic base-org dataset for lazy-flow tests.
 *
 * Edge cases exercised (cross-reference to SPEC / WORKPLAN requirements):
 *
 * Repos
 *   - repo-alpha:  normal (merge commit) — active, not archived, not fork
 *   - repo-beta:   squash-merge repo; also isFork=false but isArchived=true (archived repo flag)
 *
 * Persons / identities
 *   - alice, bob, carol — real contributors with github + email identities
 *   - dependabot[bot] — is_bot identity; excluded from aggregates
 *   - co-authored squash commit: commit-squash-1 has Co-authored-by carol (author=alice, co-author=carol)
 *
 * Pull requests
 *   - pr-1: full stage timestamps (created/ready/firstCommit/firstReview/approved/merged), multi-round reviews
 *   - pr-2: merged without review (mergedWithoutReview edge case)
 *   - pr-3: draft PR (never merged)
 *   - pr-4: squash-merge PR in repo-beta (squash/rebase flag)
 *
 * Reviews
 *   - pr-1 has review round 1 (CHANGES_REQUESTED by bob) + round 2 (APPROVED by bob)
 *   - pr-1 has review comment from carol (multi-round, review_comments)
 *
 * Deployments
 *   - deploy-1: success, linked to pr-1 (for DORA Lead Time)
 *   - deploy-2: success, linked to pr-4 (squash-merge repo)
 *   - deploy-3: failure (no linked incident — CFR denominator with 0-linked)
 *
 * Incidents (Jira issues of type 'Incident')
 *   - issue-incident-1: linked to deploy-1; Done → reopened → Done (MTTR first-vs-last testable)
 *   - issue-incident-2: linked to deploy-2; simple resolved
 *
 * Jira hierarchy
 *   - issue-epic-1: epic (hierarchyLevel=0, no parent)
 *   - issue-story-1: story under epic-1 (hierarchyLevel=1, parentId=issue-epic-1, pointed=5)
 *   - issue-subtask-1: subtask under story-1 (hierarchyLevel=2, parentId=issue-story-1, pointed=3)
 *     → subtask AND parent are both pointed (subtask-dedup test)
 *
 * Sprints
 *   - sprint-1: has sprint_membership_events including add-then-remove for issue-subtask-1
 *
 * Changelogs / transitions
 *   - issue-story-1: >1 logical page of transitions (>10 entries to exercise pagination)
 *   - issue-incident-1: Done → reopened → Done transitions (MTTR anchor test)
 *   - Includes a reopened issue transition
 *
 * Board config
 *   - board-1: columns with "Selected for Dev" (queue, not started) vs "In Progress" (started)
 *   - board_columns.is_started_col distinguishes these
 *
 * Statuses
 *   - status-backlog (new), status-selected (new/queue), status-in-progress (started),
 *     status-in-review (active), status-done (done)
 */

// ---------------------------------------------------------------------------
// ID constants — used across the dataset for cross-referencing
// ---------------------------------------------------------------------------

export const IDS = {
  org: 'org-octo-acme',

  // Repos
  repoAlpha: 'repo-alpha',
  repoBeta: 'repo-beta',

  // Persons
  personAlice: 'person-alice',
  personBob: 'person-bob',
  personCarol: 'person-carol',
  // no person for dependabot — is_bot=true, personId=null

  // Identities
  identityAliceGh: 'identity-alice-gh',
  identityAliceEmail: 'identity-alice-email',
  identityBobGh: 'identity-bob-gh',
  identityBobEmail: 'identity-bob-email',
  identityCarolGh: 'identity-carol-gh',
  identityCarolEmail: 'identity-carol-email',
  identityDependabot: 'identity-dependabot',

  // Commits
  commitA1: 'aaaa0000000000000000000000000001',
  commitA2: 'aaaa0000000000000000000000000002',
  commitB1: 'bbbb0000000000000000000000000001', // squash commit in repo-beta
  commitSquash: 'cccc0000000000000000000000000001', // co-authored squash

  // PRs
  pr1: 'pr-1', // full lifecycle
  pr2: 'pr-2', // merged without review
  pr3: 'pr-3', // draft, never merged
  pr4: 'pr-4', // squash-merge in repo-beta

  // Reviews
  review1Round1: 'review-1-r1',
  review1Round2: 'review-1-r2',

  // Review comments
  reviewComment1: 'rc-1',

  // Deployments
  deploy1: 'deploy-1', // success, links pr-1
  deploy2: 'deploy-2', // success, links pr-4
  deploy3: 'deploy-3', // failure, no incident link

  // Jira project
  jiraProjectId: 'jira-project-acme',

  // Jira issues
  issueEpic1: 'issue-epic-1',
  issueStory1: 'issue-story-1',
  issueSubtask1: 'issue-subtask-1',
  issueIncident1: 'issue-incident-1',
  issueIncident2: 'issue-incident-2',

  // Jira statuses
  statusBacklog: 'status-10000',
  statusSelected: 'status-10001',
  statusInProgress: 'status-10002',
  statusInReview: 'status-10003',
  statusDone: 'status-10004',

  // Board / sprint
  boardId: 'board-1',
  sprintId: 'sprint-1',

  // Workflow
  workflowId: 'workflow-standard',

  // Project-moved issue key (WP-LINKING: old key for issueStory1 before project move)
  // ACME-2 was previously OLD-99 (project renamed from OLD → ACME)
  movedIssueKey: 'OLD-99',
} as const

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

export interface OrgShape {
  id: string
  githubLogin: string
  jiraCloudId: string
}

const org: OrgShape = Object.freeze({
  id: IDS.org,
  githubLogin: 'octo-acme',
  jiraCloudId: 'acme-jira-cloud',
})

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RepoShape {
  id: string
  githubNodeId: string
  orgId: string
  owner: string
  name: string
  defaultBranch: string
  isArchived: boolean
  isFork: boolean
  deletedAt: null
  raw: string
  createdAt: string
  updatedAt: string
}

const repositories: readonly RepoShape[] = Object.freeze([
  Object.freeze<RepoShape>({
    id: IDS.repoAlpha,
    githubNodeId: 'MDEwOlJlcG9zaXRvcnkxMDAwMQ==',
    orgId: IDS.org,
    owner: 'octo-acme',
    name: 'alpha-service',
    defaultBranch: 'main',
    isArchived: false,
    isFork: false,
    deletedAt: null,
    raw: '{"id":"MDEwOlJlcG9zaXRvcnkxMDAwMQ==","full_name":"octo-acme/alpha-service"}',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  // repo-beta is archived — exercises isArchived flag
  Object.freeze<RepoShape>({
    id: IDS.repoBeta,
    githubNodeId: 'MDEwOlJlcG9zaXRvcnkxMDAwMg==',
    orgId: IDS.org,
    owner: 'octo-acme',
    name: 'beta-service',
    defaultBranch: 'main',
    isArchived: true, // EDGE CASE: archived repo
    isFork: false,
    deletedAt: null,
    raw: '{"id":"MDEwOlJlcG9zaXRvcnkxMDAwMg==","full_name":"octo-acme/beta-service","archived":true}',
    createdAt: '2023-06-01T00:00:00Z',
    updatedAt: '2024-03-01T00:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

export interface PersonShape {
  id: string
  displayName: string
  primaryAccountRef: string
  updatedAt: string
}

const persons: readonly PersonShape[] = Object.freeze([
  Object.freeze<PersonShape>({
    id: IDS.personAlice,
    displayName: 'Alice Example',
    primaryAccountRef: 'gh:100001',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  Object.freeze<PersonShape>({
    id: IDS.personBob,
    displayName: 'Bob Example',
    primaryAccountRef: 'gh:100002',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  Object.freeze<PersonShape>({
    id: IDS.personCarol,
    displayName: 'Carol Example',
    primaryAccountRef: 'gh:100003',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export interface IdentityShape {
  id: string
  personId: string | null
  kind: 'github_login' | 'commit_email' | 'jira_account'
  externalId: string
  isBot: boolean
  confidence: number
  raw: string
  updatedAt: string
}

const identities: readonly IdentityShape[] = Object.freeze([
  // Alice
  Object.freeze<IdentityShape>({
    id: IDS.identityAliceGh,
    personId: IDS.personAlice,
    kind: 'github_login',
    externalId: 'alice',
    isBot: false,
    confidence: 1,
    raw: '{"login":"alice","id":100001,"type":"User"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  Object.freeze<IdentityShape>({
    id: IDS.identityAliceEmail,
    personId: IDS.personAlice,
    kind: 'commit_email',
    externalId: 'alice@example.com',
    isBot: false,
    confidence: 1,
    raw: '{"email":"alice@example.com"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  // Bob
  Object.freeze<IdentityShape>({
    id: IDS.identityBobGh,
    personId: IDS.personBob,
    kind: 'github_login',
    externalId: 'bob',
    isBot: false,
    confidence: 1,
    raw: '{"login":"bob","id":100002,"type":"User"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  Object.freeze<IdentityShape>({
    id: IDS.identityBobEmail,
    personId: IDS.personBob,
    kind: 'commit_email',
    externalId: 'bob@example.com',
    isBot: false,
    confidence: 1,
    raw: '{"email":"bob@example.com"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  // Carol
  Object.freeze<IdentityShape>({
    id: IDS.identityCarolGh,
    personId: IDS.personCarol,
    kind: 'github_login',
    externalId: 'carol',
    isBot: false,
    confidence: 1,
    raw: '{"login":"carol","id":100003,"type":"User"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  Object.freeze<IdentityShape>({
    id: IDS.identityCarolEmail,
    personId: IDS.personCarol,
    kind: 'commit_email',
    externalId: 'carol@example.com',
    isBot: false,
    confidence: 1,
    raw: '{"email":"carol@example.com"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  // dependabot[bot] — EDGE CASE: bot identity, no person, isBot=true
  Object.freeze<IdentityShape>({
    id: IDS.identityDependabot,
    personId: null, // bots never get a person record
    kind: 'github_login',
    externalId: 'dependabot[bot]',
    isBot: true,
    confidence: 1,
    raw: '{"login":"dependabot[bot]","id":49699333,"type":"Bot"}',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitShape {
  repoId: string
  sha: string
  authorIdentityId: string
  authoredAt: string
  committedAt: string
  additions: number
  deletions: number
  haloc: number
  message: string
  raw: string
  createdAt: string
  updatedAt: string
}

/**
 * Co-authored commit shape — extra field for trailer parsing tests.
 * co_authored_by is a parsed trailer (Co-authored-by: carol <carol@example.com>).
 */
export interface CoAuthoredCommitShape extends CommitShape {
  coAuthoredBy: ReadonlyArray<{ name: string; email: string }>
}

const commits: readonly (CommitShape | CoAuthoredCommitShape)[] = Object.freeze([
  // Commit in alpha-service by alice
  Object.freeze<CommitShape>({
    repoId: IDS.repoAlpha,
    sha: IDS.commitA1,
    authorIdentityId: IDS.identityAliceGh,
    authoredAt: '2024-03-01T09:00:00Z',
    committedAt: '2024-03-01T09:00:00Z',
    additions: 120,
    deletions: 30,
    haloc: 120, // max(120,30) = 120 (one hunk)
    message: 'feat: add widget service',
    raw: '{"sha":"aaaa0000000000000000000000000001","author":{"login":"alice"}}',
    createdAt: '2024-03-01T09:00:00Z',
    updatedAt: '2024-03-01T09:00:00Z',
  }),
  // Second commit in alpha-service by bob
  Object.freeze<CommitShape>({
    repoId: IDS.repoAlpha,
    sha: IDS.commitA2,
    authorIdentityId: IDS.identityBobGh,
    authoredAt: '2024-03-02T10:00:00Z',
    committedAt: '2024-03-02T10:00:00Z',
    additions: 40,
    deletions: 10,
    haloc: 40,
    message: 'fix: handle null widget',
    raw: '{"sha":"aaaa0000000000000000000000000002","author":{"login":"bob"}}',
    createdAt: '2024-03-02T10:00:00Z',
    updatedAt: '2024-03-02T10:00:00Z',
  }),
  // Squash commit in beta-service (repo-beta uses squash merge)
  Object.freeze<CommitShape>({
    repoId: IDS.repoBeta,
    sha: IDS.commitB1,
    authorIdentityId: IDS.identityBobGh,
    authoredAt: '2024-04-01T11:00:00Z',
    committedAt: '2024-04-01T11:00:00Z',
    additions: 80,
    deletions: 20,
    haloc: 80,
    message: 'feat: add gadget endpoint (#4)',
    raw: '{"sha":"bbbb0000000000000000000000000001","author":{"login":"bob"}}',
    createdAt: '2024-04-01T11:00:00Z',
    updatedAt: '2024-04-01T11:00:00Z',
  }),
  // EDGE CASE: co-authored squash commit — alice authored, carol co-authored
  Object.freeze<CoAuthoredCommitShape>({
    repoId: IDS.repoAlpha,
    sha: IDS.commitSquash,
    authorIdentityId: IDS.identityAliceGh,
    authoredAt: '2024-05-01T14:00:00Z',
    committedAt: '2024-05-01T14:00:00Z',
    additions: 200,
    deletions: 50,
    haloc: 200,
    message: 'feat: refactor widget pipeline\n\nCo-authored-by: Carol Example <carol@example.com>',
    coAuthoredBy: Object.freeze([{ name: 'Carol Example', email: 'carol@example.com' }]),
    raw: '{"sha":"cccc0000000000000000000000000001","author":{"login":"alice"},"commit":{"message":"feat: refactor widget pipeline\\n\\nCo-authored-by: Carol Example <carol@example.com>"}}',
    createdAt: '2024-05-01T14:00:00Z',
    updatedAt: '2024-05-01T14:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface PrShape {
  id: string
  repoId: string
  number: number
  authorIdentityId: string
  state: 'open' | 'closed' | 'merged'
  headRef: string
  baseRef: string
  isDraft: boolean
  mergedViaQueue: boolean
  createdAt: string
  readyAt: string | null
  firstCommitAt: string | null
  firstReviewAt: string | null
  approvedAt: string | null
  mergedAt: string | null
  mergedByIdentityId: string | null
  deletedAt: null
  raw: string
  updatedAt: string
}

const pullRequests: readonly PrShape[] = Object.freeze([
  // pr-1: full lifecycle, multi-round reviews
  Object.freeze<PrShape>({
    id: IDS.pr1,
    repoId: IDS.repoAlpha,
    number: 1,
    authorIdentityId: IDS.identityAliceGh,
    state: 'merged',
    headRef: 'feat/widget-service',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: '2024-03-01T08:00:00Z',
    readyAt: '2024-03-01T08:00:00Z', // was ready immediately (not a draft)
    firstCommitAt: '2024-03-01T07:30:00Z', // commit before PR opened
    firstReviewAt: '2024-03-01T12:00:00Z',
    approvedAt: '2024-03-02T09:00:00Z',
    mergedAt: '2024-03-02T10:00:00Z',
    mergedByIdentityId: IDS.identityAliceGh,
    deletedAt: null,
    raw: '{"number":1,"state":"closed","merged":true,"title":"fix: resolve ACME-2 widget issue","body":"Fixes ACME-2 — adds null check for widget","head":{"ref":"feat/widget-service"},"base":{"ref":"main"}}',
    updatedAt: '2024-03-02T10:00:00Z',
  }),
  // pr-2: merged without review — EDGE CASE
  Object.freeze<PrShape>({
    id: IDS.pr2,
    repoId: IDS.repoAlpha,
    number: 2,
    authorIdentityId: IDS.identityBobGh,
    state: 'merged',
    headRef: 'fix/null-widget',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: '2024-03-02T09:30:00Z',
    readyAt: '2024-03-02T09:30:00Z',
    firstCommitAt: '2024-03-02T09:00:00Z',
    firstReviewAt: null, // no review
    approvedAt: null,
    mergedAt: '2024-03-02T11:00:00Z',
    mergedByIdentityId: IDS.identityBobGh,
    deletedAt: null,
    raw: '{"number":2,"state":"closed","merged":true,"title":"fix: handle null widget","body":"No issue reference","head":{"ref":"fix/null-widget"},"base":{"ref":"main"}}',
    updatedAt: '2024-03-02T11:00:00Z',
  }),
  // pr-3: draft PR, never merged — EDGE CASE
  Object.freeze<PrShape>({
    id: IDS.pr3,
    repoId: IDS.repoAlpha,
    number: 3,
    authorIdentityId: IDS.identityCarolGh,
    state: 'open',
    headRef: 'feat/experimental',
    baseRef: 'main',
    isDraft: true, // EDGE CASE: draft
    mergedViaQueue: false,
    createdAt: '2024-03-10T10:00:00Z',
    readyAt: null, // still draft
    firstCommitAt: '2024-03-10T09:00:00Z',
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: null,
    mergedByIdentityId: null,
    deletedAt: null,
    raw: '{"number":3,"state":"open","draft":true,"title":"wip: experimental feature","body":"Draft PR, no Jira link","head":{"ref":"feat/experimental"},"base":{"ref":"main"}}',
    updatedAt: '2024-03-10T10:00:00Z',
  }),
  // pr-4: squash-merge PR in archived repo-beta — EDGE CASE: squash merge
  Object.freeze<PrShape>({
    id: IDS.pr4,
    repoId: IDS.repoBeta,
    number: 4,
    authorIdentityId: IDS.identityBobGh,
    state: 'merged',
    headRef: 'feat/gadget-endpoint',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: '2024-04-01T09:00:00Z',
    readyAt: '2024-04-01T09:00:00Z',
    firstCommitAt: '2024-04-01T08:00:00Z',
    firstReviewAt: '2024-04-01T10:00:00Z',
    approvedAt: '2024-04-01T10:30:00Z',
    mergedAt: '2024-04-01T11:00:00Z',
    mergedByIdentityId: IDS.identityBobGh,
    deletedAt: null,
    raw: '{"number":4,"state":"closed","merged":true,"title":"feat: gadget endpoint for OLD-99","body":"Implements gadget endpoint. Resolves OLD-99 (was ACME-2 before project rename).","head":{"ref":"feat/gadget-endpoint"},"base":{"ref":"main"},"merge_commit_sha":"bbbb0000000000000000000000000001"}',
    updatedAt: '2024-04-01T11:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface ReviewShape {
  nodeId: string
  prId: string
  reviewerIdentityId: string
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
  submittedAt: string
  raw: string
  updatedAt: string
}

const reviews: readonly ReviewShape[] = Object.freeze([
  // pr-1, round 1: bob requests changes
  Object.freeze<ReviewShape>({
    nodeId: IDS.review1Round1,
    prId: IDS.pr1,
    reviewerIdentityId: IDS.identityBobGh,
    state: 'changes_requested',
    submittedAt: '2024-03-01T12:00:00Z',
    raw: '{"id":"review-1-r1","state":"CHANGES_REQUESTED","user":{"login":"bob"}}',
    updatedAt: '2024-03-01T12:00:00Z',
  }),
  // pr-1, round 2: bob approves after fix
  Object.freeze<ReviewShape>({
    nodeId: IDS.review1Round2,
    prId: IDS.pr1,
    reviewerIdentityId: IDS.identityBobGh,
    state: 'approved',
    submittedAt: '2024-03-02T09:00:00Z',
    raw: '{"id":"review-1-r2","state":"APPROVED","user":{"login":"bob"}}',
    updatedAt: '2024-03-02T09:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

export interface ReviewCommentShape {
  nodeId: string
  prId: string
  authorIdentityId: string
  createdAt: string
  inReplyTo: string | null
  path: string
  raw: string
  updatedAt: string
}

const reviewComments: readonly ReviewCommentShape[] = Object.freeze([
  // Carol comments on pr-1 (multi-round review comments)
  Object.freeze<ReviewCommentShape>({
    nodeId: IDS.reviewComment1,
    prId: IDS.pr1,
    authorIdentityId: IDS.identityCarolGh,
    createdAt: '2024-03-01T13:00:00Z',
    inReplyTo: null,
    path: 'src/widget.ts',
    raw: '{"id":"rc-1","body":"please add null check","path":"src/widget.ts","user":{"login":"carol"}}',
    updatedAt: '2024-03-01T13:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export interface DeploymentShape {
  id: string
  repoId: string
  sha: string
  environment: string
  status: 'success' | 'failure' | 'pending' | 'error'
  createdAt: string
  finishedAt: string
  source: 'deployments_api' | 'release' | 'workflow' | 'merge_proxy'
  raw: string
}

const deployments: readonly DeploymentShape[] = Object.freeze([
  // deploy-1: success, alpha-service, linked to pr-1 commits
  Object.freeze<DeploymentShape>({
    id: IDS.deploy1,
    repoId: IDS.repoAlpha,
    sha: IDS.commitA2,
    environment: 'production',
    status: 'success',
    createdAt: '2024-03-02T10:30:00Z',
    finishedAt: '2024-03-02T10:45:00Z',
    source: 'deployments_api',
    raw: '{"id":"deploy-1","environment":"production","statuses_url":"..."}',
  }),
  // deploy-2: success, beta-service (squash), linked to pr-4
  Object.freeze<DeploymentShape>({
    id: IDS.deploy2,
    repoId: IDS.repoBeta,
    sha: IDS.commitB1,
    environment: 'production',
    status: 'success',
    createdAt: '2024-04-01T11:30:00Z',
    finishedAt: '2024-04-01T11:45:00Z',
    source: 'deployments_api',
    raw: '{"id":"deploy-2","environment":"production","statuses_url":"..."}',
  }),
  // deploy-3: failure, alpha-service — no linked incident (CFR edge: denominator present, numerator 0)
  Object.freeze<DeploymentShape>({
    id: IDS.deploy3,
    repoId: IDS.repoAlpha,
    sha: IDS.commitSquash,
    environment: 'production',
    status: 'failure',
    createdAt: '2024-05-01T15:00:00Z',
    finishedAt: '2024-05-01T15:05:00Z',
    source: 'deployments_api',
    raw: '{"id":"deploy-3","environment":"production","statuses_url":"..."}',
  }),
])

// ---------------------------------------------------------------------------
// Jira statuses
// ---------------------------------------------------------------------------

export interface StatusShape {
  id: string
  name: string
  category: 'new' | 'indeterminate' | 'done'
}

const jiraStatuses: readonly StatusShape[] = Object.freeze([
  Object.freeze<StatusShape>({ id: IDS.statusBacklog, name: 'Backlog', category: 'new' }),
  // "Selected for Dev" = queue column, NOT started (EDGE CASE: board_columns test)
  Object.freeze<StatusShape>({
    id: IDS.statusSelected,
    name: 'Selected for Dev',
    category: 'new',
  }),
  Object.freeze<StatusShape>({
    id: IDS.statusInProgress,
    name: 'In Progress',
    category: 'indeterminate',
  }),
  Object.freeze<StatusShape>({
    id: IDS.statusInReview,
    name: 'In Review',
    category: 'indeterminate',
  }),
  Object.freeze<StatusShape>({ id: IDS.statusDone, name: 'Done', category: 'done' }),
])

// ---------------------------------------------------------------------------
// Jira project
// ---------------------------------------------------------------------------

export interface JiraProjectShape {
  id: string
  key: string
  name: string
  jiraCloudId: string
  storyPointsFieldId: string
  raw: string
}

const jiraProject: JiraProjectShape = Object.freeze<JiraProjectShape>({
  id: IDS.jiraProjectId,
  key: 'ACME',
  name: 'Acme Project',
  jiraCloudId: 'acme-jira-cloud',
  storyPointsFieldId: 'customfield_10016',
  raw: '{"id":"jira-project-acme","key":"ACME","name":"Acme Project"}',
})

// ---------------------------------------------------------------------------
// Jira issues (epic → story → subtask hierarchy + incidents)
// ---------------------------------------------------------------------------

export interface IssueShape {
  id: string
  projectId: string
  key: string
  type: string
  statusId: string
  statusCategory: 'new' | 'indeterminate' | 'done'
  storyPoints: number | null
  storyPointsFieldId: string | null
  storyPointsRaw: string | null
  parentId: string | null
  epicKey: string | null
  isSubtask: boolean
  hierarchyLevel: number
  assigneeIdentityId: string | null
  createdAt: string
  resolvedAt: string | null
  deletedAt: null
  raw: string
  updatedAt: string
}

const jiraIssues: readonly IssueShape[] = Object.freeze([
  // Epic — hierarchyLevel=0
  Object.freeze<IssueShape>({
    id: IDS.issueEpic1,
    projectId: IDS.jiraProjectId,
    key: 'ACME-1',
    type: 'Epic',
    statusId: IDS.statusInProgress,
    statusCategory: 'indeterminate',
    storyPoints: null, // epics not typically pointed
    storyPointsFieldId: 'customfield_10016',
    storyPointsRaw: null,
    parentId: null,
    epicKey: 'ACME-1',
    isSubtask: false,
    hierarchyLevel: 0,
    assigneeIdentityId: IDS.identityAliceGh,
    createdAt: '2024-01-15T09:00:00Z',
    resolvedAt: null,
    deletedAt: null,
    raw: '{"id":"issue-epic-1","key":"ACME-1","fields":{"issuetype":{"name":"Epic"}}}',
    updatedAt: '2024-03-01T00:00:00Z',
  }),
  // Story — hierarchyLevel=1, pointed=5 (EDGE CASE: both story and subtask pointed)
  Object.freeze<IssueShape>({
    id: IDS.issueStory1,
    projectId: IDS.jiraProjectId,
    key: 'ACME-2',
    type: 'Story',
    statusId: IDS.statusDone,
    statusCategory: 'done',
    storyPoints: 5, // pointed — subtask-dedup test: engine must not double-count
    storyPointsFieldId: 'customfield_10016',
    storyPointsRaw: '5',
    parentId: IDS.issueEpic1,
    epicKey: 'ACME-1',
    isSubtask: false,
    hierarchyLevel: 1,
    assigneeIdentityId: IDS.identityAliceGh,
    createdAt: '2024-02-01T09:00:00Z',
    resolvedAt: '2024-03-02T12:00:00Z',
    deletedAt: null,
    raw: '{"id":"issue-story-1","key":"ACME-2","fields":{"issuetype":{"name":"Story"},"customfield_10016":5}}',
    updatedAt: '2024-03-02T12:00:00Z',
  }),
  // Subtask — hierarchyLevel=2, pointed=3 (EDGE CASE: subtask-dedup)
  Object.freeze<IssueShape>({
    id: IDS.issueSubtask1,
    projectId: IDS.jiraProjectId,
    key: 'ACME-3',
    type: 'Subtask',
    statusId: IDS.statusDone,
    statusCategory: 'done',
    storyPoints: 3, // also pointed — engine must choose one level to count
    storyPointsFieldId: 'customfield_10016',
    storyPointsRaw: '3',
    parentId: IDS.issueStory1,
    epicKey: 'ACME-1',
    isSubtask: true,
    hierarchyLevel: 2,
    assigneeIdentityId: IDS.identityBobGh,
    createdAt: '2024-02-05T09:00:00Z',
    resolvedAt: '2024-03-01T16:00:00Z',
    deletedAt: null,
    raw: '{"id":"issue-subtask-1","key":"ACME-3","fields":{"issuetype":{"name":"Subtask","subtask":true},"customfield_10016":3}}',
    updatedAt: '2024-03-01T16:00:00Z',
  }),
  // Incident 1 — linked to deploy-1; EDGE CASE: reopened (Done → open → Done) for MTTR first-vs-last
  Object.freeze<IssueShape>({
    id: IDS.issueIncident1,
    projectId: IDS.jiraProjectId,
    key: 'ACME-4',
    type: 'Incident',
    statusId: IDS.statusDone,
    statusCategory: 'done',
    storyPoints: null,
    storyPointsFieldId: null,
    storyPointsRaw: null,
    parentId: null,
    epicKey: null,
    isSubtask: false,
    hierarchyLevel: 1,
    assigneeIdentityId: IDS.identityAliceGh,
    createdAt: '2024-03-02T11:00:00Z', // created shortly after deploy-1 finished
    resolvedAt: '2024-03-03T09:00:00Z', // final resolution (after reopen)
    deletedAt: null,
    raw: '{"id":"issue-incident-1","key":"ACME-4","fields":{"issuetype":{"name":"Incident"}}}',
    updatedAt: '2024-03-03T09:00:00Z',
  }),
  // Incident 2 — linked to deploy-2; simple resolved
  Object.freeze<IssueShape>({
    id: IDS.issueIncident2,
    projectId: IDS.jiraProjectId,
    key: 'ACME-5',
    type: 'Incident',
    statusId: IDS.statusDone,
    statusCategory: 'done',
    storyPoints: null,
    storyPointsFieldId: null,
    storyPointsRaw: null,
    parentId: null,
    epicKey: null,
    isSubtask: false,
    hierarchyLevel: 1,
    assigneeIdentityId: IDS.identityBobGh,
    createdAt: '2024-04-01T12:00:00Z',
    resolvedAt: '2024-04-01T14:00:00Z',
    deletedAt: null,
    raw: '{"id":"issue-incident-2","key":"ACME-5","fields":{"issuetype":{"name":"Incident"}}}',
    updatedAt: '2024-04-01T14:00:00Z',
  }),
])

// ---------------------------------------------------------------------------
// Issue transitions (changelog) — SPEC C1
//
// EDGE CASES:
//   - issue-story-1: >1 logical page (13 transitions) to exercise changelog pagination
//   - issue-incident-1: Done → In Progress (reopen) → Done (MTTR first-vs-last)
//   - Initial status is NOT in the changelog — seeded from createdAt + first transition.from
//   - Entries deliberately out of order for sort-on-ingest test
// ---------------------------------------------------------------------------

export interface TransitionShape {
  id: string
  issueId: string
  fromStatusId: string
  toStatusId: string
  projectIdAtTransition: string
  transitionedAt: string
  actorIdentityId: string | null
}

/**
 * story-1 transitions: 13 entries across the lifecycle.
 * Deliberately includes some out-of-order entries at the end (sort test).
 * The pagination fixture splits these at index 5 (page 1) and 6-12 (page 2).
 */
const storyTransitions: readonly TransitionShape[] = Object.freeze([
  // Initial move: Backlog → Selected for Dev
  Object.freeze<TransitionShape>({
    id: 'tr-story-01',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusBacklog,
    toStatusId: IDS.statusSelected,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-05T09:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // Selected → In Progress (cycle-time start boundary)
  Object.freeze<TransitionShape>({
    id: 'tr-story-02',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusSelected,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-07T10:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // In Progress → In Review
  Object.freeze<TransitionShape>({
    id: 'tr-story-03',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusInReview,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-10T14:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // In Review → In Progress (back to dev — re-entry accumulates)
  Object.freeze<TransitionShape>({
    id: 'tr-story-04',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInReview,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-12T09:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  // In Progress → In Review (second review cycle)
  Object.freeze<TransitionShape>({
    id: 'tr-story-05',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusInReview,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-15T11:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // --- page boundary would split here in the mock (entries 0-4 = page 1) ---
  // In Review → Done
  Object.freeze<TransitionShape>({
    id: 'tr-story-06',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInReview,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-18T15:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  // Done → In Progress (reopened story)
  Object.freeze<TransitionShape>({
    id: 'tr-story-07',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusDone,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-20T09:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // In Progress → In Review (third cycle)
  Object.freeze<TransitionShape>({
    id: 'tr-story-08',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusInReview,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-22T10:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // In Review → Done
  Object.freeze<TransitionShape>({
    id: 'tr-story-09',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInReview,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-25T14:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  // Done → In Progress (second reopen)
  Object.freeze<TransitionShape>({
    id: 'tr-story-10',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusDone,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-27T09:00:00Z',
    actorIdentityId: IDS.identityCarolGh,
  }),
  // In Progress → Done (final resolution)
  Object.freeze<TransitionShape>({
    id: 'tr-story-11',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-01T16:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // Extra entries to push past 10 (page 2 minimum)
  Object.freeze<TransitionShape>({
    id: 'tr-story-12',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusDone,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-01T17:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  Object.freeze<TransitionShape>({
    id: 'tr-story-13',
    issueId: IDS.issueStory1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-02T12:00:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
])

/**
 * Incident-1 transitions: EDGE CASE — Done → reopened → Done.
 * MTTR first-vs-last anchor test:
 *   - first Done: tr-incident-02 at 2024-03-02T12:00:00Z
 *   - reopen: tr-incident-03
 *   - final Done: tr-incident-04 at 2024-03-03T09:00:00Z
 */
const incident1Transitions: readonly TransitionShape[] = Object.freeze([
  // Backlog → In Progress
  Object.freeze<TransitionShape>({
    id: 'tr-incident-01',
    issueId: IDS.issueIncident1,
    fromStatusId: IDS.statusBacklog,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-02T11:30:00Z',
    actorIdentityId: IDS.identityAliceGh,
  }),
  // In Progress → Done (FIRST resolve — MTTR anchor)
  Object.freeze<TransitionShape>({
    id: 'tr-incident-02',
    issueId: IDS.issueIncident1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-02T12:00:00Z', // 1h after creation
    actorIdentityId: IDS.identityAliceGh,
  }),
  // Done → In Progress (REOPEN — EDGE CASE)
  Object.freeze<TransitionShape>({
    id: 'tr-incident-03',
    issueId: IDS.issueIncident1,
    fromStatusId: IDS.statusDone,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-02T14:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  // In Progress → Done (SECOND/FINAL resolve)
  Object.freeze<TransitionShape>({
    id: 'tr-incident-04',
    issueId: IDS.issueIncident1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-03T09:00:00Z', // 22h after first done
    actorIdentityId: IDS.identityAliceGh,
  }),
])

const incident2Transitions: readonly TransitionShape[] = Object.freeze([
  Object.freeze<TransitionShape>({
    id: 'tr-incident2-01',
    issueId: IDS.issueIncident2,
    fromStatusId: IDS.statusBacklog,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-04-01T12:30:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  Object.freeze<TransitionShape>({
    id: 'tr-incident2-02',
    issueId: IDS.issueIncident2,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-04-01T14:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
])

const subtaskTransitions: readonly TransitionShape[] = Object.freeze([
  Object.freeze<TransitionShape>({
    id: 'tr-subtask-01',
    issueId: IDS.issueSubtask1,
    fromStatusId: IDS.statusBacklog,
    toStatusId: IDS.statusInProgress,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-02-07T10:30:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
  Object.freeze<TransitionShape>({
    id: 'tr-subtask-02',
    issueId: IDS.issueSubtask1,
    fromStatusId: IDS.statusInProgress,
    toStatusId: IDS.statusDone,
    projectIdAtTransition: IDS.jiraProjectId,
    transitionedAt: '2024-03-01T16:00:00Z',
    actorIdentityId: IDS.identityBobGh,
  }),
])

/** All transitions, grouped by issue for easy mock lookup. */
const issueTransitions: Readonly<Record<string, readonly TransitionShape[]>> = Object.freeze({
  [IDS.issueStory1]: storyTransitions,
  [IDS.issueIncident1]: incident1Transitions,
  [IDS.issueIncident2]: incident2Transitions,
  [IDS.issueSubtask1]: subtaskTransitions,
  [IDS.issueEpic1]: Object.freeze([]), // epic has no transitions in this dataset
})

// ---------------------------------------------------------------------------
// Sprint & membership events
// ---------------------------------------------------------------------------

export interface SprintShape {
  id: string
  boardId: string
  name: string
  state: 'active' | 'closed' | 'future'
  startAt: string | null
  endAt: string | null
  completeAt: string | null
  updatedAt: string
}

export interface SprintMembershipEventShape {
  sprintId: string
  issueId: string
  change: 'added' | 'removed'
  pointsAtEvent: number | null
  transitionedAt: string
  wasPresentAtStart: boolean
}

const sprints: readonly SprintShape[] = Object.freeze([
  Object.freeze<SprintShape>({
    id: IDS.sprintId,
    boardId: IDS.boardId,
    name: 'Sprint 1',
    state: 'closed',
    startAt: '2024-02-05T00:00:00Z',
    endAt: '2024-02-19T00:00:00Z',
    completeAt: '2024-02-19T08:00:00Z',
    updatedAt: '2024-02-19T08:00:00Z',
  }),
])

/**
 * Sprint membership events for sprint-1.
 * EDGE CASE: issue-subtask-1 is added then removed mid-sprint.
 */
const sprintMembershipEvents: readonly SprintMembershipEventShape[] = Object.freeze([
  // story-1 added at sprint start
  Object.freeze<SprintMembershipEventShape>({
    sprintId: IDS.sprintId,
    issueId: IDS.issueStory1,
    change: 'added',
    pointsAtEvent: 5,
    transitionedAt: '2024-02-05T00:00:00Z',
    wasPresentAtStart: true,
  }),
  // subtask-1 added mid-sprint
  Object.freeze<SprintMembershipEventShape>({
    sprintId: IDS.sprintId,
    issueId: IDS.issueSubtask1,
    change: 'added',
    pointsAtEvent: 3,
    transitionedAt: '2024-02-07T10:30:00Z',
    wasPresentAtStart: false,
  }),
  // subtask-1 REMOVED mid-sprint (EDGE CASE: add-then-remove)
  Object.freeze<SprintMembershipEventShape>({
    sprintId: IDS.sprintId,
    issueId: IDS.issueSubtask1,
    change: 'removed',
    pointsAtEvent: 3,
    transitionedAt: '2024-02-12T14:00:00Z',
    wasPresentAtStart: false,
  }),
])

// ---------------------------------------------------------------------------
// Board configuration
// ---------------------------------------------------------------------------

export interface BoardConfigShape {
  boardId: string
  type: 'scrum' | 'kanban'
}

export interface BoardColumnShape {
  boardId: string
  columnName: string
  statusIds: readonly string[]
  isStartedCol: boolean
  isDoneCol: boolean
}

const boardConfigs: readonly BoardConfigShape[] = Object.freeze([
  Object.freeze<BoardConfigShape>({ boardId: IDS.boardId, type: 'scrum' }),
])

/**
 * Board columns for board-1.
 * EDGE CASE: "Selected for Dev" is a queue column (is_started_col=false),
 * "In Progress" is the actual start boundary (is_started_col=true).
 */
const boardColumns: readonly BoardColumnShape[] = Object.freeze([
  Object.freeze<BoardColumnShape>({
    boardId: IDS.boardId,
    columnName: 'Backlog',
    statusIds: Object.freeze([IDS.statusBacklog]),
    isStartedCol: false,
    isDoneCol: false,
  }),
  // EDGE CASE: queue column — NOT the cycle-time start
  Object.freeze<BoardColumnShape>({
    boardId: IDS.boardId,
    columnName: 'Selected for Dev',
    statusIds: Object.freeze([IDS.statusSelected]),
    isStartedCol: false,
    isDoneCol: false,
  }),
  // Cycle-time START boundary
  Object.freeze<BoardColumnShape>({
    boardId: IDS.boardId,
    columnName: 'In Progress',
    statusIds: Object.freeze([IDS.statusInProgress]),
    isStartedCol: true,
    isDoneCol: false,
  }),
  Object.freeze<BoardColumnShape>({
    boardId: IDS.boardId,
    columnName: 'In Review',
    statusIds: Object.freeze([IDS.statusInReview]),
    isStartedCol: true,
    isDoneCol: false,
  }),
  Object.freeze<BoardColumnShape>({
    boardId: IDS.boardId,
    columnName: 'Done',
    statusIds: Object.freeze([IDS.statusDone]),
    isStartedCol: false,
    isDoneCol: true,
  }),
])

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface WorkflowShape {
  workflowId: string
  name: string
}

export interface WorkflowSchemeMappingShape {
  projectId: string
  issueType: string
  workflowId: string
}

const workflows: readonly WorkflowShape[] = Object.freeze([
  Object.freeze<WorkflowShape>({
    workflowId: IDS.workflowId,
    name: 'Standard Software Workflow',
  }),
])

const workflowSchemeMappings: readonly WorkflowSchemeMappingShape[] = Object.freeze([
  Object.freeze<WorkflowSchemeMappingShape>({
    projectId: IDS.jiraProjectId,
    issueType: 'Story',
    workflowId: IDS.workflowId,
  }),
  Object.freeze<WorkflowSchemeMappingShape>({
    projectId: IDS.jiraProjectId,
    issueType: 'Subtask',
    workflowId: IDS.workflowId,
  }),
  Object.freeze<WorkflowSchemeMappingShape>({
    projectId: IDS.jiraProjectId,
    issueType: 'Incident',
    workflowId: IDS.workflowId,
  }),
  Object.freeze<WorkflowSchemeMappingShape>({
    projectId: IDS.jiraProjectId,
    issueType: 'Epic',
    workflowId: IDS.workflowId,
  }),
])

// ---------------------------------------------------------------------------
// PR-issue links (GitHub ↔ Jira)
// ---------------------------------------------------------------------------

export interface PrIssueLinkShape {
  prId: string
  issueId: string
  linkSource: 'regex' | 'smartcommit' | 'branch' | 'llm'
  confidence: number
}

const prIssueLinks: readonly PrIssueLinkShape[] = Object.freeze([
  Object.freeze<PrIssueLinkShape>({
    prId: IDS.pr1,
    issueId: IDS.issueStory1,
    linkSource: 'regex',
    confidence: 0.95,
  }),
  Object.freeze<PrIssueLinkShape>({
    prId: IDS.pr4,
    issueId: IDS.issueStory1,
    linkSource: 'branch',
    confidence: 0.8,
  }),
])

// ---------------------------------------------------------------------------
// Deploy-incident links
// ---------------------------------------------------------------------------

export interface DeployIncidentLinkShape {
  deployId: string
  incidentIssueId: string
}

const deployIncidentLinks: readonly DeployIncidentLinkShape[] = Object.freeze([
  Object.freeze<DeployIncidentLinkShape>({
    deployId: IDS.deploy1,
    incidentIssueId: IDS.issueIncident1,
  }),
  Object.freeze<DeployIncidentLinkShape>({
    deployId: IDS.deploy2,
    incidentIssueId: IDS.issueIncident2,
  }),
  // deploy-3 has no linked incident — CFR edge case
])

// ---------------------------------------------------------------------------
// Historical issue keys (project-moved keys — WP-LINKING)
// ---------------------------------------------------------------------------

/**
 * Historical issue key record.
 * OLD-99 was the previous key for issue-story-1 (ACME-2) before the project
 * was renamed from OLD → ACME. The validTo timestamp marks when the move happened.
 */
export interface IssueKeyShape {
  issueId: string
  key: string
  validFrom: string
  validTo: string | null
}

/**
 * Historical issue keys for the base dataset.
 * Includes the "moved key" edge case: OLD-99 is a prior key for issue-story-1.
 * This lets linkIssues() tests assert that a PR body referencing "OLD-99"
 * resolves through the issue_keys history to issueStory1.
 */
const historicalIssueKeys: readonly IssueKeyShape[] = Object.freeze([
  // Current key for issueStory1 (ACME-2) — valid from creation onwards
  Object.freeze<IssueKeyShape>({
    issueId: IDS.issueStory1,
    key: 'ACME-2',
    validFrom: '2024-01-01T00:00:00Z', // after project rename
    validTo: null, // current key
  }),
  // Old key — valid before the project rename (EDGE CASE: project-moved key)
  Object.freeze<IssueKeyShape>({
    issueId: IDS.issueStory1,
    key: IDS.movedIssueKey, // 'OLD-99'
    validFrom: '2023-01-01T00:00:00Z',
    validTo: '2024-01-01T00:00:00Z', // expired when project renamed
  }),
])

// ---------------------------------------------------------------------------
// Root baseOrg export
// ---------------------------------------------------------------------------

export interface BaseOrg {
  readonly org: OrgShape
  readonly repositories: readonly RepoShape[]
  readonly persons: readonly PersonShape[]
  readonly identities: readonly IdentityShape[]
  readonly commits: readonly (CommitShape | CoAuthoredCommitShape)[]
  readonly pullRequests: readonly PrShape[]
  readonly reviews: readonly ReviewShape[]
  readonly reviewComments: readonly ReviewCommentShape[]
  readonly deployments: readonly DeploymentShape[]
  readonly jiraProject: JiraProjectShape
  readonly jiraStatuses: readonly StatusShape[]
  readonly jiraIssues: readonly IssueShape[]
  readonly issueTransitions: Readonly<Record<string, readonly TransitionShape[]>>
  readonly sprints: readonly SprintShape[]
  readonly sprintMembershipEvents: readonly SprintMembershipEventShape[]
  readonly boardConfigs: readonly BoardConfigShape[]
  readonly boardColumns: readonly BoardColumnShape[]
  readonly workflows: readonly WorkflowShape[]
  readonly workflowSchemeMappings: readonly WorkflowSchemeMappingShape[]
  readonly prIssueLinks: readonly PrIssueLinkShape[]
  readonly deployIncidentLinks: readonly DeployIncidentLinkShape[]
  /** Historical issue keys including the project-moved edge case (OLD-99 → ACME-2). */
  readonly historicalIssueKeys: readonly IssueKeyShape[]
}

/**
 * The deterministic, deep-frozen synthetic base org.
 * All identifiers are obviously fake; no real PII.
 *
 * Covers: archived repo, squash-merge repo, bot identity, co-authored squash commit,
 * draft PR, merged-without-review PR, multi-round reviews, reopened incident (MTTR),
 * pointed subtask+parent (dedup), add-then-remove sprint membership, >10 transitions
 * (multi-page changelog), queue vs started board columns, workflow scheme mappings.
 */
export const baseOrg: BaseOrg = Object.freeze<BaseOrg>({
  org,
  repositories,
  persons,
  identities,
  commits,
  pullRequests,
  reviews,
  reviewComments,
  deployments,
  jiraProject,
  jiraStatuses,
  jiraIssues,
  issueTransitions,
  sprints,
  sprintMembershipEvents,
  boardConfigs,
  boardColumns,
  workflows,
  workflowSchemeMappings,
  prIssueLinks,
  deployIncidentLinks,
  historicalIssueKeys,
})
