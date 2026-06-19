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

    // CANONICAL SORTED sample order (SPEC §8.6 — reproducible).
    const sortedSamples = [...inputs.weeklySamples].sort((a, b) => a - b)
    const n = sortedSamples.length

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
    const p90 = sampleSize >= WEEK_FLOORS.p90 ? (qs?.p90 ?? null) : null
    const p95 = sampleSize >= WEEK_FLOORS.p95 ? (qs?.p95 ?? null) : null

    return {
      id: 'flow.monte_carlo_forecast',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'weeks',
      dataQuality: sampleSize >= WEEK_FLOORS.p50 ? 'ok' : 'insufficient_sample',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      p50Weeks: qs?.p50 ?? null,
      p75Weeks: qs?.p75 ?? null,
      p85Weeks: qs?.p85 ?? null,
      p90Weeks: p90,
      p95Weeks: p95,
      sampleSize,
      simulationCount: simCount,
      hasInfiniteRisk: infiniteCount > 0,
    }
  },
}
