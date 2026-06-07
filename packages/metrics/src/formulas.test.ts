/**
 * Formula reference coverage test (WP-DOCS).
 *
 * Asserts that docs/FORMULAS.md contains an entry for every metric module
 * exported from @lazy-flow/metrics, so the doc cannot silently drift from
 * the codebase as new metrics are added.
 *
 * Behaviour tested:
 *   - Every registered metric's `id` appears in docs/FORMULAS.md.
 *   - Every registered metric exports a non-empty `formulaDoc` string
 *     (SPEC §8.6 contract).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MetricModule } from './types.js'

// ---------------------------------------------------------------------------
// Collect all registered metric modules
// ---------------------------------------------------------------------------

// Import every metric module. Non-metric exports (types, helpers) are filtered
// below by the MetricModule shape check.
import {
  agingWip,
  cfd,
  changeFailureRate,
  ciHealth,
  codeChangeImpact,
  commentsPerPr,
  complexityDelta,
  cycleTime,
  deploymentFrequency,
  deploymentReworkRate,
  estimationAccuracy,
  flowDistribution,
  flowEfficiency,
  halocAggregate,
  incidentReopenRate,
  leadTime,
  maintainabilityIndex,
  mergeWithoutReviewRate,
  monteCarlo,
  nagappanBall,
  prCycleTime,
  prSize,
  recoveryTime,
  reliabilityProxy,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
  reviewLatency,
  reworkChurn,
  sayDo,
  sprintPredictability,
  sprintVelocity,
  stalePr,
  throughput,
  timeInStatus,
  timeToFirstReview,
  timeToMerge,
  wipLoad,
} from './index.js'

// All metric module instances. Non-metric helpers (doraBandFromRate etc.) are
// not included here — only the MetricModule objects.
const ALL_METRICS: MetricModule<unknown>[] = [
  // Group A — DORA
  deploymentFrequency,
  leadTime,
  changeFailureRate,
  recoveryTime,
  incidentReopenRate,
  deploymentReworkRate,
  reliabilityProxy,
  // Group B — Flow
  cycleTime,
  flowEfficiency,
  throughput,
  wipLoad,
  flowDistribution,
  cfd,
  agingWip,
  timeInStatus,
  monteCarlo,
  // Group C — PR / Review
  prCycleTime,
  prSize,
  reviewCoverage,
  reviewersPerPr,
  reviewerLoad,
  commentsPerPr,
  reviewIterations,
  mergeWithoutReviewRate,
  reviewLatency,
  timeToFirstReview,
  timeToMerge,
  stalePr,
  ciHealth,
  // Group D — Code
  halocAggregate,
  reworkChurn,
  nagappanBall,
  complexityDelta,
  maintainabilityIndex,
  codeChangeImpact,
  // Group E — Agile
  sprintVelocity,
  sayDo,
  sprintPredictability,
  estimationAccuracy,
]

// ---------------------------------------------------------------------------
// Load docs/FORMULAS.md
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// packages/metrics/src → ../../.. → repo root → docs/FORMULAS.md
const formulasPath = resolve(__dirname, '..', '..', '..', 'docs', 'FORMULAS.md')
const formulasContent = readFileSync(formulasPath, 'utf8')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FORMULAS.md coverage', () => {
  it('every registered metric has a non-empty formulaDoc string (SPEC §8.6)', () => {
    for (const m of ALL_METRICS) {
      expect(
        m.formulaDoc,
        `metric ${m.id} must export a non-empty formulaDoc (SPEC §8.6)`,
      ).toBeTruthy()
      expect(typeof m.formulaDoc).toBe('string')
      expect(m.formulaDoc.length).toBeGreaterThan(10)
    }
  })

  it('docs/FORMULAS.md contains an entry for every registered metric id', () => {
    const missing: string[] = []
    for (const m of ALL_METRICS) {
      // The doc uses backtick-fenced ids like `dora.deployment_frequency`
      if (!formulasContent.includes(`\`${m.id}\``)) {
        missing.push(m.id)
      }
    }
    expect(
      missing,
      `docs/FORMULAS.md is missing entries for these metric ids:\n  ${missing.join('\n  ')}\nRun "npm run generate:formulas" to regenerate.`,
    ).toHaveLength(0)
  })

  it('total metric count matches expectation (update when new metrics are added)', () => {
    // This is a canary: if the count changes, the dev must update FORMULAS.md too.
    expect(ALL_METRICS).toHaveLength(39)
  })
})
