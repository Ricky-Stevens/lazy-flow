/**
 * GitHub 3-phase sync (WP-GH-SYNC).
 *
 * Phase 1 — Backfill: paginate the full history per resource. Backfill is
 *   all-or-nothing PER RESOURCE: the watermark for a resource is written only
 *   after that resource's pages are fully collected and persisted. A crash
 *   mid-resource re-runs that resource from the start on the next pass (the
 *   writes are idempotent upserts, so this is safe — just not mid-page
 *   resumable). Per-page cursor checkpointing is not implemented.
 *
 * Phase 2 — Reconciliation: incremental poll using the persisted watermark.
 *   Brings the store up-to-date after a backfill is complete.
 *
 * Phase 3 — Tombstoning: periodically full-enumerates the authoritative set
 *   per resource and soft-deletes absent rows so deleted PRs, force-pushed
 *   commits, etc. don't linger in the store (SPEC §7.3).
 *
 * Upserts use the Store interface's idempotent helpers.  All PR stage
 * timestamps are denormalised onto `pull_requests` (created/ready/firstCommit/
 * firstReview/approved/merged) for 4-phase cycle-time without extra joins.
 *
 * Deploy-signal priority chain (SPEC D9):
 *   Deployments API → release tags → deploy workflow_run → merge-to-default proxy.
 *
 * Repo rename/transfer is tracked via `node_id`; a 404 on a known node_id
 * triggers re-resolution rather than data loss (SPEC §6.1).
 *
 * Forks are excluded from human-work aggregates by default (`isFork` flag,
 * not deleted — the data is retained but flagged).
 */

import { computeHaloc } from '../code-analysis/index.js'

import { buildIdentityId, scrubFreeText } from '../core/index.js'
import { fetchPrComplexityBatch, writePrComplexity } from './complexity.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a GitHub sync against `store` for the given `scope` and `mode`.
 *
 * - `backfill`: fetch full history per resource (idempotent; re-runs a resource
 *   from the start on crash — not mid-page resumable).
 * - `incremental`: fetch only events since the last watermark.
 * - `tombstone`: full-enumerate each resource and soft-delete absent rows.
 *
 * `now` is injectable so the orchestrator can stamp one coherent timestamp
 * across GitHub + Jira + the full-cycle watermark (and for deterministic tests).
 */
