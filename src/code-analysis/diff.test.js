import { describe, expect, it } from 'bun:test'
import { synthesizeUnifiedDiff } from './diff.js'
import { computeHaloc } from './haloc.js'

/** Wrap a GitHub-style patch the way ingestion does, then run HALOC over it. */
function halocOf(path, patch) {
  const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}\n`
  return computeHaloc(diff).haloc
}

describe('synthesizeUnifiedDiff', () => {
  it('returns empty string for identical content', () => {
    expect(synthesizeUnifiedDiff('a\nb\nc\n', 'a\nb\nc\n')).toBe('')
  })

  it('returns null for binary content', () => {
    expect(synthesizeUnifiedDiff('ok', 'has\u0000nul')).toBeNull()
  })

  it('emits additions for a brand-new file', () => {
    const patch = synthesizeUnifiedDiff('', 'line1\nline2\n')
    expect(patch).toContain('+line1')
    expect(patch).toContain('+line2')
    expect(patch).toMatch(/^@@ -1,0 \+1,2 @@/)
  })

  it('emits a -old +new hunk for a single-line change, with correct HALOC', () => {
    const base = 'alpha\nbeta\ngamma\ndelta\nepsilon\n'
    const head = 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n'
    const patch = synthesizeUnifiedDiff(base, head)
    expect(patch).toContain('-gamma')
    expect(patch).toContain('+GAMMA')
    // One hunk: 1 insertion, 1 deletion → HALOC = max(1,1) = 1.
    expect(halocOf('f.txt', patch)).toBe(1)
  })

  it('HALOC of a synthesised patch equals Σ max(ins,del) per hunk', () => {
    // Two separated edit regions → two hunks.
    const base = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const headLines = base.split('\n')
    headLines[2] = 'CHANGED-2' // edit near top
    headLines.splice(20, 0, 'INSERTED-A', 'INSERTED-B') // insertions near bottom
    const head = headLines.join('\n')
    const patch = synthesizeUnifiedDiff(base, head)
    // top hunk: 1 del + 1 ins → 1; bottom hunk: 2 ins → 2. Total 3.
    expect(halocOf('f.txt', patch)).toBe(3)
  })

  it('round-trips through HALOC for a large (fallback) input without throwing', () => {
    const base = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n')
    const head = `${base}\nextra`
    const patch = synthesizeUnifiedDiff(base, head)
    expect(typeof patch).toBe('string')
    expect(halocOf('big.txt', patch)).toBeGreaterThan(0)
  })
})
