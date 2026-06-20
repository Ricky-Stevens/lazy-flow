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
  const pending = (await store.getAllPrFiles()).filter(
    (f) => (!repoId || f.repoId === repoId) && (f.patch === null || f.patch === undefined),
  )

  // Build the (deduped) blob fetch list for up to `limit` files.
  const need = new Map()
  const work = []
  for (const f of pending) {
    if (limit && work.length >= limit) break
    const ref = refByPr.get(f.prId)
    if (!ref?.headSha) continue
    need.set(`${ref.headSha}:${f.path}`, { sha: ref.headSha, path: f.path })
    if (ref.baseSha) need.set(`${ref.baseSha}:${f.path}`, { sha: ref.baseSha, path: f.path })
    work.push({ f, ref })
  }

  if (work.length === 0) {
    return {
      prFilesPending: pending.length,
      eligible: 0,
      backfilled: 0,
      skipped: 0,
      remaining: pending.length,
    }
  }

  const blobs = await client.fetchBlobs(owner, name, [...need.values()])
  const now = new Date().toISOString()
  let backfilled = 0
  let skipped = 0
  for (const { f, ref } of work) {
    const head = blobs.get(`${ref.headSha}:${f.path}`)
    // No head blob → binary / oversized / unavailable at head: leave patch null
    // (HALOC keeps its add/del fallback). An honest gap, never a fabricated diff.
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
      status: f.status,
      patch: scrubFreeText(patch),
      // Preserve the persisted classification — this row is the SAME path the
      // ingest mapper already classified, so re-derive (instead of trusting an
      // older row that predates the column) and round-trip it through the
      // upsert. Otherwise a backfill would silently flip is_generated back to 0.
      isGenerated: f.isGenerated === true,
      createdAt: f.createdAt,
      updatedAt: now,
    })
    backfilled++
  }

  return {
    prFilesPending: pending.length,
    eligible: work.length,
    backfilled,
    skipped,
    remaining: pending.length - backfilled,
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
    const repoIds = [
      ...new Set(
        (await store.getAllPrFiles())
          .filter((f) => f.patch === null || f.patch === undefined)
          .map((f) => f.repoId),
      ),
    ]
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
  const repoIds = [
    ...new Set(
      (await store.getAllPrFiles())
        .filter((f) => f.patch === null || f.patch === undefined)
        .map((f) => f.repoId),
    ),
  ]
  const repos = []
  const errors = []
  let backfilled = 0
  let skipped = 0
  let remaining = 0
  for (const repoId of repoIds) {
    // Once the budget is spent, just tally what is still outstanding.
    if (backfilled >= maxFiles) {
      remaining += (await store.getAllPrFiles()).filter(
        (f) => f.repoId === repoId && (f.patch === null || f.patch === undefined),
      ).length
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
