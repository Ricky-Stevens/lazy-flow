/**
 * Backfill pr_files.patch — GraphQL ONLY (no REST). GitHub's GraphQL API exposes
 * no per-file patch text, but it DOES expose file CONTENT at any ref via the
 * `FileBlobs` query (client.fetchBlobs). So for each changed file lacking a patch
 * we fetch the base+head blob text and synthesise the unified diff locally
 * (synthesizeUnifiedDiff), then re-store the patch + an exact per-hunk HALOC.
 *
 * This unblocks the diff-level verdict layer (the in-session judge reading real
 * diffs) and adds per-hunk HALOC precision, without re-introducing the REST path
 * the ingestion deliberately removed. NOTE: code.haloc_aggregate does NOT depend
 * on this — it always reads the complete denormalised HALOC column, so it is
 * correct with zero, partial, or full backfill. Idempotent: already-patched files
 * are skipped, so it can run incrementally and be re-run safely.
 */

import { computeHaloc, synthesizeUnifiedDiff } from '../code-analysis/index.js'
import { scrubFreeText } from '../core/index.js'

/** Exact HALOC for a synthesised patch; falls back to add/del when degenerate. */
function halocOfPatch(path, patch, additions, deletions) {
  const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}\n`
  const r = computeHaloc(diff)
  const h = r.haloc > 0 ? r.haloc : r.binaryHaloc + r.generatedHaloc
  return h > 0 ? h : Math.max(additions, deletions)
}

/**
 * @param store   BunSqliteStore
 * @param client  GitHubClient (uses client.fetchBlobs — GraphQL)
 * @param opts    { owner, name, repoId?, limit? } — limit caps files per call
 *                (bounds blob volume); re-run to continue (idempotent).
 * Returns { prFilesPending, eligible, backfilled, skipped, remaining }.
 */
export async function backfillPrPatches(store, client, opts) {
  const { owner, name, repoId, limit } = opts
  const refByPr = new Map((await store.getAllPrRefs()).map((r) => [r.prId, r]))

  // Patch-less rows ONLY, scoped to this repo, capped at `limit` (or a sane
  // default to bound the SQL scan and the blob payload). Previously this loaded
  // EVERY pr_files row including the fat patch column and filtered in memory —
  // quadratic in the drain loop (a 50k-file repo re-read the entire
  // patch-bearing table on every chunk) and read hundreds of MB just to discard
  // already-patched rows. The new query returns only what we will actually try
  // to backfill on this call. The remaining-count for the caller comes from a
  // separate COUNT query (cheap; no patch column touched).
  const repoScope = repoId
  const chunkSize = limit && limit > 0 ? limit : 500
  // When called without a repoId, fan out across every repo with patch-less
  // rows (preserves the legacy "global" backfill behaviour). The
  // `backfillAllPatches` helper below always supplies repoId, so this branch is
  // exercised only by direct callers (tests, ad-hoc scripts).
  let pending
  let prFilesPending
  if (repoScope) {
    pending = await store.getPrFilesMissingPatchByRepo(repoScope, chunkSize)
    prFilesPending = await store.countPrFilesMissingPatchByRepo(repoScope)
  } else {
    // Direct caller did not narrow by repo. Collect pending files across all
    // repos — but we can only fetch blobs for a single (owner, name) endpoint
    // per call. Guard: if files span more than one repo the caller has not
    // supplied enough information to fetch correctly, so fail fast rather than
    // silently fetching the wrong blobs.
    const repoIdsWithWork = await store.getRepoIdsWithMissingPatches()
    if (repoIdsWithWork.length > 1) {
      throw new Error(
        'backfillPrPatches called without repoId but patch-less files span ' +
          `${repoIdsWithWork.length} repos — pass repoId to scope the call to a single repo, ` +
          'or use backfillAllPatches which handles multi-repo correctly.',
      )
    }
    pending = []
    prFilesPending = 0
    for (const id of repoIdsWithWork) {
      prFilesPending += await store.countPrFilesMissingPatchByRepo(id)
      if (pending.length < chunkSize) {
        const more = await store.getPrFilesMissingPatchByRepo(id, chunkSize - pending.length)
        for (const f of more) pending.push(f)
      }
    }
  }

  // Build the (deduped) blob fetch list for up to `chunkSize` files.
  const need = new Map()
  const work = []
  for (const f of pending) {
    if (work.length >= chunkSize) break
    const ref = refByPr.get(f.prId)
    if (!ref?.headSha) continue
    need.set(`${ref.headSha}:${f.path}`, { sha: ref.headSha, path: f.path })
    if (ref.baseSha) need.set(`${ref.baseSha}:${f.path}`, { sha: ref.baseSha, path: f.path })
    work.push({ f, ref })
  }

  if (work.length === 0) {
    return {
      prFilesPending,
      eligible: 0,
      backfilled: 0,
      skipped: 0,
      remaining: prFilesPending,
    }
  }

  const blobs = await client.fetchBlobs(owner, name, [...need.values()])
  const now = new Date().toISOString()
  let backfilled = 0
  let skipped = 0
  // Wrap the per-chunk upserts in one transaction so the chunk lands as a
  // single WAL fsync instead of one per file. At 500 files/chunk this is the
  // dominant wall-clock cost of the backfill on a real ingestion run.
  await store.transaction(async () => {
    for (const { f, ref } of work) {
      const head = blobs.get(`${ref.headSha}:${f.path}`)
      // No head blob → binary / oversized / unavailable at head: leave patch
      // null (HALOC keeps its add/del fallback). An honest gap, never a
      // fabricated diff.
      if (head === undefined || head === null) {
        skipped++
        continue
      }
      const base = ref.baseSha ? (blobs.get(`${ref.baseSha}:${f.path}`) ?? '') : ''
      const patch = synthesizeUnifiedDiff(base, head)
      if (patch === null || patch === '') {
        skipped++
        continue
      }
      await store.upsertPrFile({
        prId: f.prId,
        repoId: f.repoId,
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        haloc: halocOfPatch(f.path, patch, f.additions, f.deletions),
        patch: scrubFreeText(patch),
        // Preserve the persisted classification — this row is the SAME path the
        // ingest mapper already classified, so re-derive (instead of trusting
        // an older row that predates the column) and round-trip it through the
        // upsert. Otherwise a backfill would silently flip is_generated back
        // to 0.
        isGenerated: f.isGenerated === true,
        createdAt: f.createdAt,
        updatedAt: now,
      })
      backfilled++
    }
  })

  return {
    prFilesPending,
    eligible: work.length,
    backfilled,
    skipped,
    remaining: Math.max(0, prFilesPending - backfilled),
  }
}

/**
 * Repo-iterating backfill: process patch-less files across EVERY repo that still
 * has them, up to `maxFiles` total. Shared by the `backfill_pr_patches` MCP tool
 * and the post-sync auto-backfill hook so the iteration logic lives in one place.
 * Best-effort per repo: a repo whose blob fetch fails is recorded and skipped,
 * never aborting the others.
 *
 * @returns { backfilled, skipped, remaining, repos: [{ repo, ...res }], errors }
 */
export async function backfillAllPatches(store, client, opts = {}) {
  // Drain mode: process EVERY patch-less file across all repos to completion,
  // looping in bounded chunks. Used by the explicit `backfill_pr_patches` tool
  // (drain:true) before a verdict pass — the per-sync auto-backfill stays
  // bounded by `maxFiles` for speed. Stops a repo when it reports no remaining
  // files OR when a pass makes zero progress (the residual is genuinely
  // unfetchable — e.g. blobs deleted from history — so looping further is
  // pointless and would never terminate). The returned `remaining` is that
  // honest, irreducible residual.
  if (opts.drain) {
    const chunk = opts.chunkSize ?? 1000
    const MAX_PASSES_PER_REPO = 10_000 // safety backstop against a stuck loop
    // Discover repos with outstanding work via a targeted SQL DISTINCT — the
    // previous `getAllPrFiles().filter(...).map(repoId)` materialised the full
    // patch-bearing table (hundreds of MB) just to read a handful of distinct
    // ids.
    const repoIds = await store.getRepoIdsWithMissingPatches()
    const repos = []
    const errors = []
    let backfilled = 0
    let skipped = 0
    let remaining = 0
    for (const repoId of repoIds) {
      const repo = await store.getRepository(repoId)
      if (!repo) continue
      let repoBackfilled = 0
      let repoSkipped = 0
      let repoRemaining = 0
      let passes = 0
      while (passes++ < MAX_PASSES_PER_REPO) {
        let res
        try {
          res = await backfillPrPatches(store, client, {
            owner: repo.owner,
            name: repo.name,
            repoId,
            limit: chunk,
          })
        } catch (err) {
          errors.push(
            `${repo.owner}/${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
          )
          break
        }
        repoBackfilled += res.backfilled
        repoSkipped += res.skipped
        repoRemaining = res.remaining
        // Done, or no further progress possible (remaining files are unfetchable).
        if (res.remaining === 0 || res.backfilled === 0) break
      }
      backfilled += repoBackfilled
      skipped += repoSkipped
      remaining += repoRemaining
      repos.push({
        repo: `${repo.owner}/${repo.name}`,
        backfilled: repoBackfilled,
        skipped: repoSkipped,
        remaining: repoRemaining,
      })
    }
    return { backfilled, skipped, remaining, repos, errors, drained: true }
  }

  const maxFiles = opts.maxFiles ?? 500
  const repoIds = await store.getRepoIdsWithMissingPatches()
  const repos = []
  const errors = []
  let backfilled = 0
  let skipped = 0
  let remaining = 0
  for (const repoId of repoIds) {
    // Once the budget is spent, just tally what is still outstanding via a
    // cheap COUNT — the previous tally re-loaded the entire patch-bearing
    // pr_files table to filter in memory.
    if (backfilled >= maxFiles) {
      remaining += await store.countPrFilesMissingPatchByRepo(repoId)
      continue
    }
    const repo = await store.getRepository(repoId)
    if (!repo) continue
    try {
      const res = await backfillPrPatches(store, client, {
        owner: repo.owner,
        name: repo.name,
        repoId,
        limit: maxFiles - backfilled,
      })
      backfilled += res.backfilled
      skipped += res.skipped
      remaining += res.remaining
      repos.push({ repo: `${repo.owner}/${repo.name}`, ...res })
    } catch (err) {
      errors.push(`${repo.owner}/${repo.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { backfilled, skipped, remaining, repos, errors }
}
