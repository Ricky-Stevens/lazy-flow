/**
 * PR Size — PR/Review Group C (SPEC §8.3)
 *
 * Uses HALOC if available (from code-analysis); falls back to
 * additions + deletions when haloc is null.
 *
 * HALOC-based size buckets: XS (≤10), S (≤50), M (≤200), L (≤500), XL (>500).
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { PrInput, PrSizeBucket } from './types.js'
import { prSizeBucket } from './types.js'

export interface PrSizeInputs {
  prs: readonly PrInput[]
}

export interface PrSizeResult extends MetricResult {
  readonly bucketCounts: Record<PrSizeBucket, number>
  readonly medianHaloc: number | null
  readonly sampleSize: number
}

const FORMULA_DOC =
  'PR Size (SPEC §8.3, SPEC C2): uses HALOC (Hunk-Adjusted LOC = Σ_hunk max(ins,del)) ' +
  'when available; falls back to additions+deletions. ' +
  'Buckets: XS ≤10, S ≤50, M ≤200, L ≤500, XL >500 HALOC. ' +
  'Reports bucket distribution and median HALOC for merged PRs.'

export const prSize: MetricModule<PrSizeInputs, PrSizeResult> = {
  id: 'pr.size',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): PrSizeResult {
    const mergedPrs = inputs.prs.filter((pr) => pr.state === 'merged')

    const buckets: Record<PrSizeBucket, number> = { XS: 0, S: 0, M: 0, L: 0, XL: 0 }
    const halocValues: number[] = []

    for (const pr of mergedPrs) {
      // Use haloc if available, else additions + deletions
      const size = pr.haloc !== null ? pr.haloc : pr.additions + pr.deletions
      halocValues.push(size)
      const bucket = prSizeBucket(size)
      buckets[bucket]++
    }

    // Median via sorting
    let medianHaloc: number | null = null
    if (halocValues.length > 0) {
      const sorted = [...halocValues].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      if (sorted.length % 2 === 1) {
        medianHaloc = sorted[mid] ?? null
      } else {
        const lo = sorted[mid - 1]
        const hi = sorted[mid]
        medianHaloc = lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null
      }
    }

    return {
      id: 'pr.size',
      trustTier: 'deterministic',
      scope: 'team',
      value: medianHaloc,
      unit: 'haloc',
      dataQuality: mergedPrs.length === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      bucketCounts: buckets,
      medianHaloc,
      sampleSize: mergedPrs.length,
    }
  },
}
