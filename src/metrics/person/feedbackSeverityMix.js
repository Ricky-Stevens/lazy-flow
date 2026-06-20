import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const SEVERITIES = ['nit', 'clarification', 'logic', 'architectural', 'security']
const MEANINGFUL = new Set(['logic', 'architectural', 'security'])

const DOC =
  'Review-Comment Severity Mix Received (person scope): aggregates stored LLM severity ' +
  'verdicts on review comments the person received, turning "lots of comments" into the ' +
  'share that drove MEANINGFUL rework. value = count{logic,architectural,security} / total. ' +
  'distribution gives the per-comment share across the five tiers ' +
  '(nit, clarification, logic, architectural, security). This is a per-PR/per-comment share, ' +
  'not a volume count, so a nitpicky review culture inflates everyone equally and is not a ' +
  'fair comparison signal. The fair reading: a high meaningful share means substantive ' +
  'review attention, not poor authoring; a low share is not "good" (it can just mean a ' +
  'nit-heavy culture). It is probabilistic because the tiers come from LLM classification.'

const SAMPLE_FLOOR = 5

/**
 * Person-scope mix of review-comment severities received. Inputs:
 *   severities — array of strings, each one of
 *     {nit, clarification, logic, architectural, security}
 * Unrecognised labels are ignored (not counted toward the total or distribution).
 */
export const feedbackSeverityMix = {
  id: 'pr.feedback_severity_mix_received',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const raw = inputs.severities ?? []
    const counts = { nit: 0, clarification: 0, logic: 0, architectural: 0, security: 0 }
    let sampleSize = 0
    for (const s of raw) {
      if (s in counts) {
        counts[s] += 1
        sampleSize += 1
      }
    }

    const distribution = {}
    for (const tier of SEVERITIES) {
      distribution[tier] = safeRatio(counts[tier], sampleSize)
    }

    const base = {
      id: 'pr.feedback_severity_mix_received',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      counts,
      distribution,
      sampleSize,
    }

    // No classified comments → nothing to measure.
    if (sampleSize === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const meaningful = SEVERITIES.filter((t) => MEANINGFUL.has(t)).reduce(
      (sum, t) => sum + counts[t],
      0,
    )
    const value = safeRatio(meaningful, sampleSize)
    // Computable but too few comments to read the mix as a stable signal.
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'
    return { ...base, value, dataQuality }
  },
}
