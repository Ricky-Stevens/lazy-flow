/**
 * runAlignment — Ticket-Work Alignment harness entry point (SPEC §9.2.1)
 *
 * Orchestrates:
 *   1. Build the feature pack (parse AC, rank hunks)
 *   2. Call runVerdict with the alignment prompt
 *   3. Apply the evidence-relevance guard (demote irrelevant quotes)
 *   4. Compute coverage_ratio deterministically
 *   5. Apply min(ordinal, coverage-ratio-band) rule
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import {
  applyEvidenceGuard,
  applyMinRule,
  computeCoverageRatio,
  coverageRatioToOrdinal,
} from './evidenceGuard.js'
import { buildAlignmentFeaturePack } from './featurePack.js'
import {
  ALIGNMENT_PROMPT_VERSION,
  ALIGNMENT_SYSTEM_PROMPT,
  alignmentOutputSchema,
  buildAlignmentUserMessage,
} from './prompt.js'
import type { AlignmentFeaturePack, AlignmentLlmOutput, AlignmentResult } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAlignmentOptions {
  /** Raw inputs for building the feature pack. */
  featurePackInput: {
    issueKey: string
    issueType: string
    issueSummary: string
    issueDescription: string
    prTitle: string
    prBody: string
    commitMessages: string[]
    rawDiffHunks: Array<{ filePath: string; content: string }>
  }
  /** PR node_id (used as subjectId in the audit row). */
  prId: string
  /** Override model id (defaults to DEFAULT_MODEL). */
  modelId?: string
}

/**
 * Runs the alignment verdict for a PR against its linked ticket.
 * Returns the full AlignmentResult plus the raw harness verdict row.
 */
export async function runAlignment(
  opts: RunAlignmentOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<{ result: AlignmentResult; featurePack: AlignmentFeaturePack }> {
  // 1. Build feature pack
  const featurePack = buildAlignmentFeaturePack(opts.featurePackInput)

  // 2. Build user message
  const userMessage = buildAlignmentUserMessage(featurePack)

  // 3. Content hash — deterministic hash of the feature pack
  const contentHash = createHash('sha256').update(JSON.stringify(featurePack)).digest('hex')

  // 4. Call runVerdict
  const { value } = await runVerdict<AlignmentLlmOutput>(
    {
      subjectType: 'pull_request',
      subjectId: opts.prId,
      metric: 'alignment',
      promptVersion: ALIGNMENT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 2048,
      contentHash,
      featureVector: featurePack as unknown as Record<string, unknown>,
      systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
      userMessage,
      // Wrap with zodOutputFormat so the SDK populates parsed_output. Passing the
      // bare schema produced an invalid output_config.format → parsed_output was
      // always null and every alignment verdict silently degraded to refusal.
      outputConfigFormat: zodOutputFormat(alignmentOutputSchema),
    },
    client,
    store,
    cache,
  )

  // 5. Handle refusal / cutoff
  if (value === null) {
    return {
      result: {
        ordinal: '0',
        rawOrdinal: '0',
        criteria: [],
        coverageRatio: 0,
        confidence: 0,
      },
      featurePack,
    }
  }

  // 6. Apply evidence-relevance guard
  const guardedCriteria = applyEvidenceGuard(
    value.criteria,
    featurePack.criteria,
    featurePack.diffHunks,
  )

  // 7. Compute coverage_ratio deterministically
  const coverageRatio = computeCoverageRatio(guardedCriteria)
  const coverageOrdinal = coverageRatioToOrdinal(coverageRatio)

  // 8. Apply min-rule
  const finalOrdinal = applyMinRule(value.ordinal, coverageOrdinal)

  return {
    result: {
      ordinal: finalOrdinal,
      rawOrdinal: value.ordinal,
      criteria: guardedCriteria,
      coverageRatio,
      confidence: value.confidence,
    },
    featurePack,
  }
}
