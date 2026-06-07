/**
 * NodeSqliteStore — Store implementation over the built-in node:sqlite
 * (DatabaseSync). Zero native deps, fully bundleable per SPEC D5/§12.3.
 *
 * Design decisions:
 * - Parameterized statements only — never string-interpolate values.
 * - WAL mode + busy_timeout=5000 on open.
 * - Upserts are INSERT … ON CONFLICT DO UPDATE SET … with last-writer-wins
 *   gating: the incoming row only overwrites when its updated_at >= the stored
 *   updated_at (so out-of-order webhook+poll deliveries converge correctly).
 * - Soft-delete: softDelete() sets deleted_at; read helpers filter it out.
 * - The schema is managed by the migration runner (migrate/); this class
 *   assumes the schema is already applied.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
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
import type {
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
} from './Store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString()
}

/** Tables that carry a `deleted_at` column and may be soft-deleted by id. */
const SOFT_DELETABLE_TABLES: ReadonlySet<string> = new Set([
  'repositories',
  'pull_requests',
  'issues',
])

/** Convert a JS boolean to SQLite INTEGER 0/1. */
function b(v: boolean): number {
  return v ? 1 : 0
}

/** Convert a SQLite INTEGER 0/1 to JS boolean. */
function rb(v: unknown): boolean {
  return v === 1 || v === true
}

/** Coerce a nullable DB value to string | null. */
function rstr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return String(v)
}

/** Coerce a nullable DB value to number | null. */
function rnum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return Number(v)
}

