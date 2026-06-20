import { ENGINE_VERSION, percentile, safeRatio } from '../../core/index.js'

const SMALL_PR_FLOOR = 8

const DOC =
  'Small-PR Discipline (person scope): smallPrRate = (merged PRs whose churn <= ' +
  'smallThreshold) / (total merged PRs). Churn (haloc) is added+removed lines per PR; ' +
  'smallThreshold is TEAM-RELATIVE (the caller sets it from the cohort), so this is a ' +
  'habit dial for shipping in small, reviewable batches — never a throughput or volume ' +
  'measure. A high rate just means a person tends to keep batches small; a low rate is ' +
  'not "bad" (some work is irreducibly large). Below 8 merged PRs the rate is reported ' +
  'but flagged insufficient_sample. medianHaloc gives the typical batch size for context.'

/**
 * Person-scope small-PR habit. Inputs are pre-aggregated by the caller:
 *   halocs         — array of per-merged-PR churn (added+removed lines)
 *   smallThreshold — team-relative line-count ceiling for a "small" PR
 *   wipNow         — current open/in-flight PR count for the person (or null)
 */
export const smallPrDiscipline = {
  id: 'person.wip_small_pr_discipline',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const halocs = Array.isArray(inputs?.halocs) ? inputs.halocs : []
    const smallThreshold = inputs?.smallThreshold ?? 0
    const wipNow = inputs?.wipNow ?? null
    const totalPrs = halocs.length

    const base = {
      id: 'person.wip_small_pr_discipline',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      smallThreshold,
      totalPrs,
      wipNow,
    }

    // No merged PRs → nothing to measure.
    if (totalPrs === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        smallPrRate: null,
        smallPrs: 0,
        medianHaloc: null,
      }
    }

    const smallPrs = halocs.filter((h) => h <= smallThreshold).length
    const smallPrRate = safeRatio(smallPrs, totalPrs)
    const medianHaloc = percentile(halocs, 0.5)
    const dataQuality = totalPrs < SMALL_PR_FLOOR ? 'insufficient_sample' : 'ok'

    return {
      ...base,
      value: smallPrRate,
      dataQuality,
      smallPrRate,
      smallPrs,
      medianHaloc,
    }
  },
}
