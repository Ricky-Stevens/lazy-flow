import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  'Share of Work in High-Complexity Files (person scope): of the changed lines ' +
  'the person touched in files we could score for complexity, what fraction landed ' +
  'in high-complexity files (repo-relative, top quartile). value = ' +
  'highLineWeight / coveredLineWeight, with coverage = coveredLineWeight / ' +
  'totalLineWeight and prCountShare = highFilePrCount / coveredPrCount as context. ' +
  'A trust/exposure signal — are they entrusted with the gnarly parts — not a ' +
  'productivity or quality measure. A high share is not "better" and a low share is ' +
  'not "worse" (newer contributors are steered to simpler files by design). Always ' +
  'read it next to coverage: a small covered slice makes the ratio unreliable.'

/**
 * Person-scope share of changed-line weight that fell in high-complexity files.
 * Inputs are pre-aggregated by the caller (line weights + PR counts only):
 *   highLineWeight    — changed-line weight in high-complexity (top-quartile) files
 *   coveredLineWeight — changed-line weight in files we could score for complexity
 *   totalLineWeight   — changed-line weight across all touched files (scored or not)
 *   highFilePrCount   — distinct PRs that touched a high-complexity file
 *   coveredPrCount    — distinct PRs that touched any scored file
 */
export const highComplexityFileShare = {
  id: 'person.high_complexity_file_share',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const highLineWeight = inputs.highLineWeight ?? 0
    const coveredLineWeight = inputs.coveredLineWeight ?? 0
    const totalLineWeight = inputs.totalLineWeight ?? 0
    const highFilePrCount = inputs.highFilePrCount ?? 0
    const coveredPrCount = inputs.coveredPrCount ?? 0

    const coverage = safeRatio(coveredLineWeight, totalLineWeight)
    const prCountShare = safeRatio(highFilePrCount, coveredPrCount)
    const base = {
      id: 'person.high_complexity_file_share',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      coverage,
      prCountShare,
      highLineWeight,
      coveredLineWeight,
    }

    // No scored lines → no denominator, nothing to say.
    if (coveredLineWeight === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const value = safeRatio(highLineWeight, coveredLineWeight)

    // Thin coverage makes the share statistically unreliable — surface it but flag.
    if (coverage !== null && coverage < 0.5) {
      return { ...base, value, dataQuality: 'insufficient_sample' }
    }

    return { ...base, value, dataQuality: 'ok' }
  },
}
