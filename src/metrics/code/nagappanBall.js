import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Nagappan-Ball M1/M2/M3 (SPEC §8.4): ' +
  'M1 = haloc / (priorHaloc + haloc) — relative churn [0,1]. ' +
  'M2 = haloc / windowDays — churn rate (haloc/day). ' +
  'M3 = reworkLines / (totalLines + 1) — rework density. ' +
  'Descriptive-only; do not rank individuals. ' +
  'Zero-denominator → null (SPEC §8.6).'

export const nagappanBall = {
  id: 'code.nagappan_ball',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const m1 = safeRatio(inputs.haloc, inputs.priorHaloc + inputs.haloc)
    const m2 = safeRatio(inputs.haloc, inputs.windowDays)
    // M3 denominator = totalLines + 1 (never zero)
    const m3 = inputs.reworkLines / (inputs.totalLines + 1)

    return {
      id: 'code.nagappan_ball',
      trustTier: 'deterministic',
      scope: 'team',
      value: m1,
      unit: 'ratio',
      dataQuality: inputs.haloc === 0 && inputs.priorHaloc === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      m1RelativeChurn: m1,
      m2ChurnRate: m2,
      m3ReworkDensity: m3,
    }
  },
}
