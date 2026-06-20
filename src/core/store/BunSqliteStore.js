/**
 * BunSqliteStore — Store implementation over Bun's built-in bun:sqlite
 * (Database). Zero native deps, fully bundleable per SPEC D5/§12.3.
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

import { Database } from 'bun:sqlite'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString()
}

/** Tables that carry a `deleted_at` column and may be soft-deleted by id. */
const SOFT_DELETABLE_TABLES = new Set(['repositories', 'pull_requests', 'issues'])

/** Convert a JS boolean to SQLite INTEGER 0/1. */
function b(v) {
  return v ? 1 : 0
}

/** Convert a SQLite INTEGER 0/1 to JS boolean. */
function rb(v) {
  return v === 1 || v === true
}

/** Coerce a nullable DB value to string | null. */
function rstr(v) {
  if (v === null || v === undefined) return null
  return String(v)
}

/** Coerce a nullable DB value to number | null. */
function rnum(v) {
  if (v === null || v === undefined) return null
  return Number(v)
}

/** Map a candidate_matches DB row to a CandidateMatch domain object. */
function mapCandidateMatch(r) {
  return {
    id: String(r.id),
    identityIdA: String(r.identity_id_a),
    identityIdB: String(r.identity_id_b),
    reason: r.reason,
    confidence: Number(r.confidence),
    status: r.status,
    decidedAt: rstr(r.decided_at),
    decidedBy: rstr(r.decided_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

// ---------------------------------------------------------------------------
// BunSqliteStore
// ---------------------------------------------------------------------------

export class BunSqliteStore {
  db

  constructor(path) {
    this.db = new Database(path)
    this.db.exec(`PRAGMA journal_mode = WAL`)
    // Under WAL, synchronous=NORMAL is durable across application crashes (only
    // an OS or power crash can lose the last few committed transactions, with
    // no DB corruption). This is the standard SQLite-perf setting under WAL and
    // is critical at ingest scale: synchronous=FULL fsyncs on every commit,
    // which dominates wall-clock when many small transactions land in a row.
    this.db.exec(`PRAGMA synchronous = NORMAL`)
    this.db.exec(`PRAGMA busy_timeout = 5000`)
    this.db.exec(`PRAGMA foreign_keys = ON`)
  }

  /** Close the underlying database connection. */
  close() {
    this.db.close()
  }

  /**
   * Run `fn` inside a single SQLite transaction. bun:sqlite (Database) is
   * synchronous and single-connection, so a BEGIN…COMMIT bracket batches every
   * write performed by `fn` into one durable commit (one WAL fsync) instead of
   * one per statement — the dominant cost of bulk ingest. Rolls back on throw.
   */
  _inTransaction = false
  async transaction(fn) {
    // Re-entrancy guard: bun:sqlite is a single connection with no nested
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
  _stmts = new Map()
  stmt(sql) {
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

  async upsertOrganisation(org) {
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

  async getOrganisation(id) {
    const row = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations WHERE id = ?`,
    ).get(id)
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

  async upsertPerson(person) {
    this.stmt(`
      INSERT INTO persons (id, display_name, primary_account_ref, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name        = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.display_name        ELSE persons.display_name        END,
        primary_account_ref = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.primary_account_ref ELSE persons.primary_account_ref END,
        updated_at          = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.updated_at          ELSE persons.updated_at          END
    `).run(person.id, person.displayName, person.primaryAccountRef, person.updatedAt)
  }

  async getPerson(id) {
    const row = this.stmt(
      `SELECT id, display_name, primary_account_ref, updated_at FROM persons WHERE id = ?`,
    ).get(id)
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

  async upsertIdentity(identity) {
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

  async getIdentitiesByPerson(personId) {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE person_id = ?`,
    ).all(personId)
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind,
      externalId: String(r.external_id),
      isBot: rb(r.is_bot),
      confidence: Number(r.confidence),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  /**
   * List every person with their identity handles attached. Used to let a user
   * pick a person for person/self scope and to fan out per-person snapshots and
   * peer-baseline cohorts. `isBot` is true when ALL of the person's identities
   * are bots, so callers can exclude automation from human cohorts.
   */
  async listPersons() {
    const persons = this.stmt(
      `SELECT id, display_name, primary_account_ref, updated_at FROM persons ORDER BY display_name ASC`,
    ).all()
    const idents = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot FROM identities WHERE person_id IS NOT NULL`,
    ).all()
    const byPerson = new Map()
    for (const i of idents) {
      const key = String(i.person_id)
      if (!byPerson.has(key)) byPerson.set(key, [])
      byPerson.get(key).push({
        id: String(i.id),
        kind: i.kind,
        externalId: String(i.external_id),
        isBot: rb(i.is_bot),
      })
    }
    return persons.map((p) => {
      const identities = byPerson.get(String(p.id)) ?? []
      return {
        id: String(p.id),
        displayName: String(p.display_name),
        primaryAccountRef: String(p.primary_account_ref),
        updatedAt: String(p.updated_at),
        identities,
        isBot: identities.length > 0 && identities.every((i) => i.isBot),
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------

  async upsertRepository(repo) {
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

  async getRepository(id) {
    const row = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE id = ? AND deleted_at IS NULL`,
    ).get(id)
    if (!row) return null
    return this._rowToRepository(row)
  }

  async getRepositoriesByOrg(orgId) {
    const rows = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE org_id = ? AND deleted_at IS NULL`,
    ).all(orgId)
    return rows.map((r) => this._rowToRepository(r))
  }

  _rowToRepository(r) {
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

  async upsertCommit(commit) {
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

  /** Set of commit SHAs already stored for a repo — lets sync skip re-detailing immutable commits. */
  async getCommitShasByRepo(repoId) {
    const rows = this.stmt(`SELECT sha FROM commits WHERE repo_id = ?`).all(repoId)
    return new Set(rows.map((r) => String(r.sha)))
  }

  async getCommitsByRepo(repoId, since, until) {
    let sql =
      `SELECT repo_id, sha, author_identity_id, authored_at, committed_at,` +
      ` additions, deletions, haloc, raw, created_at, updated_at` +
      ` FROM commits WHERE repo_id = ?`
    const params = [repoId]
    if (since) {
      sql += ` AND authored_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND authored_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY authored_at ASC`
    const rows = this.stmt(sql).all(...params)
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

  async upsertCommitAuthor(author) {
    this.stmt(`
      INSERT INTO commit_authors (repo_id, sha, identity_id, role, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha, identity_id, role) DO NOTHING
    `).run(author.repoId, author.sha, author.identityId, author.role, author.source)
  }

  async getCommitAuthors(repoId, sha) {
    const rows = this.stmt(
      `SELECT repo_id, sha, identity_id, role, source
       FROM commit_authors WHERE repo_id = ? AND sha = ?`,
    ).all(repoId, sha)
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      identityId: String(r.identity_id),
      role: r.role,
      source: r.source,
    }))
  }

  // ---------------------------------------------------------------------------
  // Pull requests
  // ---------------------------------------------------------------------------

  async upsertPullRequest(pr) {
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

  async getPullRequest(id) {
    const row = this.stmt(
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,
              is_draft, merged_via_queue, created_at, ready_at, first_commit_at,
              first_review_at, approved_at, merged_at, merged_by_identity_id,
              deleted_at, raw, updated_at
       FROM pull_requests WHERE id = ? AND deleted_at IS NULL`,
    ).get(id)
    if (!row) return null
    return this._rowToPullRequest(row)
  }

  async getPullRequestsByRepo(repoId, since, until) {
    let sql =
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,` +
      ` is_draft, merged_via_queue, created_at, ready_at, first_commit_at,` +
      ` first_review_at, approved_at, merged_at, merged_by_identity_id,` +
      ` deleted_at, raw, updated_at` +
      ` FROM pull_requests WHERE repo_id = ? AND deleted_at IS NULL`
    const params = [repoId]
    if (since) {
      sql += ` AND created_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND created_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY created_at ASC`
    const rows = this.stmt(sql).all(...params)
    return rows.map((r) => this._rowToPullRequest(r))
  }

  /**
   * Load the PRs a metric run needs for a window, keyed by the RELEVANT event
   * rather than by creation alone. A single created_at window wrongly drops
   * (a) PRs merged inside the window but opened before it, and (b) long-open
   * PRs (the very ones pr.stale exists to surface). The union covers:
   *   - created inside the window  (back-compat),
   *   - merged inside the window   (merged-PR metrics: cycle time, coverage…),
   *   - still open as of window end (open/stale metrics).
   * Soft-deleted PRs are excluded; rows are returned once (SQL OR dedupes).
   */
  async getPullRequestsForMetrics(repoId, fromIso, toIso) {
    const sql =
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,` +
      ` is_draft, merged_via_queue, created_at, ready_at, first_commit_at,` +
      ` first_review_at, approved_at, merged_at, merged_by_identity_id,` +
      ` deleted_at, raw, updated_at` +
      ` FROM pull_requests WHERE repo_id = ? AND deleted_at IS NULL AND (` +
      `   (created_at >= ? AND created_at <= ?)` +
      `   OR (merged_at IS NOT NULL AND merged_at >= ? AND merged_at <= ?)` +
      `   OR (state = 'open' AND created_at <= ?)` +
      ` ) ORDER BY created_at ASC`
    const rows = this.stmt(sql).all(repoId, fromIso, toIso, fromIso, toIso, toIso)
    return rows.map((r) => this._rowToPullRequest(r))
  }

  _rowToPullRequest(r) {
    return {
      id: String(r.id),
      repoId: String(r.repo_id),
      number: Number(r.number),
      authorIdentityId: String(r.author_identity_id),
      state: r.state,
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
  // PR files (per-file diffs)
  // ---------------------------------------------------------------------------

  async upsertPrFile(file) {
    // is_generated is REQUIRED on the writer; the mapper computes it from the
    // path. Coerce booleans (true/false) and 0/1 numbers; an undefined here
    // means a CALLER bug, but we keep the storage strict-typed by defaulting
    // to 0 so a single rogue row cannot wedge the whole sync.
    const isGenerated = file.isGenerated === true || file.isGenerated === 1 ? 1 : 0
    this.stmt(`
      INSERT INTO pr_files (pr_id, repo_id, path, additions, deletions, haloc, status, patch, is_generated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_id, path) DO UPDATE SET
        repo_id      = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.repo_id      ELSE pr_files.repo_id      END,
        additions    = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.additions    ELSE pr_files.additions    END,
        deletions    = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.deletions    ELSE pr_files.deletions    END,
        haloc        = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.haloc        ELSE pr_files.haloc        END,
        status       = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.status       ELSE pr_files.status       END,
        patch        = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.patch        ELSE pr_files.patch        END,
        is_generated = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.is_generated ELSE pr_files.is_generated END,
        updated_at   = CASE WHEN excluded.updated_at >= pr_files.updated_at THEN excluded.updated_at   ELSE pr_files.updated_at   END
    `).run(
      file.prId,
      file.repoId,
      file.path,
      file.additions,
      file.deletions,
      file.haloc,
      file.status,
      file.patch,
      isGenerated,
      file.createdAt,
      file.updatedAt,
    )
  }

  async getPrFilesByPullRequest(prId) {
    const rows = this.stmt(
      `SELECT pr_id, repo_id, path, additions, deletions, haloc, status, patch, is_generated, created_at, updated_at
       FROM pr_files WHERE pr_id = ? ORDER BY path ASC`,
    ).all(prId)
    return rows.map((r) => this._rowToPrFile(r))
  }

  async getPrFilesByRepo(repoId, since, until) {
    // Join through pull_requests so we can window on the PR's created_at and
    // exclude soft-deleted PRs (a tombstoned PR's files must not feed metrics).
    let sql =
      `SELECT f.pr_id, f.repo_id, f.path, f.additions, f.deletions, f.haloc,` +
      ` f.status, f.patch, f.is_generated, f.created_at, f.updated_at` +
      ` FROM pr_files f` +
      ` JOIN pull_requests p ON p.id = f.pr_id` +
      ` WHERE f.repo_id = ? AND p.deleted_at IS NULL`
    const params = [repoId]
    if (since) {
      sql += ` AND p.created_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND p.created_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY f.pr_id ASC, f.path ASC`
    const rows = this.stmt(sql).all(...params)
    return rows.map((r) => this._rowToPrFile(r))
  }

  _rowToPrFile(r) {
    return {
      prId: String(r.pr_id),
      repoId: String(r.repo_id),
      path: String(r.path),
      additions: Number(r.additions),
      deletions: Number(r.deletions),
      haloc: Number(r.haloc),
      status: String(r.status),
      patch: rstr(r.patch),
      // Round-trip the persisted classification as a real boolean so call-site
      // filters (`!f.isGenerated`) work regardless of whether the column came
      // back as 0/1 from SQLite, false/true from a fixture, or undefined from
      // a pre-migration row (older callers default to false → "authored").
      isGenerated: r.is_generated === 1 || r.is_generated === true,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------

  async upsertReview(review) {
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

  async getReviewsByPullRequest(prId) {
    const rows = this.stmt(
      `SELECT node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at
       FROM reviews WHERE pr_id = ? ORDER BY submitted_at ASC`,
    ).all(prId)
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      reviewerIdentityId: String(r.reviewer_identity_id),
      state: r.state,
      submittedAt: String(r.submitted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Review comments
  // ---------------------------------------------------------------------------

  async upsertReviewComment(comment) {
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

  async getReviewCommentsByPullRequest(prId) {
    const rows = this.stmt(
      `SELECT node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at
       FROM review_comments WHERE pr_id = ? ORDER BY created_at ASC`,
    ).all(prId)
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

  async upsertCheckRun(checkRun) {
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

  async getCheckRunsByRepo(repoId, headSha) {
    let sql =
      `SELECT node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at` +
      ` FROM check_runs WHERE repo_id = ?`
    const params = [repoId]
    if (headSha) {
      sql += ` AND head_sha = ?`
      params.push(headSha)
    }
    const rows = this.stmt(sql).all(...params)
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

  // -------------------------------------------------------------------------
  // Bulk loaders for the metrics snapshot backfill
  //
  // Each returns EVERY row of its table (non-deleted where applicable) in ONE
  // query, so the metrics layer can load the whole dataset once and slice
  // per-day windows in memory, instead of issuing windowed + per-parent (N+1)
  // queries for every (metric, day). Row shapes match the per-scope getters
  // exactly so the in-memory slice is byte-for-byte equivalent.
  // -------------------------------------------------------------------------

  async getAllPullRequests() {
    const rows = this.stmt(
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,
              is_draft, merged_via_queue, created_at, ready_at, first_commit_at,
              first_review_at, approved_at, merged_at, merged_by_identity_id,
              deleted_at, raw, updated_at
       FROM pull_requests WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    ).all()
    return rows.map((r) => this._rowToPullRequest(r))
  }

  async getAllReviews() {
    const rows = this.stmt(
      `SELECT node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at
       FROM reviews ORDER BY submitted_at ASC`,
    ).all()
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      reviewerIdentityId: String(r.reviewer_identity_id),
      state: r.state,
      submittedAt: String(r.submitted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  async getAllReviewComments() {
    const rows = this.stmt(
      `SELECT node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at
       FROM review_comments ORDER BY created_at ASC`,
    ).all()
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

  async getAllPrFiles() {
    // JOIN pull_requests to exclude soft-deleted PRs' files (matches getPrFilesByRepo).
    const rows = this.stmt(
      `SELECT f.pr_id, f.repo_id, f.path, f.additions, f.deletions, f.haloc,
              f.status, f.patch, f.is_generated, f.created_at, f.updated_at
       FROM pr_files f
       JOIN pull_requests p ON p.id = f.pr_id
       WHERE p.deleted_at IS NULL
       ORDER BY f.pr_id ASC, f.path ASC`,
    ).all()
    return rows.map((r) => this._rowToPrFile(r))
  }

  /**
   * pr_files for a specific set of PR ids only — for callers that have already
   * narrowed to a handful of PRs (e.g. listPendingVerdicts with limit=25) and must
   * NOT pull the whole pr_files table (millions of rows at scale). Chunked to stay
   * under SQLite's 999-variable cap; returns a Map<prId, PrFile[]>.
   */
  async getPrFilesByPrIds(prIds) {
    const byPr = new Map()
    const ids = [...new Set(prIds)]
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.stmt(
        `SELECT f.pr_id, f.repo_id, f.path, f.additions, f.deletions, f.haloc,
                f.status, f.patch, f.is_generated, f.created_at, f.updated_at
         FROM pr_files f
         JOIN pull_requests p ON p.id = f.pr_id
         WHERE p.deleted_at IS NULL AND f.pr_id IN (${placeholders})
         ORDER BY f.pr_id ASC, f.path ASC`,
      ).all(...chunk)
      for (const r of rows) {
        const file = this._rowToPrFile(r)
        if (!byPr.has(file.prId)) byPr.set(file.prId, [])
        byPr.get(file.prId).push(file)
      }
    }
    return byPr
  }

  async getAllDeployments() {
    const rows = this.stmt(
      `SELECT id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at
       FROM deployments ORDER BY created_at ASC`,
    ).all()
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      sha: String(r.sha),
      environment: String(r.environment),
      status: String(r.status),
      createdAt: String(r.created_at),
      finishedAt: rstr(r.finished_at),
      source: r.source,
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  async getAllCommits() {
    const rows = this.stmt(
      `SELECT repo_id, sha, author_identity_id, authored_at, committed_at,
              additions, deletions, haloc, raw, created_at, updated_at
       FROM commits ORDER BY authored_at ASC`,
    ).all()
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

  async getAllCheckRuns() {
    const rows = this.stmt(
      `SELECT node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at
       FROM check_runs`,
    ).all()
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

  async getAllIssueTransitions() {
    const rows = this.stmt(
      `SELECT id, issue_id, from_status_id, to_status_id, project_id_at_transition,
              transitioned_at, actor_identity_id
       FROM issue_transitions ORDER BY transitioned_at ASC`,
    ).all()
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

  /** All PR↔issue links (pr_id, issue_id) in one query — for cross-source identity
   * behavioral matching (PR author ↔ issue assignee co-occurrence). */
  async getAllPrIssueLinks() {
    const rows = this.stmt(`SELECT pr_id, issue_id FROM pr_issue_links`).all()
    return rows.map((r) => ({ prId: String(r.pr_id), issueId: String(r.issue_id) }))
  }

  /** All non-deleted issues' (id, assignee_identity_id) in one query — for
   * cross-source identity behavioral matching. */
  async getAllIssueAssignees() {
    const rows = this.stmt(
      `SELECT id, assignee_identity_id FROM issues WHERE deleted_at IS NULL`,
    ).all()
    return rows.map((r) => ({
      issueId: String(r.id),
      assigneeIdentityId: rstr(r.assignee_identity_id),
    }))
  }

  // --- AI-authorship signal ------------------------------------------------

  async upsertAiAuthorship(row) {
    this.stmt(`
      INSERT INTO ai_authorship
        (entity_type, entity_id, repo_id, author_identity_id, authored_at, ai_score, signals_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        repo_id            = excluded.repo_id,
        author_identity_id = excluded.author_identity_id,
        authored_at        = excluded.authored_at,
        ai_score           = excluded.ai_score,
        signals_json       = excluded.signals_json,
        computed_at        = excluded.computed_at
    `).run(
      row.entityType,
      row.entityId,
      row.repoId,
      row.authorIdentityId ?? null,
      row.authoredAt ?? null,
      row.aiScore,
      row.signalsJson,
      row.computedAt,
    )
  }

  /** (entity_type, entity_id) of every scored row — for incremental skip. */
  async getAiAuthorshipKeys() {
    const rows = this.stmt(`SELECT entity_type, entity_id FROM ai_authorship`).all()
    return rows.map((r) => ({ entityType: String(r.entity_type), entityId: String(r.entity_id) }))
  }

  /** Every AI-authorship row with author + score — for per-person AI-blend metrics. */
  async getAllAiAuthorship() {
    const rows = this.stmt(
      `SELECT entity_type, entity_id, repo_id, author_identity_id, authored_at, ai_score
       FROM ai_authorship`,
    ).all()
    return rows.map((r) => ({
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      repoId: String(r.repo_id),
      authorIdentityId: rstr(r.author_identity_id),
      authoredAt: rstr(r.authored_at),
      aiScore: Number(r.ai_score),
    }))
  }

  /** Every pr_refs row (PR head/base SHA) — for CI-at-merge and complexity joins. */
  async getAllPrRefs() {
    const rows = this.stmt(`SELECT pr_id, repo_id, base_sha, head_sha FROM pr_refs`).all()
    return rows.map((r) => ({
      prId: String(r.pr_id),
      repoId: String(r.repo_id),
      baseSha: rstr(r.base_sha),
      headSha: rstr(r.head_sha),
    }))
  }

  /** Every file_complexity row — for per-person complexity-weighted metrics. */
  async getAllFileComplexity() {
    const rows = this.stmt(
      `SELECT repo_id, sha, path, language, loc, total_cyclomatic, function_count, functions
       FROM file_complexity`,
    ).all()
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      path: String(r.path),
      language: String(r.language),
      loc: Number(r.loc),
      totalCyclomatic: Number(r.total_cyclomatic),
      functionCount: Number(r.function_count),
      functions: JSON.parse(String(r.functions)),
    }))
  }

  /** Every ai_verdict for a (subjectType, metric) — for per-person LLM-verdict metrics. */
  async getAiVerdictsByMetric(subjectType, metric) {
    const rows = this.stmt(
      `SELECT id, subject_type, subject_id, metric, structured_verdict_json, confidence, created_at
       FROM ai_verdicts WHERE subject_type = ? AND metric = ?`,
    ).all(subjectType, metric)
    // Guard the per-row JSON.parse: a single malformed structured_verdict_json
    // (possible under the full-transparency contract where the DB is directly
    // writable) must not throw and crash the whole metric read / person report.
    // Skip the corrupt row instead — its absence degrades the metric to a smaller
    // sample, which the sample floors already handle honestly.
    const out = []
    for (const r of rows) {
      let verdict
      try {
        verdict = JSON.parse(String(r.structured_verdict_json))
      } catch {
        continue
      }
      out.push({
        id: String(r.id),
        subjectType: String(r.subject_type),
        subjectId: String(r.subject_id),
        metric: String(r.metric),
        verdict,
        confidence: Number(r.confidence),
        createdAt: String(r.created_at),
      })
    }
    return out
  }

  // --- Repo AI-tooling maturity signal -------------------------------------

  async upsertRepoAiSignal(sig) {
    this.stmt(`
      INSERT INTO repo_ai_signals (repo_id, signal, category, present, detail, detected_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, signal) DO UPDATE SET
        category    = excluded.category,
        present     = excluded.present,
        detail      = excluded.detail,
        detected_at = excluded.detected_at
    `).run(
      sig.repoId,
      sig.signal,
      sig.category,
      sig.present ? 1 : 0,
      sig.detail ?? null,
      sig.detectedAt,
    )
  }

  // ---------------------------------------------------------------------------
  // Deployments
  // ---------------------------------------------------------------------------

  async upsertDeployment(deployment) {
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

  async getDeploymentsByRepo(repoId, since, until) {
    let sql =
      `SELECT id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at` +
      ` FROM deployments WHERE repo_id = ?`
    const params = [repoId]
    if (since) {
      sql += ` AND created_at >= ?`
      params.push(since)
    }
    if (until) {
      sql += ` AND created_at <= ?`
      params.push(until)
    }
    sql += ` ORDER BY created_at ASC`
    const rows = this.stmt(sql).all(...params)
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      sha: String(r.sha),
      environment: String(r.environment),
      status: String(r.status),
      createdAt: String(r.created_at),
      finishedAt: rstr(r.finished_at),
      source: r.source,
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  /** All deployments in the store (single-org DB). Used by the deploy↔incident linker. */
  async listAllDeployments() {
    const rows = this.stmt(
      `SELECT id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at
       FROM deployments ORDER BY created_at ASC`,
    ).all()
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      sha: String(r.sha),
      environment: String(r.environment),
      status: String(r.status),
      createdAt: String(r.created_at),
      finishedAt: rstr(r.finished_at),
      source: r.source,
      raw: String(r.raw),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Deploy ↔ incident links (DORA CFR / recovery / rework attribution)
  // ---------------------------------------------------------------------------

  async upsertDeployIncidentLink(link) {
    this.stmt(`
      INSERT INTO deploy_incident_links (deploy_id, incident_issue_id, link_type, linked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(deploy_id, incident_issue_id) DO UPDATE SET
        link_type = excluded.link_type,
        linked_at = excluded.linked_at
    `).run(link.deployId, link.incidentIssueId, link.linkType, link.linkedAt)
  }

  async getDeployIncidentLinks() {
    const rows = this.stmt(
      `SELECT deploy_id, incident_issue_id, link_type, linked_at FROM deploy_incident_links`,
    ).all()
    return rows.map((r) => ({
      deployId: String(r.deploy_id),
      incidentIssueId: String(r.incident_issue_id),
      linkType: String(r.link_type),
      linkedAt: String(r.linked_at),
    }))
  }

  /** Delete all links of a given type — used to recompute proximity links idempotently. */
  async clearDeployIncidentLinks(linkType) {
    this.stmt(`DELETE FROM deploy_incident_links WHERE link_type = ?`).run(linkType)
  }

  // ---------------------------------------------------------------------------
  // File complexity (code.complexity_delta / code.maintainability_index)
  // ---------------------------------------------------------------------------

  async upsertFileComplexity(fc) {
    this.stmt(`
      INSERT INTO file_complexity
        (repo_id, sha, path, language, loc, total_cyclomatic, function_count, functions, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha, path) DO UPDATE SET
        language = excluded.language, loc = excluded.loc,
        total_cyclomatic = excluded.total_cyclomatic, function_count = excluded.function_count,
        functions = excluded.functions, computed_at = excluded.computed_at
    `).run(
      fc.repoId,
      fc.sha,
      fc.path,
      fc.language,
      fc.loc,
      fc.totalCyclomatic,
      fc.functionCount,
      JSON.stringify(fc.functions),
      fc.computedAt,
    )
  }

  /** Whether a (sha, path) complexity row already exists — lets sync skip re-analysis (immutable). */
  async hasFileComplexity(repoId, sha, path) {
    return (
      this.stmt(
        `SELECT 1 FROM file_complexity WHERE repo_id = ? AND sha = ? AND path = ? LIMIT 1`,
      ).get(repoId, sha, path) !== null
    )
  }

  /** One file's complexity at a given sha, or null. `functions` is parsed back to an array. */
  async getFileComplexity(repoId, sha, path) {
    const r = this.stmt(
      `SELECT repo_id, sha, path, language, loc, total_cyclomatic, function_count, functions, computed_at
       FROM file_complexity WHERE repo_id = ? AND sha = ? AND path = ?`,
    ).get(repoId, sha, path)
    if (!r) return null
    return {
      repoId: String(r.repo_id),
      sha: String(r.sha),
      path: String(r.path),
      language: String(r.language),
      loc: Number(r.loc),
      totalCyclomatic: Number(r.total_cyclomatic),
      functionCount: Number(r.function_count),
      functions: JSON.parse(String(r.functions)),
      computedAt: String(r.computed_at),
    }
  }

  // ---------------------------------------------------------------------------
  // PR base/head refs (SHA pairing for complexity deltas)
  // ---------------------------------------------------------------------------

  async upsertPrRef(ref) {
    this.stmt(`
      INSERT INTO pr_refs (pr_id, repo_id, base_sha, head_sha, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pr_id) DO UPDATE SET
        base_sha = excluded.base_sha, head_sha = excluded.head_sha, updated_at = excluded.updated_at
    `).run(ref.prId, ref.repoId, ref.baseSha ?? null, ref.headSha ?? null, ref.updatedAt)
  }

  async getPrRef(prId) {
    const r = this.stmt(
      `SELECT pr_id, repo_id, base_sha, head_sha FROM pr_refs WHERE pr_id = ?`,
    ).get(prId)
    if (!r) return null
    return {
      prId: String(r.pr_id),
      repoId: String(r.repo_id),
      baseSha: rstr(r.base_sha),
      headSha: rstr(r.head_sha),
    }
  }

  // ---------------------------------------------------------------------------
  // Jira projects
  // ---------------------------------------------------------------------------

  async upsertJiraProject(project) {
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

  async getJiraProject(id) {
    const row = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects WHERE id = ?`,
    ).get(id)
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

  async upsertIssue(issue) {
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

  async getIssue(id) {
    const row = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE id = ? AND deleted_at IS NULL`,
    ).get(id)
    if (!row) return null
    return this._rowToIssue(row)
  }

  /**
   * Set an issue's parent link after the fact. Used to fill a parent reference
   * that was deferred at ingest time because the parent issue had not been
   * written yet (parent_id is a self-FK; a child synced before its parent would
   * otherwise violate it). A plain UPDATE — no updated_at gating — because this
   * is a structural backfill of an already-correct row, not new event data.
   */
  async setIssueParent(childId, parentId) {
    this.stmt(`UPDATE issues SET parent_id = ? WHERE id = ?`).run(parentId, childId)
  }

  async getIssuesByProject(projectId) {
    const rows = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE project_id = ? AND deleted_at IS NULL ORDER BY key ASC`,
    ).all(projectId)
    return rows.map((r) => this._rowToIssue(r))
  }

  /** All incident-type issues across projects (single-org DB). For deploy↔incident linking. */
  async listIncidentIssues() {
    const rows = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE lower(type) = 'incident' AND deleted_at IS NULL ORDER BY created_at ASC`,
    ).all()
    return rows.map((r) => this._rowToIssue(r))
  }

  _rowToIssue(r) {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      key: String(r.key),
      type: String(r.type),
      statusId: String(r.status_id),
      statusCategory: r.status_category,
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

  async upsertIssueKey(issueKey) {
    this.stmt(`
      INSERT INTO issue_keys (issue_id, key, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(issue_id, key) DO UPDATE SET
        valid_from = excluded.valid_from,
        valid_to   = excluded.valid_to
    `).run(issueKey.issueId, issueKey.key, issueKey.validFrom, issueKey.validTo)
  }

  async getIssueKeys(issueId) {
    const rows = this.stmt(
      `SELECT issue_id, key, valid_from, valid_to FROM issue_keys WHERE issue_id = ? ORDER BY valid_from ASC`,
    ).all(issueId)
    return rows.map((r) => ({
      issueId: String(r.issue_id),
      key: String(r.key),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to),
    }))
  }

  async resolveIssueKey(key, at) {
    const ts = at ?? new Date(8640000000000000).toISOString() // far future = "now"
    const row = this.stmt(
      `SELECT issue_id FROM issue_keys
       WHERE key = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       LIMIT 1`,
    ).get(key, ts, ts)
    return row ? String(row.issue_id) : null
  }

  // ---------------------------------------------------------------------------
  // Issue transitions (append-only)
  // ---------------------------------------------------------------------------

  async appendIssueTransitions(transitions) {
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

  async getIssueTransitions(issueId) {
    const rows = this.stmt(
      `SELECT id, issue_id, from_status_id, to_status_id, project_id_at_transition,
              transitioned_at, actor_identity_id
       FROM issue_transitions WHERE issue_id = ? ORDER BY transitioned_at ASC`,
    ).all(issueId)
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

  async upsertSprint(sprint) {
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

  async getSprint(id) {
    const row = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at FROM sprints WHERE id = ?`,
    ).get(id)
    if (!row) return null
    return {
      id: String(row.id),
      boardId: String(row.board_id),
      state: row.state,
      startAt: rstr(row.start_at),
      endAt: rstr(row.end_at),
      completeAt: rstr(row.complete_at),
      updatedAt: String(row.updated_at),
    }
  }

  async getSprintsByBoard(boardId) {
    const rows = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at
       FROM sprints WHERE board_id = ? ORDER BY start_at ASC`,
    ).all(boardId)
    return rows.map((r) => ({
      id: String(r.id),
      boardId: String(r.board_id),
      state: r.state,
      startAt: rstr(r.start_at),
      endAt: rstr(r.end_at),
      completeAt: rstr(r.complete_at),
      updatedAt: String(r.updated_at),
    }))
  }

  /**
   * Enumerate every sprint in the install, regardless of board.
   *
   * The Store has no board registry, and a sprint's board_id is an agile-board
   * id that does NOT share a namespace with Jira project ids — so probing
   * project ids as candidate board ids never discovers sprints on a real
   * install. Agile metrics enumerate sprints directly through this method.
   */
  async listAllSprints() {
    const rows = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at
       FROM sprints ORDER BY start_at ASC`,
    ).all()
    return rows.map((r) => ({
      id: String(r.id),
      boardId: String(r.board_id),
      state: r.state,
      startAt: rstr(r.start_at),
      endAt: rstr(r.end_at),
      completeAt: rstr(r.complete_at),
      updatedAt: String(r.updated_at),
    }))
  }

  // ---------------------------------------------------------------------------
  // Sprint membership events (append-only)
  // ---------------------------------------------------------------------------

  async appendSprintMembershipEvent(event) {
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

  async getSprintMembershipEvents(sprintId) {
    const rows = this.stmt(
      `SELECT sprint_id, issue_id, change, points_at_event, transitioned_at, was_present_at_start
       FROM sprint_membership_events WHERE sprint_id = ? ORDER BY transitioned_at ASC`,
    ).all(sprintId)
    return rows.map((r) => ({
      sprintId: String(r.sprint_id),
      issueId: String(r.issue_id),
      change: r.change,
      pointsAtEvent: rnum(r.points_at_event),
      transitionedAt: String(r.transitioned_at),
      wasPresentAtStart: rb(r.was_present_at_start),
    }))
  }

  // ---------------------------------------------------------------------------
  // Board config
  // ---------------------------------------------------------------------------

  async upsertBoardConfig(config) {
    this.stmt(`
      INSERT INTO board_configs (board_id, type, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        type       = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.type       ELSE board_configs.type       END,
        updated_at = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.updated_at ELSE board_configs.updated_at END
    `).run(config.boardId, config.type, config.updatedAt)
  }

  async getBoardConfig(boardId) {
    const row = this.stmt(
      `SELECT board_id, type, updated_at FROM board_configs WHERE board_id = ?`,
    ).get(boardId)
    if (!row) return null
    return {
      boardId: String(row.board_id),
      type: row.type,
      updatedAt: String(row.updated_at),
    }
  }

  async upsertBoardColumn(column) {
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

  async getBoardColumns(boardId) {
    const rows = this.stmt(
      `SELECT board_id, column_name, status_ids, is_started_col, is_done_col
       FROM board_columns WHERE board_id = ?`,
    ).all(boardId)
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

  async upsertWorkflow(workflow) {
    this.stmt(`
      INSERT INTO workflows (workflow_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.name       ELSE workflows.name       END,
        updated_at = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.updated_at ELSE workflows.updated_at END
    `).run(workflow.workflowId, workflow.name, workflow.updatedAt)
  }

  async getWorkflow(workflowId) {
    const row = this.stmt(
      `SELECT workflow_id, name, updated_at FROM workflows WHERE workflow_id = ?`,
    ).get(workflowId)
    if (!row) return null
    return {
      workflowId: String(row.workflow_id),
      name: String(row.name),
      updatedAt: String(row.updated_at),
    }
  }

  async upsertWorkflowSchemeMapping(mapping) {
    this.stmt(`
      INSERT INTO workflow_scheme_mappings (project_id, issue_type, workflow_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, issue_type) DO UPDATE SET
        workflow_id = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.workflow_id ELSE workflow_scheme_mappings.workflow_id END,
        updated_at  = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.updated_at  ELSE workflow_scheme_mappings.updated_at  END
    `).run(mapping.projectId, mapping.issueType, mapping.workflowId, mapping.updatedAt)
  }

  async getWorkflowSchemeMappings(projectId) {
    const rows = this.stmt(
      `SELECT project_id, issue_type, workflow_id, updated_at
       FROM workflow_scheme_mappings WHERE project_id = ?`,
    ).all(projectId)
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

  async upsertTeam(team) {
    this.stmt(`
      INSERT INTO teams (id, name, org_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.name       ELSE teams.name       END,
        org_id     = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.org_id     ELSE teams.org_id     END,
        updated_at = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.updated_at ELSE teams.updated_at END
    `).run(team.id, team.name, team.orgId, team.updatedAt)
  }

  async getTeam(id) {
    const row = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE id = ?`).get(id)

    if (!row) return null
    return {
      id: String(row.id),
      name: String(row.name),
      orgId: String(row.org_id),
      updatedAt: String(row.updated_at),
    }
  }

  async getTeamsByOrg(orgId) {
    const rows = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE org_id = ?`).all(
      orgId,
    )
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      orgId: String(r.org_id),
      updatedAt: String(r.updated_at),
    }))
  }

  async upsertTeamMembership(membership) {
    this.stmt(`
      INSERT INTO team_membership (team_id, person_id, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, person_id, valid_from) DO UPDATE SET
        valid_to = excluded.valid_to
    `).run(membership.teamId, membership.personId, membership.validFrom, membership.validTo)
  }

  async getTeamMembers(teamId, at) {
    let sql = `SELECT team_id, person_id, valid_from, valid_to FROM team_membership WHERE team_id = ?`
    const params = [teamId]
    if (at) {
      sql += ` AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`
      params.push(at, at)
    }
    const rows = this.stmt(sql).all(...params)
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

  async upsertPrIssueLink(link) {
    this.stmt(`
      INSERT INTO pr_issue_links (pr_id, issue_id, link_source, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pr_id, issue_id, link_source) DO UPDATE SET
        confidence = excluded.confidence
    `).run(link.prId, link.issueId, link.linkSource, link.confidence)
  }

  async getPrIssueLinks(prId) {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE pr_id = ?`,
    ).all(prId)
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source,
      confidence: Number(r.confidence),
    }))
  }

  async getLinkedPrIds() {
    const rows = this.stmt(`SELECT DISTINCT pr_id FROM pr_issue_links`).all()

    return rows.map((r) => String(r.pr_id))
  }

  async getIssuePrLinks(issueId) {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE issue_id = ?`,
    ).all(issueId)
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source,
      confidence: Number(r.confidence),
    }))
  }

  // ---------------------------------------------------------------------------
  // Soft deletes
  // ---------------------------------------------------------------------------

  async softDelete(table, id) {
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

  async putSnapshot(snapshot) {
    this.stmt(`
      INSERT INTO metric_snapshots
        (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
         engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale,
         data_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, metric, day, ingest_watermark_version) DO UPDATE SET
        value                = excluded.value,
        window               = excluded.window,
        trust_tier           = excluded.trust_tier,
        data_quality         = excluded.data_quality,
        engine_version       = excluded.engine_version,
        coverage_fingerprint = excluded.coverage_fingerprint,
        computed_at          = excluded.computed_at,
        is_stale             = excluded.is_stale,
        data_source          = excluded.data_source
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
      snapshot.dataSource ?? null,
    )
  }

  /**
   * Bulk-insert many snapshots in chunked multi-row INSERTs inside one
   * transaction. Replaces N single-row putSnapshot calls (one prepared-statement
   * round trip + the per-statement work each) during the backfill. Chunked to
   * stay under SQLite's bound-parameter limit (14 cols × rows). Upsert semantics
   * are identical to putSnapshot; the conflict key (scope,scope_id,metric,day,
   * watermark) never repeats within a chunk because metric differs per row.
   */
  async putSnapshots(snapshots) {
    if (snapshots.length === 0) return
    const COLS = 14
    const MAX_ROWS = Math.floor(900 / COLS) // 64 rows/chunk → ≤896 params (<999 cap)
    const conflict =
      ` ON CONFLICT(scope_type, scope_id, metric, day, ingest_watermark_version) DO UPDATE SET` +
      ` value = excluded.value, window = excluded.window, trust_tier = excluded.trust_tier,` +
      ` data_quality = excluded.data_quality, engine_version = excluded.engine_version,` +
      ` coverage_fingerprint = excluded.coverage_fingerprint, computed_at = excluded.computed_at,` +
      ` is_stale = excluded.is_stale, data_source = excluded.data_source`
    const rowPlaceholder = `(${Array(COLS).fill('?').join(', ')})`
    await this.transaction(async () => {
      for (let i = 0; i < snapshots.length; i += MAX_ROWS) {
        const chunk = snapshots.slice(i, i + MAX_ROWS)
        const sql =
          `INSERT INTO metric_snapshots` +
          ` (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,` +
          `  engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale,` +
          `  data_source)` +
          ` VALUES ${chunk.map(() => rowPlaceholder).join(', ')}` +
          conflict
        const params = []
        for (const s of chunk) {
          params.push(
            s.scopeType,
            s.scopeId,
            s.metric,
            s.day,
            s.value,
            s.window,
            s.trustTier,
            s.dataQuality,
            s.engineVersion,
            s.ingestWatermarkVersion,
            s.coverageFingerprint,
            s.computedAt,
            b(s.isStale),
            s.dataSource ?? null,
          )
        }
        this.stmt(sql).run(...params)
      }
    })
  }

  async getSnapshots(scopeType, scopeId, metric, from, to) {
    const rows = this.stmt(
      `SELECT scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
              engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale,
              data_source
       FROM metric_snapshots
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day >= ? AND day <= ?
       ORDER BY day ASC`,
    ).all(scopeType, scopeId, metric, from, to)
    return rows.map((r) => ({
      scopeType: r.scope_type,
      scopeId: String(r.scope_id),
      metric: String(r.metric),
      day: String(r.day),
      value: rnum(r.value),
      window: String(r.window),
      trustTier: r.trust_tier,
      dataQuality: r.data_quality,
      engineVersion: String(r.engine_version),
      ingestWatermarkVersion: String(r.ingest_watermark_version),
      coverageFingerprint: String(r.coverage_fingerprint),
      computedAt: String(r.computed_at),
      isStale: rb(r.is_stale),
      // NULL (pre-0008 rows / non-DORA metrics) → undefined, treated as proxy downstream.
      dataSource: r.data_source === 'real' || r.data_source === 'proxy' ? r.data_source : undefined,
    }))
  }

  async markSnapshotsStale(scopeType, scopeId, metric, day) {
    this.stmt(
      `UPDATE metric_snapshots SET is_stale = 1
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day = ?`,
    ).run(scopeType, scopeId, metric, day)
  }

  // --- Metric baselines (reporting layer, migration 0005) ------------------

  _rowToBaseline(r) {
    return {
      scopeType: r.scope_type,
      scopeId: String(r.scope_id),
      metric: String(r.metric),
      baselineKind: r.baseline_kind,
      periodKey: String(r.period_key),
      asOfDay: String(r.as_of_day),
      windowKind: r.window_kind,
      windowFrom: String(r.window_from),
      windowTo: String(r.window_to),
      n: Number(r.n),
      p50: rnum(r.p50),
      p75: rnum(r.p75),
      p90: rnum(r.p90),
      mean: rnum(r.mean),
      sd: rnum(r.sd),
      mad: rnum(r.mad),
      driftZ: rnum(r.drift_z),
      driftStatus: r.drift_status,
      driftCause: rstr(r.drift_cause),
      superseded: rb(r.superseded),
      trustTier: r.trust_tier,
      dataQuality: r.data_quality,
      engineVersion: String(r.engine_version),
      ingestWatermarkVersion: String(r.ingest_watermark_version),
      coverageFingerprint: String(r.coverage_fingerprint),
      baselineVersion: String(r.baseline_version),
      computedAt: String(r.computed_at),
    }
  }

  async putBaseline(baseline) {
    this.stmt(`
      INSERT INTO metric_baselines
        (scope_type, scope_id, metric, baseline_kind, period_key, as_of_day, window_kind,
         window_from, window_to, n, p50, p75, p90, mean, sd, mad, drift_z, drift_status,
         drift_cause, superseded, trust_tier, data_quality, engine_version,
         ingest_watermark_version, coverage_fingerprint, baseline_version, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, metric, baseline_kind, period_key, as_of_day, ingest_watermark_version)
      DO UPDATE SET
        window_kind = excluded.window_kind, window_from = excluded.window_from,
        window_to = excluded.window_to, n = excluded.n,
        p50 = excluded.p50, p75 = excluded.p75, p90 = excluded.p90,
        mean = excluded.mean, sd = excluded.sd, mad = excluded.mad,
        drift_z = excluded.drift_z, drift_status = excluded.drift_status,
        drift_cause = excluded.drift_cause, superseded = excluded.superseded,
        trust_tier = excluded.trust_tier, data_quality = excluded.data_quality,
        engine_version = excluded.engine_version,
        coverage_fingerprint = excluded.coverage_fingerprint,
        baseline_version = excluded.baseline_version, computed_at = excluded.computed_at
    `).run(
      baseline.scopeType,
      baseline.scopeId,
      baseline.metric,
      baseline.baselineKind,
      baseline.periodKey,
      baseline.asOfDay,
      baseline.windowKind,
      baseline.windowFrom,
      baseline.windowTo,
      baseline.n,
      baseline.p50,
      baseline.p75,
      baseline.p90,
      baseline.mean,
      baseline.sd,
      baseline.mad,
      baseline.driftZ,
      baseline.driftStatus,
      baseline.driftCause,
      b(baseline.superseded),
      baseline.trustTier,
      baseline.dataQuality,
      baseline.engineVersion,
      baseline.ingestWatermarkVersion,
      baseline.coverageFingerprint,
      baseline.baselineVersion,
      baseline.computedAt,
    )
  }

  async getBaselines(scopeType, scopeId, metric, baselineKind) {
    const base = `SELECT * FROM metric_baselines
       WHERE scope_type = ? AND scope_id = ? AND metric = ?`
    const rows =
      baselineKind === undefined
        ? this.stmt(`${base} ORDER BY as_of_day DESC`).all(scopeType, scopeId, metric)
        : this.stmt(`${base} AND baseline_kind = ? ORDER BY as_of_day DESC`).all(
            scopeType,
            scopeId,
            metric,
            baselineKind,
          )
    return rows.map((r) => this._rowToBaseline(r))
  }

  async getLatestBaseline(scopeType, scopeId, metric, baselineKind, periodKey) {
    const row = this.stmt(
      `SELECT * FROM metric_baselines
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND baseline_kind = ?
         AND period_key = ? AND superseded = 0
       ORDER BY as_of_day DESC LIMIT 1`,
    ).get(scopeType, scopeId, metric, baselineKind, periodKey)

    // bun:sqlite's .get() returns null (not undefined) when no row matches, so
    // a truthy check covers both runtimes.
    if (!row) return null
    return this._rowToBaseline(row)
  }

  async markBaselinesSuperseded(scopeType, scopeId, metric, baselineKind) {
    this.stmt(
      `UPDATE metric_baselines SET superseded = 1
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND baseline_kind = ?`,
    ).run(scopeType, scopeId, metric, baselineKind)
  }

  // ---------------------------------------------------------------------------
  // AI verdicts
  // ---------------------------------------------------------------------------

  async insertAiVerdict(verdict) {
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

  async getAiVerdict(id) {
    const row = this.stmt(
      `SELECT id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
              request_shape, feature_vector_json, structured_verdict_json, evidence_json,
              confidence, created_at, corrected_by, correction_json
       FROM ai_verdicts WHERE id = ?`,
    ).get(id)
    if (!row) return null
    return this._rowToAiVerdict(row)
  }

  async correctAiVerdict(id, correctedBy, correctionJson) {
    this.stmt(`UPDATE ai_verdicts SET corrected_by = ?, correction_json = ? WHERE id = ?`).run(
      correctedBy,
      correctionJson,
      id,
    )
  }

  /** Remove any verdicts for a (subjectType, subjectId, metric) — for idempotent re-record. */
  async deleteAiVerdictsForSubject(subjectType, subjectId, metric) {
    this.stmt(
      `DELETE FROM ai_verdicts WHERE subject_type = ? AND subject_id = ? AND metric = ?`,
    ).run(subjectType, subjectId, metric)
  }

  _rowToAiVerdict(r) {
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

  async upsertFlowStateModel(model) {
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

  async getFlowStateModel(workflowId, statusId, at) {
    const ts = at ?? new Date().toISOString()
    const row = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models
       WHERE workflow_id = ? AND status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`,
    ).get(workflowId, statusId, ts, ts)
    if (!row) return null
    return this._rowToFlowStateModel(row)
  }

  async getFlowStateModelsByWorkflow(workflowId) {
    const rows = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models WHERE workflow_id = ? ORDER BY status_id, valid_from ASC`,
    ).all(workflowId)
    return rows.map((r) => this._rowToFlowStateModel(r))
  }

  _rowToFlowStateModel(r) {
    return {
      workflowId: String(r.workflow_id),
      statusId: String(r.status_id),
      flowState: r.flow_state,
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

  async upsertStatusCategoryHistory(history) {
    this.stmt(`
      INSERT INTO status_category_history (status_id, category, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(status_id, valid_from) DO UPDATE SET
        category = excluded.category,
        valid_to = excluded.valid_to
    `).run(history.statusId, history.category, history.validFrom, history.validTo)
  }

  async getStatusCategory(statusId, at) {
    const ts = at ?? new Date().toISOString()
    const row = this.stmt(
      `SELECT category FROM status_category_history
       WHERE status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`,
    ).get(statusId, ts, ts)
    if (!row) return null
    return row.category
  }

  /**
   * Bulk-load every status's CURRENT category as a Map<statusId, category>.
   * Mirrors `getStatusCategory(statusId)` (no `at` → "now") for every status
   * id that has any history row — used by metric compute to avoid calling
   * `getStatusCategory` per status × per metric × per day in the backfill.
   */
  async getCurrentStatusCategories() {
    const ts = new Date().toISOString()
    const rows = this.stmt(
      `SELECT status_id, category, valid_from FROM status_category_history
       WHERE valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)`,
    ).all(ts, ts)
    // If multiple rows overlap "now" for the same status (shouldn't, but be
    // safe), the latest valid_from wins — matches the single-row ORDER BY DESC.
    const latest = new Map()
    for (const r of rows) {
      const statusId = String(r.status_id)
      const prev = latest.get(statusId)
      if (!prev || String(r.valid_from) > prev.validFrom) {
        latest.set(statusId, { category: r.category, validFrom: String(r.valid_from) })
      }
    }
    const out = new Map()
    for (const [statusId, v] of latest) out.set(statusId, v.category)
    return out
  }

  // ---------------------------------------------------------------------------
  // Sync state
  // ---------------------------------------------------------------------------

  async getSyncState(source, resource, scopeId) {
    const row = this.stmt(
      `SELECT source, resource, scope_id, cursor, watermark_at, last_run_at, status, error
       FROM sync_state WHERE source = ? AND resource = ? AND scope_id = ?`,
    ).get(source, resource, scopeId)
    if (!row) return null
    return {
      source: String(row.source),
      resource: String(row.resource),
      scopeId: String(row.scope_id),
      cursor: rstr(row.cursor),
      watermarkAt: rstr(row.watermark_at),
      lastRunAt: rstr(row.last_run_at),
      status: row.status,
      error: rstr(row.error),
    }
  }

  async listSyncStates() {
    const rows = this.stmt(
      `SELECT source, resource, scope_id, cursor, watermark_at, last_run_at, status, error
       FROM sync_state`,
    ).all()
    return rows.map((row) => ({
      source: String(row.source),
      resource: String(row.resource),
      scopeId: String(row.scope_id),
      cursor: rstr(row.cursor),
      watermarkAt: rstr(row.watermark_at),
      lastRunAt: rstr(row.last_run_at),
      status: row.status,
      error: rstr(row.error),
    }))
  }

  async putSyncState(cursor) {
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

  // --- Tenant isolation (SPEC §6.5) ----------------------------------------

  async assertOrgBound(orgId) {
    const rows = this.db.prepare('SELECT id FROM organisations WHERE id != ?').all(orgId)

    if (rows.length > 0) {
      throw new Error(
        `Cross-org config detected: this DB already contains data for org(s) [${rows.map((r) => r.id).join(', ')}] — refusing to bind to org '${orgId}'. Each install must use a separate DB per SPEC §6.5.`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Extended organisation / Jira project list methods
  // ---------------------------------------------------------------------------

  async listOrganisations() {
    const rows = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations`,
    ).all()
    return rows.map((r) => ({
      id: String(r.id),
      githubLogin: rstr(r.github_login),
      jiraCloudId: rstr(r.jira_cloud_id),
      name: String(r.name),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }))
  }

  async listJiraProjects() {
    const rows = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects`,
    ).all()
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

  async findIdentityByExternalId(kind, externalId) {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE kind = ? AND external_id = ?`,
    ).get(kind, externalId)
    if (!row) return null
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind,
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at),
    }
  }

  async listAllIdentities() {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities`,
    ).all()
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind,
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

  async setIssueAssigneeIdentity(issueId, identityId) {
    this.stmt(
      `UPDATE issues SET assignee_identity_id = ? WHERE id = ? AND assignee_identity_id IS NULL`,
    ).run(identityId, issueId)
  }

  async setTransitionActorIdentity(transitionId, identityId) {
    this.stmt(
      `UPDATE issue_transitions SET actor_identity_id = ? WHERE id = ? AND actor_identity_id IS NULL`,
    ).run(identityId, transitionId)
  }

  // ---------------------------------------------------------------------------
  // Candidate match queue
  // ---------------------------------------------------------------------------

  async appendCandidateMatch(match) {
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

  async getCandidateMatch(id) {
    const row = this.stmt(
      `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
              decided_at, decided_by, created_at, updated_at
       FROM candidate_matches WHERE id = ?`,
    ).get(id)
    if (!row) return null
    return mapCandidateMatch(row)
  }

  async getCandidateMatches(status) {
    const rows =
      status !== undefined
        ? this.stmt(
            `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches WHERE status = ?`,
          ).all(status)
        : this.stmt(
            `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches`,
          ).all()
    return rows.map(mapCandidateMatch)
  }

  async resolveCandidateMatch(id, status, decidedBy, decidedAt) {
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
  async findIdentityById(id) {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE id = ?`,
    ).get(id)
    if (!row) return null
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind,
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at),
    }
  }
}
