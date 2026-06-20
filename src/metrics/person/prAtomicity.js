import { ENGINE_VERSION, percentile, safeRatio } from '../../core/index.js'

const ATOMICITY_FLOOR = 8

const DOC =
  'PR Atomicity / Single-Concern (person scope): value = median of per-PR atomicity ' +
  'priors (each in 0..1, where 1 = a tightly single-concern PR and lower values mean ' +
  'the change spans several unrelated concerns). The prior is hybrid — model-assisted ' +
  'and controlled for monorepo spread, so a wide file spread driven only by repo layout ' +
  'is not penalised. ALWAYS read this beside PR size: a large-but-atomic PR (one coherent ' +
  'concern, many lines) is healthy, whereas a large-and-sprawling PR (many unrelated ' +
  'concerns) is the thing this signal flags. sprawlingShare = fraction of PRs the prior ' +
  'marked as sprawling. This is a coaching signal about change shape, not a productivity ' +
  'or volume measure — a lower median is not inherently "bad" (some work is irreducibly ' +
  'cross-cutting). Below 8 PRs the median is reported but flagged insufficient_sample.'

/**
 * Person-scope PR atomicity / single-concern habit. Inputs are pre-aggregated:
 *   priors         — array of per-PR atomicity priors in 0..1 (1 = atomic)
 *   sprawlingFlags — array of booleans, true when a PR was flagged as sprawling
 */
export const prAtomicity = {
  id: 'person.pr_atomicity',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const priors = Array.isArray(inputs?.priors) ? inputs.priors : []
    const sprawlingFlags = Array.isArray(inputs?.sprawlingFlags) ? inputs.sprawlingFlags : []
    const sampleSize = priors.length

    const base = {
      id: 'person.pr_atomicity',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      sampleSize,
    }

    // No priors → nothing to measure.
    if (sampleSize === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        sprawlingShare: null,
      }
    }

    const value = percentile(priors, 0.5)
    const sprawlingCount = sprawlingFlags.filter((f) => f === true).length
    const sprawlingShare = safeRatio(sprawlingCount, sprawlingFlags.length)
    const dataQuality = sampleSize < ATOMICITY_FLOOR ? 'insufficient_sample' : 'ok'

    return {
      ...base,
      value,
      dataQuality,
      sprawlingShare,
    }
  },
}
