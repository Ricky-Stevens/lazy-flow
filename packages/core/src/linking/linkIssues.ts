/**
 * WP-LINKING — GitHub ↔ Jira PR-issue link extractor.
 *
 * Extracts Jira issue keys from PR title, body, head_ref, and commit messages
 * using three strategies:
 *
 *  - regex:       bare key pattern [A-Z][A-Z0-9]+-\d+ anywhere in the text
 *  - smartcommit: Atlassian smart-commit syntax (e.g. "git commit -m 'FOO-123 #comment ...'")
 *  - branch:      head_ref that starts with or contains a Jira key
 *
 * False-positive guard: extracted keys are resolved against the `issue_keys`
 * history table. Keys not present in the store (not a real project key) are
 * silently dropped so random version strings like "V8-10" don't produce links.
 *
 * Moved-key resolution: `resolveIssueKey` searches across historical keys, so
 * a PR referencing OLD-99 (now ACME-2) still produces a link to the current
 * issue record.
 */

import type { PrIssueLink, Store } from '../store/Store.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches a Jira-style issue key: one-or-more uppercase letters + digits, hyphen, digits. */
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g

/**
 * Atlassian smart-commit pattern: key immediately followed by a smart-commit
 * command (#comment, #time, #done, #close, #resolve, #transition).
 *
 * Examples:
 *   "FOO-123 #comment This looks good."
 *   "BAR-456 #time 2h"
 *   "BAZ-789 #done"
 */
const SMART_COMMIT_RE = /\b([A-Z][A-Z0-9]+-\d+)\s+#(?:comment|time|done|close|resolve|transition)/gi

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkIssuesOptions {
  /** ISO timestamp for resolving issue-key history (default: far future = current). */
  now?: string
}

export interface LinkIssuesResult {
  linksUpserted: number
  /** Number of candidate keys dropped because they weren't in the store (false-positive guard). */
  falsePositivesDropped: number
}

// ---------------------------------------------------------------------------
// Key extraction helpers
// ---------------------------------------------------------------------------

/** Extract all bare Jira issue key matches from a text string. */
function extractRegexKeys(text: string): string[] {
  return [...text.matchAll(ISSUE_KEY_RE)].flatMap((m) => (m[1] !== undefined ? [m[1]] : []))
}

/** Extract keys from Atlassian smart-commit patterns in a text string. */
function extractSmartCommitKeys(text: string): string[] {
  return [...text.matchAll(SMART_COMMIT_RE)].flatMap((m) =>
    m[1] !== undefined ? [m[1].toUpperCase()] : [],
  )
}

/** Extract keys from a branch name (head_ref). */
function extractBranchKeys(headRef: string): string[] {
  return extractRegexKeys(headRef)
}

// ---------------------------------------------------------------------------
// PR raw parsing
// ---------------------------------------------------------------------------

function parsePrRaw(raw: string): { title: string; body: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    }
  } catch {
    return { title: '', body: '' }
  }
}

// ---------------------------------------------------------------------------
// Main export: linkIssues
// ---------------------------------------------------------------------------

/**
 * Scan all pull requests in the store and populate `pr_issue_links` by
 * extracting Jira issue keys from PR title, body, head_ref, and commit messages.
 *
 * Guards against false positives by resolving every candidate key through the
 * `issue_keys` history table — keys not present in the store are dropped.
 *
 * Moved-key resolution is automatic: `resolveIssueKey` searches historical
 * keys so a PR referencing OLD-99 (later renamed ACME-2) still links correctly.
 *
 * Idempotent: upserts on (pr_id, issue_id, link_source) — re-running is safe.
 */
