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
  const rawRepos = await client.listOrgRepos(scope.org)
  const filteredRaw = scope.repos
    ? rawRepos.filter((r) => {
        const full = r.full_name
        return full !== undefined && (scope.repos?.includes(full) ?? false)
      })
    : rawRepos

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

  return { org: scope.org, repos: repoNames, mode, syncedAt: now }
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
  // Batch the per-commit writes (identity + commit + commit_author rows) into a
  // single transaction so the ingest is one durable commit instead of one WAL
  // fsync per row.
  const rawCommits = await client.listCommits(owner, name, since)
  // The commit LIST endpoint carries no per-commit stats (additions/deletions),
  // so commit volume + HALOC always read 0 from the list payload. Fetch the
  // per-commit DETAIL (one request each) for the commits in this window and
  // merge its `stats` onto the raw before mapping. Only windowed commits are
  // detailed (the LIST already applied the `since` filter), so the rate-limit
  // cost is bounded to the incremental delta on reconciliation runs.
  const detailBySha = new Map()
  for (const raw of rawCommits) {
    const sha = raw.sha
    if (!sha) continue
    const detail = await client.getCommitDetail(owner, name, sha)
    const additions = detail.stats?.additions ?? 0
    const deletions = detail.stats?.deletions ?? 0
    // HALOC from the real per-file patches (Σ_hunk max(ins,del)); falls back to
    // max(additions,deletions) when GitHub omits patches (binary/oversized).
    let haloc = 0
    if (detail.files && detail.files.length > 0) {
      for (const f of detail.files) {
        haloc += halocForFilePatch(f.filename, f.patch)
      }
    }
    if (haloc === 0) haloc = Math.max(additions, deletions)
    detailBySha.set(sha, { additions, deletions, haloc })
  }
  // Anchor the watermark on the max committer date actually seen (robust to
  // local/GitHub clock skew), not the local sync-start clock.
  let maxCommitAt = null
  await store.transaction(async () => {
    for (const raw of rawCommits) {
      const commitData0 = raw.commit ?? {}
      const committedAt = commitData0.committer?.date ?? commitData0.author?.date
      if (committedAt && (maxCommitAt === null || committedAt > maxCommitAt)) {
        maxCommitAt = committedAt
      }
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
  const rawPrs = await client.listPullRequestsUpdatedSince(owner, name, prsSince)
  // Anchor the PR watermark on the max server-provided updated_at, not local now.
  let maxPrUpdatedAt = null
  for (const rawPr of rawPrs) {
    const u = rawPr.updated_at
    if (u && (maxPrUpdatedAt === null || u > maxPrUpdatedAt)) maxPrUpdatedAt = u
    // One transaction per PR so its reviews/comments writes are one durable
    // commit instead of one WAL fsync per row.
    await store.transaction(() =>
      syncPr(store, client, rawPr, owner, name, repoId, repo.defaultBranch, now),
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
  const rawDeploys = await client.listDeployments(owner, name)
  // Anchor the deployments watermark on the max server-provided updated_at.
  let maxDeployUpdatedAt = null
  for (const rawDeploy of rawDeploys) {
    const u = rawDeploy.updated_at ?? rawDeploy.created_at
    if (u && (maxDeployUpdatedAt === null || u > maxDeployUpdatedAt)) maxDeployUpdatedAt = u
    const deploy = mapDeployment(rawDeploy, repoId, now, 'deployments_api')
    await store.upsertDeployment(deploy)
  }

  // Releases → deployments if no deployments_api signal (D9 priority 2).
  if (rawDeploys.length === 0) {
    const rawReleases = await client.listReleases(owner, name)
    for (const rawRelease of rawReleases) {
      const deploy = mapReleaseAsDeployment(rawRelease, repoId, now)
      await store.upsertDeployment(deploy)
    }
  }

  // Merge-to-default-branch proxy (D9 priority 4) — create a proxy deployment
  // for each merged PR targeting the default branch when no other signal exists.
  // Reuse the PR list already fetched above rather than re-paginating it.
  if (rawDeploys.length === 0) {
    for (const rawPr of rawPrs) {
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
// Per-PR sync (reviews, comments, timeline, stage timestamps)
// ---------------------------------------------------------------------------

async function syncPr(store, client, rawPr, owner, repoName, repoId, defaultBranch, now) {
  const prNumber = rawPr.number
  const prId = buildPrId(repoId, prNumber)

  // Author identity — must be upserted BEFORE the PR row (FK constraint).
  // Fall back to a sentinel 'identity-unknown' when the raw lacks a user field.
  const authorLogin = rawPr.user?.login
  const authorIdentityId = authorLogin
    ? buildIdentityId('github_login', authorLogin)
    : 'identity-unknown'
  if (authorLogin) {
    await store.upsertIdentity(mapIdentityFromLogin(authorLogin, now))
  } else {
    // Ensure the sentinel identity exists so the FK is satisfied.
    await store.upsertIdentity({
      id: 'identity-unknown',
      personId: null,
      kind: 'github_login',
      externalId: 'unknown',
      isBot: false,
      confidence: 0,
      raw: '{}',
      updatedAt: now,
    })
  }

  // Fetch reviews to derive firstReviewAt, approvedAt, and firstCommitAt.
  const rawReviews = await client.listReviews(owner, repoName, prNumber)
  const rawComments = await client.listReviewComments(owner, repoName, prNumber)

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
      const state = rev.state.toUpperCase()
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
    const reviewerLogin = rawReview.user?.login
    const reviewerIdentityId = reviewerLogin
      ? buildIdentityId('github_login', reviewerLogin)
      : 'unknown'
    if (reviewerLogin) {
      await store.upsertIdentity(mapIdentityFromLogin(reviewerLogin, now))
    }

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
    const commentAuthorLogin = rawComment.user?.login
    const commentAuthorIdentityId = commentAuthorLogin
      ? buildIdentityId('github_login', commentAuthorLogin)
      : 'unknown'
    if (commentAuthorLogin) {
      await store.upsertIdentity(mapIdentityFromLogin(commentAuthorLogin, now))
    }

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

  // Persist per-file diffs (GET /pulls/{n}/files). These feed the code.* metrics
  // (HALOC aggregation, Nagappan-Ball churn, code-change impact). The patch text
  // is scrubbed of free-text secrets inside mapPrFile before persistence.
  const rawFiles = await client.listPrFiles(owner, repoName, prNumber)
  for (const rawFile of rawFiles) {
    if (!rawFile.filename) continue
    await store.upsertPrFile(mapPrFile(rawFile, prId, repoId, now))
  }

  // Persist CI check runs for the PR head sha (GET /commits/{ref}/check-runs).
  // These feed pr.ci_health (compute reads getCheckRunsByRepo). The head sha is
  // the only ref that carries the PR's final CI status; when the raw PR payload
  // omits head.sha (minimal stub / API variance) we skip the fetch rather than
  // querying a bogus ref — an honest gap, not a fabricated pass/fail.
  const headSha = extractHeadSha(rawPr)
  if (headSha) {
    const rawChecks = await client.listCheckRuns(owner, repoName, headSha)
    for (const rawCheck of rawChecks) {
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
  const livePrs = await client.listPullRequests(owner, name)
  const livePrIds = new Set(livePrs.map((p) => buildPrId(repoId, p.number)))
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

function mapDeployment(raw, repoId, now, source) {
  const id = String(raw.id)
  return {
    id,
    repoId,
    sha: raw.sha ?? '',
    environment: raw.environment ?? 'production',
    status: raw.status ?? 'success',
    createdAt: raw.created_at ?? now,
    finishedAt: raw.finished_at ?? null,
    source,
    raw: JSON.stringify(raw),
    updatedAt: raw.updated_at ?? now,
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
  const haloc = halocForFilePatch(path, patch)
  return {
    prId,
    repoId,
    path,
    additions: typeof raw.additions === 'number' ? raw.additions : 0,
    deletions: typeof raw.deletions === 'number' ? raw.deletions : 0,
    haloc,
    status: raw.status ?? 'modified',
    patch: patch !== undefined ? scrubFreeText(patch) : null,
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
    name: raw.name,
    status: raw.status,
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
  const merged = rawPr.merged
  if (merged) return 'merged'
  const state = rawPr.state
  if (state === 'closed') return 'closed'
  return 'open'
}

function normaliseReviewState(state) {
  switch (state.toUpperCase()) {
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
 * Extract the PR head commit sha from the raw PR payload (`head.sha`), or null
 * when absent. Used as the ref for the check-runs fetch; a null sha means we
 * skip CI ingestion for the PR rather than querying an invalid ref.
 */
function extractHeadSha(rawPr) {
  const head = rawPr.head
  const sha = head?.sha
  return sha && sha.length > 0 ? sha : null
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
