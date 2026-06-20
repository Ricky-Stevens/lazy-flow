import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  'Follows-Team-Conventions (person scope): aggregates stored LLM verdicts, one per change, ' +
  'each classified as follows | minor_divergence | violates against repo-relative idioms ' +
  '(error-handling style, layering, naming, module boundaries). value = share of verdicts ' +
  'rated follows. distribution gives the share at each level and violatesShare isolates clear ' +
  'breaks. These are local, repo-specific idioms — there is no universal "correct" style, so ' +
  'the signal is impossible to compute for a multi-tenant SaaS spanning many codebases. New ' +
  "hires legitimately diverge while learning a codebase, so read this against the person's own " +
  'trend rather than as an absolute bar or a cross-person ranking — rising adherence over time ' +
  'is the fair reading, not a high number at any instant. Requires >= 5 verdicts; below that ' +
  'the sample is reported but flagged insufficient_sample.'

const SAMPLE_FLOOR = 5
const LEVELS = ['follows', 'minor_divergence', 'violates']

export const conventionAdherence = {
  id: 'person.convention_adherence',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const adherence = inputs.adherence ?? []
    const sampleSize = adherence.length

    const base = {
      id: 'person.convention_adherence',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
    }

    // No stored verdicts → nothing to characterise.
    if (sampleSize === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        distribution: { follows: null, minor_divergence: null, violates: null },
        violatesShare: null,
        sampleSize: 0,
      }
    }

    const counts = { follows: 0, minor_divergence: 0, violates: 0 }
    for (const level of adherence) {
      if (level in counts) counts[level] += 1
    }

    const distribution = {}
    for (const level of LEVELS) {
      distribution[level] = safeRatio(counts[level], sampleSize)
    }

    return {
      ...base,
      value: distribution.follows,
      dataQuality: sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok',
      distribution,
      violatesShare: distribution.violates,
      sampleSize,
    }
  },
}
