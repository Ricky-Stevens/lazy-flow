/**
 * HALOC — Hunk-Adjusted Lines of Code (SPEC §1 C2, §8.4, §8.6)
 *
 * HALOC = Σ_hunk max(insertions, deletions)
 *
 * Kills git's modify-line double-counting (a changed line counts once, not
 * twice).  Language-agnostic; operates purely on normalised unified diff text.
 *
 * Classification rules (SPEC §8.6 HALOC normalisation):
 *  - Binary paths: detected by diff header "Binary files … differ" or a NUL
 *    byte in a hunk body. Their volume is surfaced separately in
 *    `binaryHaloc`; they are NEVER silently zeroed.
 *  - Generated/vendored paths: matched against `linguist-generated` gitattribute
 *    convention plus a configurable glob list (defaults: `*-lock.json`,
 *    `dist/**`, `vendor/**`, `*.min.js`, `*.min.css`).  Their volume is
 *    surfaced in `generatedHaloc`; excluded from `haloc`.
 *  - Rename-with-edits: only the edit hunks count (edit-only HALOC);
 *    pure renames (zero hunks) contribute 0 HALOC per SPEC pinning.
 *  - Whitespace-insensitive mode: caller pre-strips whitespace-only hunk lines
 *    before calling (or use the `whitespaceSensitive: false` option which uses
 *    the same normalisation logic inline — mirrors `git diff -w` semantics).
 */

/**
 * A single parsed hunk from a unified diff.
 */

// ── Default generated/vendored glob patterns ─────────────────────────────────

const DEFAULT_GENERATED_GLOBS = [
  '*-lock.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'dist/**',
  'vendor/**',
  'node_modules/**',
  '*.min.js',
  '*.min.css',
  '*.generated.*',
  '*.pb.go',
  '*.pb.ts',
  '*.snap',
]

// ── Glob matching (minimal, no dependencies) ─────────────────────────────────

/**
 * Minimal glob matcher supporting `*` (any chars except `/`) and `**` (any
 * chars including `/`), anchored to the full path or suffix match for patterns
 * without a leading `/`.
 */
function matchGlob(pattern, path) {
  // Normalise to forward slashes
  const p = path.replace(/\\/g, '/')
  const re = globToRegExp(pattern)
  return re.test(p)
}

function globToRegExp(pattern) {
  let src = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — match anything including `/`
        src += '.*'
        i += 2
        // swallow trailing `/` after `**`
        if (pattern[i] === '/') i++
      } else {
        // `*` — match anything except `/`
        src += '[^/]*'
        i++
      }
    } else if (c === '?') {
      src += '[^/]'
      i++
    } else if (c === '.') {
      src += '\\.'
      i++
    } else {
      src += c
      i++
    }
  }
  // Match against the full path (anchored) or as a suffix after a `/`.
  // A pattern like `dist/**` should match both `dist/foo.js` and exactly
  // `dist/**`.  Suffix matching lets `*-lock.json` match `packages/foo-lock.json`.
  return new RegExp(`(^|/)${src}$`)
}

function isGeneratedPath(path, extraGlobs) {
  const allGlobs = [...DEFAULT_GENERATED_GLOBS, ...extraGlobs]
  return allGlobs.some((g) => matchGlob(g, path))
}

// ── Diff parser ───────────────────────────────────────────────────────────────

const DIFF_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/
const BINARY_RE = /^Binary files? /
const RENAME_TO_RE = /^rename to (.+)$/
const HUNK_HEADER_RE = /^@@/
const INSERT_LINE_RE = /^\+(?!\+\+)/
const DELETE_LINE_RE = /^-(?!--)/
const WHITESPACE_ONLY_RE = /^[+-]\s*$/

function isWhitespaceOnlyLine(line) {
  return WHITESPACE_ONLY_RE.test(line)
}

/**
 * Parse a normalised unified diff string into per-file sections.
 * Handles multi-file diffs, binary files, and rename headers.
 */
