/**
 * Alignment feature-pack builder — SPEC §9.2.1, WP-AI-ALIGNMENT
 *
 * Builds the deterministic feature pack from the store.
 * Relevance-ranks diff hunks against the acceptance criteria using
 * a keyword-overlap score (no LLM involvement).
 */

import type { AcceptanceCriterion, AlignmentFeaturePack, DiffHunk } from './types.js'

// ---------------------------------------------------------------------------
// Acceptance-criteria parser
// ---------------------------------------------------------------------------

/**
 * Parses acceptance criteria from a Jira description string.
 * Recognises common patterns:
 *   - Lines that start with "- ", "* ", numbers like "1.", or "AC:"
 *   - A heading line followed by bullet lines
 *
 * Returns an empty array when no criteria are found (caller may fall back
 * to treating the whole description as a single criterion).
 */
export function parseAcceptanceCriteria(description: string): AcceptanceCriterion[] {
  if (!description.trim()) return []

  const lines = description.split('\n').map((l) => l.trim())
  const criteria: AcceptanceCriterion[] = []

  // Find lines that look like acceptance criteria bullets
  const bulletRe = /^(?:[-*•]|\d+[.):])\s+(.+)$/
  // Lines after a heading that contains "acceptance" or "AC" (case-insensitive)
  let inAcSection = false
  let index = 0

  for (const line of lines) {
    const lower = line.toLowerCase()
    if (lower.match(/acceptance criteria|^ac:/)) {
      inAcSection = true
      continue
    }
    // A blank line or a new heading ends the section
    if (inAcSection && (line === '' || /^#+\s/.test(line))) {
      inAcSection = false
    }

    const m = line.match(bulletRe)
    const mText = m?.[1]
    if (m && mText && (inAcSection || lower.startsWith('ac:'))) {
      criteria.push({ index, text: mText })
      index++
    } else if (m && mText && inAcSection) {
      criteria.push({ index, text: mText })
      index++
    }
  }

  // Fallback: grab ALL bullets if no AC section found
  if (criteria.length === 0) {
    for (const line of lines) {
      const m = line.match(bulletRe)
      const mText = m?.[1]
      if (m && mText) {
        criteria.push({ index, text: mText })
        index++
      }
    }
  }

  return criteria
}

// ---------------------------------------------------------------------------
// Relevance ranking
// ---------------------------------------------------------------------------

/**
 * Scores a single diff hunk against a set of criteria using
 * normalised term-overlap (Jaccard-like).  Returns a value in [0, 1].
 *
 * Deterministic, no LLM, no external deps.
 */
export function scoreHunkRelevance(hunkContent: string, criteria: AcceptanceCriterion[]): number {
  if (criteria.length === 0) return 0

  const hunkTokens = tokenise(hunkContent)
  if (hunkTokens.size === 0) return 0

  const criteriaTokens = new Set<string>()
  for (const c of criteria) {
    for (const t of tokenise(c.text)) criteriaTokens.add(t)
  }

  const intersection = [...hunkTokens].filter((t) => criteriaTokens.has(t)).length
  const union = new Set([...hunkTokens, ...criteriaTokens]).size
  return union === 0 ? 0 : intersection / union
}

/** Tokenises text into a set of lowercase alphanumeric tokens (≥3 chars). */
function tokenise(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
  return new Set(tokens)
}

/**
 * Relevance-rank a set of raw diff hunks against the acceptance criteria.
 * Returns them sorted descending by relevanceScore.
 * Never silently truncates — all hunks are returned.
 */
export function rankDiffHunks(
  rawHunks: Array<{ filePath: string; content: string }>,
  criteria: AcceptanceCriterion[],
): DiffHunk[] {
  const ranked = rawHunks.map((h) => ({
    filePath: h.filePath,
    content: h.content,
    relevanceScore: scoreHunkRelevance(h.content, criteria),
  }))
  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return ranked
}

// ---------------------------------------------------------------------------
// Feature-pack builder
// ---------------------------------------------------------------------------

/**
 * Builds the alignment feature pack from raw inputs.
 * Parses acceptance criteria and relevance-ranks the diff hunks.
 */
export function buildAlignmentFeaturePack(params: {
  issueKey: string
  issueType: string
  issueSummary: string
  issueDescription: string
  prTitle: string
  prBody: string
  commitMessages: string[]
  rawDiffHunks: Array<{ filePath: string; content: string }>
}): AlignmentFeaturePack {
  const criteria = parseAcceptanceCriteria(params.issueDescription)
  const diffHunks = rankDiffHunks(params.rawDiffHunks, criteria)

  return {
    issueKey: params.issueKey,
    issueType: params.issueType,
    issueSummary: params.issueSummary,
    issueDescription: params.issueDescription,
    criteria,
    prTitle: params.prTitle,
    prBody: params.prBody,
    commitMessages: params.commitMessages,
    diffHunks,
  }
}
