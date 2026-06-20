import { createPrng, ENGINE_VERSION, quantiles } from '../../core/index.js'

const FORMULA_DOC =
  'Monte Carlo Forecast (SPEC §8.2, §8.6): ' +
  'Bootstrap simulation over historical weekly throughput. ' +
  'Seed + engine_version → reproducible per install. ' +
  'PRNG: mulberry32 (createPrng). ' +
  'Sample order: canonical sorted ascending (reproducible draw). ' +
  'N=10000 simulations default. ' +
  'Result: weeks until remainingItems completed, p50/p75/p85/p90/p95. ' +
  'p90 requires n≥20, p95 requires n≥30 (sample floor).'

const DEFAULT_SIMULATIONS = 10000
const MAX_WEEKS_BEFORE_INF = 520 // ~10 years — cap to prevent infinite loops

export const monteCarlo = {
  id: 'flow.monte_carlo_forecast',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { simulations: DEFAULT_SIMULATIONS },

  compute(inputs, asOf) {
    const simCount = inputs.simulations ?? DEFAULT_SIMULATIONS
    const sampleSize = inputs.weeklySamples.length
    const remaining = inputs.remainingItems
    // Weeks of GENUINE history backing the forecast. The weeklySamples array is
    // padded with zeros to the full window width (a zero week is a valid
    // bootstrap draw), but those padding weeks are NOT observations and must not
    // satisfy the sample floor — otherwise a team active in 2 of 13 weeks reads
    // sampleSize=13, clears the p95 floor, and emits a false-precise forecast off
    // two data points. Gate the floor on observedWeeks (the active span);
    // default to sampleSize when the caller doesn't supply it (back-compat).
    const observedWeeks = inputs.observedWeeks ?? sampleSize

    if (sampleSize === 0 || remaining <= 0) {
      return {
        id: 'flow.monte_carlo_forecast',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'weeks',
        dataQuality: sampleSize === 0 ? 'no_data' : 'ok',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        p50Weeks: null,
        p75Weeks: null,
        p85Weeks: null,
        p90Weeks: null,
        p95Weeks: null,
        sampleSize,
        simulationCount: 0,
        hasInfiniteRisk: false,
      }
    }

    // CANONICAL SORTED sample order (SPEC §8.6 — reproducible). Throughput is a
    // non-negative count; a negative weekly sample (corrupt ingest) would let
    // `completed` move backwards and inflate the forecast, so clamp at 0.
    const sortedSamples = [...inputs.weeklySamples].map((s) => Math.max(0, s)).sort((a, b) => a - b)
    const n = sortedSamples.length

    // A history of all-zero (or non-positive) throughput cannot complete any
    // remaining work: every simulation would hit the MAX_WEEKS cap and report a
    // false-precise "~10 years" at ok quality. There is no signal to forecast
    // from, so this is no_data, not a trustworthy number.
    const maxThroughput = n > 0 ? sortedSamples[n - 1] : 0
    if (maxThroughput <= 0) {
      return {
        id: 'flow.monte_carlo_forecast',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'weeks',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        p50Weeks: null,
        p75Weeks: null,
        p85Weeks: null,
        p90Weeks: null,
        p95Weeks: null,
        sampleSize,
        simulationCount: 0,
        hasInfiniteRisk: false,
      }
    }

    const prng = createPrng(inputs.seed)
    const weeksToComplete = []
    let infiniteCount = 0

    for (let sim = 0; sim < simCount; sim++) {
      let completed = 0
      let weeks = 0

      while (completed < remaining && weeks < MAX_WEEKS_BEFORE_INF) {
        // Draw a sample index deterministically via prng
        const idx = Math.floor(prng() * n)
        const throughput = sortedSamples[idx] ?? 0
        completed += throughput
        weeks++
      }

      if (weeks >= MAX_WEEKS_BEFORE_INF && completed < remaining) {
        infiniteCount++
        weeksToComplete.push(MAX_WEEKS_BEFORE_INF)
      } else {
        weeksToComplete.push(weeks)
      }
    }

    const qs = quantiles(weeksToComplete)

    // The sample here is the number of WEEKS of throughput history (sampleSize =
    // weeklySamples.length), NOT a count of items. The generic item-level floors
    // (n≥20 / n≥30) demand ~5 months of history, so a monthly/quarterly report
    // window (≈4–13 weeks) would ALWAYS read insufficient_sample and never emit
    // p90/p95. Monte-Carlo forecasting is conventionally usable from a handful of
    // weekly data points, so we gate on week-appropriate floors: p50 needs ≥4
    // weeks, p90 ≥8, p95 ≥12. Below the p50 floor the history is too thin to
    // trust at all → insufficient_sample.
    const WEEK_FLOORS = { p50: 4, p90: 8, p95: 12 }
    const p90 = observedWeeks >= WEEK_FLOORS.p90 ? (qs?.p90 ?? null) : null
    const p95 = observedWeeks >= WEEK_FLOORS.p95 ? (qs?.p95 ?? null) : null

    return {
      id: 'flow.monte_carlo_forecast',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'weeks',
      dataQuality: observedWeeks >= WEEK_FLOORS.p50 ? 'ok' : 'insufficient_sample',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      p50Weeks: qs?.p50 ?? null,
      p75Weeks: qs?.p75 ?? null,
      p85Weeks: qs?.p85 ?? null,
      p90Weeks: p90,
      p95Weeks: p95,
      sampleSize,
      observedWeeks,
      simulationCount: simCount,
      hasInfiniteRisk: infiniteCount > 0,
      // Fraction of simulations that hit the MAX_WEEKS cap without completing.
      // When > 0 the upper-tail percentiles are CENSORED at MAX_WEEKS (a floor,
      // not a true quantile); a consumer should render "≥520 / may never
      // complete" rather than a precise week count for any percentile ≥ this.
      infiniteFraction: infiniteCount / simCount,
    }
  },
}