/** Map a candidate_matches DB row to a CandidateMatch domain object. */
function mapCandidateMatch(r: Record<string, unknown>): CandidateMatch {
  return {
    id: String(r.id),
    identityIdA: String(r.identity_id_a),
    identityIdB: String(r.identity_id_b),
    reason: r.reason as CandidateMatch['reason'],
    confidence: Number(r.confidence),
    status: r.status as CandidateMatch['status'],
    decidedAt: rstr(r.decided_at),
    decidedBy: rstr(r.decided_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

// ---------------------------------------------------------------------------
// NodeSqliteStore
// ---------------------------------------------------------------------------

export class NodeSqliteStore implements Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode = WAL`)
    this.db.exec(`PRAGMA busy_timeout = 5000`)
    this.db.exec(`PRAGMA foreign_keys = ON`)
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close()
  }

  /**
   * Run `fn` inside a single SQLite transaction. node:sqlite (DatabaseSync) is
   * synchronous and single-connection, so a BEGIN…COMMIT bracket batches every
   * write performed by `fn` into one durable commit (one WAL fsync) instead of
   * one per statement — the dominant cost of bulk ingest. Rolls back on throw.
   */
  private _inTransaction = false
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    // Re-entrancy guard: node:sqlite is a single connection with no nested
    // transactions; a naive nested BEGIN would throw, and its ROLLBACK would
    // then abort the OUTER transaction. If one is already open, join it (run
    // inline) so the outer BEGIN/COMMIT still brackets everything.
    if (this._inTransaction) return await fn()

    this._inTransaction = true
    this.db.exec('BEGIN')
    try {
      const result = await fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this._inTransaction = false
    }
  }

  // Prepare a statement lazily — cached per SQL string for efficiency.
  // Using a map avoids re-preparing on every call while keeping the impl simple.
  private readonly _stmts = new Map<string, StatementSync>()
  private stmt(sql: string): StatementSync {
    let s = this._stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this._stmts.set(sql, s)
    }
    return s
  }

  // ---------------------------------------------------------------------------
  // Organisations
  // ---------------------------------------------------------------------------

  async upsertOrganisation(org: Organisation): Promise<void> {
    this.stmt(`
      INSERT INTO organisations (id, github_login, jira_cloud_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_login  = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.github_login  ELSE organisations.github_login  END,
        jira_cloud_id = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.jira_cloud_id ELSE organisations.jira_cloud_id END,
        name          = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.name          ELSE organisations.name          END,
        updated_at    = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.updated_at    ELSE organisations.updated_at    END
    `).run(org.id, org.githubLogin, org.jiraCloudId, org.name, org.createdAt, org.updatedAt)
  }

  async getOrganisation(id: string): Promise<Organisation | null> {
    const row = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      githubLogin: rstr(row.github_login),
      jiraCloudId: rstr(row.jira_cloud_id),
      name: String(row.name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Persons
  // ---------------------------------------------------------------------------

  async upsertPerson(person: Person): Promise<void> {
    this.stmt(`
      INSERT INTO persons (id, display_name, primary_account_ref, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name        = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.display_name        ELSE persons.display_name        END,
        primary_account_ref = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.primary_account_ref ELSE persons.primary_account_ref END,
        updated_at          = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.updated_at          ELSE persons.updated_at          END
    `).run(person.id, person.displayName, person.primaryAccountRef, person.updatedAt)
  }

  async getPerson(id: string): Promise<Person | null> {
    const row = this.stmt(
      `SELECT id, display_name, primary_account_ref, updated_at FROM persons WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      primaryAccountRef: String(row.primary_account_ref),
      updatedAt: String(row.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Identities
  // ---------------------------------------------------------------------------

  async upsertIdentity(identity: Identity): Promise<void> {
    this.stmt(`
      INSERT INTO identities (id, person_id, kind, external_id, is_bot, confidence, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        person_id   = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.person_id   ELSE identities.person_id   END,
        kind        = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.kind        ELSE identities.kind        END,
        external_id = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.external_id ELSE identities.external_id END,
        is_bot      = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.is_bot      ELSE identities.is_bot      END,
        confidence  = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.confidence  ELSE identities.confidence  END,
        raw         = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.raw         ELSE identities.raw         END,
        updated_at  = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.updated_at  ELSE identities.updated_at  END
    `).run(
      identity.id,
      identity.personId,
      identity.kind,
      identity.externalId,
      b(identity.isBot),
      identity.confidence,
      identity.raw,
      identity.updatedAt,
    )
  }

  async getIdentitiesByPerson(personId: string): Promise<Identity[]> {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE person_id = ?`,
    ).all(personId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind as Identity['kind'],
      externalId: String(r.external_id),
      isBot: rb(r.is_bot),
      confidence: Number(r.confidence),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------

  async upsertRepository(repo: Repository): Promise<void> {
    this.stmt(`
      INSERT INTO repositories (id, github_node_id, org_id, owner, name, default_branch,
        is_archived, is_fork, deleted_at, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_node_id = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.github_node_id ELSE repositories.github_node_id END,
        org_id         = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.org_id         ELSE repositories.org_id         END,
        owner          = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.owner          ELSE repositories.owner          END,
        name           = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.name           ELSE repositories.name           END,
        default_branch = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.default_branch ELSE repositories.default_branch END,
        is_archived    = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.is_archived    ELSE repositories.is_archived    END,
        is_fork        = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.is_fork        ELSE repositories.is_fork        END,
        deleted_at     = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.deleted_at     ELSE repositories.deleted_at     END,
        raw            = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.raw            ELSE repositories.raw            END,
        updated_at     = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.updated_at     ELSE repositories.updated_at     END
    `).run(
      repo.id,
      repo.githubNodeId,
      repo.orgId,
      repo.owner,
      repo.name,
      repo.defaultBranch,
      b(repo.isArchived),
      b(repo.isFork),
      repo.deletedAt,
      repo.raw,
      repo.createdAt,
      repo.updatedAt,
    )
  }

  async getRepository(id: string): Promise<Repository | null> {
    const row = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this._rowToRepository(row)
  }

  async getRepositoriesByOrg(orgId: string): Promise<Repository[]> {
    const rows = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE org_id = ? AND deleted_at IS NULL`,
    ).all(orgId) as Record<string, unknown>[]
    return rows.map((r) => this._rowToRepository(r))
  }

  private _rowToRepository(r: Record<string, unknown>): Repository {
    return {
      id: String(r.id),
      githubNodeId: String(r.github_node_id),
      orgId: String(r.org_id),
      owner: String(r.owner),
      name: String(r.name),
      defaultBranch: String(r.default_branch),
      isArchived: rb(r.is_archived),
      isFork: rb(r.is_fork),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------------

  async upsertCommit(commit: Commit): Promise<void> {
    this.stmt(`
      INSERT INTO commits (repo_id, sha, author_identity_id, authored_at, committed_at,
        additions, deletions, haloc, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha) DO UPDATE SET
        author_identity_id = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.author_identity_id ELSE commits.author_identity_id END,
        authored_at        = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.authored_at        ELSE commits.authored_at        END,
        committed_at       = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.committed_at       ELSE commits.committed_at       END,
        additions          = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.additions          ELSE commits.additions          END,
        deletions          = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.deletions          ELSE commits.deletions          END,
        haloc              = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.haloc              ELSE commits.haloc              END,
        raw                = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.raw                ELSE commits.raw                END,
        updated_at         = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.updated_at         ELSE commits.updated_at         END
    `).run(
      commit.repoId,
      commit.sha,
      commit.authorIdentityId,
      commit.authoredAt,
      commit.committedAt,
      commit.additions,
      commit.deletions,
      commit.haloc,
      commit.raw,
      commit.createdAt,
      commit.updatedAt,
    )
  }

  async getCommitsByRepo(repoId: string, since?: string, until?: string): Promise<Commit[]> {
    let sql =
      `SELECT repo_id, sha, author_identity_id, authored_at, committed_at,` +
      ` additions, deletions, haloc, raw, created_at, updated_at` +
      ` FROM commits WHERE repo_id = ?`
    const params: SQLInputValue[] = [repoId]
    if (since) {
      sql += ` AND authored_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND authored_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY authored_at ASC`
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      authorIdentityId: String(r.author_identity_id),
      authoredAt: String(r.authored_at),
      committedAt: String(r.committed_at),
      additions: Number(r.additions),
      deletions: Number(r.deletions),
      haloc: Number(r.haloc),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Commit authors (co-authors / trailers)
  // ---------------------------------------------------------------------------

  async upsertCommitAuthor(author: CommitAuthor): Promise<void> {
    this.stmt(`
      INSERT INTO commit_authors (repo_id, sha, identity_id, role, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha, identity_id, role) DO NOTHING
    `).run(author.repoId, author.sha, author.identityId, author.role, author.source)
  }

  async getCommitAuthors(repoId: string, sha: string): Promise<CommitAuthor[]> {
    const rows = this.stmt(
      `SELECT repo_id, sha, identity_id, role, source
       FROM commit_authors WHERE repo_id = ? AND sha = ?`,
    ).all(repoId, sha) as Record<string, unknown>[]
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      identityId: String(r.identity_id),
      role: r.role as CommitAuthor['role'],
      source: r.source as CommitAuthor['source'],
    }))
  }

  // ---------------------------------------------------------------------------
  // Pull requests
  // ---------------------------------------------------------------------------

  async upsertPullRequest(pr: PullRequest): Promise<void> {
    this.stmt(`
      INSERT INTO pull_requests (id, repo_id, number, author_identity_id, state,
        head_ref, base_ref, is_draft, merged_via_queue, created_at, ready_at,
        first_commit_at, first_review_at, approved_at, merged_at,
        merged_by_identity_id, deleted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state                 = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.state                 ELSE pull_requests.state                 END,
        head_ref              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.head_ref              ELSE pull_requests.head_ref              END,
        base_ref              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.base_ref              ELSE pull_requests.base_ref              END,
        is_draft              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.is_draft              ELSE pull_requests.is_draft              END,
        merged_via_queue      = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_via_queue      ELSE pull_requests.merged_via_queue      END,
        ready_at              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.ready_at              ELSE pull_requests.ready_at              END,
        first_commit_at       = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.first_commit_at       ELSE pull_requests.first_commit_at       END,
        first_review_at       = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.first_review_at       ELSE pull_requests.first_review_at       END,
        approved_at           = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.approved_at           ELSE pull_requests.approved_at           END,
        merged_at             = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_at             ELSE pull_requests.merged_at             END,
        merged_by_identity_id = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_by_identity_id ELSE pull_requests.merged_by_identity_id END,
        deleted_at            = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.deleted_at            ELSE pull_requests.deleted_at            END,
        raw                   = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.raw                   ELSE pull_requests.raw                   END,
        updated_at            = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.updated_at            ELSE pull_requests.updated_at            END
    `).run(
      pr.id,
      pr.repoId,
      pr.number,
      pr.authorIdentityId,
      pr.state,
      pr.headRef,
      pr.baseRef,
      b(pr.isDraft),
      b(pr.mergedViaQueue),
      pr.createdAt,
      pr.readyAt,
      pr.firstCommitAt,
      pr.firstReviewAt,
      pr.approvedAt,
      pr.mergedAt,
      pr.mergedByIdentityId,
      pr.deletedAt,
      pr.raw,
      pr.updatedAt,
    )
  }

  async getPullRequest(id: string): Promise<PullRequest | null> {
    const row = this.stmt(
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,
              is_draft, merged_via_queue, created_at, ready_at, first_commit_at,
              first_review_at, approved_at, merged_at, merged_by_identity_id,
              deleted_at, raw, updated_at
       FROM pull_requests WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this._rowToPullRequest(row)
  }

  async getPullRequestsByRepo(
    repoId: string,
    since?: string,
    until?: string,
  ): Promise<PullRequest[]> {
    let sql =
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,` +
      ` is_draft, merged_via_queue, created_at, ready_at, first_commit_at,` +
      ` first_review_at, approved_at, merged_at, merged_by_identity_id,` +
      ` deleted_at, raw, updated_at` +
      ` FROM pull_requests WHERE repo_id = ? AND deleted_at IS NULL`
    const params: SQLInputValue[] = [repoId]
    if (since) {
      sql += ` AND created_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND created_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY created_at ASC`
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => this._rowToPullRequest(r))
  }

  private _rowToPullRequest(r: Record<string, unknown>): PullRequest {
    return {
      id: String(r.id),
      repoId: String(r.repo_id),
      number: Number(r.number),
      authorIdentityId: String(r.author_identity_id),
      state: r.state as PullRequest['state'],
      headRef: String(r.head_ref),
      baseRef: String(r.base_ref),
      isDraft: rb(r.is_draft),
      mergedViaQueue: rb(r.merged_via_queue),
      createdAt: String(r.created_at),
      readyAt: rstr(r.ready_at),
      firstCommitAt: rstr(r.first_commit_at),
      firstReviewAt: rstr(r.first_review_at),
      approvedAt: rstr(r.approved_at),
      mergedAt: rstr(r.merged_at),
      mergedByIdentityId: rstr(r.merged_by_identity_id),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------

  async upsertReview(review: Review): Promise<void> {
    this.stmt(`
      INSERT INTO reviews (node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        state                = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.state                ELSE reviews.state                END,
        submitted_at         = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.submitted_at         ELSE reviews.submitted_at         END,
        reviewer_identity_id = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.reviewer_identity_id ELSE reviews.reviewer_identity_id END,
        raw                  = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.raw                  ELSE reviews.raw                  END,
        updated_at           = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.updated_at           ELSE reviews.updated_at           END
    `).run(
      review.nodeId,
      review.prId,
      review.reviewerIdentityId,
      review.state,
      review.submittedAt,
      review.raw,
      review.updatedAt,
    )
  }

  async getReviewsByPullRequest(prId: string): Promise<Review[]> {
    const rows = this.stmt(
      `SELECT node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at
       FROM reviews WHERE pr_id = ? ORDER BY submitted_at ASC`,
    ).all(prId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      reviewerIdentityId: String(r.reviewer_identity_id),
      state: r.state as Review['state'],
      submittedAt: String(r.submitted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Review comments
  // ---------------------------------------------------------------------------

  async upsertReviewComment(comment: ReviewComment): Promise<void> {
    this.stmt(`
      INSERT INTO review_comments (node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        author_identity_id = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.author_identity_id ELSE review_comments.author_identity_id END,
        in_reply_to        = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.in_reply_to        ELSE review_comments.in_reply_to        END,
        path               = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.path               ELSE review_comments.path               END,
        raw                = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.raw                ELSE review_comments.raw                END,
        updated_at         = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.updated_at         ELSE review_comments.updated_at         END
    `).run(
      comment.nodeId,
      comment.prId,
      comment.authorIdentityId,
      comment.createdAt,
      comment.inReplyTo,
      comment.path,
      comment.raw,
      comment.updatedAt,
    )
  }

  async getReviewCommentsByPullRequest(prId: string): Promise<ReviewComment[]> {
    const rows = this.stmt(
      `SELECT node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at
       FROM review_comments WHERE pr_id = ? ORDER BY created_at ASC`,
    ).all(prId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      authorIdentityId: String(r.author_identity_id),
      createdAt: String(r.created_at),
      inReplyTo: rstr(r.in_reply_to),
      path: rstr(r.path),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Check runs
  // ---------------------------------------------------------------------------

  async upsertCheckRun(checkRun: CheckRun): Promise<void> {
    this.stmt(`
      INSERT INTO check_runs (node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        status       = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.status       ELSE check_runs.status       END,
        conclusion   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.conclusion   ELSE check_runs.conclusion   END,
        started_at   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.started_at   ELSE check_runs.started_at   END,
        completed_at = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.completed_at ELSE check_runs.completed_at END,
        raw          = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.raw          ELSE check_runs.raw          END,
        updated_at   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.updated_at   ELSE check_runs.updated_at   END
    `).run(
      checkRun.nodeId,
      checkRun.repoId,
      checkRun.headSha,
      checkRun.name,
      checkRun.status,
      checkRun.conclusion,
      checkRun.startedAt,
      checkRun.completedAt,
      checkRun.raw,
      checkRun.updatedAt,
    )
  }

  async getCheckRunsByRepo(repoId: string, headSha?: string): Promise<CheckRun[]> {
    let sql =
      `SELECT node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at` +
      ` FROM check_runs WHERE repo_id = ?`
    const params: SQLInputValue[] = [repoId]
    if (headSha) {
      sql += ` AND head_sha = ?`
      params.push(headSha)
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      repoId: String(r.repo_id),
      headSha: String(r.head_sha),
      name: String(r.name),
      status: String(r.status),
      conclusion: rstr(r.conclusion),
      startedAt: rstr(r.started_at),
      completedAt: rstr(r.completed_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Deployments
  // ---------------------------------------------------------------------------

  async upsertDeployment(deployment: Deployment): Promise<void> {
    this.stmt(`
      INSERT INTO deployments (id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status      = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.status      ELSE deployments.status      END,
        finished_at = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.finished_at ELSE deployments.finished_at END,
        raw         = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.raw         ELSE deployments.raw         END,
        updated_at  = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.updated_at  ELSE deployments.updated_at  END
    `).run(
      deployment.id,
      deployment.repoId,
      deployment.sha,
      deployment.environment,
      deployment.status,
      deployment.createdAt,
      deployment.finishedAt,
      deployment.source,
      deployment.raw,
      deployment.updatedAt,
    )
  }

  async getDeploymentsByRepo(
    repoId: string,
    since?: string,
    until?: string,
  ): Promise<Deployment[]> {
    let sql =
      `SELECT id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at` +
      ` FROM deployments WHERE repo_id = ?`
    const params: SQLInputValue[] = [repoId]
    if (since) {
      sql += ` AND created_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND created_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY created_at ASC`
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      sha: String(r.sha),
      environment: String(r.environment),
      status: String(r.status),
      createdAt: String(r.created_at),
      finishedAt: rstr(r.finished_at),
      source: r.source as Deployment['source'],
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Jira projects
  // ---------------------------------------------------------------------------

  async upsertJiraProject(project: JiraProject): Promise<void> {
    this.stmt(`
      INSERT INTO jira_projects (id, key, name, jira_cloud_id, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key           = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.key           ELSE jira_projects.key           END,
        name          = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.name          ELSE jira_projects.name          END,
        jira_cloud_id = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.jira_cloud_id ELSE jira_projects.jira_cloud_id END,
        raw           = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.raw           ELSE jira_projects.raw           END,
        updated_at    = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.updated_at    ELSE jira_projects.updated_at    END
    `).run(
      project.id,
      project.key,
      project.name,
      project.jiraCloudId,
      project.raw,
      project.createdAt,
      project.updatedAt,
    )
  }

  async getJiraProject(id: string): Promise<JiraProject | null> {
    const row = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      key: String(row.key),
      name: String(row.name),
      jiraCloudId: String(row.jira_cloud_id),
      raw: String(row.raw),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Issues
  // ---------------------------------------------------------------------------

  async upsertIssue(issue: Issue): Promise<void> {
    this.stmt(`
      INSERT INTO issues (id, project_id, key, type, status_id, status_category,
        story_points, story_points_field_id, story_points_raw, parent_id, epic_key,
        is_subtask, hierarchy_level, assignee_identity_id, created_at, resolved_at,
        deleted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key                    = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.key                    ELSE issues.key                    END,
        type                   = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.type                   ELSE issues.type                   END,
        status_id              = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.status_id              ELSE issues.status_id              END,
        status_category        = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.status_category        ELSE issues.status_category        END,
        story_points           = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points           ELSE issues.story_points           END,
        story_points_field_id  = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points_field_id  ELSE issues.story_points_field_id  END,
        story_points_raw       = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points_raw       ELSE issues.story_points_raw       END,
        parent_id              = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.parent_id              ELSE issues.parent_id              END,
        epic_key               = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.epic_key               ELSE issues.epic_key               END,
        is_subtask             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.is_subtask             ELSE issues.is_subtask             END,
        hierarchy_level        = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.hierarchy_level        ELSE issues.hierarchy_level        END,
        assignee_identity_id   = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.assignee_identity_id   ELSE issues.assignee_identity_id   END,
        resolved_at            = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.resolved_at            ELSE issues.resolved_at            END,
        deleted_at             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.deleted_at             ELSE issues.deleted_at             END,
        raw                    = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.raw                    ELSE issues.raw                    END,
        updated_at             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.updated_at             ELSE issues.updated_at             END
    `).run(
      issue.id,
      issue.projectId,
      issue.key,
      issue.type,
      issue.statusId,
      issue.statusCategory,
      issue.storyPoints,
      issue.storyPointsFieldId,
      issue.storyPointsRaw,
      issue.parentId,
      issue.epicKey,
      b(issue.isSubtask),
      issue.hierarchyLevel,
      issue.assigneeIdentityId,
      issue.createdAt,
      issue.resolvedAt,
      issue.deletedAt,
      issue.raw,
      issue.updatedAt,
    )
  }

  async getIssue(id: string): Promise<Issue | null> {
    const row = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this._rowToIssue(row)
  }

  async getIssuesByProject(projectId: string): Promise<Issue[]> {
    const rows = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE project_id = ? AND deleted_at IS NULL ORDER BY key ASC`,
    ).all(projectId) as Record<string, unknown>[]
    return rows.map((r) => this._rowToIssue(r))
  }

  private _rowToIssue(r: Record<string, unknown>): Issue {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      key: String(r.key),
      type: String(r.type),
      statusId: String(r.status_id),
      statusCategory: r.status_category as Issue['statusCategory'],
      storyPoints: rnum(r.story_points),
      storyPointsFieldId: rstr(r.story_points_field_id),
      storyPointsRaw: rstr(r.story_points_raw),
      parentId: rstr(r.parent_id),
      epicKey: rstr(r.epic_key),
      isSubtask: rb(r.is_subtask),
      hierarchyLevel: Number(r.hierarchy_level),
      assigneeIdentityId: rstr(r.assignee_identity_id),
      createdAt: String(r.created_at),
      resolvedAt: rstr(r.resolved_at),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Issue keys
  // ---------------------------------------------------------------------------

  async upsertIssueKey(issueKey: IssueKey): Promise<void> {
    this.stmt(`
      INSERT INTO issue_keys (issue_id, key, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(issue_id, key) DO UPDATE SET
        valid_from = excluded.valid_from,
        valid_to   = excluded.valid_to
    `).run(issueKey.issueId, issueKey.key, issueKey.validFrom, issueKey.validTo)
  }

  async getIssueKeys(issueId: string): Promise<IssueKey[]> {
    const rows = this.stmt(
      `SELECT issue_id, key, valid_from, valid_to FROM issue_keys WHERE issue_id = ? ORDER BY valid_from ASC`,
    ).all(issueId) as Record<string, unknown>[]
    return rows.map((r) => ({
      issueId: String(r.issue_id),
      key: String(r.key),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to),
    }))
  }

  async resolveIssueKey(key: string, at?: string): Promise<string | null> {
    const ts = at ?? new Date(8640000000000000).toISOString() // far future = "now"
    const row = this.stmt(
      `SELECT issue_id FROM issue_keys
       WHERE key = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       LIMIT 1`,
    ).get(key, ts, ts) as Record<string, unknown> | undefined
    return row ? String(row.issue_id) : null
  }

  // ---------------------------------------------------------------------------
  // Issue transitions (append-only)
  // ---------------------------------------------------------------------------

  async appendIssueTransitions(transitions: IssueTransition[]): Promise<void> {
    const insert = this.stmt(`
      INSERT OR IGNORE INTO issue_transitions
        (id, issue_id, from_status_id, to_status_id, project_id_at_transition, transitioned_at, actor_identity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const t of transitions) {
      insert.run(
        t.id,
        t.issueId,
        t.fromStatusId,
        t.toStatusId,
        t.projectIdAtTransition,
        t.transitionedAt,
        t.actorIdentityId,
      )
    }
  }

  async getIssueTransitions(issueId: string): Promise<IssueTransition[]> {
    const rows = this.stmt(
      `SELECT id, issue_id, from_status_id, to_status_id, project_id_at_transition,
              transitioned_at, actor_identity_id
       FROM issue_transitions WHERE issue_id = ? ORDER BY transitioned_at ASC`,
    ).all(issueId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      issueId: String(r.issue_id),
      fromStatusId: String(r.from_status_id),
      toStatusId: String(r.to_status_id),
      projectIdAtTransition: String(r.project_id_at_transition),
      transitionedAt: String(r.transitioned_at),
      actorIdentityId: rstr(r.actor_identity_id),
    }))
  }

  // ---------------------------------------------------------------------------
  // Sprints
  // ---------------------------------------------------------------------------

  async upsertSprint(sprint: Sprint): Promise<void> {
    this.stmt(`
      INSERT INTO sprints (id, board_id, state, start_at, end_at, complete_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state       = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.state       ELSE sprints.state       END,
        start_at    = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.start_at    ELSE sprints.start_at    END,
        end_at      = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.end_at      ELSE sprints.end_at      END,
        complete_at = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.complete_at ELSE sprints.complete_at END,
        updated_at  = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.updated_at  ELSE sprints.updated_at  END
    `).run(
      sprint.id,
      sprint.boardId,
      sprint.state,
      sprint.startAt,
      sprint.endAt,
      sprint.completeAt,
      sprint.updatedAt,
    )
  }

  async getSprint(id: string): Promise<Sprint | null> {
    const row = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at FROM sprints WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      boardId: String(row.board_id),
      state: row.state as Sprint['state'],
      startAt: rstr(row.start_at),
      endAt: rstr(row.end_at),
      completeAt: rstr(row.complete_at),
      updatedAt: String(row.updated_at),
    }
  }

  async getSprintsByBoard(boardId: string): Promise<Sprint[]> {
    const rows = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at
       FROM sprints WHERE board_id = ? ORDER BY start_at ASC`,
    ).all(boardId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      boardId: String(r.board_id),
      state: r.state as Sprint['state'],
      startAt: rstr(r.start_at),
      endAt: rstr(r.end_at),
      completeAt: rstr(r.complete_at),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Sprint membership events (append-only)
  // ---------------------------------------------------------------------------

  async appendSprintMembershipEvent(event: SprintMembershipEvent): Promise<void> {
    // INSERT OR IGNORE against the unique natural key (migration 0004) so a
    // re-sync of the same sprint does not duplicate membership events — which
    // would double-count committed/added points in velocity.
    this.stmt(`
      INSERT OR IGNORE INTO sprint_membership_events
        (sprint_id, issue_id, change, points_at_event, transitioned_at, was_present_at_start)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.sprintId,
      event.issueId,
      event.change,
      event.pointsAtEvent,
      event.transitionedAt,
      b(event.wasPresentAtStart),
    )
  }

  async getSprintMembershipEvents(sprintId: string): Promise<SprintMembershipEvent[]> {
    const rows = this.stmt(
      `SELECT sprint_id, issue_id, change, points_at_event, transitioned_at, was_present_at_start
       FROM sprint_membership_events WHERE sprint_id = ? ORDER BY transitioned_at ASC`,
    ).all(sprintId) as Record<string, unknown>[]
    return rows.map((r) => ({
      sprintId: String(r.sprint_id),
      issueId: String(r.issue_id),
      change: r.change as SprintMembershipEvent['change'],
      pointsAtEvent: rnum(r.points_at_event),
      transitionedAt: String(r.transitioned_at),
      wasPresentAtStart: rb(r.was_present_at_start),
    }))
  }

  // ---------------------------------------------------------------------------
  // Board config
  // ---------------------------------------------------------------------------

  async upsertBoardConfig(config: BoardConfig): Promise<void> {
    this.stmt(`
      INSERT INTO board_configs (board_id, type, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        type       = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.type       ELSE board_configs.type       END,
        updated_at = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.updated_at ELSE board_configs.updated_at END
    `).run(config.boardId, config.type, config.updatedAt)
  }

  async getBoardConfig(boardId: string): Promise<BoardConfig | null> {
    const row = this.stmt(
      `SELECT board_id, type, updated_at FROM board_configs WHERE board_id = ?`,
    ).get(boardId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      boardId: String(row.board_id),
      type: row.type as BoardConfig['type'],
      updatedAt: String(row.updated_at),
    }
  }

  async upsertBoardColumn(column: BoardColumn): Promise<void> {
    this.stmt(`
      INSERT INTO board_columns (board_id, column_name, status_ids, is_started_col, is_done_col)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(board_id, column_name) DO UPDATE SET
        status_ids     = excluded.status_ids,
        is_started_col = excluded.is_started_col,
        is_done_col    = excluded.is_done_col
    `).run(
      column.boardId,
      column.columnName,
      column.statusIds,
      b(column.isStartedCol),
      b(column.isDoneCol),
    )
  }

  async getBoardColumns(boardId: string): Promise<BoardColumn[]> {
    const rows = this.stmt(
      `SELECT board_id, column_name, status_ids, is_started_col, is_done_col
       FROM board_columns WHERE board_id = ?`,
    ).all(boardId) as Record<string, unknown>[]
    return rows.map((r) => ({
      boardId: String(r.board_id),
      columnName: String(r.column_name),
      statusIds: String(r.status_ids),
      isStartedCol: rb(r.is_started_col),
      isDoneCol: rb(r.is_done_col),
    }))
  }

  // ---------------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------------

  async upsertWorkflow(workflow: Workflow): Promise<void> {
    this.stmt(`
      INSERT INTO workflows (workflow_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.name       ELSE workflows.name       END,
        updated_at = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.updated_at ELSE workflows.updated_at END
    `).run(workflow.workflowId, workflow.name, workflow.updatedAt)
  }

  async getWorkflow(workflowId: string): Promise<Workflow | null> {
    const row = this.stmt(
      `SELECT workflow_id, name, updated_at FROM workflows WHERE workflow_id = ?`,
    ).get(workflowId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      workflowId: String(row.workflow_id),
      name: String(row.name),
      updatedAt: String(row.updated_at),
    }
  }

  async upsertWorkflowSchemeMapping(mapping: WorkflowSchemeMapping): Promise<void> {
    this.stmt(`
      INSERT INTO workflow_scheme_mappings (project_id, issue_type, workflow_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, issue_type) DO UPDATE SET
        workflow_id = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.workflow_id ELSE workflow_scheme_mappings.workflow_id END,
        updated_at  = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.updated_at  ELSE workflow_scheme_mappings.updated_at  END
    `).run(mapping.projectId, mapping.issueType, mapping.workflowId, mapping.updatedAt)
  }

  async getWorkflowSchemeMappings(projectId: string): Promise<WorkflowSchemeMapping[]> {
    const rows = this.stmt(
      `SELECT project_id, issue_type, workflow_id, updated_at
       FROM workflow_scheme_mappings WHERE project_id = ?`,
    ).all(projectId) as Record<string, unknown>[]
    return rows.map((r) => ({
      projectId: String(r.project_id),
      issueType: String(r.issue_type),
      workflowId: String(r.workflow_id),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  async upsertTeam(team: Team): Promise<void> {
    this.stmt(`
      INSERT INTO teams (id, name, org_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.name       ELSE teams.name       END,
        org_id     = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.org_id     ELSE teams.org_id     END,
        updated_at = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.updated_at ELSE teams.updated_at END
    `).run(team.id, team.name, team.orgId, team.updatedAt)
  }

  async getTeam(id: string): Promise<Team | null> {
    const row = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return {
      id: String(row.id),
      name: String(row.name),
      orgId: String(row.org_id),
      updatedAt: String(row.updated_at),
    }
  }

  async getTeamsByOrg(orgId: string): Promise<Team[]> {
    const rows = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE org_id = ?`).all(
      orgId,
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      orgId: String(r.org_id),
      updatedAt: String(r.updated_at),
    }))
  }

  async upsertTeamMembership(membership: TeamMembership): Promise<void> {
    this.stmt(`
      INSERT INTO team_membership (team_id, person_id, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, person_id, valid_from) DO UPDATE SET
        valid_to = excluded.valid_to
    `).run(membership.teamId, membership.personId, membership.validFrom, membership.validTo)
  }

  async getTeamMembers(teamId: string, at?: string): Promise<TeamMembership[]> {
    let sql = `SELECT team_id, person_id, valid_from, valid_to FROM team_membership WHERE team_id = ?`
    const params: SQLInputValue[] = [teamId]
    if (at) {
      sql += ` AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`
      params.push(at, at)
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      teamId: String(r.team_id),
      personId: String(r.person_id),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to),
    }))
  }

  // ---------------------------------------------------------------------------
  // PR ↔ Issue links
  // ---------------------------------------------------------------------------

  async upsertPrIssueLink(link: PrIssueLink): Promise<void> {
    this.stmt(`
      INSERT INTO pr_issue_links (pr_id, issue_id, link_source, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pr_id, issue_id, link_source) DO UPDATE SET
        confidence = excluded.confidence
    `).run(link.prId, link.issueId, link.linkSource, link.confidence)
  }

  async getPrIssueLinks(prId: string): Promise<PrIssueLink[]> {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE pr_id = ?`,
    ).all(prId) as Record<string, unknown>[]
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source as PrIssueLink['linkSource'],
      confidence: Number(r.confidence),
    }))
  }

  async getLinkedPrIds(): Promise<string[]> {
    const rows = this.stmt(`SELECT DISTINCT pr_id FROM pr_issue_links`).all() as Record<
      string,
      unknown
    >[]
    return rows.map((r) => String(r.pr_id))
  }

  async getIssuePrLinks(issueId: string): Promise<PrIssueLink[]> {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE issue_id = ?`,
    ).all(issueId) as Record<string, unknown>[]
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source as PrIssueLink['linkSource'],
      confidence: Number(r.confidence),
    }))
  }

  // ---------------------------------------------------------------------------
  // Soft deletes
  // ---------------------------------------------------------------------------

  async softDelete(table: string, id: string): Promise<void> {
    // The table name cannot be parameterised, so it is interpolated into the
    // statement. Validate it against a fixed allowlist of soft-deletable tables
    // (the only ones carrying a deleted_at column) rather than trusting callers
    // — defence-in-depth against this becoming an arbitrary-statement primitive.
    if (!SOFT_DELETABLE_TABLES.has(table)) {
      throw new Error(`softDelete: refusing unknown/non-soft-deletable table '${table}'`)
    }
    this.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now(), id)
  }

  // ---------------------------------------------------------------------------
  // Metric snapshots
  // ---------------------------------------------------------------------------

  async putSnapshot(snapshot: MetricSnapshot): Promise<void> {
    this.stmt(`
      INSERT INTO metric_snapshots
        (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
         engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, metric, day, ingest_watermark_version) DO UPDATE SET
        value                = excluded.value,
        window               = excluded.window,
        trust_tier           = excluded.trust_tier,
        data_quality         = excluded.data_quality,
        engine_version       = excluded.engine_version,
        coverage_fingerprint = excluded.coverage_fingerprint,
        computed_at          = excluded.computed_at,
        is_stale             = excluded.is_stale
    `).run(
      snapshot.scopeType,
      snapshot.scopeId,
      snapshot.metric,
      snapshot.day,
      snapshot.value,
      snapshot.window,
      snapshot.trustTier,
      snapshot.dataQuality,
      snapshot.engineVersion,
      snapshot.ingestWatermarkVersion,
      snapshot.coverageFingerprint,
      snapshot.computedAt,
      b(snapshot.isStale),
    )
  }

  async getSnapshots(
    scopeType: MetricScope,
    scopeId: string,
    metric: string,
    from: string,
    to: string,
  ): Promise<MetricSnapshot[]> {
    const rows = this.stmt(
      `SELECT scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
              engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale
       FROM metric_snapshots
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day >= ? AND day <= ?
       ORDER BY day ASC`,
    ).all(scopeType, scopeId, metric, from, to) as Record<string, unknown>[]
    return rows.map((r) => ({
      scopeType: r.scope_type as MetricScope,
      scopeId: String(r.scope_id),
      metric: String(r.metric),
      day: String(r.day),
      value: rnum(r.value),
      window: String(r.window),
      trustTier: r.trust_tier as MetricSnapshot['trustTier'],
      dataQuality: r.data_quality as MetricSnapshot['dataQuality'],
      engineVersion: String(r.engine_version),
      ingestWatermarkVersion: String(r.ingest_watermark_version),
      coverageFingerprint: String(r.coverage_fingerprint),
      computedAt: String(r.computed_at),
      isStale: rb(r.is_stale),
    }))
  }

  async markSnapshotsStale(
    scopeType: MetricScope,
    scopeId: string,
    metric: string,
    day: string,
  ): Promise<void> {
    this.stmt(
      `UPDATE metric_snapshots SET is_stale = 1
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day = ?`,
    ).run(scopeType, scopeId, metric, day)
  }

  // ---------------------------------------------------------------------------
  // AI verdicts
  // ---------------------------------------------------------------------------

  async insertAiVerdict(verdict: AiVerdict): Promise<void> {
    this.stmt(`
      INSERT INTO ai_verdicts
        (id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
         request_shape, feature_vector_json, structured_verdict_json, evidence_json,
         confidence, created_at, corrected_by, correction_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      verdict.id,
      verdict.subjectType,
      verdict.subjectId,
      verdict.metric,
      verdict.promptVersion,
      verdict.modelId,
      verdict.modelSnapshot,
      verdict.requestShape,
      verdict.featureVectorJson,
      verdict.structuredVerdictJson,
      verdict.evidenceJson,
      verdict.confidence,
      verdict.createdAt,
      verdict.correctedBy,
      verdict.correctionJson,
    )
  }

  async getAiVerdict(id: string): Promise<AiVerdict | null> {
    const row = this.stmt(
      `SELECT id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
              request_shape, feature_vector_json, structured_verdict_json, evidence_json,
              confidence, created_at, corrected_by, correction_json
       FROM ai_verdicts WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this._rowToAiVerdict(row)
  }

  async correctAiVerdict(id: string, correctedBy: string, correctionJson: string): Promise<void> {
    this.stmt(`UPDATE ai_verdicts SET corrected_by = ?, correction_json = ? WHERE id = ?`).run(
      correctedBy,
      correctionJson,
      id,
    )
  }

  private _rowToAiVerdict(r: Record<string, unknown>): AiVerdict {
    return {
      id: String(r.id),
      subjectType: String(r.subject_type),
      subjectId: String(r.subject_id),
      metric: String(r.metric),
      promptVersion: String(r.prompt_version),
      modelId: String(r.model_id),
      modelSnapshot: String(r.model_snapshot),
      requestShape: String(r.request_shape),
      featureVectorJson: String(r.feature_vector_json),
      structuredVerdictJson: String(r.structured_verdict_json),
      evidenceJson: String(r.evidence_json),
      confidence: Number(r.confidence),
      createdAt: String(r.created_at),
      correctedBy: rstr(r.corrected_by),
      correctionJson: rstr(r.correction_json),
    }
  }

  // ---------------------------------------------------------------------------
  // Flow state models
  // ---------------------------------------------------------------------------

  async upsertFlowStateModel(model: FlowStateModel): Promise<void> {
    this.stmt(`
      INSERT INTO flow_state_models
        (workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, status_id, valid_from) DO UPDATE SET
        flow_state   = excluded.flow_state,
        confidence   = excluded.confidence,
        confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at,
        valid_to     = excluded.valid_to
    `).run(
      model.workflowId,
      model.statusId,
      model.flowState,
      model.confidence,
      model.confirmedBy,
      model.confirmedAt,
      model.validFrom,
      model.validTo,
    )
  }

  async getFlowStateModel(
    workflowId: string,
    statusId: string,
    at?: string,
  ): Promise<FlowStateModel | null> {
    const ts = at ?? new Date().toISOString()
    const row = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models
       WHERE workflow_id = ? AND status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`,
    ).get(workflowId, statusId, ts, ts) as Record<string, unknown> | undefined
    if (!row) return null
    return this._rowToFlowStateModel(row)
  }

  async getFlowStateModelsByWorkflow(workflowId: string): Promise<FlowStateModel[]> {
    const rows = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models WHERE workflow_id = ? ORDER BY status_id, valid_from ASC`,
    ).all(workflowId) as Record<string, unknown>[]
    return rows.map((r) => this._rowToFlowStateModel(r))
  }

  private _rowToFlowStateModel(r: Record<string, unknown>): FlowStateModel {
    return {
      workflowId: String(r.workflow_id),
      statusId: String(r.status_id),
      flowState: r.flow_state as FlowStateModel['flowState'],
      confidence: Number(r.confidence),
      confirmedBy: rstr(r.confirmed_by),
      confirmedAt: rstr(r.confirmed_at),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to),
    }
  }

  // ---------------------------------------------------------------------------
  // Status category history
  // ---------------------------------------------------------------------------

  async upsertStatusCategoryHistory(history: StatusCategoryHistory): Promise<void> {
    this.stmt(`
      INSERT INTO status_category_history (status_id, category, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(status_id, valid_from) DO UPDATE SET
        category = excluded.category,
        valid_to = excluded.valid_to
    `).run(history.statusId, history.category, history.validFrom, history.validTo)
  }

  async getStatusCategory(
    statusId: string,
    at?: string,
  ): Promise<'new' | 'indeterminate' | 'done' | null> {
    const ts = at ?? new Date().toISOString()
    const row = this.stmt(
      `SELECT category FROM status_category_history
       WHERE status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`,
    ).get(statusId, ts, ts) as Record<string, unknown> | undefined
    if (!row) return null
    return row.category as 'new' | 'indeterminate' | 'done'
  }

  // ---------------------------------------------------------------------------
  // Sync state
  // ---------------------------------------------------------------------------

  async getSyncState(
    source: string,
    resource: string,
    scopeId: string,
  ): Promise<SyncStateCursor | null> {
    const row = this.stmt(
      `SELECT source, resource, scope_id, cursor, watermark_at, last_run_at, status, error
       FROM sync_state WHERE source = ? AND resource = ? AND scope_id = ?`,
    ).get(source, resource, scopeId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      source: String(row.source),
      resource: String(row.resource),
      scopeId: String(row.scope_id),
      cursor: rstr(row.cursor),
      watermarkAt: rstr(row.watermark_at),
      lastRunAt: rstr(row.last_run_at),
      status: row.status as SyncStateCursor['status'],
      error: rstr(row.error),
    }
  }

  async listSyncStates(): Promise<SyncStateCursor[]> {
    const rows = this.stmt(
      `SELECT source, resource, scope_id, cursor, watermark_at, last_run_at, status, error
       FROM sync_state`,
    ).all() as Record<string, unknown>[]
    return rows.map((row) => ({
      source: String(row.source),
      resource: String(row.resource),
      scopeId: String(row.scope_id),
      cursor: rstr(row.cursor),
      watermarkAt: rstr(row.watermark_at),
      lastRunAt: rstr(row.last_run_at),
      status: row.status as SyncStateCursor['status'],
      error: rstr(row.error),
    }))
  }

  async putSyncState(cursor: SyncStateCursor): Promise<void> {
    this.stmt(`
      INSERT INTO sync_state (source, resource, scope_id, cursor, watermark_at, last_run_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, resource, scope_id) DO UPDATE SET
        cursor       = excluded.cursor,
        watermark_at = excluded.watermark_at,
        last_run_at  = excluded.last_run_at,
        status       = excluded.status,
        error        = excluded.error
    `).run(
      cursor.source,
      cursor.resource,
      cursor.scopeId,
      cursor.cursor,
      cursor.watermarkAt,
      cursor.lastRunAt,
      cursor.status,
      cursor.error,
    )
  }

  // --- GDPR / erasure (WP-GDPR-SCAFFOLD) -----------------------------------

  async erasePerson(personId: string): Promise<{ erasedIdentityIds: string[] }> {
    return this.transaction(() => {
      // Collect identity rows (id + external_id) and the display name before
      // deletion — these are the identifying tokens we must purge from the
      // retained raw payloads (GDPR Art. 17 requires the subject be genuinely
      // un-attributable, not merely de-linked).
      const idRows = this.db
        .prepare('SELECT id, external_id FROM identities WHERE person_id = ?')
        .all(personId) as Array<{ id: string; external_id: string }>
      const erasedIdentityIds = idRows.map((r) => r.id)

      if (erasedIdentityIds.length > 0) {
        const person = this.db
          .prepare('SELECT display_name FROM persons WHERE id = ?')
          .get(personId) as { display_name: string } | undefined
        // External ids (login / email / account id) are high-specificity, so a
        // literal substring replacement is safe. The display name is NOT —
        // a name like "Jo" or "Sam" would corrupt unrelated text ("Same fix")
        // via blind REPLACE, so it is matched on word boundaries only. Drop
        // blanks and 1-char tokens to avoid pathological over-redaction.
        const idTokens = idRows.map((r) => r.external_id).filter((t) => t && t.length >= 2)
        const displayName = (person?.display_name ?? '').trim()
        const ph = erasedIdentityIds.map(() => '?').join(', ')

        // Find the subject's PRs/issues so we can purge AI verdicts keyed on them.
        const prIds = (
          this.db
            .prepare(
              `SELECT id FROM pull_requests WHERE author_identity_id IN (${ph}) OR merged_by_identity_id IN (${ph})`,
            )
            .all(...erasedIdentityIds, ...erasedIdentityIds) as Array<{ id: string }>
        ).map((r) => r.id)
        const issueIds = (
          this.db
            .prepare(`SELECT id FROM issues WHERE assignee_identity_id IN (${ph})`)
            .all(...erasedIdentityIds) as Array<{ id: string }>
        ).map((r) => r.id)

        // Scrub the identifying tokens out of raw payloads on rows attributable
        // to the subject. Bounded to FK-linked rows (erasure is rare).
        const scrubTargets: Array<{ table: string; cols: string[] }> = [
          { table: 'pull_requests', cols: ['author_identity_id', 'merged_by_identity_id'] },
          { table: 'reviews', cols: ['reviewer_identity_id'] },
          { table: 'review_comments', cols: ['author_identity_id'] },
          { table: 'issues', cols: ['assignee_identity_id'] },
          { table: 'commits', cols: ['author_identity_id'] },
        ]
        // Whole-word matcher for the display name (case-insensitive). Built once.
        const nameRe =
          displayName.length >= 2
            ? new RegExp(`\\b${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
            : null
        const redact = (raw: string): string => {
          let out = raw
          for (const token of idTokens) out = out.split(token).join('[ERASED]')
          if (nameRe) out = out.replace(nameRe, '[ERASED]')
          return out
        }
        for (const { table, cols } of scrubTargets) {
          const where = cols.map((c) => `${c} IN (${ph})`).join(' OR ')
          const args = cols.flatMap(() => erasedIdentityIds)
          // Use rowid (present on every ordinary table) so we don't depend on
          // each target table's primary-key column name (e.g. commits uses sha).
          const rows = this.db
            .prepare(`SELECT rowid AS rid, raw FROM ${table} WHERE ${where}`)
            .all(...args) as Array<{ rid: number; raw: string }>
          const update = this.db.prepare(`UPDATE ${table} SET raw = ? WHERE rowid = ?`)
          for (const row of rows) {
            const scrubbed = redact(row.raw)
            if (scrubbed !== row.raw) update.run(scrubbed, row.rid)
          }
        }

        // Delete AI verdicts that pertain to the subject's PRs/issues (their
        // feature vectors embed the subject's authored prose).
        const verdictSubjects = [...prIds, ...issueIds]
        if (verdictSubjects.length > 0) {
          const vph = verdictSubjects.map(() => '?').join(', ')
          this.db
            .prepare(`DELETE FROM ai_verdicts WHERE subject_id IN (${vph})`)
            .run(...verdictSubjects)
        }
      }

      // Nullify person_id on identities (keep identity rows for FK integrity,
      // but sever the person linkage so no data is attributable to the subject).
      this.db.prepare('UPDATE identities SET person_id = NULL WHERE person_id = ?').run(personId)

      // Remove team-membership rows (effective-dated; no deleted_at column).
      this.db.prepare('DELETE FROM team_membership WHERE person_id = ?').run(personId)

      // Erase the subject's survey responses (the most sensitive, perceptual
      // data). DELETE is permitted for erasure per SPEC §6.5. This MUST happen
      // before deleting the person: survey_responses.person_id is a FK and
      // PRAGMA foreign_keys=ON, so a retained row would abort the whole
      // erasure transaction (FOREIGN KEY constraint failed).
      this.db.prepare('DELETE FROM survey_responses WHERE person_id = ?').run(personId)

      // Remove the person record itself.
      this.db.prepare('DELETE FROM persons WHERE id = ?').run(personId)

      return { erasedIdentityIds }
    })
  }

  async assertOrgBound(orgId: string): Promise<void> {
    const rows = this.db.prepare('SELECT id FROM organisations WHERE id != ?').all(orgId) as Array<{
      id: string
    }>
    if (rows.length > 0) {
      throw new Error(
        `Cross-org config detected: this DB already contains data for org(s) [${rows.map((r) => r.id).join(', ')}] — refusing to bind to org '${orgId}'. Each install must use a separate DB per SPEC §6.5.`,
      )
    }
  }

  async pruneOlderThan(cutoffIso: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}

    // Soft-delete pull_requests older than cutoff.
    const prResult = this.db
      .prepare(
        `UPDATE pull_requests SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL`,
      )
      .run(now(), cutoffIso)
    counts.pull_requests = Number((prResult as { changes: number }).changes)

    // Soft-delete issues older than cutoff.
    const issueResult = this.db
      .prepare(`UPDATE issues SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL`)
      .run(now(), cutoffIso)
    counts.issues = Number((issueResult as { changes: number }).changes)

    // Hard-delete metric_snapshots (no deleted_at — versioned, prunable).
    const snapResult = this.db
      .prepare(`DELETE FROM metric_snapshots WHERE computed_at < ?`)
      .run(cutoffIso)
    counts.metric_snapshots = Number((snapResult as { changes: number }).changes)

    // Hard-delete AI verdicts older than cutoff.
    const verdictResult = this.db
      .prepare(`DELETE FROM ai_verdicts WHERE created_at < ?`)
      .run(cutoffIso)
    counts.ai_verdicts = Number((verdictResult as { changes: number }).changes)

    return counts
  }

  // ---------------------------------------------------------------------------
  // Extended organisation / Jira project list methods
  // ---------------------------------------------------------------------------

  async listOrganisations(): Promise<Organisation[]> {
    const rows = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations`,
    ).all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      githubLogin: rstr(r.github_login),
      jiraCloudId: rstr(r.jira_cloud_id),
      name: String(r.name),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  async listJiraProjects(): Promise<JiraProject[]> {
    const rows = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects`,
    ).all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      key: String(r.key),
      name: String(r.name),
      jiraCloudId: String(r.jira_cloud_id),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Extended identity methods
  // ---------------------------------------------------------------------------

  async findIdentityByExternalId(
    kind: 'github_login' | 'commit_email' | 'jira_account',
    externalId: string,
  ): Promise<Identity | null> {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE kind = ? AND external_id = ?`,
    ).get(kind, externalId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind as Identity['kind'],
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at),
    }
  }

  async listAllIdentities(): Promise<Identity[]> {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities`,
    ).all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind as Identity['kind'],
      externalId: String(r.external_id),
      isBot: rb(r.is_bot),
      confidence: Number(r.confidence),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Backfill helpers — identity resolution pass
  // ---------------------------------------------------------------------------

  async setIssueAssigneeIdentity(issueId: string, identityId: string): Promise<void> {
    this.stmt(
      `UPDATE issues SET assignee_identity_id = ? WHERE id = ? AND assignee_identity_id IS NULL`,
    ).run(identityId, issueId)
  }

  async setTransitionActorIdentity(transitionId: string, identityId: string): Promise<void> {
    this.stmt(
      `UPDATE issue_transitions SET actor_identity_id = ? WHERE id = ? AND actor_identity_id IS NULL`,
    ).run(identityId, transitionId)
  }

  // ---------------------------------------------------------------------------
  // Candidate match queue
  // ---------------------------------------------------------------------------

  async appendCandidateMatch(match: CandidateMatch): Promise<void> {
    // Normalise pair order so (A,B) and (B,A) dedup correctly.
    const [idA, idB] =
      match.identityIdA < match.identityIdB
        ? [match.identityIdA, match.identityIdB]
        : [match.identityIdB, match.identityIdA]
    this.stmt(`
      INSERT INTO candidate_matches
        (id, identity_id_a, identity_id_b, reason, confidence, status, decided_at, decided_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_id_a, identity_id_b, reason) DO NOTHING
    `).run(
      match.id,
      idA,
      idB,
      match.reason,
      match.confidence,
      match.status,
      match.decidedAt,
      match.decidedBy,
      match.createdAt,
      match.updatedAt,
    )
  }

  async getCandidateMatch(id: string): Promise<CandidateMatch | null> {
    const row = this.stmt(
      `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
              decided_at, decided_by, created_at, updated_at
       FROM candidate_matches WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return mapCandidateMatch(row)
  }

  async getCandidateMatches(status?: CandidateMatch['status']): Promise<CandidateMatch[]> {
    const rows =
      status !== undefined
        ? (this.stmt(
            `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches WHERE status = ?`,
          ).all(status) as Record<string, unknown>[])
        : (this.stmt(
            `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches`,
          ).all() as Record<string, unknown>[])
    return rows.map(mapCandidateMatch)
  }

  async resolveCandidateMatch(
    id: string,
    status: 'confirmed' | 'rejected',
    decidedBy: string,
    decidedAt: string,
  ): Promise<void> {
    const match = await this.getCandidateMatch(id)
    if (!match) throw new Error(`CandidateMatch not found: ${id}`)
    if (match.status !== 'pending') {
      throw new Error(`CandidateMatch ${id} is already resolved (${match.status})`)
    }

    // The status flip and the two identity re-links must commit atomically:
    // otherwise a crash between them leaves a `confirmed` match whose identities
    // were never merged, and the merge can never be retried (the guard above
    // refuses any non-pending match), so the person stays split forever.
    await this.transaction(async () => {
      this.stmt(
        `UPDATE candidate_matches
         SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, decidedBy, decidedAt, decidedAt, id)

      if (status === 'confirmed') {
        // Merge: link both identities to the same person.
        // Find or create a person for identityIdA; then link identityIdB to the same person.
        const identityA = await this.findIdentityById(match.identityIdA)
        const identityB = await this.findIdentityById(match.identityIdB)
        if (!identityA || !identityB) return

        // Determine target person: prefer an existing person_id, or identityA's
        const targetPersonId = identityA.personId ?? identityB.personId
        if (!targetPersonId) return // Neither has a person yet — stitchPersons should run first

        // Link both to the same person
        if (identityA.personId !== targetPersonId) {
          this.stmt(`UPDATE identities SET person_id = ?, updated_at = ? WHERE id = ?`).run(
            targetPersonId,
            decidedAt,
            identityA.id,
          )
        }
        if (identityB.personId !== targetPersonId) {
          this.stmt(`UPDATE identities SET person_id = ?, updated_at = ? WHERE id = ?`).run(
            targetPersonId,
            decidedAt,
            identityB.id,
          )
        }
      }
    })
  }

  /** Internal helper: get an identity by its primary id (not externalId). */
  private async findIdentityById(id: string): Promise<Identity | null> {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind as Identity['kind'],
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at),
    }
  }
}
