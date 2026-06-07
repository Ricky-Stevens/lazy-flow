/**
 * Monte Carlo Forecast — Flow Group B (SPEC §8.2, §8.6)
 *
 * Uses:
 *   - `createPrng(seed)` from `@lazy-flow/core` (vendored mulberry32).
 *   - Canonical SORTED sample order (sort sample ascending before iterating).
 *
 * These two pins guarantee reproducibility per engine-version + seed,
 * regardless of Node/arch/runtime (SPEC §8.6 randomness contract).
 *
 * Method: Bootstrap simulation over historical throughput samples.
 *   For each of N simulations, draw `horizonWeeks` weekly throughput
 *   samples with replacement, sum them → projected completion weeks.
 *   Report p50/p75/p85/p90/p95 of the distribution.
 *
 * formulaDoc:
 *   Monte Carlo forecast (SPEC §8.2, §8.6): bootstrap over historical
 *   weekly throughput samples.  N simulations (default 10000).
 *   PRNG: mulberry32 seeded with `seed` (createPrng).
 *   Sample order: canonical sorted ascending before iteration.
 *   Forecast = weeks until `remainingItems` items are completed.
 *   p50/p75/p85/p90/p95 of simulation distribution.
 */

import type { MetricResult } from '@lazy-flow/core'
import { createPrng, ENGINE_VERSION, meetsSampleFloor, quantiles } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'

export interface MonteCarloInputs {
  /**
   * Historical weekly throughput samples (issues completed per week).
   * The engine will sort these canonically before using them.
   */
  weeklySamples: readonly number[]
  /** Number of items remaining to complete. */
  remainingItems: number
  /**
   * PRNG seed.  The seed + engine_version together guarantee reproducible
   * forecasts per SPEC §8.6.
   */
  seed: number
  /** Number of simulations.  Default: 10000. */
  simulations?: number
}

export interface MonteCarloResult extends MetricResult {
  readonly p50Weeks: number | null
  readonly p75Weeks: number | null
  readonly p85Weeks: number | null
  readonly p90Weeks: number | null
  readonly p95Weeks: number | null
  readonly sampleSize: number
  readonly simulationCount: number
  /** True when the simulation could not converge for some runs (all-zero samples). */
  readonly hasInfiniteRisk: boolean
}

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

export const monteCarlo: MetricModule<MonteCarloInputs, MonteCarloResult> = {
  id: 'flow.monte_carlo_forecast',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { simulations: DEFAULT_SIMULATIONS },

  compute(inputs, asOf): MonteCarloResult {
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
    const weeksToComplete: number[] = []
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

    // Sample floor gates on the HISTORICAL weekly-sample count (sampleSize), not
    // the simulation count (simCount, ~10000) — the floor exists to suppress
    // high percentiles when the throughput history is too thin. Gating on
    // simCount made it a no-op (a 1-week history still reported p90/p95).
    const meetsP90Floor = meetsSampleFloor(sampleSize, 0.9)
    const p90 = meetsP90Floor ? (qs?.p90 ?? null) : null
    const p95 = meetsSampleFloor(sampleSize, 0.95) ? (qs?.p95 ?? null) : null

    return {
      id: 'flow.monte_carlo_forecast',
      trustTier: 'deterministic',
      scope: 'team',
      value: qs?.p50 ?? null,
      unit: 'weeks',
      dataQuality: meetsP90Floor ? 'ok' : 'insufficient_sample',
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
