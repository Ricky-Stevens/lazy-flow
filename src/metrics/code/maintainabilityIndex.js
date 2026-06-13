import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Maintainability Index (SPEC §8.4, trend only): ' +
  'MI = max(0, min(100, 171 − 5.2*ln(avgHaloc+1) − 0.23*avgCyclomatic − 16.2*ln(avgLoc+1))). ' +
  'Microsoft VS variant. +1 in ln() avoids ln(0). ' +
  'TREND ONLY — absolute value not comparable across repos/languages.'

export const maintainabilityIndex = {
  id: 'code.maintainability_index',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const rawMi =
      171 -
      5.2 * Math.log(inputs.avgHaloc + 1) -
      0.23 * inputs.avgCyclomatic -
      16.2 * Math.log(inputs.avgLoc + 1)

    const mi = Math.max(0, Math.min(100, rawMi))

    return {
      id: 'code.maintainability_index',
      trustTier: 'deterministic',
      scope: 'team',
      value: mi,
      unit: 'index',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      mi,
      avgHaloc: inputs.avgHaloc,
      avgCyclomatic: inputs.avgCyclomatic,
      avgLoc: inputs.avgLoc,
    }
  },
}
