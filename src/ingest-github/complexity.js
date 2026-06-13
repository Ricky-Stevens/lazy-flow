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

/** Largest-by-change code files analysed per PR — caps the extra contents fetches. */
const MAX_FILES_PER_PR = 10

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

async function analyzeAndStore(store, client, owner, repoName, repoId, sha, path, language, now) {
  // Immutable: a (sha, path) pair's complexity never changes — analyse once.
  if (await store.hasFileComplexity(repoId, sha, path)) return
  const source = await client.getFileContentAtRef(owner, repoName, path, sha)
  if (source === null) return // absent at this ref (e.g. added file's base), binary, or >1MB

  let result
  try {
    result = await analyzeComplexity(source, language)
  } catch {
    // Unparseable (syntax the grammar rejects, partial file) — skip this file.
    return
  }

  await store.upsertFileComplexity({
    repoId,
    sha,
    path,
    language,
    loc: source.split('\n').length,
    totalCyclomatic: result.totalCyclomatic,
    functionCount: result.functions.length,
    functions: result.functions.map((fn) => ({
      name: fn.name,
      cyclomatic: fn.cyclomatic,
      cognitive: fn.cognitive,
    })),
    computedAt: now,
  })
}

/**
 * Record a PR's base/head SHAs and analyse the complexity of its changed code
 * files at both refs. `rawFiles` are the GitHub PR-files entries (filename +
 * additions/deletions). Best-effort and bounded; safe to call for every PR.
 */
export async function ingestPrComplexity(store, client, ctx) {
  const { owner, repoName, repoId, rawPr, prId, rawFiles, now } = ctx
  const baseSha = rawPr.base?.sha ?? null
  const headSha = rawPr.head?.sha ?? null

  // Record the SHA pair so the metric layer can pair base↔head complexity
  // (pull_requests stores only branch names, which are mutable / deleted on merge).
  await store.upsertPrRef({ prId, repoId, baseSha, headSha, updatedAt: now })

  if (!headSha) return

  const codeFiles = rawFiles
    .filter((f) => f.filename && languageFor(f.filename))
    .sort(
      (a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)),
    )
    .slice(0, MAX_FILES_PER_PR)

  for (const f of codeFiles) {
    const language = languageFor(f.filename)
    if (!language) continue
    await analyzeAndStore(
      store,
      client,
      owner,
      repoName,
      repoId,
      headSha,
      f.filename,
      language,
      now,
    )
    if (baseSha) {
      await analyzeAndStore(
        store,
        client,
        owner,
        repoName,
        repoId,
        baseSha,
        f.filename,
        language,
        now,
      )
    }
  }
}
