/**
 * Per-PR file-complexity ingestion (G5 — code.complexity_delta /
 * code.maintainability_index).
 *
 * GitHub exposes only diff hunks via the PR-files API, but the complexity metrics
 * need whole-file ASTs at the base AND head refs. This fetches the full file
 * contents at both refs for a merged PR's changed code files, runs the tree-sitter
 * analyzer, and caches the result per (repo, sha, path) — commits are immutable,
 * so a (sha, path) pair is analyzed once and reused across PRs/syncs.
 *
 * BOUNDED: at most MAX_FILES_PER_PR files (largest by change size) per PR, and
 * only the four tree-sitter-supported languages — so the extra contents fetches
 * stay a small, capped fraction of each sync rather than a full-tree crawl.
 * Entirely best-effort: any fetch/parse failure skips that file, never aborting
 * the PR or repo sync. Blame-based code.rework_churn is intentionally NOT covered
 * here (deferred — needs GraphQL git blame).
 */

import { analyzeComplexity } from '../code-analysis/index.js'
import { mapWithConcurrency } from '../core/index.js'

/** Largest-by-change code files analysed per PR — caps the extra contents fetches. */
const MAX_FILES_PER_PR = 10

/** Concurrent file-blob fetches+parses per PR. The blob GETs dominate; parsing
 * is CPU-bound but fast. Kept modest to stay under GitHub secondary limits. */
const COMPLEXITY_CONCURRENCY = 6

/** Map a filename extension to a tree-sitter-supported language, or undefined. */
const LANGUAGE_BY_EXT = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  go: 'go',
}

function languageFor(path) {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return undefined
  return LANGUAGE_BY_EXT[path.slice(dot + 1).toLowerCase()]
}

/**
 * Parse already-fetched source into a file-complexity row, or null when the
 * grammar rejects it. Pure (no I/O), so the per-file parse loop stays cheap.
 */
async function analyzeSource(source, repoId, sha, path, language, now) {
  let result
  try {
    result = await analyzeComplexity(source, language)
  } catch {
    // Unparseable (syntax the grammar rejects, partial file) — skip this file.
    return null
  }
  return {
    repoId,
    sha,
    path,
    language,
    // LOC = newline count, NOT split length: a trailing newline (every well-formed
    // file) would otherwise inflate the count by one via the empty final element.
    loc: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    totalCyclomatic: result.totalCyclomatic,
    functionCount: result.functions.length,
    functions: result.functions.map((fn) => ({
      name: fn.name,
      cyclomatic: fn.cyclomatic,
      cognitive: fn.cognitive,
    })),
    computedAt: now,
  }
}

/**
 * FETCH phase (no DB writes): resolve a PR's base/head SHAs and analyse the
 * complexity of its changed code files at both refs. All needed file contents
 * are fetched in ONE batched GraphQL call (`fetchBlobs`) instead of a REST
 * contents call per file — the per-file N+1 that dominated complexity ingestion.
 * Already-analysed (sha, path) pairs are skipped (immutable), so re-syncs only
 * pay for new code. Returns the pr_ref row and the file-complexity rows to write.
 */
export async function fetchPrComplexity(client, store, ctx) {
  const { repoId, rawPr, prId, rawFiles, now } = ctx
  const owner = ctx.owner
  const repoName = ctx.repoName
  const baseSha = rawPr.base?.sha ?? null
  const headSha = rawPr.head?.sha ?? null

  // The SHA pair lets the metric layer pair base↔head complexity (pull_requests
  // stores only branch names, which are mutable / deleted on merge).
  const prRef = { prId, repoId, baseSha, headSha, updatedAt: now }

  if (!headSha) return { prRef, rows: [] }

  const codeFiles = rawFiles
    .filter((f) => f.filename && languageFor(f.filename))
    .sort(
      (a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)),
    )
    .slice(0, MAX_FILES_PER_PR)

  // Build (sha, path, language) candidates — head, and base when present — and
  // drop any already analysed (a (sha, path) pair's complexity is immutable).
  const candidates = []
  for (const f of codeFiles) {
    const language = languageFor(f.filename)
    if (!language) continue
    candidates.push({ sha: headSha, path: f.filename, language })
    if (baseSha) candidates.push({ sha: baseSha, path: f.filename, language })
  }
  const todo = []
  for (const c of candidates) {
    if (!(await store.hasFileComplexity(repoId, c.sha, c.path))) todo.push(c)
  }
  if (todo.length === 0) return { prRef, rows: [] }

  // One batched GraphQL fetch for every needed blob, then parse (CPU-bound, fast)
  // each with bounded concurrency.
  const blobs = await client.fetchBlobs(
    owner,
    repoName,
    todo.map((t) => ({ sha: t.sha, path: t.path })),
  )

  const analysed = await mapWithConcurrency(todo, COMPLEXITY_CONCURRENCY, (t) => {
    const source = blobs.get(`${t.sha}:${t.path}`)
    if (source == null) return null // absent at this ref (added file's base), binary, or >1MB
    return analyzeSource(source, repoId, t.sha, t.path, t.language, now)
  })

  return { prRef, rows: analysed.filter((r) => r !== null) }
}

