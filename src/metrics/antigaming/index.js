/**
 * Gaming detection & data-quality annotation — WP-ANTIGAMING (SPEC §10)
 *
 * Detectors annotate metric outputs with a `data_quality` / confidence flag.
 * They do NOT silently penalise — they flag so the MCP/explain surface can
 * surface the concern to the model and the team.
 *
 * Detectors:
 *   1. deploymentFrequencyInflation — non-prod or rapid redeploys
 *   2. cfrSuppression               — deploy + later hotfix/revert, but NO incident ticket
 *   3. leadTimeReset                — squash/rebase author-date rewrite detected
 *   4. statusJuggling               — rapid back-and-forth transitions inflate flow efficiency
 *   5. trivialPrSplitting           — many tiny PRs in a short window from one author
 *
 * Goodhart warning: surface when a caller attempts to pin a metric as a hard target.
 *
 * No single composite "productivity number" is produced — assert this is so.
 *
 * All functions are pure (injected clock via `now`), deterministic, and side-effect-free.
 */

// ---------------------------------------------------------------------------
// DataQuality extension for gaming flags
// ---------------------------------------------------------------------------

/**
 * Extended data quality / confidence tags that include gaming-signal flags.
 * Superset of the core `DataQuality` union — the base values are preserved
 * so this type is a drop-in annotation alongside `MetricResult.dataQuality`.
 */

/**
 * Detects deployment-frequency inflation:
 * - Non-production environment deployments counted in a `production` window.
 * - Rapid consecutive redeploys of the same environment within `rapidRedeployWindowMs`.
 *
 * Returns `deploy_frequency_inflated` when either signal is found.
 */
export function detectDeployInflation(deploys, opts = {}) {
  const targetEnv = opts.targetEnv ?? 'production'
  const rapidMs = opts.rapidRedeployWindowMs ?? 5 * 60 * 1000

  // Non-prod deployments included in a prod window
  const nonProdIncluded = deploys.some((d) => d.environment !== targetEnv)
  if (nonProdIncluded) {
    return {
      flag: 'deploy_frequency_inflated',
      reason:
        `Non-production deployments (env != '${targetEnv}') included in the window. ` +
        'Frequency count may be inflated.',
    }
  }

  // Rapid redeploys: sort by createdAt, check gap between consecutive deploys to same env
  const sorted = [...deploys]
    .filter((d) => d.environment === targetEnv)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    // noUncheckedIndexedAccess: both are defined since we index within bounds
    if (prev === undefined || curr === undefined) continue
    const gap = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime()
    if (gap < rapidMs) {
      return {
        flag: 'deploy_frequency_inflated',
        reason:
          `Rapid consecutive redeployments detected (gap ${gap}ms < ${rapidMs}ms). ` +
          `Deploy '${curr.id}' followed '${prev.id}' suspiciously quickly — frequency may be inflated.`,
      }
    }
  }

  return { flag: 'ok', reason: '' }
}

// ---------------------------------------------------------------------------
// 2. CFR suppression
// ---------------------------------------------------------------------------

/**
 * Detects CFR suppression:
 * a deploy is followed by a hotfix/revert event but has NO incident ticket.
 *
 * Pattern: team reverts or hotfixes a bad deploy without raising an incident,
 * suppressing the CFR numerator.
 */
export function detectCfrSuppression(deploys) {
  const suppressed = deploys.filter((d) => d.hotfixOrRevertAt !== null && !d.hasLinkedIncident)

  if (suppressed.length > 0) {
    const ids = suppressed.map((d) => d.deployId).join(', ')
    return {
      flag: 'cfr_suppressed',
      reason:
        `${suppressed.length} deploy(s) had a subsequent hotfix/revert but no linked incident ticket. ` +
        `CFR may be understated. Deploy ids: ${ids}`,
    }
  }

  return { flag: 'ok', reason: '' }
}

// ---------------------------------------------------------------------------
// 3. Lead-time reset (squash/rebase author-date rewrite)
// ---------------------------------------------------------------------------

