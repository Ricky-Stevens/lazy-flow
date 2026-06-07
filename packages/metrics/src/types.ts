/**
 * Shared types for the @lazy-flow/metrics engine.
 *
 * Every metric module exports an object conforming to MetricModule<I>.
 * compute() is a pure function: same (inputs, params) → same MetricResult.
 * Clock (asOf) is injected; no Date.now() in metric paths.
 */

import type { MetricResult, MetricScope, TrustTier } from '@lazy-flow/core'

// Re-export for convenience
export type { MetricResult }

/**
 * A metric module — the shared contract per SPEC §8.6 / §6 WP shared contract.
 */
export interface MetricModule<I, O extends MetricResult = MetricResult> {
  /** Unique metric identifier (snake_case). */
  readonly id: string
  readonly trustTier: TrustTier
  readonly scope: MetricScope
  /** Published "how is this computed?" string for in-product transparency. */
  readonly formulaDoc: string
  /** Param defaults (may be overridden at call-site). */
  readonly params: Record<string, unknown>
  /** Pure compute function — injected clock, no side effects. */
  compute(inputs: I, asOf: string, params?: Record<string, unknown>): O
}
