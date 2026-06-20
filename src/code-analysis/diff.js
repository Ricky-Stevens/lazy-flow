/**
 * Pure line-level unified-diff synthesiser. lazy-flow ingests GitHub over GraphQL
 * ONLY, and GraphQL exposes no per-file patch text — but it DOES expose file
 * contents at any ref (the `FileBlobs` query / client.fetchBlobs). So we compute
 * the diff locally from the base+head blob text and emit a GitHub-`patch`-style
 * unified diff (hunk bodies, no `diff --git` header — reconstructFileDiff adds it).
 *
 * The output is consumed by computeHaloc (exact per-hunk HALOC) and by the
 * in-session verdict layer (readable diffs). Deterministic; no deps; no network.
 *
 * LCS via DP, capped at MAX_LINES per side — beyond that (or for binary content)
 * we emit a single whole-file replace hunk, which keeps HALOC monotonic and the
 * cost bounded for pathological inputs.
 */

const MAX_LINES = 1500
const NUL = '\u0000'

/** Split into lines WITHOUT a trailing empty element for a final newline. */
function toLines(text) {
  if (text === null || text === undefined || text === '') return []
  const norm = text.replace(/\r\n?/g, '\n')
  const lines = norm.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Longest-common-subsequence edit script over two line arrays. */
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  // DP table of LCS lengths (n+1)×(m+1).
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', line: a[i] })
      i++
    } else {
      ops.push({ t: 'ins', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ t: 'del', line: a[i++] })
  while (j < m) ops.push({ t: 'ins', line: b[j++] })
  return ops
}

/** A single whole-file replace hunk — fallback for huge/binary inputs. */
function replaceAllOps(a, b) {
  return [...a.map((line) => ({ t: 'del', line })), ...b.map((line) => ({ t: 'ins', line }))]
}

/** Group an op script into unified-diff hunks with `context` equal lines around edits. */
function toUnifiedHunks(ops, context) {
  // Indices of ops that are edits (non-eq).
  const editIdx = []
  for (let k = 0; k < ops.length; k++) if (ops[k].t !== 'eq') editIdx.push(k)
  if (editIdx.length === 0) return ''

  // Merge edit runs whose context windows touch/overlap into hunk ranges.
  const ranges = []
  let start = Math.max(0, editIdx[0] - context)
  let end = Math.min(ops.length - 1, editIdx[0] + context)
  for (let e = 1; e < editIdx.length; e++) {
    const s = Math.max(0, editIdx[e] - context)
    if (s <= end + 1) {
      end = Math.min(ops.length - 1, editIdx[e] + context)
    } else {
      ranges.push([start, end])
      start = s
      end = Math.min(ops.length - 1, editIdx[e] + context)
    }
  }
  ranges.push([start, end])

  let out = ''
  // Track 1-based line cursors in base (a) and head (b).
  let baseLine = 1
  let headLine = 1
  let idx = 0
  for (const [rs, re] of ranges) {
    // Advance cursors over the eq ops before this range.
    for (; idx < rs; idx++) {
      if (ops[idx].t !== 'ins') baseLine++
      if (ops[idx].t !== 'del') headLine++
    }
    let baseLen = 0
    let headLen = 0
    let body = ''
    for (let k = rs; k <= re; k++) {
      const op = ops[k]
      if (op.t === 'eq') {
        body += ` ${op.line}\n`
        baseLen++
        headLen++
      } else if (op.t === 'del') {
        body += `-${op.line}\n`
        baseLen++
      } else {
        body += `+${op.line}\n`
        headLen++
      }
    }
    out += `@@ -${baseLine},${baseLen} +${headLine},${headLen} @@\n${body}`
    // Advance cursors over the range we just emitted.
    for (let k = rs; k <= re; k++) {
      if (ops[k].t !== 'ins') baseLine++
      if (ops[k].t !== 'del') headLine++
    }
    idx = re + 1
  }
  return out
}

/**
 * Synthesise a GitHub-style unified-diff `patch` from base→head file text.
 * Returns '' when the content is identical (caller should leave patch null),
 * or null for binary content (HALOC then falls back to add/del counts).
 * @param baseText file content at the base ref (null/'' for a new file)
 * @param headText file content at the head ref (null/'' for a deletion)
 */
export function synthesizeUnifiedDiff(baseText, headText, opts = {}) {
  const context = opts.context ?? 3
  if (baseText?.includes(NUL) || headText?.includes(NUL)) return null
  const a = toLines(baseText)
  const b = toLines(headText)
  if (a.length === 0 && b.length === 0) return ''
  const ops = a.length > MAX_LINES || b.length > MAX_LINES ? replaceAllOps(a, b) : diffLines(a, b)
  return toUnifiedHunks(ops, context)
}