/**
 * REPO-WIDE batch complexity fetch: collects the changed-code-file analysis
 * candidates across EVERY PR, fetches all needed blobs in ONE chunked GraphQL
 * call (deduping (sha,path) shared across PRs), and returns a `{prRef, rows}`
 * result per PR (aligned to `items`). This replaces the per-PR blob fetch (one
 * GraphQL call PER pr) with ~O(distinctBlobs/50) calls for the whole repo.
 *
 * `items`: [{ prId, repoId, baseSha, headSha, rawFiles }].
 */
export async function fetchPrComplexityBatch(client, store, owner, repoName, items, now) {
  // Per-PR prRef + its candidate (sha, path, language) tasks.
  const perPr = []
  const globalTodo = new Map() // `${sha}:${path}` → { sha, path } (deduped)
  for (const it of items) {
    const prRef = {
      prId: it.prId,
      repoId: it.repoId,
      baseSha: it.baseSha ?? null,
      headSha: it.headSha ?? null,
      updatedAt: now,
    }
    const tasks = []
    if (it.headSha) {
      const codeFiles = (it.rawFiles ?? [])
        .filter((f) => f.filename && languageFor(f.filename))
        .sort(
          (a, b) =>
            (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)),
        )
        .slice(0, MAX_FILES_PER_PR)
      for (const f of codeFiles) {
        const language = languageFor(f.filename)
        if (!language) continue
        for (const sha of it.baseSha ? [it.headSha, it.baseSha] : [it.headSha]) {
          // eslint-disable-next-line no-await-in-loop — cheap indexed read
          if (!(await store.hasFileComplexity(it.repoId, sha, f.filename))) {
            const key = `${sha}:${f.filename}`
            tasks.push({ sha, path: f.filename, language, key })
            if (!globalTodo.has(key)) globalTodo.set(key, { sha, path: f.filename })
          }
        }
      }
    }
    perPr.push({ prRef, repoId: it.repoId, tasks })
  }

  // ONE batched fetch for every distinct blob across all PRs (fetchBlobs chunks
  // internally to 50 aliases per request).
  const blobs =
    globalTodo.size > 0
      ? await client.fetchBlobs(owner, repoName, [...globalTodo.values()])
      : new Map()

  // Parse each PR's candidates from the shared blob map.
  const results = []
  for (const { prRef, repoId, tasks } of perPr) {
    const rows = []
    for (const t of tasks) {
      const source = blobs.get(t.key)
      if (source == null) continue
      const row = await analyzeSource(source, repoId, t.sha, t.path, t.language, now)
      if (row !== null) rows.push(row)
    }
    results.push({ prRef, rows })
  }
  return results
}

/** WRITE phase (sequential, SQLite is single-writer): persist the pr_ref and the
 * file-complexity rows produced by `fetchPrComplexity`. */
export async function writePrComplexity(store, { prRef, rows }) {
  await store.upsertPrRef(prRef)
  for (const row of rows) {
    await store.upsertFileComplexity(row)
  }
}

/**
 * Convenience fetch+write for a single PR (used where prefetch isn't separated).
 * `rawFiles` are the GitHub PR-files entries. Best-effort and bounded.
 */
export async function ingestPrComplexity(store, client, ctx) {
  const fetched = await fetchPrComplexity(client, store, ctx)
  await writePrComplexity(store, fetched)
}