/**
 * Detects lead-time resets caused by squash/rebase author-date rewrites.
 *
 * A reset is flagged when the merge commit's authored_at is significantly LATER
 * than the first commit's authored_at — meaning a squash/rebase replaced the
 * historical commit timestamps, making the work appear shorter.
 *
 * Threshold: mergeCommitAuthoredAt > firstCommitAuthoredAt + thresholdMs
 * Default threshold: 1 hour (3 600 000 ms).
 */
export function detectLeadTimeReset(prs, opts = {}) {
  const thresholdMs = opts.thresholdMs ?? 60 * 60 * 1000 // 1 hour

  const resets = prs.filter((pr) => {
    const mergeMs = new Date(pr.mergeCommitAuthoredAt).getTime()
    const firstMs = new Date(pr.firstCommitAuthoredAt).getTime()
    // The merge commit was authored significantly AFTER the first commit:
    // squash/rebase moved the anchor forward → shorter apparent lead time.
    return mergeMs - firstMs > thresholdMs
  })

  if (resets.length > 0) {
    const ids = resets.map((pr) => pr.prId).join(', ')
    return {
      flag: 'lead_time_reset',
      reason:
        `${resets.length} PR(s) show a squash/rebase author-date reset. ` +
        'The merge commit authored_at is significantly later than the first commit, ' +
        `shortening apparent lead time. PR ids: ${ids}`,
    }
  }

  return { flag: 'ok', reason: '' }
}

// ---------------------------------------------------------------------------
// 4. Status juggling (inflates flow efficiency)
// ---------------------------------------------------------------------------

/**
 * Detects status juggling that inflates flow efficiency.
 *
 * Pattern: a ticket rapidly alternates between an active status and a wait
 * status in a short window, artificially increasing the active-time fraction.
 *
 * Detection heuristic:
 * - Count back-and-forth transitions (A → B → A) within `windowMs`.
 * - Flag when an issue has `minRoundTrips` or more such round-trips.
 */
export function detectStatusJuggling(issues, opts = {}) {
  const windowMs = opts.windowMs ?? 60 * 60 * 1000 // 1 hour
  const minRoundTrips = opts.minRoundTrips ?? 2

  const juggled = []

  for (const issue of issues) {
    const txns = issue.transitions
    let roundTrips = 0

    // A → B → A is formed by the adjacent transitions a=txns[i] and b=txns[i+1];
    // the round-trip's span is tB − tA. (The old code measured tC − tA against
    // the NEXT, unrelated transition and skipped trailing round-trips via the
    // `i + 2 < length` bound, both producing false negatives.)
    for (let i = 0; i + 1 < txns.length; i++) {
      const a = txns[i]
      const b = txns[i + 1]
      if (a === undefined || b === undefined) continue

      // Detect A → B → A round-trip pattern
      if (a.toStatusId === b.fromStatusId && b.toStatusId === a.fromStatusId) {
        const tA = new Date(a.transitionedAt).getTime()
        const tB = new Date(b.transitionedAt).getTime()
        if (tB - tA <= windowMs) {
          roundTrips++
        }
      }
    }

    if (roundTrips >= minRoundTrips) {
      juggled.push(issue.issueId)
    }
  }

  if (juggled.length > 0) {
    return {
      flag: 'status_juggling',
      reason:
        `${juggled.length} issue(s) show rapid back-and-forth status transitions ` +
        `(>= ${minRoundTrips} round-trips within ${windowMs}ms). ` +
        `Flow efficiency may be inflated. Issue ids: ${juggled.join(', ')}`,
    }
  }

  return { flag: 'ok', reason: '' }
}

// ---------------------------------------------------------------------------
// 5. Trivial PR splitting
// ---------------------------------------------------------------------------

/**
 * Detects trivial PR splitting: many tiny PRs from one author in a short window.
 *
 * Pattern: an author submits many very small PRs in a short window, inflating
 * PR throughput counts and potentially gaming deployment-frequency metrics.
 *
 * Detection:
 * - Group PRs by author.
 * - For each author, find any window of `windowMs` containing >= `minPrs` PRs
 *   that are all <= `maxSize` HALOC.
 */
