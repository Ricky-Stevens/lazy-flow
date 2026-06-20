import { ENGINE_VERSION, percentile } from '../../core/index.js'

const LATENCY_DOC =
  'Review Round-Trip Cadence (person scope, PROXY): the elapsed seconds between a ' +
  "changes_requested review on the person's PR and the NEXT review event that follows. " +
  'IMPORTANT — this interval is gated by when the reviewer comes back, so it is a ' +
  'round-trip cadence proxy, NOT a clean measure of how fast the author addressed ' +
  'feedback (commit→PR linkage to anchor on the authors next push is not ingested). ' +
  'headline value = median (p50) seconds; p75 and (with >=20 samples) p90 are reported ' +
  'because these times are log-skewed and a mean would mislead. DESCRIPTIVE / STUCK / ' +
  'OVERLOAD signal, NOT a score: a long cadence often means the PR is blocked or the ' +
  'reviewer is slow. Lower is NOT "better"; read it as a prompt to ask what is in the ' +
  'way, never as a ranking or an author penalty.'

const SAMPLE_FLOOR = 5
const P90_FLOOR = 20

/**
 * Person-scope feedback-response latency. Inputs are pre-aggregated by the caller:
 *   samples — array of latency observations in SECONDS (one per addressed feedback event)
 */
export const feedbackResponseLatency = {
  id: 'pr.feedback_response_latency',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: LATENCY_DOC,
  params: {},

  compute(inputs, asOf) {
    const samples = Array.isArray(inputs?.samples) ? inputs.samples : []
    const sampleSize = samples.length
    const base = {
      id: 'pr.feedback_response_latency',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'seconds',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: LATENCY_DOC,
      sampleSize,
      p75: null,
      p90: null,
    }

    if (sampleSize === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const p50 = percentile(samples, 0.5)
    const p75 = percentile(samples, 0.75)
    const p90 = sampleSize >= P90_FLOOR ? percentile(samples, 0.9) : null
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return { ...base, value: p50, dataQuality, p75, p90 }
  },
}
