import { classifyWorkType } from '../../code-analysis/index.js'

import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Rework/Churn % (SPEC §8.4, D7): ' +
  'Classify changed lines by blame age + authorship. ' +
  'Rework: author re-touching own code within churnWindowDays. ' +
  'reworkPercent = (Rework / total) * 100. ' +
  'efficiency = 100 − reworkPercent. ' +
  'Window default: 30 days (D7). ' +
  'STORE-VS-FIXTURE: blameRecords from git blame adapter or test fixtures.'

export const reworkChurn = {
  id: 'code.rework_churn',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { churnWindowDays: 30 },

  compute(inputs, asOf) {
    const result = classifyWorkType({
      author: inputs.author,
      blameRecords: [...inputs.blameRecords],
      now: new Date(inputs.now),
      lines: inputs.lines ? [...inputs.lines] : undefined,
      windowDays: inputs.churnWindowDays ?? 30,
    })

    return {
      id: 'code.rework_churn',
      trustTier: 'deterministic',
      scope: 'team',
      value: result.reworkPercent,
      unit: 'percent',
      dataQuality: result.total === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      totalLines: result.total,
      reworkLines: result.counts.Rework,
      newLines: result.counts.New,
      legacyRefactorLines: result.counts['Legacy-Refactor'],
      helpOthersLines: result.counts['Help-Others'],
      reworkPercent: result.reworkPercent,
      efficiency: result.efficiency,
    }
  },
}