export async function linkIssues(
  store: Store,
  options: LinkIssuesOptions = {},
): Promise<LinkIssuesResult> {
  const at = options.now ?? new Date(8_640_000_000_000_000).toISOString()
  let linksUpserted = 0
  let falsePositivesDropped = 0

  // `at` is constant for the whole run, so resolveIssueKey(key, at) is pure per
  // key — memoise it to collapse the previous N+1 (one point query per candidate
  // key of every PR) down to one query per DISTINCT key.
  const keyResolution = new Map<string, string | null>()
  const resolveKey = async (key: string): Promise<string | null> => {
    const cached = keyResolution.get(key)
    if (cached !== undefined) return cached
    const issueId = await store.resolveIssueKey(key, at)
    keyResolution.set(key, issueId)
    return issueId
  }

  // Wrap the whole pass in one transaction: across thousands of PRs this issues
  // many upsertPrIssueLink writes; one BEGIN/COMMIT batches them into a single
  // durable commit instead of one WAL fsync per link.
  await store.transaction(async () => {
    const orgs = await store.listOrganisations()
    for (const org of orgs) {
      const repos = await store.getRepositoriesByOrg(org.id)
      for (const repo of repos) {
        const prs = await store.getPullRequestsByRepo(repo.id)
        for (const pr of prs) {
          if (pr.deletedAt) continue

          const { title, body } = parsePrRaw(pr.raw)
          const headRef = pr.headRef

          // Linking is scoped to THIS PR's own text (title, body, head_ref).
          // We deliberately do NOT scan repo-wide commit messages: the store has
          // no PR↔commit association, so matching all repo commits linked a PR to
          // issue keys mentioned in *unrelated* PRs' commits — and the false-
          // positive guard can't catch that because those keys are real. (It was
          // also O(PRs × commits) with repeated JSON.parse of every commit.)
          // Proper commit-scoped linking needs a PR-commits join captured at
          // ingest (WP-LINKING follow-up).

          // Build a deduplicated set of (key, source, confidence) candidates.
          // Use Map<key, {source, confidence}> keeping highest confidence per key.
          const candidates = new Map<
            string,
            { source: PrIssueLink['linkSource']; confidence: number }
          >()

          function addCandidate(
            key: string,
            source: PrIssueLink['linkSource'],
            confidence: number,
          ): void {
            const existing = candidates.get(key)
            if (existing === undefined || confidence > existing.confidence) {
              candidates.set(key, { source, confidence })
            }
          }

          // 1. Smart-commit patterns (highest confidence — explicit intent)
          for (const key of extractSmartCommitKeys(`${title} ${body}`)) {
            addCandidate(key, 'smartcommit', 0.98)
          }

          // 2. Branch name (high confidence — deliberate naming)
          for (const key of extractBranchKeys(headRef)) {
            addCandidate(key, 'branch', 0.85)
          }

          // 3. Regex in title/body (medium confidence)
          for (const key of extractRegexKeys(`${title} ${body}`)) {
            addCandidate(key, 'regex', 0.75)
          }

          // Resolve each candidate key through issue_keys history (false-positive guard
          // + moved-key resolution).
          for (const [key, { source, confidence }] of candidates) {
            const issueId = await resolveKey(key)
            if (issueId === null) {
              falsePositivesDropped++
              continue
            }

            const link: PrIssueLink = {
              prId: pr.id,
              issueId,
              linkSource: source,
              confidence,
            }
            await store.upsertPrIssueLink(link)
            linksUpserted++
          }
        }
      }
    }
  })

  return { linksUpserted, falsePositivesDropped }
}

// ---------------------------------------------------------------------------
// linkageRate: linked merged PRs / total merged PRs
// ---------------------------------------------------------------------------

/**
 * Compute the PR linkage rate: the fraction of merged PRs that have at least
 * one `pr_issue_links` entry.
 *
 * Returns `null` when there are no merged PRs (zero-denominator → null per §8.6).
 */
export async function linkageRate(store: Store): Promise<number | null> {
  const orgs = await store.listOrganisations()
  let mergedTotal = 0
  let linked = 0

  // Fetch the set of linked PR ids in one query instead of one lookup per PR.
  const linkedPrIds = new Set(await store.getLinkedPrIds())

  for (const org of orgs) {
    const repos = await store.getRepositoriesByOrg(org.id)
    for (const repo of repos) {
      const prs = await store.getPullRequestsByRepo(repo.id)
      for (const pr of prs) {
        if (pr.deletedAt) continue
        if (pr.state !== 'merged') continue
        mergedTotal++
        if (linkedPrIds.has(pr.id)) linked++
      }
    }
  }

  if (mergedTotal === 0) return null
  return linked / mergedTotal
}
