import { ENGINE_VERSION } from '../../core/index.js'
import { BASELINE_VERSION, classifyDrift, MIN_BASELINE_N, summarize } from './stats.js'

export function buildBaselineRecord(opts) {
  const stats = summarize(opts.values)
  const { driftZ, driftStatus } = classifyDrift(stats.p50, opts.prior ?? null)
  const dataQuality =
    stats.n === 0 ? 'no_data' : stats.n < MIN_BASELINE_N ? 'insufficient_sample' : 'ok'

  return {
    scopeType: opts.scopeType,
    scopeId: opts.scopeId,
    metric: opts.metric,
    baselineKind: opts.baselineKind,
    periodKey: opts.periodKey,
    asOfDay: opts.asOfDay,
    windowKind: opts.windowKind,
    windowFrom: opts.windowFrom,
    windowTo: opts.windowTo,
    n: stats.n,
    p50: stats.p50,
    p75: stats.p75,
    p90: stats.p90,
    mean: stats.mean,
    sd: stats.sd,
    mad: stats.mad,
    driftZ,
    driftStatus,
    driftCause: null,
    superseded: false,
    trustTier: opts.trustTier,
    dataQuality,
    engineVersion: ENGINE_VERSION,
    ingestWatermarkVersion: opts.ingestWatermarkVersion,
    coverageFingerprint: opts.coverageFingerprint,
    baselineVersion: BASELINE_VERSION,
    computedAt: opts.computedAt,
  }
}

/** Project a persisted baseline back into the summary-stats shape (for compareToStats). */
export function baselineToStats(b) {
  return { n: b.n, p50: b.p50, p75: b.p75, p90: b.p90, mean: b.mean, sd: b.sd, mad: b.mad }
}
