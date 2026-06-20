import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  "Ticket-Linkage Rate (person scope): share of a person's PRs that reference a " +
  'tracked issue. value = (PRs with linkCount>=1) / (total PRs). ' +
  'confidenceWeightedRate = (sum of per-PR maxLinkConfidence) / (total PRs) — ' +
  'discounts weak/heuristic links. An untracked-work process signal, not a ' +
  'productivity score: anchor to the team median, since hotfixes, chores and ' +
  'trivial changes are legitimately untracked, so a rate below 1 is expected and fine.'

export const ticketLinkageRate = {
  id: 'person.ticket_linkage_rate',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const prs = inputs.prs ?? []
    const totalPrs = prs.length
    const base = {
      id: 'person.ticket_linkage_rate',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      totalPrs,
    }

    // No PRs in window → nothing to assess.
    if (totalPrs === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        confidenceWeightedRate: null,
        linkedPrs: 0,
        unlinkedEvidence: [],
      }
    }

    const linkedPrs = prs.filter((pr) => (pr.linkCount ?? 0) >= 1).length
    const confidenceSum = prs.reduce((acc, pr) => acc + (pr.maxLinkConfidence ?? 0), 0)
    const unlinkedEvidence = prs
      .filter((pr) => (pr.linkCount ?? 0) === 0)
      .slice(0, 5)
      .map((pr) => pr.id)

    return {
      ...base,
      value: safeRatio(linkedPrs, totalPrs),
      // Below 5 PRs the rate is too noisy to compare; still report it.
      dataQuality: totalPrs < 5 ? 'insufficient_sample' : 'ok',
      confidenceWeightedRate: safeRatio(confidenceSum, totalPrs),
      linkedPrs,
      unlinkedEvidence,
    }
  },
}
