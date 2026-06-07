/**
 * Change Failure Rate (CFR) — DORA Group A (SPEC §8.1)
 *
 * CFR = deploys-with-linked-incident / total prod deploys (success+failure).
 * Returns null when totalDeploys === 0 (SPEC §8.6: zero-denom → null).
 *
 * "Linked incident" = a Jira Incident (or GH incident label) whose linked
 * deploy is in the window. The deterministic denom is used; LLM linkage fallback
 * is a Wave-5 concern and not part of this module.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { DeployIncidentLink, DeployRecord } from './types.js'

export interface ChangeFailureRateInputs {
  deploys: readonly DeployRecord[]
  /** Incident-deploy links within the window. */
  deployIncidentLinks: readonly DeployIncidentLink[]
  /** Environment filter (default 'production'). */
  environment?: string
}

export interface ChangeFailureRateResult extends MetricResult {
  readonly rate: number | null
  readonly deploysWithIncident: number
  readonly totalDeploys: number
}

const FORMULA_DOC =
  'Change Failure Rate (SPEC §8.1): deploys_with_linked_incident / total_prod_deploys. ' +
  'Returns null when totalDeploys = 0 (SPEC §8.6 zero-denominator rule). ' +
  'Denominator includes all prod deployments (success + failure). ' +
  'Incident link = Jira Incident with a deploy-incident join record.'

export const changeFailureRate: MetricModule<ChangeFailureRateInputs, ChangeFailureRateResult> = {
  id: 'dora.change_failure_rate',
  trustTier: 'hybrid',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf): ChangeFailureRateResult {
    const env = inputs.environment ?? 'production'
    const prodDeploys = inputs.deploys.filter((d) => d.environment === env)
    const total = prodDeploys.length

    if (total === 0) {
      return {
        id: 'dora.change_failure_rate',
        trustTier: 'hybrid',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        rate: null,
        deploysWithIncident: 0,
        totalDeploys: 0,
      }
    }

    const prodDeployIds = new Set(prodDeploys.map((d) => d.id))
    const linkedDeployIds = new Set(
      inputs.deployIncidentLinks
        .filter((l) => prodDeployIds.has(l.deployId))
        .map((l) => l.deployId),
    )
    const deploysWithIncident = linkedDeployIds.size
    const rate = safeRatio(deploysWithIncident, total)

    return {
      id: 'dora.change_failure_rate',
      trustTier: 'hybrid',
      scope: 'team',
      value: rate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      rate,
      deploysWithIncident,
      totalDeploys: total,
    }
  },
}
