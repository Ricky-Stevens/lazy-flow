import { ENGINE_VERSION, environmentMatches, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Deployment Rework Rate (SPEC §8.1): unplanned_hotfix_deploys / total_prod_deploys. ' +
  'A hotfix deploy is identified by the hotfixDeployIds set supplied by the caller. ' +
  'NOTE: branch-prefix (hotfix/, fix/) and revert-keyword detection are NOT yet wired ' +
  '— the deploy feed carries no branch/ref marker — so with the current incident-only ' +
  'linkage this rate equals change_failure_rate. Treat the two as the same signal until ' +
  'a distinct hotfix marker is ingested. Returns null on 0 deploys.'

export const deploymentReworkRate = {
  id: 'dora.deployment_rework_rate',
  trustTier: 'hybrid',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf) {
    const env = inputs.environment ?? 'production'
    const prodDeploys = inputs.deploys.filter((d) => environmentMatches(d.environment, env))
    const total = prodDeploys.length

    if (total === 0) {
      return {
        id: 'dora.deployment_rework_rate',
        trustTier: 'hybrid',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        rate: null,
        hotfixDeploys: 0,
        totalDeploys: 0,
      }
    }

    const hotfixCount = prodDeploys.filter((d) => inputs.hotfixDeployIds.has(d.id)).length
    const rate = safeRatio(hotfixCount, total)

    return {
      id: 'dora.deployment_rework_rate',
      trustTier: 'hybrid',
      scope: 'team',
      value: rate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      rate,
      hotfixDeploys: hotfixCount,
      totalDeploys: total,
    }
  },
}
