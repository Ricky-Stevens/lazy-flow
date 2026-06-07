/**
 * runClassify — Work-type Classification harness entry point (SPEC §9.2.5)
 *
 * Orchestrates:
 *   1. Apply deterministic prior (conventional commit / path pattern)
 *   2. If prior yields a confident result, return it directly (no LLM call)
 *   3. Otherwise call runVerdict with the classify prompt
 *   4. Expose a calibration hook (macro-F1 ≥ 0.7 is a later item — §9.2.5)
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import { applyDeterministicPrior } from './prior.js'
import {
  buildClassifyUserMessage,
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
} from './prompt.js'
import type { ClassifyResult, WorkType } from './types.js'
import { ClassifyLlmOutput } from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunClassifyOptions {
  /** PR title. */
  prTitle: string
  /** PR body. */
  prBody: string
  /** Commit messages for the PR. */
  commitMessages: string[]
  /** All file paths changed in the PR. */
  filePaths: string[]
  /**
   * Short diff summary passed to the LLM (e.g. first 2000 chars of the diff).
   * Callers are responsible for truncation to stay within token budget.
   */
  diffSummary: string
  /** PR or issue id for the audit row. */
  subjectId: string
  /** Subject type for the audit row. */
  subjectType?: string
  /** Override model id. */
  modelId?: string
  /**
   * Blame-fallback work type — used when issue links are missing and the
   * prior/LLM cannot determine the type.  Callers compute this from git blame.
   */
  blameFallback?: WorkType
}

// ---------------------------------------------------------------------------
// Calibration hook
// ---------------------------------------------------------------------------

/**
 * Calibration hook type.  WP-AI-CALIBRATION will register a hook that
 * receives every classification result and the ground-truth label (when
 * available) to maintain the macro-F1 score.
 *
 * This is a no-op by default; consumers may inject their own hook.
 */
export type CalibrationHook = (result: ClassifyResult, groundTruth?: WorkType) => void

let _calibrationHook: CalibrationHook | null = null

/**
 * Registers a calibration hook.  Called by WP-AI-CALIBRATION.
 */
export function registerCalibrationHook(hook: CalibrationHook): void {
  _calibrationHook = hook
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classifies the work type for a PR.
 * Deterministic prior is applied first; LLM is only called when no prior
 * yields a result (or when blame fallback is the only option).
 */
export async function runClassify(
  opts: RunClassifyOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<ClassifyResult> {
  // 1. Deterministic prior
  const prior = applyDeterministicPrior(opts.commitMessages, opts.prTitle, opts.filePaths)

  if (prior) {
    const result: ClassifyResult = {
      workType: prior.workType,
      source: prior.source,
      confidence: 1.0,
      priorWorkType: prior.workType,
    }
    _calibrationHook?.(result)
    return result
  }

  // 2. LLM call
  const userMessage = buildClassifyUserMessage({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    commitMessages: opts.commitMessages,
    filePaths: opts.filePaths,
    diffSummary: opts.diffSummary,
  })

  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        prTitle: opts.prTitle,
        // prBody is part of the prompt, so it must be part of the cache key —
        // otherwise an edited PR body returns a stale work-type from cache.
        prBody: opts.prBody,
        commitMessages: opts.commitMessages,
        filePaths: opts.filePaths,
        diffSummary: opts.diffSummary,
      }),
    )
    .digest('hex')

  const { value } = await runVerdict<ClassifyLlmOutput>(
    {
      subjectType: opts.subjectType ?? 'pull_request',
      subjectId: opts.subjectId,
      metric: 'classify',
      promptVersion: CLASSIFY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 256,
      contentHash,
      featureVector: {
        prTitle: opts.prTitle,
        filePaths: opts.filePaths,
        commitCount: opts.commitMessages.length,
      },
      systemPrompt: CLASSIFY_SYSTEM_PROMPT,
      userMessage,
      outputConfigFormat: zodOutputFormat(ClassifyLlmOutput),
    },
    client,
    store,
    cache,
  )

  if (value === null) {
    // 3. Blame fallback when LLM refuses
    if (opts.blameFallback) {
      const result: ClassifyResult = {
        workType: opts.blameFallback,
        source: 'blame_fallback',
        confidence: 0.5,
        priorWorkType: null,
      }
      _calibrationHook?.(result)
      return result
    }
    // Last resort — default to 'chore' at low confidence
    const result: ClassifyResult = {
      workType: 'chore',
      source: 'llm',
      confidence: 0,
      priorWorkType: null,
    }
    _calibrationHook?.(result)
    return result
  }

  const result: ClassifyResult = {
    workType: value.workType,
    source: 'llm',
    confidence: value.confidence,
    priorWorkType: null,
  }
  _calibrationHook?.(result)
  return result
}
