/**
 * Backfill pr_files.patch — GraphQL ONLY (no REST). GitHub's GraphQL API exposes
 * no per-file patch text, but it DOES expose file CONTENT at any ref via the
 * `FileBlobs` query (client.fetchBlobs). So for each changed file lacking a patch
 * we fetch the base+head blob text and synthesise the unified diff locally
 * (synthesizeUnifiedDiff), then re-store the patch + an exact per-hunk HALOC.
 *
 * This unblocks diff-level signals (exact code.haloc_aggregate + the in-session
 * verdict layer's ability to read real diffs) without re-introducing the REST
 * path the ingestion deliberately removed. Idempotent: already-patched files are
 * skipped, so it can run incrementally and be re-run safely.
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
