import { ENGINE_VERSION, percentile } from '../../core/index.js'

const SAMPLE_FLOOR = 5

const DELTA_DOC =
  'Complexity-Weighted Authored Delta (person scope): the per-PR positive ' +
  'complexity a person added across their authored PRs. value = median ' +
  '(percentile 0.5) of prPositiveDeltas; totalDelta = sum; p75 = the 75th ' +
  'percentile tail. ALWAYS read WITH PR count — a high total can simply mean ' +
  'high volume, so compare the PER-PR median so low-volume devs are not ' +
  'punished. Complexity added is not inherently bad (hard problems are ' +
  'complex) and "more" is NEVER "better"; bucket the peer baseline by ' +
  'language before any comparison.'

/**
 * Person-scope complexity authored per PR. Input is pre-aggregated by the
 * caller — only the list of POSITIVE complexity deltas (one entry per authored
 * PR that increased complexity):
 *   prPositiveDeltas — number[] of positive complexity deltas, one per PR
 */
export const complexityAuthoredDelta = {
  id: 'person.complexity_authored_delta',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DELTA_DOC,
  params: {},

  compute(inputs, asOf) {
    const deltas = inputs.prPositiveDeltas ?? []
    const sampleSize = deltas.length
    const base = {
      id: 'person.complexity_authored_delta',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'index',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DELTA_DOC,
      sampleSize,
    }

    if (sampleSize === 0) {
      return { ...base, value: null, dataQuality: 'no_data', totalDelta: 0, p75: null }
    }

    const value = percentile(deltas, 0.5)
    const totalDelta = deltas.reduce((sum, d) => sum + d, 0)
    const p75 = percentile(deltas, 0.75)
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return { ...base, value, dataQuality, totalDelta, p75 }
  },
}
