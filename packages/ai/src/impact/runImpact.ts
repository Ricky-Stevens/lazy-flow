/**
 * Explainable Code-Change Impact — SPEC §9.2.7, WP-AI-IMPACT
 *
 * Runs the deterministic Impact blend from @lazy-flow/metrics and
 * attaches an LLM rationale string referencing the actual changed paths.
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import { codeChangeImpact } from '@lazy-flow/metrics'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import {
  buildImpactUserMessage,
  IMPACT_PROMPT_VERSION,
  IMPACT_SYSTEM_PROMPT,
  impactOutputSchema,
} from './prompt.js'
import type { ImpactRationaleOutput, ImpactResult } from './types.js'

export interface RunImpactOptions {
  /**
   * Subject identifier — PR node_id or commit sha used as subjectId in audit.
   */
  subjectId: string
  /** File paths changed. */
  filePaths: string[]
  /** HALOC for this change. */
  haloc: number
  /** Lines classified as Rework (old code touched). */
  legacyRefactorLines: number
  /** Total lines classified. */
  totalLines: number
  /**
   * Optional weight overrides for the deterministic blend.
   * Keys: editDiversity, halocNorm, fileCountNorm, changeEntropy, oldCodePct.
   */
  weightOverrides?: Partial<Record<string, number>>
  /** Override model id (defaults to DEFAULT_MODEL). */
  modelId?: string
}

export async function runImpact(
  opts: RunImpactOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<ImpactResult> {
  const asOf = new Date().toISOString()

  // 1. Deterministic blend (the LLM does NOT compute this)
  const metricResult = codeChangeImpact.compute(
    {
      haloc: opts.haloc,
      filePaths: opts.filePaths,
      legacyRefactorLines: opts.legacyRefactorLines,
      totalLines: opts.totalLines,
      weightOverrides: opts.weightOverrides,
    },
    asOf,
  )

  const { impactScore, factors, weights } = metricResult

  // 2. Build LLM user message
  const userMessage = buildImpactUserMessage({
    filePaths: opts.filePaths,
    haloc: opts.haloc,
    impactScore,
    factors: factors as unknown as Record<string, number>,
    weights: weights as unknown as Record<string, number>,
  })

  // 3. Content hash — must cover every input that drives impactScore (which the
  // rationale references), else a re-derivation with different rework/total/
  // weights serves a stale rationale from cache.
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        filePaths: opts.filePaths,
        haloc: opts.haloc,
        legacyRefactorLines: opts.legacyRefactorLines,
        totalLines: opts.totalLines,
        weightOverrides: opts.weightOverrides ?? null,
        impactScore,
      }),
    )
    .digest('hex')

  // 4. Run LLM verdict for rationale only
  const { value } = await runVerdict<ImpactRationaleOutput>(
    {
      subjectType: 'pull_request',
      subjectId: opts.subjectId,
      metric: 'impact',
      promptVersion: IMPACT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 256,
      contentHash,
      featureVector: {
        impactScore,
        haloc: opts.haloc,
        fileCount: opts.filePaths.length,
      },
      systemPrompt: IMPACT_SYSTEM_PROMPT,
      userMessage,
      outputConfigFormat: zodOutputFormat(impactOutputSchema),
    },
    client,
    store,
    cache,
  )

  return {
    impactScore,
    factors: factors as unknown as Record<string, number>,
    weights: weights as unknown as Record<string, number>,
    rationale: value?.rationale ?? null,
  }
}
