import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  'Design-Bearing vs Boilerplate Ratio (person scope): aggregates stored per-change LLM ' +
  'verdicts. Each verdict carries designBearing (bool), difficulty (1..5) and confidence ' +
  '(0..1). Verdicts below minConfidence (default 0.5) are dropped. value = difficulty-weighted ' +
  'share of design-bearing work = sum(difficulty over kept design-bearing verdicts) / ' +
  'sum(difficulty over all kept verdicts). Only an LLM reading the real diff can tell ' +
  'designed-a-cache from bumped-a-version, so this is a probabilistic coaching signal, not a ' +
  'score. A lower ratio is NOT worse — boilerplate, version bumps and config are necessary ' +
  'work; the fair reading is the mix over time, always shown with the underlying evidence and ' +
  'never used to rank people.'

const DEFAULT_MIN_CONFIDENCE = 0.5
const SAMPLE_FLOOR = 5

export const designBearingRatio = {
  id: 'person.design_bearing_ratio',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const verdicts = inputs.verdicts ?? []
    const minConfidence = inputs.minConfidence ?? DEFAULT_MIN_CONFIDENCE

    const base = {
      id: 'person.design_bearing_ratio',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
    }

    const kept = verdicts.filter((v) => (v.confidence ?? 0) >= minConfidence)

    // No verdicts survive the confidence floor → nothing to characterise.
    if (kept.length === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        designBearingCount: 0,
        mechanicalCount: 0,
        meanConfidence: null,
        sampleSize: 0,
      }
    }

    const designBearing = kept.filter((v) => v.designBearing === true)
    const designBearingCount = designBearing.length
    const mechanicalCount = kept.length - designBearingCount

    const designWeight = designBearing.reduce((sum, v) => sum + v.difficulty, 0)
    const totalWeight = kept.reduce((sum, v) => sum + v.difficulty, 0)
    const value = safeRatio(designWeight, totalWeight)

    const meanConfidence = kept.reduce((sum, v) => sum + v.confidence, 0) / kept.length
    const sampleSize = kept.length
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return {
      ...base,
      value,
      dataQuality,
      designBearingCount,
      mechanicalCount,
      meanConfidence,
      sampleSize,
    }
  },
}
