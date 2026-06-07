/**
 * Deterministic conventional-commit / path prior — SPEC §9.2.5
 *
 * Applied BEFORE the LLM.  If the prior yields a confident classification
 * the LLM call is skipped.
 *
 * Two signals (in order):
 *   1. Conventional-commit prefix on the commit message(s) or PR title.
 *   2. File-path pattern (test files, docs, infra, etc.).
 */

import type { WorkType } from './types.js'

// ---------------------------------------------------------------------------
// Conventional-commit prefix map
// ---------------------------------------------------------------------------

/**
 * Maps conventional-commit type prefixes to work types.
 * Follows the Conventional Commits v1 spec plus common extensions.
 */
const CC_PREFIX_MAP: Record<string, WorkType> = {
  feat: 'feature',
  feature: 'feature',
  fix: 'bugfix',
  bug: 'bugfix',
  bugfix: 'bugfix',
  hotfix: 'bugfix',
  refactor: 'refactor',
  perf: 'refactor',
  test: 'test',
  tests: 'test',
  docs: 'docs',
  doc: 'docs',
  chore: 'chore',
  build: 'chore',
  ci: 'chore',
  style: 'chore',
  revert: 'chore',
  release: 'chore',
  wip: 'chore',
}

/**
 * Regex to extract the conventional-commit type from a message.
 * Matches: "type: ..." or "type(scope): ..."
 */
const CC_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s/

/**
 * Attempts to classify a single commit/PR message using conventional-commit
 * prefix.  Returns the WorkType or null if no prefix matched.
 */
export function classifyByConventionalCommit(message: string): WorkType | null {
  const m = message.trim().match(CC_RE)
  if (!m) return null
  const rawPrefix = m[1]
  if (!rawPrefix) return null
  const prefix = rawPrefix.toLowerCase()
  return CC_PREFIX_MAP[prefix] ?? null
}

// ---------------------------------------------------------------------------
// Path-pattern map
// ---------------------------------------------------------------------------

/** Path patterns and their associated work types (checked in order). */
const PATH_PATTERNS: Array<{ pattern: RegExp; workType: WorkType }> = [
  // Test files
  { pattern: /\.(test|spec)\.[jt]sx?$/, workType: 'test' },
  { pattern: /\/__tests__\//, workType: 'test' },
  { pattern: /\/test\//, workType: 'test' },
  { pattern: /\/tests\//, workType: 'test' },
  { pattern: /\/e2e\//, workType: 'test' },
  // Docs
  { pattern: /\.(md|mdx|rst|txt)$/i, workType: 'docs' },
  { pattern: /\/docs?\//i, workType: 'docs' },
  // Chore / infra
  { pattern: /^\.github\//, workType: 'chore' },
  { pattern: /\/(ci|cd|infra|deploy|terraform|k8s)\//i, workType: 'chore' },
  { pattern: /\.(yml|yaml|json|toml|lock)$/i, workType: 'chore' },
  { pattern: /^Makefile$|^Dockerfile/i, workType: 'chore' },
  { pattern: /package\.json$|package-lock\.json$/, workType: 'chore' },
]

/**
 * Classifies based on the most common work type across a set of file paths.
 * Returns null if no path pattern matched.
 */
export function classifyByPathPatterns(filePaths: string[]): WorkType | null {
  if (filePaths.length === 0) return null

  const counts = new Map<WorkType, number>()
  for (const p of filePaths) {
    for (const { pattern, workType } of PATH_PATTERNS) {
      if (pattern.test(p)) {
        counts.set(workType, (counts.get(workType) ?? 0) + 1)
        break // first match wins for this file
      }
    }
  }

  if (counts.size === 0) return null

  // Majority type
  let best: WorkType | null = null
  let bestCount = 0
  for (const [wt, count] of counts) {
    if (count > bestCount) {
      best = wt
      bestCount = count
    }
  }

  // Only trust the path prior if it covers >50% of files
  const ratio = bestCount / filePaths.length
  return ratio > 0.5 ? best : null
}

// ---------------------------------------------------------------------------
// Composite prior
// ---------------------------------------------------------------------------

export interface PriorResult {
  workType: WorkType
  source: 'conventional_commit' | 'path_pattern'
}

/**
 * Applies the deterministic prior (conventional commit first, then path pattern).
 * Returns the first signal that yields a classification, or null if neither matched.
 */
export function applyDeterministicPrior(
  commitMessages: string[],
  prTitle: string,
  filePaths: string[],
): PriorResult | null {
  // 1. Conventional commit on commit messages (majority vote)
  const ccCounts = new Map<WorkType, number>()
  for (const msg of [prTitle, ...commitMessages]) {
    const wt = classifyByConventionalCommit(msg)
    if (wt) ccCounts.set(wt, (ccCounts.get(wt) ?? 0) + 1)
  }
  if (ccCounts.size > 0) {
    let best: WorkType | null = null
    let bestCount = 0
    for (const [wt, count] of ccCounts) {
      if (count > bestCount) {
        best = wt
        bestCount = count
      }
    }
    if (best) return { workType: best, source: 'conventional_commit' }
  }

  // 2. Path pattern
  const pathResult = classifyByPathPatterns(filePaths)
  if (pathResult) return { workType: pathResult, source: 'path_pattern' }

  return null
}
