import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Say/Do Ratio (SPEC §8.5): completed_points / committed_points. ' +
  'Returns null when committed = 0 or when points are unmapped (null). ' +
  'A ratio of 1.0 = delivered exactly what was committed. ' +
  '>1.0 = over-delivered; <1.0 = under-delivered.'

export const sayDo = {
  id: 'agile.say_do',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const { committed, completed } = inputs

    // null on unmapped points or 0-committed
    if (committed === null || completed === null) {
      return {
        id: 'agile.say_do',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        ratio: null,
        committed,
        completed,
      }
    }

    // safeRatio returns null on committed === 0 (per §8.6)
    const ratio = safeRatio(completed, committed)

    return {
      id: 'agile.say_do',
      trustTier: 'deterministic',
      scope: 'team',
      value: ratio,
      unit: 'ratio',
      dataQuality: committed === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      ratio,
      committed,
      completed,
    }
  },
}
