import { describe, expect, it } from 'bun:test'
import { computeHaloc } from './haloc.js'

// ── helpers ────────────────────────────────────────────────────────────────

function makeDiff(files) {
  const parts = []
  for (const f of files) {
    const aPath = f.renameTo ? f.name : f.name
    const bPath = f.renameTo ?? f.name
    parts.push(`diff --git a/${aPath} b/${bPath}`)
    if (f.renameTo) {
      parts.push(`rename from ${f.name}`)
      parts.push(`rename to ${f.renameTo}`)
    }
    if (f.binary) {
      parts.push(`Binary files a/${f.name} and b/${bPath} differ`)
    } else {
      for (const h of f.hunks ?? []) {
        parts.push('@@ -1,3 +1,3 @@')
        for (const l of h.removed) parts.push(`-${l}`)
        for (const l of h.added) parts.push(`+${l}`)
      }
    }
  }
  return parts.join('\n')
}

// ── pure-add ──────────────────────────────────────────────────────────────

describe('pure addition', () => {
  it('counts only insertions when no deletions', () => {
    const diff = makeDiff([{ name: 'a.ts', hunks: [{ added: ['a', 'b', 'c'], removed: [] }] }])
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(3)
    expect(result.binaryHaloc).toBe(0)
    expect(result.generatedHaloc).toBe(0)
    expect(result.files[0]?.haloc).toBe(3)
  })
})

// ── pure-delete ───────────────────────────────────────────────────────────

describe('pure deletion', () => {
  it('counts only deletions when no insertions', () => {
    const diff = makeDiff([{ name: 'b.ts', hunks: [{ added: [], removed: ['x', 'y'] }] }])
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(2)
  })
})

// ── modify (max, not sum) ─────────────────────────────────────────────────

describe('modification — max kills double-counting', () => {
  it('HALOC = max(ins, del) per hunk, not ins + del', () => {
    // 2 insertions + 3 deletions in one hunk → HALOC should be 3, not 5
    const diff = makeDiff([
      { name: 'c.ts', hunks: [{ added: ['a', 'b'], removed: ['x', 'y', 'z'] }] },
    ])
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(3)
  })

  it('sums max across multiple hunks', () => {
    // hunk1: 2 ins, 1 del → 2; hunk2: 0 ins, 4 del → 4 → total 6
    const parts = [
      'diff --git a/d.ts b/d.ts',
      '@@ -1,5 +1,6 @@',
      '+a',
      '+b',
      '-x',
      '@@ -10,4 +11,0 @@',
      '-p',
      '-q',
      '-r',
      '-s',
    ]
    const result = computeHaloc(parts.join('\n'))
    expect(result.haloc).toBe(6)
  })
})

// ── binary files ──────────────────────────────────────────────────────────

describe('binary files', () => {
  it('binary volume is surfaced in binaryHaloc, not haloc', () => {
    const diff = makeDiff([
      { name: 'image.png', binary: true },
      { name: 'code.ts', hunks: [{ added: ['a'], removed: [] }] },
    ])
    const result = computeHaloc(diff)
    expect(result.binaryHaloc).toBeGreaterThan(0)
    expect(result.haloc).toBe(1)
    const binFile = result.files.find((f) => f.path === 'image.png')
    expect(binFile?.isBinary).toBe(true)
    expect(binFile?.haloc).toBeGreaterThan(0)
  })

  it('binary swap NEVER produces 0 binaryHaloc', () => {
    const diff = makeDiff([{ name: 'lib.wasm', binary: true }])
    const result = computeHaloc(diff)
    expect(result.binaryHaloc).not.toBe(0)
  })
})

// ── generated/vendored ────────────────────────────────────────────────────

