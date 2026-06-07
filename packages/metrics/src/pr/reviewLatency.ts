/**
 * Review Latency Decomposition — PR/Review Group C (SPEC §8.3)
 *
 * Three sub-metrics:
 *   First-Response: time from readyAt to first review event
 *   Rework:         time spent in changes-requested state (sum of CR rounds per PR)
 *   Idle:           time with no review activity (pickup + time between rounds)
 *
 * Time-to-First-Review and Time-to-Merge are separate simple metrics.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, quantiles } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { PrInput, ReviewInput } from './types.js'

export interface ReviewLatencyInputs {
  prs: readonly PrInput[]
  reviews: readonly ReviewInput[]
}

export interface ReviewLatencyResult extends MetricResult {
  readonly firstResponseP50Seconds: number | null
  readonly reworkP50Seconds: number | null
  readonly idleP50Seconds: number | null
  readonly sampleSize: number
}

const FORMULA_DOC =
  'Review Latency Decomposition (SPEC §8.3): ' +
  'First-Response = first review submittedAt − readyAt. ' +
  'Rework = time from changes_requested to next review event. ' +
  'Idle = total latency − first_response − rework. ' +
  'Reports p50 (type-7). Only merged PRs with at least one review.'

function diffMs(a: string, b: string): number {
  return Math.max(0, new Date(b).getTime() - new Date(a).getTime())
}

export const reviewLatency: MetricModule<ReviewLatencyInputs, ReviewLatencyResult> = {
  id: 'pr.review_latency',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): ReviewLatencyResult {
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged' && pr.mergedAt !== null)

    // Group reviews by prId, sorted by submittedAt
    const reviewsByPr = new Map<string, ReviewInput[]>()
    for (const rev of inputs.reviews) {
      if (!reviewsByPr.has(rev.prId)) reviewsByPr.set(rev.prId, [])
      reviewsByPr.get(rev.prId)?.push(rev)
    }
    for (const [, revs] of reviewsByPr) {
      revs.sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
    }

    const firstResponseSecs: number[] = []
    const reworkSecs: number[] = []
    const idleSecs: number[] = []

    for (const pr of mergedPrs) {
      const revs = reviewsByPr.get(pr.id)
      if (!revs || revs.length === 0) continue

      const readyTs = pr.readyAt ?? pr.createdAt
      const firstRev = revs[0]
      if (!firstRev) continue

      // First-response latency
      const frMs = diffMs(readyTs, firstRev.submittedAt)
      firstResponseSecs.push(frMs / 1000)

      // Rework: sum time between changes_requested and the next review event
      let reworkMs = 0
      for (let i = 0; i < revs.length; i++) {
        const rev = revs[i]
        if (!rev) continue
        if (rev.state === 'changes_requested') {
          const nextRev = revs[i + 1]
          if (nextRev) {
            reworkMs += diffMs(rev.submittedAt, nextRev.submittedAt)
          }
        }
      }
      reworkSecs.push(reworkMs / 1000)

      // Idle: total latency (readyAt → mergedAt) − first_response − rework
      if (pr.mergedAt) {
        const totalMs = diffMs(readyTs, pr.mergedAt)
        const idleMs = Math.max(0, totalMs - frMs - reworkMs)
        idleSecs.push(idleMs / 1000)
      }
    }

    const n = firstResponseSecs.length

    const frQ = quantiles(firstResponseSecs)
    const rwQ = quantiles(reworkSecs)
    const idleQ = quantiles(idleSecs)

    return {
      id: 'pr.review_latency',
      trustTier: 'deterministic',
      scope: 'team',
      value: frQ?.p50 ?? null,
      unit: 'seconds',
      dataQuality: n === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      firstResponseP50Seconds: frQ?.p50 ?? null,
      reworkP50Seconds: rwQ?.p50 ?? null,
      idleP50Seconds: idleQ?.p50 ?? null,
      sampleSize: n,
    }
  },
}

// ---------------------------------------------------------------------------
// Time-to-First-Review
// ---------------------------------------------------------------------------

export interface TimeToFirstReviewInputs {
  prs: readonly PrInput[]
}

export interface TimeToFirstReviewResult extends MetricResult {
  readonly p50Seconds: number | null
  readonly p75Seconds: number | null
  readonly p90Seconds: number | null
  readonly sampleSize: number
}

const TTR_DOC =
  'Time-to-First-Review (SPEC §8.3): firstReviewAt − readyAt (or createdAt). ' +
  'Only merged PRs with a first review. Reports p50/p75/p90 (type-7).'

export const timeToFirstReview: MetricModule<TimeToFirstReviewInputs, TimeToFirstReviewResult> = {
  id: 'pr.time_to_first_review',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: TTR_DOC,
  params: {},

  compute(inputs, asOf): TimeToFirstReviewResult {
    const values: number[] = []
    for (const pr of inputs.prs) {
      if (pr.state !== 'merged' || !pr.firstReviewAt) continue
      const readyTs = pr.readyAt ?? pr.createdAt
      const ms = Math.max(0, new Date(pr.firstReviewAt).getTime() - new Date(readyTs).getTime())
      values.push(ms / 1000)
    }

    const n = values.length
    const qs = quantiles(values)

    return {
      id: 'pr.time_to_first_review',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'seconds',
      dataQuality: n === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: TTR_DOC,
      p50Seconds: qs?.p50 ?? null,
      p75Seconds: qs?.p75 ?? null,
      p90Seconds: meetsSampleFloor(n, 0.9) ? (qs?.p90 ?? null) : null,
      sampleSize: n,
    }
  },
}

// ---------------------------------------------------------------------------
// Time-to-Merge
// ---------------------------------------------------------------------------

export interface TimeToMergeInputs {
  prs: readonly PrInput[]
}

export interface TimeToMergeResult extends MetricResult {
  readonly p50Seconds: number | null
  readonly p75Seconds: number | null
  readonly p90Seconds: number | null
  readonly sampleSize: number
}

const TTM_DOC =
  'Time-to-Merge (SPEC §8.3): mergedAt − readyAt (or createdAt). ' +
  'Only merged PRs. Reports p50/p75/p90 (type-7).'

export const timeToMerge: MetricModule<TimeToMergeInputs, TimeToMergeResult> = {
  id: 'pr.time_to_merge',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: TTM_DOC,
  params: {},

  compute(inputs, asOf): TimeToMergeResult {
    const values: number[] = []
    for (const pr of inputs.prs) {
      if (pr.state !== 'merged' || !pr.mergedAt) continue
      const readyTs = pr.readyAt ?? pr.createdAt
      const ms = Math.max(0, new Date(pr.mergedAt).getTime() - new Date(readyTs).getTime())
      values.push(ms / 1000)
    }

    const n = values.length
    const qs = quantiles(values)

    return {
      id: 'pr.time_to_merge',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'seconds',
      dataQuality: n === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: TTM_DOC,
      p50Seconds: qs?.p50 ?? null,
      p75Seconds: qs?.p75 ?? null,
      p90Seconds: meetsSampleFloor(n, 0.9) ? (qs?.p90 ?? null) : null,
      sampleSize: n,
    }
  },
}
