/**
 * Shared types for Code metrics (Group D, SPEC §8.4).
 *
 * The code metrics layer is split into:
 *   - Pure functions over fixture/store data (testable without git)
 *   - A store-vs-fixture boundary for blame-dependent metrics
 *
 * STORE-VS-FIXTURE BOUNDARY (SPEC §8.4, WP-METRICS-CODE):
 *   Git blame/diff data is NOT persisted in the store (the live git-blame
 *   adapter was deferred in code-analysis).  Tests inject fixture
 *   diff/blame inputs directly.  Production callers must obtain these
 *   from the code-analysis `gitBlameRecords()` adapter (a TODO in worktype.ts)
 *   or from a CI diff artifact.
 *
 *   Metrics that depend on blame (work-type split, rework%, churn efficiency,
 *   Nagappan-Ball M3) are pure functions over BlameRecord[] + diff string —
 *   they do NOT access the store directly.  The caller is responsible for
 *   obtaining real blame data in production.
 *
 *   Metrics that depend on AST complexity deltas (cyclomatic/cognitive)
 *   require the tree-sitter parser to be initialised before calling
 *   analyzeComplexity().  Tests use fixture source strings.
 *
 * This boundary is documented here so consumers know which inputs are
 * "store-backed" vs "fixture/adapter-backed".
 */

import type { FileComplexity } from '@lazy-flow/code-analysis'

// ---------------------------------------------------------------------------
// Change record — represents one commit/PR's code change
// ---------------------------------------------------------------------------

/**
 * A single code change (commit or PR diff).
 * The caller projects from the store + git adapter into this shape.
 */
export interface CodeChangeRecord {
  /**
   * Unique change id (commit sha or PR id).
   */
  id: string
  /** Author identity string (used for work-type classification). */
  author: string
  /** ISO-8601 when this change was made. */
  changedAt: string
  /**
   * Unified diff string for the change.
   * STORE-VS-FIXTURE: in production, fetch from git or a stored diff.
   * In tests, pass a fixture diff string.
   */
  diff: string
  /** File paths changed (for edit-location diversity in impact score). */
  filePaths: readonly string[]
}

// ---------------------------------------------------------------------------
// Per-file complexity snapshot
// ---------------------------------------------------------------------------

/**
 * A snapshot of file complexity at a point in time.
 * Used to compute complexity deltas between base and head.
 */
export interface ComplexitySnapshot {
  /** Relative file path. */
  path: string
  /** Complexity from analyzeComplexity (tree-sitter). */
  complexity: FileComplexity
}
