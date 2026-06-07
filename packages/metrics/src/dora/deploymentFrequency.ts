/**
 * Deployment Frequency — DORA Group A (SPEC §8.1)
 *
 * Counts successful prod deploys per window and maps to a DORA band.
 *
 * DORA 2025 bands (deploys/day on median deploy-days/week basis):
 *   Elite:  ≥1/day (multiple times per day)
 *   High:   1/week – 1/month
 *   Medium: 1/month – 1/6 months
 *   Low:    <1/6 months
 *
 * formulaDoc: count(deploys where status='success' and environment='production') / windowDays.
 * Reports deploys_per_day. DORA band derived from median weekly deploy-days.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { DeployRecord } from './types.js'

export interface DeploymentFrequencyInputs {
  deploys: readonly DeployRecord[]
  /** Window length in days (default 28). */
  windowDays: number
  /** Environment filter (default 'production'). */
  environment?: string
}

export type DoraBand = 'elite' | 'high' | 'medium' | 'low'

export interface DeploymentFrequencyResult extends MetricResult {
  readonly deploysPerDay: number | null
  readonly totalSuccessDeploys: number
  readonly doraBand: DoraBand | null
  /** Number of distinct calendar days (UTC) that had at least one success deploy. */
  readonly deployDays: number
}

/** Map deploys/day to a DORA 2025 band. */
export function doraBandFromRate(deploysPerDay: number): DoraBand {
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

export const deploymentFrequency: MetricModule<
  DeploymentFrequencyInputs,
  DeploymentFrequencyResult
> = {
  id: 'dora.deployment_frequency',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { windowDays: 28, environment: 'production' },

  compute(inputs, asOf): DeploymentFrequencyResult {
    const env = inputs.environment ?? 'production'
    const successDeploys = inputs.deploys.filter(
      (d) => d.status === 'success' && d.environment === env,
    )
    const total = successDeploys.length

    // Distinct calendar days (UTC date string)
    const deployDaySet = new Set(successDeploys.map((d) => d.createdAt.slice(0, 10)))
    const deployDays = deployDaySet.size

    // When there are no deploys, return null (not 0) — SPEC §8.6 zero-denom rule.
    // windowDays is the denominator but "no deploys" is no_data, not a zero rate.
    const deploysPerDay = total === 0 ? null : safeRatio(total, inputs.windowDays)
    const doraBand: DoraBand | null =
      deploysPerDay !== null ? doraBandFromRate(deploysPerDay) : null

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
