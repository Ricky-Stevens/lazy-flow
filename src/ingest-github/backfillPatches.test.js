import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { BunSqliteStore, migrate } from '../core/index.js'
import { backfillAllPatches, backfillPrPatches } from './backfillPatches.js'

const NOW = '2024-06-01T00:00:00.000Z'

function freshStore() {
  const db = new Database(':memory:')
  migrate(db, 'up')
  const store = new BunSqliteStore(':memory:')
  store.db.close()
  store.db = db
  return store
}

async function seed(store) {
  await store.upsertOrganisation({
    id: 'org-1',
    githubLogin: 'acme',
    jiraCloudId: null,
    name: 'Acme',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertRepository({
    id: 'repo-1',
    githubNodeId: 'n1',
    orgId: 'org-1',
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    isArchived: false,
    isFork: false,
    deletedAt: null,
    raw: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertPerson({
    id: 'p-1',
    displayName: 'Dev',
    primaryAccountRef: 'gh:d',
    updatedAt: NOW,
  })
  await store.upsertIdentity({
    id: 'id-1',
    personId: 'p-1',
    kind: 'github_login',
    externalId: 'd',
    isBot: false,
    confidence: 1,
    raw: '{}',
    updatedAt: NOW,
  })
  await store.upsertPullRequest({
    id: 'pr-1',
    repoId: 'repo-1',
    number: 1,
    authorIdentityId: 'id-1',
    state: 'merged',
    headRef: 'feat',
    baseRef: 'main',
    isDraft: false,
    mergedViaQueue: false,
    createdAt: NOW,
    readyAt: NOW,
    firstCommitAt: NOW,
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: NOW,
    mergedByIdentityId: 'id-1',
    deletedAt: null,
    raw: '{}',
    updatedAt: NOW,
  })
  await store.upsertPrRef({
    prId: 'pr-1',
    repoId: 'repo-1',
    baseSha: 'base1',
    headSha: 'head1',
    updatedAt: NOW,
  })
  // pr_files with NULL patch (the post-GraphQL state), HALOC from add/del fallback.
  await store.upsertPrFile({
    prId: 'pr-1',
    repoId: 'repo-1',
    path: 'src/x.ts',
    additions: 1,
    deletions: 1,
    haloc: 1,
    status: 'modified',
    patch: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

/** Stub client: only fetchBlobs is used, returning a Map keyed `${sha}:${path}`. */
function stubClient(blobMap) {
  return {
    async fetchBlobs(_owner, _name, refPaths) {
      const out = new Map()
      for (const { sha, path } of refPaths) {
        const key = `${sha}:${path}`
        if (blobMap.has(key)) out.set(key, blobMap.get(key))
      }
      return out
    },
  }
}

describe('backfillPrPatches (GraphQL blob-diff, no REST)', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
  })

  it('synthesises a patch from base+head blobs and stores it with exact HALOC', async () => {
    const client = stubClient(
      new Map([
        ['base1:src/x.ts', 'a\nb\nc\n'],
        ['head1:src/x.ts', 'a\nB\nc\n'], // one line changed
      ]),
    )
    const res = await backfillPrPatches(store, client, {
      owner: 'acme',
      name: 'app',
      repoId: 'repo-1',
    })
    expect(res.backfilled).toBe(1)
    expect(res.skipped).toBe(0)

    const files = await store.getAllPrFiles()
    const f = files.find((x) => x.path === 'src/x.ts')
    expect(f.patch).toBeTruthy()
    expect(f.patch).toContain('-b')
    expect(f.patch).toContain('+B')
    expect(f.haloc).toBe(1) // one changed line → max(1,1)
  })

  it('skips files whose head blob is unavailable (binary/oversized) — no fabricated patch', async () => {
    const client = stubClient(new Map([['base1:src/x.ts', 'a\nb\n']])) // no head blob
    const res = await backfillPrPatches(store, client, { owner: 'acme', name: 'app' })
    expect(res.backfilled).toBe(0)
    expect(res.skipped).toBe(1)
    const f = (await store.getAllPrFiles()).find((x) => x.path === 'src/x.ts')
    expect(f.patch).toBeNull()
  })

  it('is idempotent: a second run finds nothing pending', async () => {
    const client = stubClient(
      new Map([
        ['base1:src/x.ts', 'a\nb\n'],
        ['head1:src/x.ts', 'a\nb\nc\n'],
      ]),
    )
    await backfillPrPatches(store, client, { owner: 'acme', name: 'app' })
    const second = await backfillPrPatches(store, client, { owner: 'acme', name: 'app' })
    expect(second.eligible).toBe(0)
    expect(second.backfilled).toBe(0)
  })
})

describe('backfillPrPatches — no-repoId multi-repo guard', () => {
  it('throws a clear error when patch-less files span multiple repos and repoId is omitted', async () => {
    const store = freshStore()
    await seed(store) // seeds repo-1 with one patch-less file

    // Add a second repo with another patch-less file so the guard fires.
    await store.upsertRepository({
      id: 'repo-2',
      githubNodeId: 'n2',
      orgId: 'org-1',
      owner: 'acme',
      name: 'other',
      defaultBranch: 'main',
      isArchived: false,
      isFork: false,
      deletedAt: null,
      raw: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await store.upsertPullRequest({
      id: 'pr-2',
      repoId: 'repo-2',
      number: 2,
      authorIdentityId: 'id-1',
      state: 'merged',
      headRef: 'feat',
      baseRef: 'main',
      isDraft: false,
      mergedViaQueue: false,
      createdAt: NOW,
      readyAt: NOW,
      firstCommitAt: NOW,
      firstReviewAt: null,
      approvedAt: null,
      mergedAt: NOW,
      mergedByIdentityId: 'id-1',
      deletedAt: null,
      raw: '{}',
      updatedAt: NOW,
    })
    await store.upsertPrRef({
      prId: 'pr-2',
      repoId: 'repo-2',
      baseSha: 'base2',
      headSha: 'head2',
      updatedAt: NOW,
    })
    await store.upsertPrFile({
      prId: 'pr-2',
      repoId: 'repo-2',
      path: 'src/y.ts',
      additions: 1,
      deletions: 0,
      haloc: 1,
      patch: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const client = stubClient(new Map())
    await expect(
      backfillPrPatches(store, client, { owner: 'acme', name: 'app' /* no repoId */ }),
    ).rejects.toThrow(/2 repos/)
  })

  it('succeeds when only one repo has patch-less files and repoId is omitted', async () => {
    const store = freshStore()
    await seed(store) // single repo, single patch-less file

    const client = stubClient(
      new Map([
        ['base1:src/x.ts', 'a\nb\n'],
        ['head1:src/x.ts', 'a\nB\n'],
      ]),
    )
    // No repoId — single-repo path should still work.
    const res = await backfillPrPatches(store, client, { owner: 'acme', name: 'app' })
    expect(res.backfilled).toBe(1)
  })
})

describe('backfillAllPatches drain mode', () => {
  let store
  beforeEach(async () => {
    store = freshStore()
    await seed(store)
    // Two more files on the same PR: y.ts is fetchable, z.ts is not (no blobs).
    for (const path of ['src/y.ts', 'src/z.ts']) {
      await store.upsertPrFile({
        prId: 'pr-1',
        repoId: 'repo-1',
        path,
        additions: 1,
        deletions: 1,
        haloc: 1,
        status: 'modified',
        patch: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
  })

  it('drains every fetchable file to completion across bounded passes, leaving only the unfetchable residual', async () => {
    const client = stubClient(
      new Map([
        ['base1:src/x.ts', 'a\nb\n'],
        ['head1:src/x.ts', 'a\nB\n'],
        ['base1:src/y.ts', 'a\nb\n'],
        ['head1:src/y.ts', 'a\nB\n'],
        // src/z.ts intentionally absent → permanently unfetchable.
      ]),
    )
    // chunkSize:1 forces multiple passes; the loop must still terminate (no
    // infinite loop on the unfetchable residual) thanks to the no-progress break.
    const res = await backfillAllPatches(store, client, { drain: true, chunkSize: 1 })

    expect(res.drained).toBe(true)
    expect(res.backfilled).toBe(2) // x + y
    expect(res.remaining).toBe(1) // z is unfetchable — honest residual
    expect(res.errors).toEqual([])

    const files = await store.getAllPrFiles()
    expect(files.find((f) => f.path === 'src/x.ts').patch).toBeTruthy()
    expect(files.find((f) => f.path === 'src/y.ts').patch).toBeTruthy()
    expect(files.find((f) => f.path === 'src/z.ts').patch).toBeNull()
  })
})
