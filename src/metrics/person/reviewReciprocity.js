import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const RECIPROCITY_DOC =
  'Review Reciprocity (person scope): reviews the person GIVES to others vs ' +
  'reviews their own authored PRs RECEIVE. reciprocity = reviewsGiven / (reviewsReceived + 1). ' +
  '>1 = net reviewer (carries review load); <1 = net receiver. Counts non-author, non-bot ' +
  'reviews only. A collaboration-health signal compared to a peer cohort — and ' +
  'low reciprocity is not "bad" (juniors receive more than they give by design). ' +
  'Below SAMPLE_FLOOR total review interactions the ratio is reported but flagged ' +
  'insufficient_sample — a value from one or two reviews is noise, not a balance.'

/**
 * Minimum total review interactions (given + received) for the ratio to be a
 * stable signal rather than a coin-flip. Mirrors the SAMPLE_FLOOR convention the
 * sibling person metrics use, so a single review never reads as an authoritative
 * collaboration balance (and never seeds the peer baseline — the report only
 * folds `ok`-quality peers into the cohort distribution).
 */
const SAMPLE_FLOOR = 5

/**
 * Person-scope review give/receive balance. Inputs are pre-aggregated by the
 * caller (counts only — no raw identities cross the module boundary):
 *   reviewsGiven        — non-author reviews the person submitted on OTHERS' PRs
 *   reviewsReceived     — non-author, non-bot reviews on the person's authored PRs
 *   prsReviewed         — distinct PRs (by others) the person reviewed
 *   authoredPrsWithReview — authored PRs that drew ≥1 external review
 */
export const reviewReciprocity = {
  id: 'person.review_reciprocity',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: RECIPROCITY_DOC,
  params: {},

  compute(inputs, asOf) {
    const given = inputs.reviewsGiven ?? 0
    const received = inputs.reviewsReceived ?? 0
    const base = {
      id: 'person.review_reciprocity',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: RECIPROCITY_DOC,
      reviewsGiven: given,
      reviewsReceived: received,
      prsReviewed: inputs.prsReviewed ?? 0,
      authoredPrsWithReview: inputs.authoredPrsWithReview ?? 0,
    }

    // No reviewing activity in either direction → nothing to say.
    if (given === 0 && received === 0) {
      return { ...base, value: null, dataQuality: 'no_data', reciprocity: null }
    }

    // +1 smoothing on the denominator keeps the ratio finite for a pure giver
    // (received = 0) and bounds an early-tenure receiver near 0 rather than at it.
    const reciprocity = safeRatio(given, received + 1)
    const dataQuality = given + received < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'
    return { ...base, value: reciprocity, dataQuality, reciprocity }
  },
}
