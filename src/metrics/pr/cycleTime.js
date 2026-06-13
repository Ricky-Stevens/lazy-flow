import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'PR Cycle Time 4-phase (SPEC §8.3): ' +
  'Coding = readyAt − firstCommitAt; ' +
  'Pickup = firstReviewAt − readyAt; ' +
  'Review = mergedAt − firstReviewAt; ' +
  'Deploy = deployFinishedAt − mergedAt. ' +
  'Only merged PRs. Reports p50/p75/p85/p90/p95 (type-7). ' +
  'p90/p95 suppressed below sample floor (n<20/n<30).'

function msToSec(ms) {
  return ms / 1000
}

function diffSec(a, b) {
  if (!a || !b) return null
  const diff = new Date(b).getTime() - new Date(a).getTime()
  // A truthy-but-unparseable timestamp yields NaN here; return null rather than
  // letting Math.max(0, NaN)=NaN leak into the percentile arrays (which would
  // otherwise mis-sort and produce order-dependent quantiles).
  if (!Number.isFinite(diff)) return null
  return Math.max(0, msToSec(diff))
}

function buildPhaseQuantiles(values) {
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

export const prCycleTime = {
  id: 'pr.cycle_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf) {
    const env = inputs.environment ?? 'production'
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged' && pr.mergedAt !== null)

    // Build a map from repoId → latest deploy finishedAt at or after mergedAt
    const deploysByRepo = new Map()
    for (const d of inputs.deploys) {
      if (d.environment !== env || d.status !== 'success' || !d.finishedAt) continue
      if (!deploysByRepo.has(d.repoId)) deploysByRepo.set(d.repoId, [])
      deploysByRepo.get(d.repoId)?.push(d)
    }

    const codingValues = []
    const pickupValues = []
    const reviewValues = []
    const deployValues = []
    const totalValues = []

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
      let deployPhase = null
      if (pr.mergedAt) {
        const mergedMs = new Date(pr.mergedAt).getTime()
        const repoDeploys = deploysByRepo.get(pr.repoId) ?? []
        const nextDeploy = repoDeploys
          .filter((d) => d.finishedAt && new Date(d.finishedAt).getTime() >= mergedMs)
          .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime())[0]
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
