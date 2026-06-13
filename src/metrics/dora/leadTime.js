import { ENGINE_VERSION, meetsSampleFloor, percentile, quantiles } from '../../core/index.js'

const FORMULA_DOC =
  'Lead Time for Changes (SPEC §8.1, §8.6): each merged PR is attributed ONCE to the first ' +
  'successful deploy at/after its mergedAt; lead time = deploy.finishedAt − PR.firstCommitAt ' +
  '(earliest commit authored_at in the PR). PRs with no subsequent deploy are excluded. Reports ' +
  'p50/p75/p90 (type-7 linear interpolation). Squash/rebase flag raised when the deployed commit ' +
  'was authored at/after the PR merge (author-date reset). Minimum 1 sample required.'

function isoToMs(iso) {
  return new Date(iso).getTime()
}

export const leadTime = {
  id: 'dora.lead_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28, environment: 'production' },

  compute(inputs, asOf) {
    const env = inputs.environment ?? 'production'
    const successDeploys = inputs.deploys
      .filter((d) => d.status === 'success' && d.environment === env && d.finishedAt !== null)
      // Earliest-first so we can attribute each PR to the first deploy after merge.
      .sort((a, b) => isoToMs(a.finishedAt) - isoToMs(b.finishedAt))

    // repoId → successful deploys (sorted ascending by finishedAt).
    const deploysByRepo = new Map()
    for (const d of successDeploys) {
      const arr = deploysByRepo.get(d.repoId)
      if (arr) arr.push(d)
      else deploysByRepo.set(d.repoId, [d])
    }

    // repoId+sha → commit, for squash detection.
    const commitMap = new Map()
    for (const c of inputs.commits) {
      commitMap.set(`${c.repoId}:${c.sha}`, c)
    }

    const leadTimeSeconds = []
    let squashRebaseDetected = false

    // Attribute each merged PR to the FIRST deploy that could have shipped it,
    // contributing exactly one sample (no per-deploy re-counting).
    for (const pr of inputs.prs) {
      if (pr.mergedAt === null || pr.firstCommitAt === null) continue
      const mergedMs = isoToMs(pr.mergedAt)
      const repoDeploys = deploysByRepo.get(pr.repoId)
      if (!repoDeploys) continue

      const shippingDeploy = repoDeploys.find((d) => isoToMs(d.finishedAt) >= mergedMs)
      if (!shippingDeploy) continue // never deployed → not a completed change

      const deployMs = isoToMs(shippingDeploy.finishedAt)
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
