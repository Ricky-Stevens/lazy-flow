import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const CHANGES_REQUESTED_DOC =
  "Changes-Requested Rate Received (person scope): share of the person's authored PRs " +
  'that drew at least one changes-requested review. rate = prsWithChangesRequested / totalPrs. ' +
  'This is ANY-CR incidence (did a PR receive a changes-requested verdict at all), distinct ' +
  'from review_iterations which counts ROUNDS within a PR. A healthy amount of changes ' +
  'requested is normal and expected — review exists to catch things. The fair reading is a ' +
  'signal only when far above the team band or trending up over time; a low rate is not ' +
  '"good" (it can mean rubber-stamp reviews) and a moderate rate is not "bad".'

const SAMPLE_FLOOR = 8

/**
 * Person-scope incidence of changes-requested on authored PRs. Inputs are the
 * person's authored PRs, each carrying a boolean of whether it ever received a
 * changes-requested review:
 *   prs — [{ id, hadChangesRequested (bool) }]
 */
export const changesRequestedReceived = {
  id: 'pr.changes_requested_rate_received',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: CHANGES_REQUESTED_DOC,
  params: {},

  compute(inputs, asOf) {
    const prs = inputs.prs ?? []
    const totalPrs = prs.length
    const prsWithChangesRequested = prs.filter((pr) => pr.hadChangesRequested).length

    const base = {
      id: 'pr.changes_requested_rate_received',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: CHANGES_REQUESTED_DOC,
      prsWithChangesRequested,
      totalPrs,
    }

    // No authored PRs → nothing to measure.
    if (totalPrs === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const value = safeRatio(prsWithChangesRequested, totalPrs)
    // Computable but too few PRs to read the rate as a stable signal.
    const dataQuality = totalPrs < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'
    return { ...base, value, dataQuality }
  },
}
