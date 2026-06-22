import { ENGINE_VERSION, environmentMatches, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Change Failure Rate (SPEC §8.1): deploys_with_linked_incident / total_prod_deploys. ' +
  'Returns null when totalDeploys = 0 (SPEC §8.6 zero-denominator rule). ' +
  'Also returns null (no_data) when prod deploys exist but NO incidents are tracked ' +
  'in the window — absence of a failure signal is not a measured 0% failure rate. ' +
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
    const prodDeploys = inputs.deploys.filter((d) => environmentMatches(d.environment, env))
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
        incidentsTracked: inputs.incidentsTracked ?? null,
      }
    }

    // Coverage guard: a rate of 0 is only a *measurement* when an incident
    // signal exists. When the caller reports zero incidents tracked anywhere in
    // the window (incidentsTracked === 0), there is no failure signal at all, so
    // "0% change failure" would read as measured when it is actually
    // unmeasurable. Degrade to no_data — mirroring how lead_time degrades when
    // its input signal is absent. `incidentsTracked === undefined` means the
    // caller did not supply the count (legacy/unknown) → do not degrade.
    if (inputs.incidentsTracked === 0) {
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
        totalDeploys: total,
        incidentsTracked: 0,
        coverageNote:
          'No incidents are tracked in this window, so change-failure cannot be measured. ' +
          'This is absence of a failure signal, not a measured 0% failure rate.',
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
      incidentsTracked: inputs.incidentsTracked ?? null,
    }
  },
}