function parseDiff(diff, wsInsensitive) {
  // Normalise line endings first. A CRLF-terminated diff leaves a trailing '\r'
  // on every line; DIFF_HEADER_RE anchors on '$' (and JS '.' does not match
  // '\r'), so the "diff --git" header would fail to match and the ENTIRE file's
  // HALOC would be silently zeroed. This enforces the "normalised diff" the
  // module contract (and SPEC §8.6) assumes.
  const lines = diff.replace(/\r\n?/g, '\n').split('\n')
  const files = []
  let current = null
  let currentHunk = null

  function pushHunk() {
    if (current && currentHunk) {
      current.hunks.push(currentHunk)
      currentHunk = null
    }
  }

  for (const line of lines) {
    const headerMatch = DIFF_HEADER_RE.exec(line)
    if (headerMatch) {
      pushHunk()
      current = {
        path: headerMatch[1] ?? '',
        hunks: [],
        isBinary: false,
        renameTo: null,
      }
      files.push(current)
      continue
    }

    if (!current) continue

    if (BINARY_RE.test(line)) {
      current.isBinary = true
      // Binary files: represent as one "hunk" with 1 HALOC to surface the swap.
      // The caller will see isBinary=true and bucket accordingly.
      current.hunks.push({ insertions: 1, deletions: 1 })
      continue
    }

    const renameMatch = RENAME_TO_RE.exec(line)
    if (renameMatch) {
      current.renameTo = renameMatch[1] ?? null
      // Update the path to the rename target for classification purposes
      current.path = current.renameTo ?? current.path
      continue
    }

    if (HUNK_HEADER_RE.test(line)) {
      pushHunk()
      currentHunk = { insertions: 0, deletions: 0 }
      continue
    }

    if (!currentHunk) continue

    // NUL byte in a hunk body → the file is binary even without a "Binary files
    // … differ" header. Flag it so its volume is bucketed into binaryHaloc and
    // not counted as source (SPEC §8.6 HALOC normalisation).
    if (line.includes('\u0000')) {
      current.isBinary = true
    }

    if (INSERT_LINE_RE.test(line)) {
      if (wsInsensitive && isWhitespaceOnlyLine(line)) continue
      currentHunk.insertions++
    } else if (DELETE_LINE_RE.test(line)) {
      if (wsInsensitive && isWhitespaceOnlyLine(line)) continue
      currentHunk.deletions++
    }
  }
  pushHunk()

  return files
}

// ── HALOC computation ─────────────────────────────────────────────────────────

/**
 * Compute HALOC over a normalised unified diff string.
 *
 * @param diff - A unified diff string (as produced by `git diff`).
 * @param options - Classification and whitespace options.
 * @returns {@link HalocResult} with HALOC broken down by classification bucket.
 */
export function computeHaloc(diff, options = {}) {
  const extraGlobs = options.additionalGeneratedGlobs ?? []
  const wsInsensitive = options.whitespaceSensitive === false

  const parsedFiles = parseDiff(diff, wsInsensitive)

  let haloc = 0
  let binaryHaloc = 0
  let generatedHaloc = 0
  const files = []

  for (const file of parsedFiles) {
    const isGenerated = isGeneratedPath(file.path, extraGlobs)
    const isRename = file.renameTo !== null
    const fileHaloc = file.hunks.reduce((sum, h) => sum + Math.max(h.insertions, h.deletions), 0)
    const totalIns = file.hunks.reduce((sum, h) => sum + h.insertions, 0)
    const totalDel = file.hunks.reduce((sum, h) => sum + h.deletions, 0)

    files.push({
      path: file.path,
      haloc: fileHaloc,
      insertions: totalIns,
      deletions: totalDel,
      isBinary: file.isBinary,
      isGenerated,
      isRename,
    })

    if (file.isBinary) {
      binaryHaloc += fileHaloc
    } else if (isGenerated) {
      generatedHaloc += fileHaloc
    } else {
      haloc += fileHaloc
    }
  }

  return { haloc, binaryHaloc, generatedHaloc, files }
}
