import { ENGINE_VERSION, percentile, safeRatio } from '../../core/index.js'

const DOC =
  'AI-Authorship Blend vs Rework Coupling (person scope): aiBlend = mean of per-change ' +
  'AI-authorship scores (0..1). pctAiHeavy = share of changes scoring >= aiHeavyThreshold ' +
  '(default 0.5). reworkCoupling = median(rework on AI-heavy changes) / median(rework on ' +
  'human-authored changes) — a WITHIN-PERSON ratio, so it cancels between-person confounders ' +
  '(tenure, seniority, codebase area). High AI-blend is CONTEXT, not a defect: it describes how ' +
  'a person works, not how well. The fair reading is the coupling — coupling ~1 means AI-heavy ' +
  'and human-authored work carry similar rework; only a coupling well above 1 hints AI-heavy ' +
  'changes need more follow-up for this person. Requires >= 5 samples in each group to report ' +
  'coupling; below that, couplingQuality = insufficient_sample.'

const MEDIAN = 0.5
const COUPLING_FLOOR = 5

export const aiBlendCoupling = {
  id: 'person.ai_blend_rework_coupling',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const aiScores = inputs.aiScores ?? []
    const aiHeavyRework = inputs.aiHeavyRework ?? []
    const humanRework = inputs.humanRework ?? []
    const threshold = inputs.aiHeavyThreshold ?? MEDIAN

    const base = {
      id: 'person.ai_blend_rework_coupling',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
    }

    // No AI-authorship scores → nothing to characterise.
    if (aiScores.length === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        pctAiHeavy: null,
        reworkCoupling: null,
        aiHeavyN: 0,
        humanN: 0,
        couplingQuality: 'no_data',
      }
    }

    const aiBlend = aiScores.reduce((sum, s) => sum + s, 0) / aiScores.length
    const heavyCount = aiScores.filter((s) => s >= threshold).length
    const pctAiHeavy = heavyCount / aiScores.length

    const aiHeavyN = aiHeavyRework.length
    const humanN = humanRework.length
    const haveSamples = aiHeavyN >= COUPLING_FLOOR && humanN >= COUPLING_FLOOR
    const couplingQuality = haveSamples ? 'ok' : 'insufficient_sample'
    const reworkCoupling = haveSamples
      ? safeRatio(percentile(aiHeavyRework, MEDIAN), percentile(humanRework, MEDIAN))
      : null

    return {
      ...base,
      value: aiBlend,
      dataQuality: 'ok',
      pctAiHeavy,
      reworkCoupling,
      aiHeavyN,
      humanN,
      couplingQuality,
    }
  },
}
