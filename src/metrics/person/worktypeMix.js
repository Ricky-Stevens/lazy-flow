import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const WORKTYPE_MIX_DOC =
  'Semantic Work-Type Mix (person scope): the single source of truth for a ' +
  "person's bug share and debt share, classified from issue/PR CONTENT rather " +
  'than the Jira label alone. Each unit of work is bucketed into one of ' +
  'feature, bug, debt, refactor, test, docs, other. value = the share (0..1) ' +
  "of the DOMINANT bucket; distribution gives every bucket's share. A mix " +
  'signal for evaluation and context — a high feature share is ' +
  'not "better" than a high debt or test share; the healthy reading depends ' +
  'on the role, the team, and the phase of work.'

const BUCKETS = ['feature', 'bug', 'debt', 'refactor', 'test', 'docs', 'other']

/**
 * Person-scope work-type mix. Inputs are pre-classified bucket labels:
 *   buckets — array of strings, each one of the 7 BUCKETS (one per work unit)
 * Returns the dominant bucket's share as the headline, plus the full
 * distribution, per-bucket counts, total, and the dominant bucket name.
 */
export const worktypeMix = {
  id: 'person.worktype_mix',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: WORKTYPE_MIX_DOC,
  params: {},

  compute(inputs, asOf) {
    const buckets = inputs.buckets ?? []
    const counts = {}
    for (const b of BUCKETS) counts[b] = 0
    for (const b of buckets) {
      if (b in counts) counts[b] += 1
      else counts.other += 1
    }
    const total = buckets.length

    const base = {
      id: 'person.worktype_mix',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: WORKTYPE_MIX_DOC,
      counts,
      total,
    }

    if (total === 0) {
      const distribution = {}
      for (const b of BUCKETS) distribution[b] = 0
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        distribution,
        dominantBucket: null,
      }
    }

    const distribution = {}
    for (const b of BUCKETS) distribution[b] = safeRatio(counts[b], total)

    let dominantBucket = BUCKETS[0]
    for (const b of BUCKETS) {
      if (counts[b] > counts[dominantBucket]) dominantBucket = b
    }
    const value = distribution[dominantBucket]

    return { ...base, value, dataQuality: 'ok', distribution, dominantBucket }
  },
}
