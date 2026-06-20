import { ENGINE_VERSION, percentile } from '../../core/index.js'

const DOC =
  'Review Difficulty Score (person scope): aggregates stored per-PR LLM difficulty ' +
  'verdicts on a 1..5 band scale. value = median(bands); pctHard = share of bands >= 4; ' +
  'p75 shows the heavier tail. The band separates large-but-mechanical work (low band) ' +
  'from small-but-subtle work (high band). Read it PAIRED with PR size: high difficulty ' +
  'at low size is a positive signal — genuinely hard work that line counts would miss. ' +
  'High difficulty is not "better" and low difficulty is not "worse" — both are normal ' +
  'depending on what the work demanded; treat this as a coaching signal, not a ranking.'

const SAMPLE_FLOOR = 8

/**
 * Person-scope review difficulty. Inputs are pre-aggregated by the caller:
 *   bands — array of per-PR LLM difficulty verdicts on a 1..5 scale (numbers)
 * Pure module: no store, no fetch, no clock. asOf supplies the timestamp.
 */
export const prReviewDifficulty = {
  id: 'person.pr_review_difficulty',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const bands = inputs.bands ?? []
    const sampleSize = bands.length
    const base = {
      id: 'person.pr_review_difficulty',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'band',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      sampleSize,
      pctHard: null,
      p75: null,
    }

    // No stored verdicts in the window → nothing to say.
    if (sampleSize === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const median = percentile(bands, 0.5)
    const p75 = percentile(bands, 0.75)
    const hardCount = bands.filter((b) => b >= 4).length
    const pctHard = hardCount / sampleSize
    // Below the floor the median is computable but too noisy to lean on.
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return { ...base, value: median, pctHard, p75, dataQuality }
  },
}
