import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const PR_DESCRIPTION_QUALITY_DOC =
  'PR Description Quality (person scope, probabilistic): aggregates stored ' +
  'LLM verdicts on PR descriptions, each rated one of absent, thin, adequate, ' +
  'or strong. The judge weighs whether the body substantively explains the ' +
  'why, the testing, and the risk — NOT its length; a long body is not ' +
  'automatically strong, and a short focused one can be adequate. value = the ' +
  'share (0..1) of ratings that are adequate or strong; distribution gives ' +
  "every rating's share, and sampleSize is the number of judged PRs. This is " +
  'an evaluative signal: a higher share is not categorically ' +
  '"better", and the reading must account for ai_authorship context so a ' +
  'machine-generated body is not credited to the author.'

const RATINGS = ['absent', 'thin', 'adequate', 'strong']
const SAMPLE_FLOOR = 5

/**
 * Person-scope PR description quality. Inputs are pre-stored LLM verdicts:
 *   ratings — array of strings, each one of the 4 RATINGS (one per judged PR)
 * Headline is the share of ratings in {adequate, strong}, plus the full
 * distribution over the 4 ratings, per-rating counts, and sampleSize.
 */
export const prDescriptionQuality = {
  id: 'person.pr_description_quality',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: PR_DESCRIPTION_QUALITY_DOC,
  params: {},

  compute(inputs, asOf) {
    const ratings = inputs.ratings ?? []
    const counts = {}
    for (const r of RATINGS) counts[r] = 0
    for (const r of ratings) {
      if (r in counts) counts[r] += 1
    }
    const sampleSize = ratings.length

    const base = {
      id: 'person.pr_description_quality',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: PR_DESCRIPTION_QUALITY_DOC,
      counts,
      sampleSize,
    }

    if (sampleSize === 0) {
      const distribution = {}
      for (const r of RATINGS) distribution[r] = 0
      return { ...base, value: null, dataQuality: 'no_data', distribution }
    }

    const distribution = {}
    for (const r of RATINGS) distribution[r] = safeRatio(counts[r], sampleSize)

    const substantive = counts.adequate + counts.strong
    const value = safeRatio(substantive, sampleSize)
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return { ...base, value, dataQuality, distribution }
  },
}
