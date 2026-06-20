import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

// Below this many merged PRs the ratio is noise (a single self-merged PR reads
// 100% bypass). Mirror the sibling person ratios (changes_requested_received)
// so a thin sample is flagged 'insufficient_sample' and the report excludes it
// from the cohort distribution instead of banding it as a confident outlier.
const SAMPLE_FLOOR = 8

const BYPASS_DOC =
  "Review-Bypass Rate (person scope): share of the person's merged PRs that " +
  'shipped WITHOUT external scrutiny. A PR counts as bypassed when it drew no ' +
  'external review (hadExternalReview = false) OR it was self-merged. ' +
  'value = bypassedPrs / totalPrs. This contextualises a deceptively-low ' +
  'changes-requested rate: a clean review record can simply mean reviews were ' +
  'skipped. A high rate is not inherently bad — some teams legitimately ' +
  'self-merge docs/config or trivial changes — so read it as an evaluative signal ' +
  'about review coverage, in context.'

/**
 * Person-scope review-bypass rate. Inputs:
 *   prs — array of the person's merged PRs, each:
 *     { id, hadExternalReview (bool), selfMerged (bool) }
 * A PR is bypassed when it had no external review OR was self-merged.
 */
export const reviewBypassReceived = {
  id: 'pr.review_bypass_rate_received',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: BYPASS_DOC,
  params: {},

  compute(inputs, asOf) {
    const prs = inputs.prs ?? []
    const totalPrs = prs.length
    const bypassedPrs = prs.filter((pr) => !pr.hadExternalReview || pr.selfMerged).length
    const selfMergedPrs = prs.filter((pr) => pr.selfMerged).length

    const base = {
      id: 'pr.review_bypass_rate_received',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: BYPASS_DOC,
      bypassedPrs,
      totalPrs,
      selfMergedPrs,
    }

    if (totalPrs === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const dataQuality = totalPrs < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'
    return { ...base, value: safeRatio(bypassedPrs, totalPrs), dataQuality }
  },
}
