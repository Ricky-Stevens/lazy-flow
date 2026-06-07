/**
 * Deterministic PR quality checks — SPEC §9.2.6
 */

import type { DeterministicChecks } from './types.js'

/** Issue key patterns: JIRA-style (PROJ-123) or GitHub-style (#123). */
const ISSUE_REF_PATTERN = /([A-Z][A-Z0-9]+-\d+|#\d+)/

/** Test file patterns. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i

/** Maximum files for atomic PR. */
export const ATOMICITY_MAX_FILES = 10

/** Maximum HALOC for atomic PR. */
export const ATOMICITY_MAX_HALOC = 400

export function runDeterministicChecks(opts: {
  /** PR title. */
  prTitle: string
  /** PR body text (may be empty). */
  prBody: string
  /** List of changed file paths. */
  filePaths: string[]
  /** HALOC for this PR. */
  haloc: number
}): DeterministicChecks {
  const { prTitle, prBody, filePaths, haloc } = opts

  return {
    has_description: prBody.trim().length > 10,
    linked_issue: ISSUE_REF_PATTERN.test(prTitle) || ISSUE_REF_PATTERN.test(prBody),
    has_tests: filePaths.some((p) => TEST_FILE_PATTERN.test(p)),
    is_atomic: filePaths.length <= ATOMICITY_MAX_FILES && haloc <= ATOMICITY_MAX_HALOC,
  }
}

/**
 * Convert a boolean deterministic check to a 0 or 2 score.
 * (No partial credit for deterministic checks — they are binary.)
 */
export function boolToScore(b: boolean): 0 | 2 {
  return b ? 2 : 0
}
