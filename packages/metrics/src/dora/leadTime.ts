/**
 * Lead Time for Changes — DORA Group A (SPEC §8.1)
 *
 * Per-commit lead time = deploy.finishedAt − commit.firstCommitAt (anchored on
 * pull_requests.first_commit_at per SPEC §8.6).
 *
 * Each merged PR is attributed to the FIRST successful deployment in its repo
 * whose finishedAt is at/after the PR's mergedAt (the earliest deploy that could
 * have shipped it), and contributes exactly ONE lead-time sample:
 * deploy.finishedAt − PR.firstCommitAt (seconds). PRs with no subsequent deploy
 * are excluded. (The PR projection carries no merge/head SHA, so a true
 * commit-set join isn't possible here; first-deploy-after-merge is the correct
 * single-count approximation — counting per-deploy double-counted every
 * historical PR once per later deploy and inflated all percentiles.)
 *
 * Reports median p50/p75/p90 per SPEC §8.1.
 *
 * Squash/rebase flag: raised when the deployed commit was authored at/after the
 * PR merge (the signature of a squash/merge commit whose author-date was reset),
 * not merely because it differs from the first commit.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, meetsSampleFloor, percentile, quantiles } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { CommitRecord, DeployRecord, PrRecord } from './types.js'

export interface LeadTimeInputs {
  deploys: readonly DeployRecord[]
  prs: readonly PrRecord[]
  commits: readonly CommitRecord[]
  /** Window length in days (used for filtering). */
  windowDays: number
  /** Environment filter (default 'production'). */
  environment?: string
  /** Reference timestamp for window (asOf). */
  windowStart?: string
}

export interface LeadTimeResult extends MetricResult {
  readonly p50Seconds: number | null
  readonly p75Seconds: number | null
  readonly p90Seconds: number | null
  readonly sampleSize: number
  /** True if any deploy in the window is a squash/rebase commit (author-date reset risk). */
  readonly squashRebaseDetected: boolean
}

const FORMULA_DOC =
  'Lead Time for Changes (SPEC §8.1, §8.6): each merged PR is attributed ONCE to the first ' +
  'successful deploy at/after its mergedAt; lead time = deploy.finishedAt − PR.firstCommitAt ' +
  '(earliest commit authored_at in the PR). PRs with no subsequent deploy are excluded. Reports ' +
  'p50/p75/p90 (type-7 linear interpolation). Squash/rebase flag raised when the deployed commit ' +
  'was authored at/after the PR merge (author-date reset). Minimum 1 sample required.'

function isoToMs(iso: string): number {
  return new Date(iso).getTime()
}

export const leadTime: MetricModule<LeadTimeInputs, LeadTimeResult> = {
  id: 'dora.lead_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28, environment: 'production' },

  compute(inputs, asOf): LeadTimeResult {
    const env = inputs.environment ?? 'production'
    const successDeploys = inputs.deploys
      .filter((d) => d.status === 'success' && d.environment === env && d.finishedAt !== null)
      // Earliest-first so we can attribute each PR to the first deploy after merge.
      .sort((a, b) => isoToMs(a.finishedAt as string) - isoToMs(b.finishedAt as string))

    // repoId → successful deploys (sorted ascending by finishedAt).
    const deploysByRepo = new Map<string, DeployRecord[]>()
    for (const d of successDeploys) {
      const arr = deploysByRepo.get(d.repoId)
      if (arr) arr.push(d)
      else deploysByRepo.set(d.repoId, [d])
    }

    // repoId+sha → commit, for squash detection.
    const commitMap = new Map<string, CommitRecord>()
    for (const c of inputs.commits) {
      commitMap.set(`${c.repoId}:${c.sha}`, c)
    }

    const leadTimeSeconds: number[] = []
    let squashRebaseDetected = false

    // Attribute each merged PR to the FIRST deploy that could have shipped it,
    // contributing exactly one sample (no per-deploy re-counting).
    for (const pr of inputs.prs) {
      if (pr.mergedAt === null || pr.firstCommitAt === null) continue
      const mergedMs = isoToMs(pr.mergedAt)
      const repoDeploys = deploysByRepo.get(pr.repoId)
      if (!repoDeploys) continue

      const shippingDeploy = repoDeploys.find((d) => isoToMs(d.finishedAt as string) >= mergedMs)
      if (!shippingDeploy) continue // never deployed → not a completed change

      const deployMs = isoToMs(shippingDeploy.finishedAt as string)
      const commitMs = isoToMs(pr.firstCommitAt)
      // Clamp to 0 (guard against clock skew per §8.6).
      leadTimeSeconds.push(Math.max(0, deployMs - commitMs) / 1000)

      // Squash/rebase signature: the deployed commit was authored at/after the
      // PR merge (its author-date was reset to merge time). This avoids the old
      // false positive that fired for any PR spanning more than a minute.
      const deployCommit = commitMap.get(`${shippingDeploy.repoId}:${shippingDeploy.sha}`)
      if (deployCommit && isoToMs(deployCommit.authoredAt) >= mergedMs - 1000) {
        squashRebaseDetected = true
      }
    }

    const n = leadTimeSeconds.length
    const meetsP90Floor = meetsSampleFloor(n, 0.9)

    if (n === 0) {
      return {
        id: 'dora.lead_time',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'seconds',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        p50Seconds: null,
        p75Seconds: null,
        p90Seconds: null,
        sampleSize: 0,
        squashRebaseDetected,
      }
    }

    const qs = quantiles(leadTimeSeconds)
    const p90 = meetsP90Floor ? (qs?.p90 ?? null) : null

    return {
      id: 'dora.lead_time',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'seconds',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      p50Seconds: qs?.p50 ?? null,
      p75Seconds: qs?.p75 ?? null,
      p90Seconds: p90,
      sampleSize: n,
      squashRebaseDetected,
    }
  },
}

// Re-export for convenience
export { percentile }
