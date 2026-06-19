import { describe, expect, it } from 'bun:test'
import { migrate } from '../core/migrate/runner.js'
import { BunSqliteStore } from '../core/store/BunSqliteStore.js'
import { ingestPrComplexity } from './complexity.js'

function makeStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  // Seed only the complexity/ref rows we assert on; skip repo/PR FK parents.
  store.db.exec('PRAGMA foreign_keys = OFF')
  return store
}

// Stub client: head source has a branch (cyclomatic 2), base source is straight-line.
// Mirrors the GraphQL fetchBlobs contract: returns a Map keyed `"<sha>:<path>"`.
function makeClient() {
  return {
    fetchBlobs: async (_owner, _repo, refPaths) => {
      const m = new Map()
      for (const { sha, path } of refPaths) {
        m.set(
          `${sha}:${path}`,
          sha === 'head1'
            ? 'export function f(a) { if (a) { return 1 } return 2 }'
            : 'export function f() { return 1 }',
        )
      }
      return m
    },
  }
}

describe('ingestPrComplexity', () => {
  it('records PR base/head SHAs and analyses changed code files at both refs', async () => {
    const store = makeStore()
    await ingestPrComplexity(store, makeClient(), {
      owner: 'o',
      repoName: 'r',
      repoId: 'repo-1',
      prId: 'pr-1',
      now: '2024-01-01T00:00:00Z',
      rawPr: { base: { sha: 'base1' }, head: { sha: 'head1' } },
      rawFiles: [
        { filename: 'src/foo.ts', additions: 10, deletions: 2 },
        { filename: 'README.md', additions: 5, deletions: 0 }, // non-code → skipped
      ],
    })

    const ref = await store.getPrRef('pr-1')
    expect(ref?.headSha).toBe('head1')
    expect(ref?.baseSha).toBe('base1')

    const headC = await store.getFileComplexity('repo-1', 'head1', 'src/foo.ts')
    expect(headC).not.toBeNull()
    expect(headC?.language).toBe('typescript')
    expect(headC?.functionCount).toBeGreaterThanOrEqual(1)
    // head has an `if` branch → higher cyclomatic than the straight-line base.
    const baseC = await store.getFileComplexity('repo-1', 'base1', 'src/foo.ts')
    expect(baseC).not.toBeNull()
    expect(headC?.totalCyclomatic).toBeGreaterThan(baseC?.totalCyclomatic ?? 0)

    // Non-code file is never fetched/analysed.
    expect(await store.getFileComplexity('repo-1', 'head1', 'README.md')).toBeNull()
  })

  it('records the ref pair but analyses nothing when head sha is absent', async () => {
    const store = makeStore()
    await ingestPrComplexity(store, makeClient(), {
      owner: 'o',
      repoName: 'r',
      repoId: 'repo-1',
      prId: 'pr-2',
      now: '2024-01-01T00:00:00Z',
      rawPr: { base: { ref: 'main' }, head: { ref: 'feature' } }, // no SHAs
      rawFiles: [{ filename: 'src/foo.ts', additions: 1, deletions: 0 }],
    })
    const ref = await store.getPrRef('pr-2')
    expect(ref).not.toBeNull()
    expect(ref?.headSha).toBeNull()
    expect(await store.getFileComplexity('repo-1', 'head1', 'src/foo.ts')).toBeNull()
  })
})
