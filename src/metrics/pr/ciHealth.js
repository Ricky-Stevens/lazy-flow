import { ENGINE_VERSION, meetsSampleFloor, quantiles, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'CI/Check-Run Health (SPEC §8.3): ' +
  'passRate = success_runs / total_completed_runs. ' +
  'Latency = completedAt − startedAt (p50/p90). ' +
  'Flakiness proxy = fraction of (sha, name) pairs with >1 run. ' +
  'p90 suppressed below sample floor (n<20).'

export const ciHealth = {
  id: 'pr.ci_health',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const completed = inputs.checkRuns.filter(
      (cr) => cr.status === 'completed' && cr.conclusion !== null,
    )

    if (completed.length === 0) {
      return {
        id: 'pr.ci_health',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        passRate: null,
        totalCompleted: 0,
        successCount: 0,
        p50LatencySeconds: null,
        p90LatencySeconds: null,
        flakinessRate: null,
      }
    }

    const success = completed.filter((cr) => cr.conclusion === 'success').length
    const passRate = safeRatio(success, completed.length)

    // Latency
    const latencies = []
    for (const cr of completed) {
      if (cr.startedAt && cr.completedAt) {
        const ms = Math.max(
          0,
          new Date(cr.completedAt).getTime() - new Date(cr.startedAt).getTime(),
        )
        latencies.push(ms / 1000)
      }
    }

    const qs = quantiles(latencies)
    const n = latencies.length

    // Flakiness: a (sha, name) is flaky only when its runs disagree — i.e. the
    // SAME check on the SAME commit produced more than one distinct conclusion
    // (e.g. failure then success), matching the module definition
    // "conclusion ≠ first attempt". Counting any pair with >1 run conflated
    // deterministic re-runs (all-success retries, manual "Re-run all jobs")
    // with genuine flakiness, inflating the rate toward 100%.
    const shaNameConclusions = new Map()
    for (const cr of completed) {
      const key = `${cr.headSha}:${cr.name}`
      let conclusions = shaNameConclusions.get(key)
      if (!conclusions) {
        conclusions = new Set()
        shaNameConclusions.set(key, conclusions)
      }
      conclusions.add(cr.conclusion ?? 'unknown')
    }
    const totalPairs = shaNameConclusions.size
    const flakyPairs = [...shaNameConclusions.values()].filter((s) => s.size > 1).length
    const flakinessRate = safeRatio(flakyPairs, totalPairs)

    return {
      id: 'pr.ci_health',
      trustTier: 'deterministic',
      scope: 'team',
      value: passRate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      passRate,
      totalCompleted: completed.length,
      successCount: success,
      p50LatencySeconds: qs?.p50 ?? null,
      p90LatencySeconds: meetsSampleFloor(n, 0.9) ? (qs?.p90 ?? null) : null,
      flakinessRate,
    }
  },
}
