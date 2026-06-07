/**
 * 4-phase PR Cycle Time — PR/Review Group C (SPEC §8.3)
 *
 * Phases (all in seconds):
 *   Coding   = readyAt (or createdAt) − firstCommitAt
 *   Pickup   = firstReviewAt − readyAt (or createdAt)
 *   Review   = mergedAt − firstReviewAt
 *   Deploy   = deployFinishedAt − mergedAt
 *
 * When a phase timestamp is missing, that phase is null for that PR.
 * Reports p50/p75/p85/p90/p95 per SPEC §8.1 aggregation rule.
 * Only merged PRs are included in cycle-time computation.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { DeployInput, PrInput } from './types.js'

export interface PrCycleTimeInputs {
  prs: readonly PrInput[]
  deploys: readonly DeployInput[]
  /** Environment filter for deploy phase (default 'production'). */
  environment?: string
}

export interface PhaseQuantiles {
  p50: number | null
  p75: number | null
  p85: number | null
  p90: number | null
  p95: number | null
  sampleSize: number
}

export interface PrCycleTimeResult extends MetricResult {
  readonly coding: PhaseQuantiles
  readonly pickup: PhaseQuantiles
  readonly review: PhaseQuantiles
  readonly deploy: PhaseQuantiles
  /** Total cycle time (coding + pickup + review + deploy) p50. */
  readonly totalP50Seconds: number | null
}

const FORMULA_DOC =
  'PR Cycle Time 4-phase (SPEC §8.3): ' +
  'Coding = readyAt − firstCommitAt; ' +
  'Pickup = firstReviewAt − readyAt; ' +
  'Review = mergedAt − firstReviewAt; ' +
  'Deploy = deployFinishedAt − mergedAt. ' +
  'Only merged PRs. Reports p50/p75/p85/p90/p95 (type-7). ' +
  'p90/p95 suppressed below sample floor (n<20/n<30).'

function msToSec(ms: number): number {
  return ms / 1000
}

function diffSec(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const diff = new Date(b).getTime() - new Date(a).getTime()
  // A truthy-but-unparseable timestamp yields NaN here; return null rather than
  // letting Math.max(0, NaN)=NaN leak into the percentile arrays (which would
  // otherwise mis-sort and produce order-dependent quantiles).
  if (!Number.isFinite(diff)) return null
  return Math.max(0, msToSec(diff))
}

function buildPhaseQuantiles(values: number[]): PhaseQuantiles {
  const n = values.length
  if (n === 0) return { p50: null, p75: null, p85: null, p90: null, p95: null, sampleSize: 0 }
  const qs = quantiles(values)
  if (!qs) return { p50: null, p75: null, p85: null, p90: null, p95: null, sampleSize: n }
  return {
    p50: qs.p50,
    p75: qs.p75,
    p85: qs.p85,
    p90: meetsSampleFloor(n, 0.9) ? qs.p90 : null,
    p95: meetsSampleFloor(n, 0.95) ? qs.p95 : null,
    sampleSize: n,
  }
}

export const prCycleTime: MetricModule<PrCycleTimeInputs, PrCycleTimeResult> = {
  id: 'pr.cycle_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf): PrCycleTimeResult {
    const env = inputs.environment ?? 'production'
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged' && pr.mergedAt !== null)

    // Build a map from repoId → latest deploy finishedAt at or after mergedAt
    const deploysByRepo = new Map<string, DeployInput[]>()
    for (const d of inputs.deploys) {
      if (d.environment !== env || d.status !== 'success' || !d.finishedAt) continue
      if (!deploysByRepo.has(d.repoId)) deploysByRepo.set(d.repoId, [])
      deploysByRepo.get(d.repoId)?.push(d)
    }

    const codingValues: number[] = []
    const pickupValues: number[] = []
    const reviewValues: number[] = []
    const deployValues: number[] = []
    const totalValues: number[] = []

    for (const pr of mergedPrs) {
      // Use readyAt if available, else createdAt as the "ready" timestamp
      const readyTs = pr.readyAt ?? pr.createdAt

      const coding = diffSec(pr.firstCommitAt, readyTs)
      const pickup = diffSec(readyTs, pr.firstReviewAt)
      const review = diffSec(pr.firstReviewAt, pr.mergedAt)

      // Deploy phase: first success deploy in the same repo with finishedAt ≥
      // mergedAt. NOTE: this is a per-PR single attribution (no double-count),
      // but it cannot confirm the deploy actually shipped this PR's commit — the
      // PR projection carries no merge/head SHA. First-deploy-after-merge is the
      // correct approximation until a PR↔commit/deploy association is captured.
      let deployPhase: number | null = null
      if (pr.mergedAt) {
        const mergedMs = new Date(pr.mergedAt).getTime()
        const repoDeploys = deploysByRepo.get(pr.repoId) ?? []
        const nextDeploy = repoDeploys
          .filter((d) => d.finishedAt && new Date(d.finishedAt).getTime() >= mergedMs)
          .sort(
            (a, b) =>
              new Date(a.finishedAt as string).getTime() -
              new Date(b.finishedAt as string).getTime(),
          )[0]
        if (nextDeploy?.finishedAt) {
          deployPhase = diffSec(pr.mergedAt, nextDeploy.finishedAt)
        }
      }

      if (coding !== null) codingValues.push(coding)
      if (pickup !== null) pickupValues.push(pickup)
      if (review !== null) reviewValues.push(review)
      if (deployPhase !== null) deployValues.push(deployPhase)

      // Total only when all 4 phases available
      if (coding !== null && pickup !== null && review !== null && deployPhase !== null) {
        totalValues.push(coding + pickup + review + deployPhase)
      }
    }

    const coding = buildPhaseQuantiles(codingValues)
    const pickup = buildPhaseQuantiles(pickupValues)
    const review = buildPhaseQuantiles(reviewValues)
    const deploy = buildPhaseQuantiles(deployValues)

    const totalP50 = totalValues.length > 0 ? (quantiles(totalValues)?.p50 ?? null) : null

    const dataQuality = mergedPrs.length === 0 ? 'no_data' : 'ok'

    return {
      id: 'pr.cycle_time',
      trustTier: 'deterministic',
      scope: 'team',
      value: totalP50,
      unit: 'seconds',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      coding,
      pickup,
      review,
      deploy,
      totalP50Seconds: totalP50,
    }
  },
}

// Export safeRatio for use in other PR metrics
export { safeRatio }
