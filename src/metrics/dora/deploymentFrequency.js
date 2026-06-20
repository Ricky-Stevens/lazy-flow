import { ENGINE_VERSION, environmentMatches, safeRatio } from '../../core/index.js'

/** Map deploys/day to a DORA 2025 band. */
export function doraBandFromRate(deploysPerDay) {
  if (deploysPerDay >= 1) return 'elite'
  // 1/week ≈ 0.143/day; 1/month ≈ 0.033/day
  if (deploysPerDay >= 1 / 7) return 'high'
  if (deploysPerDay >= 1 / 30) return 'medium'
  return 'low'
}

const FORMULA_DOC =
  'Deployment Frequency (SPEC §8.1): count(prod deploys, status=success) / windowDays, ' +
  'where the caller passes the deploys already scoped to the window. DORA band is ' +
  'derived directly from deploys/day: elite ≥1/day, high 1/week–1/month, medium ' +
  '1/month–1/6months, low <1/6months (DORA 2025 benchmarks). `deployDays` (distinct ' +
  'UTC calendar days with a success deploy) is surfaced as a supplementary signal.'

export const deploymentFrequency = {
  id: 'dora.deployment_frequency',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28, environment: 'production' },

  compute(inputs, asOf) {
    const env = inputs.environment ?? 'production'
    const successDeploys = inputs.deploys.filter(
      (d) => d.status === 'success' && environmentMatches(d.environment, env),
    )
    const total = successDeploys.length

    // Distinct calendar days (UTC date string)
    const deployDaySet = new Set(successDeploys.map((d) => d.createdAt.slice(0, 10)))
    const deployDays = deployDaySet.size

    // When there are no deploys, return null (not 0) — SPEC §8.6 zero-denom rule.
    // windowDays is the denominator but "no deploys" is no_data, not a zero rate.
    const deploysPerDay = total === 0 ? null : safeRatio(total, inputs.windowDays)
    const doraBand = deploysPerDay !== null ? doraBandFromRate(deploysPerDay) : null

    const dataQuality = total === 0 ? 'no_data' : 'ok'

    return {
      id: 'dora.deployment_frequency',
      trustTier: 'deterministic',
      scope: 'team',
      value: deploysPerDay,
      unit: 'deploys/day',
      dataQuality,
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      deploysPerDay,
      totalSuccessDeploys: total,
      doraBand,
      deployDays,
    }
  },
}
