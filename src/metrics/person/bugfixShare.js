import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const BUGFIX_SHARE_DOC =
  'Content-Verified Bug-Fix Share (person scope): share = bugUnits / totalUnits, the ' +
  "fraction of a person's delivered work that fixed bugs vs all work. dataSource is " +
  '"real" when at least 70% of totalUnits were content-verified (verifiedUnits/totalUnits ' +
  '>= 0.7), else "proxy" (inferred from labels/heuristics, treat as soft). Always shown ' +
  'beside feature share and complexity so it is never a solo score, and on-call/support ' +
  'windows are annotated: a high bug-fix share there reads as "on support", not "low value".'

/**
 * Person-scope bug-fix share. Inputs are pre-aggregated by the caller (counts
 * only — no raw identities cross the module boundary):
 *   bugUnits      — units of delivered work classified as bug fixes
 *   totalUnits    — all delivered units (bug + feature + other)
 *   verifiedUnits — units whose classification was content-verified (not proxy)
 */
export const bugfixShare = {
  id: 'person.bugfix_share',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: BUGFIX_SHARE_DOC,
  params: {},

  compute(inputs, asOf) {
    const bugUnits = inputs.bugUnits ?? 0
    const totalUnits = inputs.totalUnits ?? 0
    const verifiedUnits = inputs.verifiedUnits ?? 0
    const base = {
      id: 'person.bugfix_share',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: BUGFIX_SHARE_DOC,
      bugUnits,
      totalUnits,
    }

    // No delivered work in window → nothing to say.
    if (totalUnits === 0) {
      return { ...base, value: null, dataQuality: 'no_data', dataSource: 'proxy' }
    }

    // "real" only when the classification is content-verified for the bulk of
    // the sample; otherwise the share is a soft, heuristic-derived proxy.
    const verifiedRatio = safeRatio(verifiedUnits, totalUnits)
    const dataSource = verifiedRatio !== null && verifiedRatio >= 0.7 ? 'real' : 'proxy'
    const value = safeRatio(bugUnits, totalUnits)
    return { ...base, value, dataQuality: 'ok', dataSource }
  },
}
