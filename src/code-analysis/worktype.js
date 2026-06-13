/**
 * Work-type / churn split (SPEC §8.4, §8.6 decision D7).
 *
 * Classifies lines into four buckets based on blame age and authorship
 * (matches the implementation below exactly):
 *
 *  - **New**             — lines with no blame record (brand-new file/line).
 *  - **Rework**          — same author, last touched ≤ `windowDays` ago
 *                          (churn on one's own recent work).
 *  - **Legacy-Refactor** — lines last touched > `windowDays` ago, whether by the
 *                          same author (cleaning up own legacy code) or someone
 *                          else (old code by another author).
 *  - **Help-Others**     — lines last touched ≤ `windowDays` ago by a *different*
 *                          author (editing someone else's recent code).
 *
 * Derived metrics:
 *  - `reworkPercent = (rework / total) * 100`   (null when total=0)
 *  - `efficiency    = 100 − reworkPercent`       (null when total=0)
 *
 * The function is **pure** — it takes injected blame records and a reference
 * "now" timestamp, so it never calls `Date.now()` and is 100% deterministic.
 *
 * A thin `gitBlameRecords()` adapter (not required for tests) can wrap
 * `child_process.execSync('git blame …')` to produce BlameRecord arrays for
 * production use — that layer is deferred (it requires a live repo) and noted
 * in TODO below.
 *
 * TODO(WP-CODE-ANALYSIS): implement `gitBlameRecords(filePath, repo)` adapter
 * over `child_process` / `git blame -p` porcelain output.
 */

/** A single blame record for one line of a file. */

const DEFAULT_WINDOW_DAYS = 30

function toMs(d) {
  return d instanceof Date ? d.getTime() : d
}

/**
 * Classify changed lines by work type (New / Legacy-Refactor / Help-Others /
 * Rework) based on injected blame records.
 *
 * @param options - Author, blame records, now timestamp, and optional lines/window.
 * @returns {@link WorkTypeResult} with per-bucket counts and efficiency metrics.
 */
export function classifyWorkType(options) {
  const { author, blameRecords, now, windowDays = DEFAULT_WINDOW_DAYS } = options
  const nowMs = toMs(now)
  const windowMs = windowDays * 24 * 60 * 60 * 1000

  // Build a lookup by line number
  const blameByLine = new Map()
  for (const rec of blameRecords) {
    blameByLine.set(rec.line, rec)
  }

  // Determine which lines to classify
  const linesToClassify =
    options.lines !== undefined ? options.lines : blameRecords.map((r) => r.line)

  const lines = []
  const counts = {
    New: 0,
    'Legacy-Refactor': 0,
    'Help-Others': 0,
    Rework: 0,
  }

  for (const lineNum of linesToClassify) {
    const blame = blameByLine.get(lineNum)
    let workType

    if (!blame) {
      // No blame record → brand-new line in a new file
      workType = 'New'
    } else {
      const ageMs = nowMs - toMs(blame.lastChangedAt)
      const isRecent = ageMs <= windowMs
      const isSameAuthor = blame.author === author

      if (isSameAuthor && isRecent) {
        // Re-touching own recent work → Rework (churn)
        workType = 'Rework'
      } else if (isSameAuthor && !isRecent) {
        // Author touching their own old code → Legacy-Refactor
        // (same-author but old = they're cleaning up their own legacy code)
        workType = 'Legacy-Refactor'
      } else if (!isSameAuthor && isRecent) {
        // Helping someone else's recent code
        workType = 'Help-Others'
      } else {
        // !isSameAuthor && !isRecent → old code by someone else
        workType = 'Legacy-Refactor'
      }
    }

    counts[workType]++
    lines.push({ line: lineNum, workType })
  }

  const total = lines.length
  const reworkPercent = total > 0 ? (counts.Rework / total) * 100 : null
  const efficiency = reworkPercent !== null ? 100 - reworkPercent : null

  return { total, counts, reworkPercent, efficiency, lines }
}
