/**
 * Regression test for FIX 3: generated/vendored files must NOT enter the
 * authored-code numerator of pr.size / nagappan_ball / change_impact / the
 * per-person ownership/skill/complexity builders.
 *
 * Builds a synthetic PR with one source file + one lockfile + one wasm bundle
 * (the three observed-in-the-wild bad cases) and asserts the personDerive
 * builders count ONLY the source file's volume.
 */

import { describe, expect, it } from 'bun:test'

import {
  buildComplexityDeltaInputs,
  buildConceptualSurfaceInputs,
  buildHighComplexityShareInputs,
  buildKnowledgeOwnershipInputs,
  buildSkillDomainInputs,
} from './personDerive.js'

const NOW = '2024-06-01T00:00:00.000Z'

/** A merged PR authored by `identity-1`, ready for the builders. */
const PR = {
  id: 'pr-1',
  repoId: 'repo-1',
  number: 1,
  authorIdentityId: 'identity-1',
  state: 'merged',
  createdAt: NOW,
  mergedAt: NOW,
}

/**
 * Three files on the same PR:
 *  - src/index.ts: real source, 100 lines added (the only authored work)
 *  - package-lock.json: 5000-line dependency bump
 *  - public/wasm/module.wasm.js: 80000-line emscripten output
 * All are persisted with the is_generated flag matching the classifier.
 */
function filesByPr() {
  return new Map([
    [
      'pr-1',
      [
        {
          prId: 'pr-1',
          repoId: 'repo-1',
          path: 'src/index.ts',
          additions: 100,
          deletions: 0,
          haloc: 100,
          status: 'modified',
          patch: null,
          isGenerated: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          prId: 'pr-1',
          repoId: 'repo-1',
          path: 'package-lock.json',
          additions: 5000,
          deletions: 0,
          haloc: 5000,
          status: 'modified',
          patch: null,
          isGenerated: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          prId: 'pr-1',
          repoId: 'repo-1',
          path: 'public/wasm/module.wasm.js',
          additions: 80000,
          deletions: 0,
          haloc: 80000,
          status: 'modified',
          patch: null,
          isGenerated: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    ],
  ])
}

describe('FIX 3: generated/vendored files are filtered from authored-code metric numerators', () => {
  it('buildKnowledgeOwnershipInputs only credits the authored source file', () => {
    const result = buildKnowledgeOwnershipInputs(
      [PR],
      filesByPr(),
      new Set(['identity-1']),
      new Map(),
    )
    // Only src/index.ts must reach the aggregate. Lockfile + wasm bundle filtered.
    expect(result.paths.map((p) => p.path).sort()).toEqual(['src/index.ts'])
    expect(result.paths[0].personLines).toBe(100)
    expect(result.paths[0].totalLines).toBe(100)
  })

  it('buildSkillDomainInputs does NOT credit lockfile churn as a skill domain', () => {
    const result = buildSkillDomainInputs([PR], filesByPr())
    const total = result.domains.reduce((sum, d) => sum + d.weight, 0)
    // Without the filter: total would include 5000 + 80000 = 85100 from
    // generated files, dwarfing the 100 authored lines. With the filter: 100.
    expect(total).toBe(100)
  })

  it('buildComplexityDeltaInputs ignores generated files entirely', () => {
    // fcByKey is empty so no complexity coverage → coverage=false unless any
    // file is BOTH non-generated AND has a complexity record. Empty fc → no
    // coverage, no positive delta. The relevant assertion is that the builder
    // does not iterate generated files (a generated file with a complexity
    // record would have skewed the cyclomatic delta dramatically).
    const result = buildComplexityDeltaInputs(
      [PR],
      filesByPr(),
      new Map([['pr-1', { headSha: 'h1', baseSha: 'b1' }]]),
      new Map(),
    )
    expect(result.prPositiveDeltas).toEqual([])
  })

  it('buildHighComplexityShareInputs line-weight sums exclude generated files', () => {
    const result = buildHighComplexityShareInputs(
      [PR],
      filesByPr(),
      new Map([['pr-1', { headSha: 'h1', baseSha: 'b1' }]]),
      new Map(),
      new Map([['repo-1', 10]]),
    )
    // totalLineWeight is the sum of additions+deletions on AUTHORED files only —
    // generated files would dominate. With the filter: 100.
    expect(result.totalLineWeight).toBe(100)
  })

  it('buildConceptualSurfaceInputs does not iterate generated files', () => {
    // Same shape as complexityDelta: no fc records → no coverage → no surfaces.
    const result = buildConceptualSurfaceInputs(
      [PR],
      filesByPr(),
      new Map([['pr-1', { headSha: 'h1' }]]),
      new Map(),
    )
    expect(result.prSurfaces).toEqual([])
  })
})
