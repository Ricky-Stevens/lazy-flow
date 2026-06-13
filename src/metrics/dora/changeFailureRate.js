import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Change Failure Rate (SPEC §8.1): deploys_with_linked_incident / total_prod_deploys. ' +
  'Returns null when totalDeploys = 0 (SPEC §8.6 zero-denominator rule). ' +
  'Denominator includes all prod deployments (success + failure). ' +
  'Incident link = Jira Incident with a deploy-incident join record.'

export const changeFailureRate = {
  id: 'dora.change_failure_rate',
  trustTier: 'hybrid',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf) {
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
