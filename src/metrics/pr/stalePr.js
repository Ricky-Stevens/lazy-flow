import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FORMULA_DOC =
  'Stale PR Detection (SPEC §8.3): open non-draft PRs with no meaningful activity ' +
  '(review, comment, or update) for > thresholdDays (default 14). ' +
  'staleRate = stalePrCount / openPrCount. Returns null on 0 open PRs.'

export const stalePr = {
  id: 'pr.stale',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { thresholdDays: 14 },

  compute(inputs, asOf) {
    const thresholdDays = inputs.thresholdDays ?? 14
    const asOfMs = new Date(asOf).getTime()
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000

    const openPrs = inputs.prs.filter((pr) => pr.state === 'open' && !pr.isDraft)

    if (openPrs.length === 0) {
      return {
        id: 'pr.stale',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'count',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        stalePrCount: 0,
        openPrCount: 0,
        staleRate: null,
        stalePrIds: [],
      }
    }

    // Last activity timestamps per PR
    const lastActivity = new Map()
    for (const pr of openPrs) {
      lastActivity.set(pr.id, new Date(pr.updatedAt).getTime())
    }

    for (const rev of inputs.reviews) {
      if (!lastActivity.has(rev.prId)) continue
      const ts = new Date(rev.submittedAt).getTime()
      const current = lastActivity.get(rev.prId) ?? 0
      if (ts > current) lastActivity.set(rev.prId, ts)
    }

    for (const comment of inputs.reviewComments) {
      if (!lastActivity.has(comment.prId)) continue
      const ts = new Date(comment.createdAt).getTime()
      const current = lastActivity.get(comment.prId) ?? 0
      if (ts > current) lastActivity.set(comment.prId, ts)
    }

    const stalePrIds = []
    for (const pr of openPrs) {
      const lastTs = lastActivity.get(pr.id) ?? new Date(pr.createdAt).getTime()
      if (asOfMs - lastTs > thresholdMs) {
        stalePrIds.push(pr.id)
      }
    }

    const staleRate = safeRatio(stalePrIds.length, openPrs.length)

    return {
      id: 'pr.stale',
      trustTier: 'deterministic',
      scope: 'team',
      value: stalePrIds.length,
      unit: 'count',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      stalePrCount: stalePrIds.length,
      openPrCount: openPrs.length,
      staleRate,
      stalePrIds,
    }
  },
}
