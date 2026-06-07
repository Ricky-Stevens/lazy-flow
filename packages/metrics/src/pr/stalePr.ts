/**
 * Stale PR Detection — PR/Review Group C (SPEC §8.3)
 *
 * A PR is stale when it has been open (non-draft, non-merged) with no
 * meaningful activity for longer than the staleness threshold.
 * "Last meaningful activity" = max(lastCommentAt, lastReviewAt, updatedAt).
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { ReviewCommentInput, ReviewInput } from './types.js'

export interface StalePrInput {
  id: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  createdAt: string
  updatedAt: string
}

export interface StalePrInputs {
  prs: readonly StalePrInput[]
  reviews: readonly ReviewInput[]
  reviewComments: readonly ReviewCommentInput[]
  /** Reference timestamp (asOf) — PRs inactive before (asOf − thresholdDays) are stale. */
  thresholdDays?: number
}

export interface StalePrResult extends MetricResult {
  readonly stalePrCount: number
  readonly openPrCount: number
  readonly staleRate: number | null
  /** IDs of stale PRs. */
  readonly stalePrIds: readonly string[]
}

const FORMULA_DOC =
  'Stale PR Detection (SPEC §8.3): open non-draft PRs with no meaningful activity ' +
  '(review, comment, or update) for > thresholdDays (default 14). ' +
  'staleRate = stalePrCount / openPrCount. Returns null on 0 open PRs.'

export const stalePr: MetricModule<StalePrInputs, StalePrResult> = {
  id: 'pr.stale',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { thresholdDays: 14 },

  compute(inputs, asOf): StalePrResult {
    const thresholdDays = inputs.thresholdDays ?? 14
    const asOfMs = new Date(asOf).getTime()
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000

    const openPrs = inputs.prs.filter((pr) => pr.state === 'open' && !pr.isDraft)

    if (openPrs.length === 0) {
      return {
        id: 'pr.stale',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'count',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        stalePrCount: 0,
        openPrCount: 0,
        staleRate: null,
        stalePrIds: [],
      }
    }

    // Last activity timestamps per PR
    const lastActivity = new Map<string, number>()
    for (const pr of openPrs) {
      lastActivity.set(pr.id, new Date(pr.updatedAt).getTime())
    }

    for (const rev of inputs.reviews) {
      if (!lastActivity.has(rev.prId)) continue
      const ts = new Date(rev.submittedAt).getTime()
      const current = lastActivity.get(rev.prId) ?? 0
      if (ts > current) lastActivity.set(rev.prId, ts)
    }

    for (const comment of inputs.reviewComments) {
      if (!lastActivity.has(comment.prId)) continue
      const ts = new Date(comment.createdAt).getTime()
      const current = lastActivity.get(comment.prId) ?? 0
      if (ts > current) lastActivity.set(comment.prId, ts)
    }

    const stalePrIds: string[] = []
    for (const pr of openPrs) {
      const lastTs = lastActivity.get(pr.id) ?? new Date(pr.createdAt).getTime()
      if (asOfMs - lastTs > thresholdMs) {
        stalePrIds.push(pr.id)
      }
    }

    const staleRate = safeRatio(stalePrIds.length, openPrs.length)

    return {
      id: 'pr.stale',
      trustTier: 'deterministic',
      scope: 'team',
      value: stalePrIds.length,
      unit: 'count',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      stalePrCount: stalePrIds.length,
      openPrCount: openPrs.length,
      staleRate,
      stalePrIds,
    }
  },
}
