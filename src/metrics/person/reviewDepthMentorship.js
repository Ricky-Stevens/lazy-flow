import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  'Review Depth & Mentorship (person scope, probabilistic): aggregates stored ' +
  'LLM verdicts on the reviews a person GAVE. Each review thread is classified ' +
  'into one category and carries a complexityWeight (the difficulty of the code ' +
  'under review). Substantive categories are substantive_logic, design_arch, ' +
  'security and test_coverage; cosmetic_nit and rubber_stamp are not. ' +
  'value = (sum of complexityWeight over substantive threads) / (sum of ' +
  'complexityWeight over all threads), so deep, teaching reviews on hard code ' +
  'count for more than rubber-stamps. This is a coaching signal, never a target: ' +
  'a higher substantive share is not automatically "better" — a senior reviewing ' +
  'simple PRs or a reviewer on a mature codebase will legitimately log many ' +
  'small nits. Read it segmented by role and by the complexity of work reviewed.'

const SUBSTANTIVE = new Set(['substantive_logic', 'design_arch', 'security', 'test_coverage'])

const SAMPLE_FLOOR = 5

/**
 * Person-scope review depth. inputs.threads is an array of
 *   { category: string, complexityWeight: number }
 * one entry per LLM-classified review thread the person authored.
 */
export const reviewDepthMentorship = {
  id: 'person.review_depth_mentorship',
  trustTier: 'probabilistic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const threads = inputs.threads ?? []
    const sampleSize = threads.length

    const base = {
      id: 'person.review_depth_mentorship',
      trustTier: 'probabilistic',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
      sampleSize,
    }

    if (sampleSize === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        substantiveShare: null,
        rubberStampShare: null,
      }
    }

    let weightAll = 0
    let weightSubstantive = 0
    let countSubstantive = 0
    let countRubberStamp = 0
    for (const t of threads) {
      const w = t.complexityWeight ?? 0
      weightAll += w
      if (SUBSTANTIVE.has(t.category)) {
        weightSubstantive += w
        countSubstantive += 1
      }
      if (t.category === 'rubber_stamp') countRubberStamp += 1
    }

    const value = safeRatio(weightSubstantive, weightAll)
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return {
      ...base,
      value,
      dataQuality,
      substantiveShare: safeRatio(countSubstantive, sampleSize),
      rubberStampShare: safeRatio(countRubberStamp, sampleSize),
    }
  },
}
