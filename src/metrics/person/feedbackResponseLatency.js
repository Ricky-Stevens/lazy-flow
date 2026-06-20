import { ENGINE_VERSION, percentile } from '../../core/index.js'

const LATENCY_DOC =
  'Feedback Response Latency / Time-to-Address-Feedback (person scope): the elapsed ' +
  "seconds between review feedback landing on the person's PR and the person addressing " +
  'it, summarised over a sample of such events. headline value = median (p50) seconds; ' +
  'p75 and (with >=20 samples) p90 are reported because these times are log-skewed and ' +
  'a mean would mislead. This is a STUCK / OVERLOAD SUPPORT signal, NOT a score: a long ' +
  'latency often means the person is blocked, context-switched, or overloaded — and part ' +
  'of any delay belongs to the reviewer (when feedback arrives, how actionable it is), not ' +
  'the author. Lower is not automatically "better"; read it as a prompt to ask what is in ' +
  'the way, never as a ranking.'

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
