import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const CI_GREEN_DOC =
  'CI-Green-Before-Merge Rate (person scope): of the PRs that HAD CI checks, the share whose ' +
  'checks were green at merge time. rate = greenAtMerge / hadChecks. Always read this beside ' +
  'noCiShare (PRs with no checks at all) so "no CI configured" is never mis-scored as ' +
  'indiscipline — a low rate driven by missing pipelines is a tooling gap, not a person signal. ' +
  'postMergeCiShare flags checked PRs whose checks only completed AFTER merge (a race/config ' +
  "smell, not necessarily the author's fault). A coaching signal compared to a cohort, never a " +
  'rank; "more green" is not automatically "better".'

/**
 * Person-scope CI discipline. Inputs are pre-shaped by the caller:
 *   prs: [{ id, hadChecks, greenAtMerge, checksCompletedAfterMerge }]
 * Denominator is PRs with hadChecks. Headline = green-at-merge / checked.
 */
export const ciGreenBeforeMerge = {
  id: 'person.ci_green_before_merge_rate',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: CI_GREEN_DOC,
  params: {},

  compute(inputs, asOf) {
    const prs = inputs?.prs ?? []
    const totalPrs = prs.length
    const checked = prs.filter((p) => p.hadChecks)
    const checkedPrs = checked.length
    const greenCount = checked.filter((p) => p.greenAtMerge).length
    const postMergeCount = checked.filter((p) => p.checksCompletedAfterMerge).length
    const noCiCount = totalPrs - checkedPrs

    const base = {
      id: 'person.ci_green_before_merge_rate',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: CI_GREEN_DOC,
      checkedPrs,
      totalPrs,
      noCiShare: safeRatio(noCiCount, totalPrs),
      postMergeCiShare: safeRatio(postMergeCount, checkedPrs),
    }

    if (checkedPrs === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    return {
      ...base,
      value: safeRatio(greenCount, checkedPrs),
      dataQuality: checkedPrs < 5 ? 'insufficient_sample' : 'ok',
    }
  },
}