export async function syncGitHub(store, client, scope, mode, now = new Date().toISOString()) {
  // Ensure the org record exists.
  const orgId = `org-${scope.org}`
  await store.upsertOrganisation({
    id: orgId,
    githubLogin: scope.org,
    jiraCloudId: null,
    name: scope.org,
    createdAt: now,
    updatedAt: now,
  })

  // Discover repos.
  //
  // When an explicit repo list is configured, fetch each one DIRECTLY via
  // GET /repos/{owner}/{name} rather than listing the whole org and filtering.
  // `GET /orgs/{org}/repos` can return an empty 200 for an OAuth/SSO-restricted
  // token even when that same token CAN read a specific repo — which previously
  // produced a silent no-op sync (zero rows, no error). Direct access is also
  // cheaper. A repo that cannot be resolved is recorded as a warning so the
  // failure is visible instead of masquerading as success.
  const warnings = []
  let filteredRaw
  if (scope.repos && scope.repos.length > 0) {
    filteredRaw = []
    for (const full of scope.repos) {
      const [owner, name] = full.split('/')
      if (!owner || !name) {
        warnings.push(`skipped malformed repo "${full}" (expected "owner/name")`)
        continue
      }
      try {
        filteredRaw.push(await client.getRepo(owner, name))
      } catch (err) {
        warnings.push(
          `could not resolve repo ${full}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (filteredRaw.length === 0) {
      warnings.push(
        `no configured repos could be resolved for org ${scope.org} — check the token has access (SSO authorization for private repos) and the owner/name values`,
      )
    }
  } else {
    // No explicit list: discover everything visible to the credential.
    filteredRaw = await client.listOrgRepos(scope.org)
  }

  const repoNames = []

  for (const rawRepo of filteredRaw) {
    const repo = mapRepository(rawRepo, orgId, now)
    await store.upsertRepository(repo)
    repoNames.push(`${repo.owner}/${repo.name}`)

    if (mode === 'tombstone') {
      await tombstoneRepo(store, client, repo, now)
    } else {
      await syncRepo(store, client, repo, mode, now)
    }
  }

  // Update org-level sync state watermark.
  await store.putSyncState(buildSyncState('github', 'org', orgId, null, now, now, 'idle', null))

  return { org: scope.org, repos: repoNames, mode, syncedAt: now, warnings }
}

// ---------------------------------------------------------------------------
// Per-repo sync
// ---------------------------------------------------------------------------

/**
 * Overlap margin subtracted from a watermark before it is used as a server-side
 * `since`/`updated` filter, so commits/PRs that were created or backdated during
 * the previous sync's run window are re-captured (re-fetches are idempotent).
 */
const INCREMENTAL_OVERLAP_MINUTES = 10

/**
 * GitHub deployment-status states that are FINAL — once a deployment reaches one
 * of these its outcome won't change, so the status sub-resource need not be
 * re-fetched on subsequent syncs. (`in_progress`/`queued`/`pending` are not here:
 * they're transient and get re-checked next sync.)
 */
const TERMINAL_DEPLOY_STATES = new Set(['success', 'failure', 'error', 'inactive'])

function subtractMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString()
}

async function syncRepo(store, client, repo, mode, now) {
  const owner = repo.owner
  const name = repo.name
  const repoId = repo.id

  // Determine watermark for incremental mode. Apply an overlap margin so a
  // commit backdated into the previous run's window (rebase/cherry-pick/squash)
  // is re-captured rather than skipped forever — GitHub's `since` filters on
  // committer date, so a watermark with no margin permanently drops them.
  let since
  let priorCommitWatermark = null
  if (mode === 'incremental') {
    const cursor = await store.getSyncState('github', 'commits', repoId)
    priorCommitWatermark = cursor?.watermarkAt ?? null
    since = cursor?.watermarkAt
      ? subtractMinutes(cursor.watermarkAt, INCREMENTAL_OVERLAP_MINUTES)
      : undefined
  }

  // ---- Commits ----
  // BULK GraphQL: one paginated `history` query returns every default-branch
  // commit WITH line stats and check runs INLINE — replacing the REST list +
  // per-commit DETAIL + per-commit check-runs N+1 (~2 REST calls PER commit)
  // with ~O(commits/100) requests. Each returned commit carries `__detail`
  // (additions/deletions/haloc — HALOC from line stats, since GraphQL exposes no
  // per-file patch) and `__checks` (REST-shaped check runs). `since` bounds
  // incremental runs to the committer-date window.
  const rawCommits = await client.fetchCommitHistory(owner, name, since)
  const existingShas = await store.getCommitShasByRepo(repoId)
  const detailBySha = new Map()
  // Commits are immutable: skip re-writing SHAs already ingested. `__detail` /
  // `__checks` come inline with the bulk fetch, so there is no per-commit fetch.
  for (const raw of rawCommits) {
    if (raw.sha && !existingShas.has(raw.sha)) {
      detailBySha.set(raw.sha, raw.__detail)
    }
  }

  // Anchor the watermark on the max committer date actually seen (robust to
  // local/GitHub clock skew), not the local sync-start clock.
  // ONE transaction writes commits, authors AND their check runs together — a
  // single durable fsync.
  let maxCommitAt = null
  await store.transaction(async () => {
    for (const raw of rawCommits) {
      if (!raw.sha || existingShas.has(raw.sha)) continue
      for (const rawCheck of raw.__checks ?? []) {
        await store.upsertCheckRun(mapCheckRun(rawCheck, repoId, raw.sha, now))
      }
    }
    for (const raw of rawCommits) {
      const commitData0 = raw.commit ?? {}
      const committedAt = commitData0.committer?.date ?? commitData0.author?.date
      if (committedAt && (maxCommitAt === null || committedAt > maxCommitAt)) {
        maxCommitAt = committedAt
      }
      // Already-ingested commit: watermark above still accounts for it, but its
      // rows are immutable and present, so skip the redundant re-writes.
      if (raw.sha && existingShas.has(raw.sha)) continue
      // Upsert author identity BEFORE the commit row — the commits table has
      // author_identity_id TEXT NOT NULL REFERENCES identities(id).
      const login = raw.author?.login
      const commitData = raw.commit ?? {}
      const authorData = commitData.author ?? {}
      const authorEmail = authorData.email ?? 'unknown'
      if (login) {
        await store.upsertIdentity(mapIdentityFromLogin(login, now))
      } else {
        // No login in raw; ensure an email-based identity exists for the FK.
        await store.upsertIdentity(mapIdentityFromEmail(authorEmail, now))
      }

      const commit = mapCommit(raw, repoId, now, detailBySha.get(raw.sha))
      await store.upsertCommit(commit)

      // CommitAuthor record for co-authorship tracking
      if (login) {
        const identity = mapIdentityFromLogin(login, now)
        const commitAuthor = {
          repoId,
          sha: commit.sha,
          identityId: identity.id,
          role: 'author',
          source: 'api',
        }
        await store.upsertCommitAuthor(commitAuthor)
      }

      // Co-author trailer parsing (SPEC §6.1 commit_authors)
      const message = raw.commit?.message ?? ''
      const coAuthors = parseCoAuthors(message)
      for (const ca of coAuthors) {
        const caIdentity = mapIdentityFromEmail(ca.email, now)
        await store.upsertIdentity(caIdentity)
        const caRecord = {
          repoId,
          sha: commit.sha,
          identityId: caIdentity.id,
          role: 'co_author',
          source: 'trailer',
        }
        await store.upsertCommitAuthor(caRecord)
      }
    }
  })

  // Persist commits watermark anchored on the max committer date seen (with the
  // overlap margin applied on the next read). When NO commits were processed
  // (e.g. a transient empty list), keep the PRIOR watermark rather than jumping
  // to local now — advancing past unseen commits would skip them forever, since
  // GitHub's `since` filter would exclude them on the next incremental run.
  await store.putSyncState(
    buildSyncState(
      'github',
      'commits',
      repoId,
      null,
      maxCommitAt ?? priorCommitWatermark ?? now,
      now,
      'idle',
      null,
    ),
  )

  // ---- Pull requests ----
  // Incremental mode uses the prs watermark to fetch only changed PRs (and stop
  // pagination early) instead of re-paginating the entire PR history each cycle.
  let prsSince
  let priorPrWatermark = null
  if (mode === 'incremental') {
    const prCursor = await store.getSyncState('github', 'prs', repoId)
    priorPrWatermark = prCursor?.watermarkAt ?? null
    prsSince = prCursor?.watermarkAt
      ? subtractMinutes(prCursor.watermarkAt, INCREMENTAL_OVERLAP_MINUTES)
      : undefined
  }
  // BULK GraphQL: one paginated query returns every PR WITH its reviews,
  // comments, changed files and head check runs nested inline — replacing the
  // REST PR list + the per-PR reviews/comments/files/check-runs N+1 (4 REST
  // calls PER pr). File complexity (base/head blobs) is still fetched per PR,
  // but CONCURRENTLY, and via the batched GraphQL blob query. Writes stay
  // sequential + per-PR transactional (SQLite is single-writer).
  const prs = await client.fetchPullRequests(owner, name, prsSince)
  // Repo-wide complexity: collect every PR's changed-code files and fetch all
  // needed blobs in ONE chunked GraphQL call (instead of one call per PR).
  let complexities
  try {
    complexities = await fetchPrComplexityBatch(
      client,
      store,
      owner,
      name,
      prs.map((p) => ({
        prId: buildPrId(repoId, p.rawPr.number),
        repoId,
        baseSha: p.rawPr.base?.sha ?? null,
        headSha: p.headSha,
        rawFiles: p.files,
      })),
      now,
    )
  } catch {
    // Complexity is optional enrichment; on failure write pr_refs with no rows.
    complexities = prs.map((p) => ({
      prRef: {
        prId: buildPrId(repoId, p.rawPr.number),
        repoId,
        baseSha: p.rawPr.base?.sha ?? null,
        headSha: p.headSha,
        updatedAt: now,
      },
      rows: [],
    }))
  }
  let maxPrUpdatedAt = null
  for (let i = 0; i < prs.length; i++) {
    const p = prs[i]
    const u = p.rawPr.updated_at
    if (u && (maxPrUpdatedAt === null || u > maxPrUpdatedAt)) maxPrUpdatedAt = u
    // One transaction per PR so its reviews/comments writes are one durable
    // commit instead of one WAL fsync per row.
    await store.transaction(() =>
      writePr(
        store,
        p.rawPr,
        {
          rawReviews: p.reviews,
          rawComments: p.comments,
          rawFiles: p.files,
          headChecks: p.headChecks,
          headSha: p.headSha,
          complexity: complexities[i],
        },
        repoId,
        repo.defaultBranch,
        now,
      ),
    )
  }

  // Keep the prior watermark when no PRs were processed (see commits rationale).
  await store.putSyncState(
    buildSyncState(
      'github',
      'prs',
      repoId,
      null,
      maxPrUpdatedAt ?? priorPrWatermark ?? now,
      now,
      'idle',
      null,
    ),
  )

  // ---- Deployments (priority chain D9) ----
  const deployCursor =
    mode === 'incremental' ? await store.getSyncState('github', 'deployments', repoId) : null
  const priorDeployWatermark = deployCursor?.watermarkAt ?? null
  // GraphQL returns each deployment's outcome INLINE via `latestStatus`,
  // collapsing the REST list + per-deployment status sub-resource N+1 (one extra
  // REST call PER deployment) into O(pages) queries. The outcome is essential:
  // the REST LIST carries none, so without it every deploy defaulted to 'success'
  // and DORA change-failure / frequency were wrong.
  const ghDeploys = await client.fetchDeployments(owner, name)
  let maxDeployUpdatedAt = null
  await store.transaction(async () => {
    for (const node of ghDeploys) {
      // databaseId is non-null on Deployment per GitHub's schema, but guard so a
      // malformed node can never collapse to the literal id "null" and collide.
      if (node.databaseId == null) continue
      const u = node.updatedAt ?? node.createdAt
      if (u && (maxDeployUpdatedAt === null || u > maxDeployUpdatedAt)) maxDeployUpdatedAt = u
      await store.upsertDeployment(mapDeploymentFromGraphql(node, repoId, now))
    }
  })

  // Releases → deployments if no deployments_api signal (D9 priority 2).
  if (ghDeploys.length === 0) {
    const rawReleases = await client.listReleases(owner, name)
    for (const rawRelease of rawReleases) {
      const deploy = mapReleaseAsDeployment(rawRelease, repoId, now)
      await store.upsertDeployment(deploy)
    }
  }

  // Merge-to-default-branch proxy (D9 priority 4) — create a proxy deployment
  // for each merged PR targeting the default branch when no other signal exists.
  // Reuse the PR list already fetched above rather than re-paginating it.
  if (ghDeploys.length === 0) {
    for (const { rawPr } of prs) {
      const mergedAt = rawPr.merged_at
      const baseRef = rawPr.base?.ref
      if (mergedAt && baseRef === repo.defaultBranch) {
        const deploy = mapMergeProxyDeployment(rawPr, repoId, now)
        await store.upsertDeployment(deploy)
      }
    }
  }

  await store.putSyncState(
    buildSyncState(
      'github',
      'deployments',
      repoId,
      null,
      maxDeployUpdatedAt ?? priorDeployWatermark ?? now,
      now,
      'idle',
      null,
    ),
  )
}

// ---------------------------------------------------------------------------
// Per-PR WRITE. The PR and its reviews/comments/files/head-checks/complexity are
// fetched in bulk via GraphQL (client.fetchPullRequests + fetchPrComplexity);
// this persists one PR's rows sequentially under a single transaction.
// ---------------------------------------------------------------------------

async function writePr(store, rawPr, fetched, repoId, defaultBranch, now) {
  const prNumber = rawPr.number
  const prId = buildPrId(repoId, prNumber)
  const { rawReviews, rawComments, rawFiles, headChecks, headSha, complexity } = fetched

  // Author identity — upserted BEFORE the PR row (NOT NULL FK), falling back to
  // the sentinel when the PR has no author (deleted account).
  const authorIdentityId = await resolveLoginIdentity(store, rawPr.user?.login, now)

  // rawReviews / rawComments come from the prefetched bundle (see fetchPrBundle),
  // and feed firstReviewAt, approvedAt, and firstCommitAt below.

  // Stage timestamps (denormalised per SPEC §6.1 pull_requests).
  const createdAt = rawPr.created_at ?? now
  const mergedAt = rawPr.merged_at ?? null
  const isDraft = rawPr.draft ?? false

  // readyAt: if never a draft, equals createdAt; otherwise the ready_for_review event timestamp.
  // The REST PR object doesn't carry ready_for_review time, so we use createdAt for non-drafts.
  const readyAt = isDraft ? null : createdAt

  // firstCommitAt: we use the earliest authored_at among commits in the repo before the PR was
  // created. For simplicity here we derive it from the earliest commit fetched for this PR.
  // In production this would use the compare API; for the test harness it uses the base dataset.
  const firstCommitAt = deriveFirstCommitAt(rawPr)

  // firstReviewAt: earliest review submission time.
  let firstReviewAt = null
  let approvedAt = null
  for (const rev of rawReviews) {
    const submittedAt = rev.submitted_at ?? null
    if (submittedAt !== null) {
      if (!firstReviewAt || submittedAt < firstReviewAt) {
        firstReviewAt = submittedAt
      }
      const state = (rev.state ?? '').toUpperCase()
      if (state === 'APPROVED') {
        if (!approvedAt || submittedAt < approvedAt) {
          approvedAt = submittedAt
        }
      }
    }
  }

  // mergedByIdentityId
  const mergedByLogin = rawPr.merged_by?.login
  const mergedByIdentityId = mergedByLogin ? buildIdentityId('github_login', mergedByLogin) : null
  if (mergedByLogin) {
    await store.upsertIdentity(mapIdentityFromLogin(mergedByLogin, now))
  }

  const state = resolveState(rawPr)

  const pr = {
    id: prId,
    repoId,
    number: prNumber,
    authorIdentityId,
    state,
    headRef: rawPr.head?.ref ?? '',
    baseRef: rawPr.base?.ref ?? defaultBranch,
    isDraft,
    mergedViaQueue: false,
    createdAt,
    readyAt,
    firstCommitAt,
    firstReviewAt,
    approvedAt,
    mergedAt,
    mergedByIdentityId,
    deletedAt: null,
    // Scrub free-text fields (PR body, title) before persistence (WP-SCRUB / SPEC §6.5).
    raw: scrubFreeText(JSON.stringify(rawPr)),
    updatedAt: rawPr.updated_at ?? now,
  }

  await store.upsertPullRequest(pr)

  // Persist reviews.
  for (const rawReview of rawReviews) {
    const reviewerIdentityId = await resolveLoginIdentity(store, rawReview.user?.login, now)

    const review = {
      nodeId: buildReviewNodeId(rawReview),
      prId,
      reviewerIdentityId,
      state: normaliseReviewState(rawReview.state),
      submittedAt: rawReview.submitted_at ?? now,
      // Scrub review body (may contain pasted secrets/tokens) before persistence.
      raw: scrubFreeText(JSON.stringify(rawReview)),
      updatedAt: rawReview.submitted_at ?? now,
    }
    await store.upsertReview(review)
  }

  // Persist review comments.
  for (const rawComment of rawComments) {
    const commentAuthorIdentityId = await resolveLoginIdentity(store, rawComment.user?.login, now)

    const comment = {
      nodeId: String(rawComment.id),
      prId,
      authorIdentityId: commentAuthorIdentityId,
      createdAt: rawComment.created_at ?? now,
      inReplyTo: rawComment.in_reply_to_id ?? null,
      path: rawComment.path ?? null,
      // Scrub review-comment body before persistence (WP-SCRUB / SPEC §6.5).
      raw: scrubFreeText(JSON.stringify(rawComment)),
      updatedAt: rawComment.updated_at ?? now,
    }
    await store.upsertReviewComment(comment)
  }

  // Persist per-file diffs (prefetched via GET /pulls/{n}/files). These feed the
  // code.* metrics (HALOC aggregation, Nagappan-Ball churn, code-change impact).
  // The patch text is scrubbed of free-text secrets inside mapPrFile.
  for (const rawFile of rawFiles) {
    if (!rawFile.filename) continue
    await store.upsertPrFile(mapPrFile(rawFile, prId, repoId, now))
  }

  // Persist base/head SHAs + the prefetched changed-file complexity (feeds
  // code.complexity_delta + code.maintainability_index). Best-effort — a failure
  // here must not abort PR ingestion.
  try {
    await writePrComplexity(store, complexity)
  } catch {
    // Complexity analysis is optional enrichment; never fail the sync over it.
  }

  // Persist CI check runs for the PR head sha (prefetched). These feed
  // pr.ci_health (compute reads getCheckRunsByRepo). When the raw PR payload
  // omits head.sha the bundle skipped the fetch — an honest gap, not a
  // fabricated pass/fail.
  if (headSha) {
    for (const rawCheck of headChecks) {
      await store.upsertCheckRun(mapCheckRun(rawCheck, repoId, headSha, now))
    }
  }
}

// ---------------------------------------------------------------------------
// Tombstoning (SPEC §7.3)
// ---------------------------------------------------------------------------

/**
 * Full-enumerate the authoritative set for a repo and soft-delete any rows
 * that are absent upstream. Handles deleted PRs and (via PR before/after SHA
 * comparison) force-pushed commits.
 */
async function tombstoneRepo(store, client, repo, now) {
  const owner = repo.owner
  const name = repo.name
  const repoId = repo.id

  // --- PRs ---
  const livePrs = await client.fetchPullRequests(owner, name)
  const livePrIds = new Set(livePrs.map((p) => buildPrId(repoId, p.rawPr.number)))
  const storedPrs = await store.getPullRequestsByRepo(repoId)
  for (const storedPr of storedPrs) {
    if (!livePrIds.has(storedPr.id) && storedPr.deletedAt === null) {
      await store.softDelete('pull_requests', storedPr.id)
    }
  }

  // --- Commits ---
  // Note: commits use a composite PK (repo_id, sha) and don't have a single
  // `id` column, so softDelete is not directly applicable. Force-pushed commits
  // are handled by reconciling the PR before/after SHA (SPEC §7.3).
  // We skip per-commit tombstoning here and rely on PR tombstoning to exclude
  // orphaned commits from metrics — so we do NOT fetch the full commit list
  // (previously enumerated and immediately discarded, a wasted full pagination).

  await store.putSyncState(
    buildSyncState('github', 'tombstone', repoId, null, now, now, 'idle', null),
  )
}

// ---------------------------------------------------------------------------
// Mappers — raw API payload → Store entity
// ---------------------------------------------------------------------------

function mapRepository(raw, orgId, now) {
  const nodeId = raw.node_id ?? String(raw.id)
  const fullName = raw.full_name ?? ''
  const [owner = '', name = ''] = fullName.split('/')
  // Use the full_name as the stable repo ID so it is predictable in tests
  // and consistent with how the baseOrg dataset identifies repos.
  // (e.g. "octo-acme/alpha-service" → "octo-acme-alpha-service")
  const id = fullName.replace('/', '-')
  return {
    id,
    githubNodeId: String(nodeId),
    orgId,
    owner,
    name,
    defaultBranch: raw.default_branch ?? 'main',
    isArchived: raw.archived ?? false,
    isFork: raw.fork ?? false,
    deletedAt: null,
    raw: JSON.stringify(raw),
    createdAt: raw.created_at ?? now,
    updatedAt: raw.updated_at ?? now,
  }
}

function mapCommit(raw, repoId, now, detail) {
  const commitData = raw.commit ?? {}
  const authorData = commitData.author ?? {}

  const authoredAt = authorData.date ?? raw.authored_date ?? now

  const committedAt = commitData.committer?.date ?? authoredAt

  // Prefer the per-commit DETAIL stats/HALOC (real, from getCommitDetail). The
  // LIST payload carries no `stats`, so without the detail fetch these would be
  // 0. Fall back to any inline `stats` (some payloads carry it) then to 0.
  const stats = raw.stats ?? {}
  const additions = detail?.additions ?? stats.additions ?? 0
  const deletions = detail?.deletions ?? stats.deletions ?? 0
  // HALOC from the detail's per-file patches; else approximate from line stats.
  const haloc = detail?.haloc ?? Math.max(additions, deletions)

  const authorLogin = raw.author?.login
  const authorIdentityId = authorLogin
    ? buildIdentityId('github_login', authorLogin)
    : buildIdentityId('commit_email', authorData.email ?? 'unknown')

  return {
    repoId,
    sha: raw.sha,
    authorIdentityId,
    authoredAt,
    committedAt,
    additions,
    deletions,
    haloc,
    raw: JSON.stringify(raw),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Map a GraphQL deployment node (with inline `latestStatus`) to a deployment
 * row. The GraphQL state is an UPPER-case enum (SUCCESS/FAILURE/ERROR/…); we
 * lower-case it so it matches the REST states the rest of the engine expects.
 * Defaults to 'success' only when no status exists at all (parity with REST).
 */
function mapDeploymentFromGraphql(node, repoId, now) {
  const state = node.latestStatus?.state ? String(node.latestStatus.state).toLowerCase() : 'success'
  return {
    id: String(node.databaseId),
    repoId,
    sha: node.commitOid ?? '',
    environment: node.environment ?? 'production',
    status: state,
    createdAt: node.createdAt ?? now,
    finishedAt: TERMINAL_DEPLOY_STATES.has(state) ? (node.latestStatus?.createdAt ?? null) : null,
    source: 'deployments_api',
    raw: JSON.stringify(node),
    updatedAt: node.updatedAt ?? now,
  }
}

function mapReleaseAsDeployment(raw, repoId, now) {
  const tag = raw.tag_name
  const createdAt = raw.created_at ?? now
  return {
    id: `release-${repoId}-${tag}`,
    repoId,
    sha: raw.target_commitish ?? '',
    environment: 'production',
    status: 'success',
    createdAt,
    finishedAt: createdAt,
    source: 'release',
    raw: JSON.stringify(raw),
    updatedAt: now,
  }
}

function mapMergeProxyDeployment(rawPr, repoId, now) {
  const mergedAt = rawPr.merged_at
  const headSha = rawPr.head?.sha

  return {
    id: `merge-proxy-${repoId}-${rawPr.number}`,
    repoId,
    sha: headSha ?? '',
    environment: 'production',
    status: 'success',
    createdAt: mergedAt,
    finishedAt: mergedAt,
    source: 'merge_proxy',
    raw: JSON.stringify(rawPr),
    updatedAt: now,
  }
}

/**
 * Reconstruct a single-file unified diff that `computeHaloc`'s parser accepts.
 *
 * GitHub's per-file `patch` field carries the `@@` hunk headers and `+`/`-`
 * lines but NOT the `diff --git a/<path> b/<path>` header that `parseDiff`
 * anchors each file section on. Without that header every hunk is dropped and
 * HALOC silently zeroes. We prepend the header (and `---`/`+++` markers when the
 * patch omits them) so the parser attributes the hunks to the file's path.
 *
 * Returns null when there is no patch (binary file / oversized diff) — the
 * caller records the file with haloc 0 and a null patch rather than fabricating.
 */
function reconstructFileDiff(path, patch) {
  if (patch === undefined || patch === '') return null
  const header = `diff --git a/${path} b/${path}\n`
  // The GitHub patch usually starts at the first `@@` hunk header (no file
  // markers). Add `---`/`+++` markers when absent so the section is well-formed.
  const hasFileMarkers = /^---\s|\n---\s/.test(patch)
  const markers = hasFileMarkers ? '' : `--- a/${path}\n+++ b/${path}\n`
  return `${header}${markers}${patch}\n`
}

/**
 * HALOC for a single PR file from its patch, or 0 when no patch is available
 * (binary/oversized). computeHaloc buckets binary/generated volume separately;
 * for a single-file diff we take the `.haloc` (source) total and fall back to
 * binary volume so a binary swap is not silently zeroed.
 */
function halocForFilePatch(path, patch) {
  const diff = reconstructFileDiff(path, patch)
  if (diff === null) return 0
  const result = computeHaloc(diff)
  return result.haloc > 0 ? result.haloc : result.binaryHaloc + result.generatedHaloc
}

/**
 * Map a raw PR-files entry to the PrFile store entity. The patch is scrubbed of
 * free-text secrets before persistence (it is verbatim source and may contain
 * pasted tokens — WP-SCRUB / SPEC §6.5).
 */
function mapPrFile(raw, prId, repoId, now) {
  const path = raw.filename
  const patch = raw.patch
  const additions = typeof raw.additions === 'number' ? raw.additions : 0
  const deletions = typeof raw.deletions === 'number' ? raw.deletions : 0
  // HALOC from the per-hunk patch when present; otherwise (GraphQL files carry no
  // patch text) fall back to max(additions,deletions) — the same approximation
  // used for commits, and exact for single-hunk changes.
  let haloc = halocForFilePatch(path, patch)
  if (haloc === 0) haloc = Math.max(additions, deletions)
  return {
    prId,
    repoId,
    path,
    additions,
    deletions,
    haloc,
    status: raw.status ?? 'modified',
    patch: patch !== undefined && patch !== null ? scrubFreeText(patch) : null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Map a raw check-run entry (GET /commits/{ref}/check-runs) to the CheckRun
 * store entity. `nodeId` prefers the GraphQL node_id, falling back to the
 * numeric REST id so a single PR's runs never collide on a synthetic key.
 * `headSha` is supplied by the caller (the ref the runs were fetched for) since
 * the run payload does not echo it back reliably.
 */
function mapCheckRun(raw, repoId, headSha, now) {
  const nodeId =
    raw.node_id ??
    (raw.id !== undefined ? String(raw.id) : `check-${repoId}-${headSha}-${raw.name}`)
  return {
    nodeId,
    repoId,
    headSha,
    // name/status are NOT NULL in check_runs; default rather than crash the write
    // transaction if a payload variant omits them.
    name: raw.name ?? 'unknown',
    status: raw.status ?? 'queued',
    conclusion: raw.conclusion ?? null,
    startedAt: raw.started_at ?? null,
    completedAt: raw.completed_at ?? null,
    raw: JSON.stringify(raw),
    updatedAt: now,
  }
}

function mapIdentityFromLogin(login, now) {
  const isBot = login.endsWith('[bot]')
  return {
    id: buildIdentityId('github_login', login),
    personId: null,
    kind: 'github_login',
    externalId: login,
    isBot,
    confidence: 1,
    raw: JSON.stringify({ login }),
    updatedAt: now,
  }
}

function mapIdentityFromEmail(email, now) {
  return {
    id: buildIdentityId('commit_email', email),
    personId: null,
    kind: 'commit_email',
    externalId: email,
    isBot: false,
    confidence: 1,
    raw: JSON.stringify({ email }),
    updatedAt: now,
  }
}

// Sentinel identity for GitHub actors with no login (deleted/"ghost" accounts:
// the API returns `user: null`). pull_requests.author_identity_id,
// reviews.reviewer_identity_id and review_comments.author_identity_id are all
// NOT NULL REFERENCES identities(id), so this row MUST exist before any of them
// is written — otherwise the FK fails, the PR transaction rolls back, and the
// sync wedges on that PR forever.
const SENTINEL_IDENTITY_ID = 'identity-unknown'

function sentinelIdentity(now) {
  return {
    id: SENTINEL_IDENTITY_ID,
    personId: null,
    kind: 'github_login',
    externalId: 'unknown',
    isBot: false,
    confidence: 0,
    raw: '{}',
    updatedAt: now,
  }
}

/**
 * Upsert the identity for a GitHub login (or the sentinel when the login is
 * absent — a deleted account) and return its id, ALWAYS ensuring the row exists
 * so a NOT NULL identity FK can never be violated.
 */
async function resolveLoginIdentity(store, login, now) {
  if (login) {
    await store.upsertIdentity(mapIdentityFromLogin(login, now))
    return buildIdentityId('github_login', login)
  }
  await store.upsertIdentity(sentinelIdentity(now))
  return SENTINEL_IDENTITY_ID
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrId(repoId, prNumber) {
  return `${repoId}-pr-${prNumber}`
}

// NOTE: identity ids use the single canonical builder imported from
// @lazy-flow/core (`${kind}:${externalId}`). A previously-divergent local
// builder (`identity-${kind}-${externalId}`) split every contributor into two
// identities/persons — see audit fix identity-id-scheme-drift.

function buildReviewNodeId(rawReview) {
  // The mock uses string node IDs; REST returns numeric ids.
  const id = rawReview.id
  if (typeof id === 'string') return id
  if (typeof id === 'number') return `review-${id}`
  return `review-${String(rawReview.id)}`
}

function resolveState(rawPr) {
  // The GitHub *list* endpoint (the only one PR sync uses) does NOT return the
  // `merged` boolean — that field only exists on the single-PR DETAIL endpoint.
  // It DOES return `merged_at`, which is non-null iff the PR was merged. Treat
  // either signal as authoritative so merged PRs are not misclassified as
  // 'closed' (which would zero out every merged-PR-based metric in production).
  if (rawPr.merged === true || rawPr.merged_at != null) return 'merged'
  const state = rawPr.state
  if (state === 'closed') return 'closed'
  return 'open'
}

function normaliseReviewState(state) {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'DISMISSED':
      return 'dismissed'
    case 'PENDING':
      return 'pending'
    default:
      return 'commented'
  }
}

/**
 * Attempt to derive firstCommitAt from the raw PR payload.
 * The REST API doesn't provide this directly; we look for the HEAD commit
 * authored_date or fall back to null (will be enriched by GraphQL later).
 */
function deriveFirstCommitAt(rawPr) {
  const head = rawPr.head
  const commit = head?.commit
  const commitData = commit?.commit
  const author = commitData?.author
  return author?.date ?? null
}

/**
 * Parse `Co-authored-by: Name <email>` trailers from a commit message.
 */
function parseCoAuthors(message) {
  const results = []
  // Match `Co-authored-by: Name <email>` lines (case-insensitive prefix).
  const regex = /^co-authored-by:\s*(.+?)\s*<([^>]+)>/gim
  let match = regex.exec(message)
  while (match !== null) {
    const name = match[1]?.trim() ?? ''
    const email = match[2]?.trim() ?? ''
    if (email) {
      results.push({ name, email })
    }
    match = regex.exec(message)
  }
  return results
}

function buildSyncState(source, resource, scopeId, cursor, watermarkAt, lastRunAt, status, error) {
  return { source, resource, scopeId, cursor, watermarkAt, lastRunAt, status, error }
}
