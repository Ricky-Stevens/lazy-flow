import { ENGINE_VERSION } from '../../core/index.js'
import { classifyDrift } from '../../report/baseline/stats.js'

const DRIFT_DOC =
  'Self-Baseline Drift (person scope): where a person sits THIS window relative to ' +
  'their OWN trailing baseline, not to the team. driftZ = (currentP50 - baseline.p50) / ' +
  'robustSd(baseline), using a robust dispersion (max of sd and 1.4826·MAD) so a few ' +
  'outlier windows do not distort the signal. driftStatus bands the magnitude: stable ' +
  '(|z|<1), shifting (|z|<2), regime_change (|z|>=2). Until the baseline has enough ' +
  'history (baselineN < minN) it is still establishing and no drift is asserted. ' +
  'This is a coaching signal about change against oneself — a large drift is not ' +
  'inherently good or bad, just worth a conversation. Team trend is reference only.'

const MIN_N = 5

/**
 * Person-scope self-baseline drift wrapper. Inputs are pre-aggregated by the caller:
 *   currentP50  — the person's median for THIS window (null when no current sample)
 *   baseline    — { p50, sd, mad } trailing baseline distribution, or null (cold start)
 *   minN        — baseline-history floor below which drift is suppressed (default 5)
 *   baselineN   — number of baseline windows/observations backing the baseline
 * Pure + deterministic: drift classification is delegated to the shared stats helper.
 */
export const selfBaselineDrift = {
  id: 'person.self_baseline_drift',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DRIFT_DOC,
  params: {},

  compute(inputs, asOf) {
    const currentP50 = inputs.currentP50 ?? null
    const baseline = inputs.baseline ?? null
    const minN = inputs.minN ?? MIN_N
    const baselineN = inputs.baselineN ?? 0
    const base = {
      id: 'person.self_baseline_drift',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'zscore',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DRIFT_DOC,
      currentP50,
      baselineP50: baseline?.p50 ?? null,
      baselineN,
    }

    // No current sample → nothing to compare.
    if (currentP50 === null) {
      return { ...base, value: null, dataQuality: 'no_data', driftStatus: 'no_data', driftZ: null }
    }

    // Not enough baseline history → surface today's level but assert no drift yet.
    if (baselineN < minN) {
      return {
        ...base,
        value: currentP50,
        dataQuality: 'insufficient_sample',
        driftStatus: 'establishing',
        driftZ: null,
      }
    }

    const { driftZ, driftStatus } = classifyDrift(currentP50, baseline)
    return { ...base, value: driftZ, dataQuality: 'ok', driftStatus, driftZ }
  },
}
