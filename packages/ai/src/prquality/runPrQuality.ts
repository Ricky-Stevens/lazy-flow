/**
 * PR Quality Score — SPEC §9.2.6, WP-AI-PRQUALITY
 *
 * Deterministic checks first, then LLM dimensions with quoted evidence.
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import { boolToScore, runDeterministicChecks } from './checks.js'
import {
  buildPrQualityUserMessage,
  PRQUALITY_PROMPT_VERSION,
  PRQUALITY_SYSTEM_PROMPT,
  prQualityOutputSchema,
} from './prompt.js'
import type { PrQualityLlmOutput, PrQualityResult } from './types.js'

export interface RunPrQualityOptions {
  /** PR node_id (used as subjectId in the audit row). */
  prId: string
  /** PR title. */
  prTitle: string
  /** PR body text (may be empty). */
  prBody: string
  /** List of changed file paths. */
  filePaths: string[]
  /** HALOC for this PR. */
  haloc: number
  /**
   * Concatenated diff text (or a representative summary).
   * Used by the LLM to check body-diff consistency.
   */
  diffSummary: string
  /** Override model id (defaults to DEFAULT_MODEL). */
  modelId?: string
}

export async function runPrQuality(
  opts: RunPrQualityOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<PrQualityResult> {
  // 1. Deterministic checks
  const deterministic = runDeterministicChecks({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    filePaths: opts.filePaths,
    haloc: opts.haloc,
  })

  // 2. Build LLM user message
  const userMessage = buildPrQualityUserMessage({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    diffSummary: opts.diffSummary,
    changedPaths: opts.filePaths,
  })

  // 3. Content hash
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        prTitle: opts.prTitle,
        prBody: opts.prBody,
        diffSummary: opts.diffSummary.slice(0, 2000),
      }),
    )
    .digest('hex')

  // 4. Run LLM verdict
  const { value } = await runVerdict<PrQualityLlmOutput>(
    {
      subjectType: 'pull_request',
      subjectId: opts.prId,
      metric: 'pr_quality',
      promptVersion: PRQUALITY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 1024,
      contentHash,
      featureVector: {
        hasDescription: deterministic.has_description,
        linkedIssue: deterministic.linked_issue,
        hasTests: deterministic.has_tests,
        isAtomic: deterministic.is_atomic,
        fileCount: opts.filePaths.length,
        haloc: opts.haloc,
      },
      systemPrompt: PRQUALITY_SYSTEM_PROMPT,
      userMessage,
      outputConfigFormat: zodOutputFormat(prQualityOutputSchema),
    },
    client,
    store,
    cache,
  )

  // 5. Compute overall score
  const detScore =
    boolToScore(deterministic.has_description) +
    boolToScore(deterministic.linked_issue) +
    boolToScore(deterministic.has_tests) +
    boolToScore(deterministic.is_atomic)

  const llmScore = value
    ? Number(value.explains_why.score) +
      Number(value.matches_diff.score) +
      Number(value.risk_flags.score)
    : 0

  return {
    deterministic,
    llm: value ?? undefined,
    overallScore: detScore + llmScore,
  }
}