describe('generated / vendored paths', () => {
  it('package-lock.json is classified as generated', () => {
    const diff = makeDiff([
      { name: 'package-lock.json', hunks: [{ added: ['a', 'b'], removed: ['c'] }] },
    ])
    const result = computeHaloc(diff)
    expect(result.generatedHaloc).toBe(2)
    expect(result.haloc).toBe(0)
    expect(result.files[0]?.isGenerated).toBe(true)
  })

  it('dist/** paths are classified as generated', () => {
    const diff = makeDiff([{ name: 'dist/bundle.js', hunks: [{ added: ['x'], removed: [] }] }])
    const result = computeHaloc(diff)
    expect(result.generatedHaloc).toBe(1)
    expect(result.haloc).toBe(0)
  })

  it('custom glob classifies additional paths as generated', () => {
    const diff = makeDiff([
      { name: 'generated/api-client.ts', hunks: [{ added: ['a', 'b', 'c'], removed: [] }] },
    ])
    const result = computeHaloc(diff, { additionalGeneratedGlobs: ['generated/**'] })
    expect(result.generatedHaloc).toBe(3)
    expect(result.haloc).toBe(0)
  })

  it('normal source files are NOT classified as generated', () => {
    const diff = makeDiff([{ name: 'src/index.ts', hunks: [{ added: ['a'], removed: [] }] }])
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(1)
    expect(result.generatedHaloc).toBe(0)
    expect(result.files[0]?.isGenerated).toBe(false)
  })
})

// ── rename handling ───────────────────────────────────────────────────────

describe('rename detection', () => {
  it('pure rename with no hunks contributes 0 HALOC', () => {
    const diff = makeDiff([{ name: 'old.ts', renameTo: 'new.ts' }])
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(0)
    const f = result.files[0]
    expect(f?.isRename).toBe(true)
    expect(f?.haloc).toBe(0)
  })

  it('rename with edits counts edit hunks only', () => {
    const parts = [
      'diff --git a/old.ts b/new.ts',
      'rename from old.ts',
      'rename to new.ts',
      '@@ -1,2 +1,3 @@',
      '+added line',
      ' context',
      '-removed line',
    ]
    const result = computeHaloc(parts.join('\n'))
    // max(1, 1) = 1
    expect(result.haloc).toBe(1)
    expect(result.files[0]?.isRename).toBe(true)
  })
})

// ── whitespace insensitive ────────────────────────────────────────────────

describe('whitespace-insensitive mode', () => {
  it('whitespace-only lines are ignored when whitespaceSensitive=false', () => {
    const parts = ['diff --git a/x.ts b/x.ts', '@@ -1,3 +1,3 @@', '+  ', '+real line', '-   ']
    // Default (sensitive): 2 ins + 1 del → HALOC = 2
    const sensitive = computeHaloc(parts.join('\n'))
    expect(sensitive.haloc).toBe(2)

    // Insensitive: 1 real ins + 0 real del → HALOC = 1
    const insensitive = computeHaloc(parts.join('\n'), { whitespaceSensitive: false })
    expect(insensitive.haloc).toBe(1)
  })
})

// ── empty diff ────────────────────────────────────────────────────────────

describe('empty or no-op diffs', () => {
  it('returns zero HALOC for an empty diff string', () => {
    const result = computeHaloc('')
    expect(result.haloc).toBe(0)
    expect(result.binaryHaloc).toBe(0)
    expect(result.generatedHaloc).toBe(0)
    expect(result.files).toHaveLength(0)
  })

  it('returns zero HALOC for a diff with no hunks', () => {
    const diff = 'diff --git a/README.md b/README.md\n'
    const result = computeHaloc(diff)
    expect(result.haloc).toBe(0)
  })
})

// ── CRLF line endings (regression) ──────────────────────────────────────────

describe('CRLF-terminated diff', () => {
  it('does NOT silently zero HALOC when the diff uses \\r\\n', () => {
    const lf = 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,2 @@\n+a\n+b\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const lfResult = computeHaloc(lf)
    const crlfResult = computeHaloc(crlf)
    expect(lfResult.haloc).toBe(2)
    expect(crlfResult.haloc).toBe(2)
    expect(crlfResult.files).toHaveLength(1)
    expect(crlfResult.files[0]?.path).toBe('src/foo.ts')
  })
})

// ── NUL-byte binary detection (regression) ──────────────────────────────────

describe('NUL byte in hunk body', () => {
  it('treats a hunk containing a NUL byte as binary (volume → binaryHaloc, never source)', () => {
    const diff = `diff --git a/blob.dat b/blob.dat\n@@ -1,1 +1,1 @@\n+abc\u0000def\n`
    const result = computeHaloc(diff)
    expect(result.files[0]?.isBinary).toBe(true)
    expect(result.haloc).toBe(0)
    expect(result.binaryHaloc).toBeGreaterThan(0)
  })
})