export function detectTrivialPrSplitting(prs, opts = {}) {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000 // 24 hours
  const minPrs = opts.minPrs ?? 5
  const maxSize = opts.maxSize ?? 10

  // Group by author
  const byAuthor = new Map()
  for (const pr of prs) {
    if (!byAuthor.has(pr.authorPersonId)) byAuthor.set(pr.authorPersonId, [])
    byAuthor.get(pr.authorPersonId)?.push(pr)
  }

  const flaggedAuthors = []

  for (const [authorId, authorPrs] of byAuthor) {
    // Only consider tiny PRs
    const tinyPrs = authorPrs.filter((pr) => pr.size <= maxSize)
    if (tinyPrs.length < minPrs) continue

    // Sort by createdAt
    const sorted = [...tinyPrs].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )

    // Sliding window: find any sub-sequence of minPrs within windowMs
    for (let i = 0; i <= sorted.length - minPrs; i++) {
      const first = sorted[i]
      const last = sorted[i + minPrs - 1]
      if (first === undefined || last === undefined) continue
      const span = new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime()
      if (span <= windowMs) {
        flaggedAuthors.push(authorId)
        break // one flag per author is enough
      }
    }
  }

  if (flaggedAuthors.length > 0) {
    return {
      flag: 'trivial_pr_splitting',
      reason:
        `${flaggedAuthors.length} author(s) submitted >= ${minPrs} tiny PRs ` +
        `(size <= ${maxSize} HALOC) within a ${windowMs}ms window. ` +
        `PR throughput may be inflated. Author ids: ${flaggedAuthors.join(', ')}`,
    }
  }

  return { flag: 'ok', reason: '' }
}

// ---------------------------------------------------------------------------
// Goodhart warning
// ---------------------------------------------------------------------------

/**
 * The list of DORA / flow metric ids that are explicitly called out as
 * Goodhart-sensitive (per DORA's own guidance on not pinning targets).
 */
export const GOODHART_SENSITIVE_METRICS = new Set([
  'dora.deployment_frequency',
  'dora.lead_time',
  'dora.change_failure_rate',
  'dora.recovery_time',
  'flow.cycle_time',
  'flow.throughput',
  'flow.flow_efficiency',
  'pr.cycle_time',
])

/**
 * Returns a Goodhart warning when a caller attempts to pin a metric as a
 * hard target (SPEC §10).
 *
 * DORA's own guidance warns that "when a measure becomes a target, it ceases
 * to be a good measure" — especially for delivery metrics where gaming is easy.
 *
 * @param metricId - The metric the caller wants to use as a hard target.
 * @returns A warning object, or null when the metric is not Goodhart-sensitive.
 */
export function goodhartWarning(metricId) {
  if (!GOODHART_SENSITIVE_METRICS.has(metricId)) return null

  return {
    metricId,
    warning:
      `⚠️  Goodhart's Law warning: pinning '${metricId}' as a hard target risks gaming. ` +
      'When a measure becomes a target it ceases to be a good measure (Goodhart, 1975; DORA 2023 guidance). ' +
      'Use this metric as a directional signal, paired with quality counter-metrics (e.g. change_failure_rate ' +
      'alongside deployment_frequency), not as a performance gate.',
  }
}

// ---------------------------------------------------------------------------
// No composite productivity number guard
// ---------------------------------------------------------------------------

/**
 * Assert that no single composite "productivity number" is being produced.
 *
 * The product deliberately has no aggregate productivity score (SPEC §10,
 * SPEC §2.2 N2). Call this to document and enforce that a given computation
 * is not producing such a number.
 *
 * If the calledFunctionName sounds like a composite score (contains "score",
 * "productivity", "impact", "composite"), this throws in development.
 *
 * In production (NODE_ENV === 'production') this is a no-op so it does not
 * crash; it is primarily a dev-time and test-time assertion.
 */
export function assertNoCompositeProductivityNumber(calledFunctionName) {
  const forbidden = /score|productivity|impact|composite|rank|leaderboard/i
  if (forbidden.test(calledFunctionName)) {
    const msg =
      `'${calledFunctionName}' appears to compute a composite productivity number, ` +
      'which lazy-flow explicitly does not produce (SPEC §10, §2.2 N2). ' +
      'Use individual metric modules paired with SPACE-style counter-metrics instead.'
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(msg)
    }
  }
}
