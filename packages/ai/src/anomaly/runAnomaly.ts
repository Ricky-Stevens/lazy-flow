/**
 * Velocity Anomaly Explanation — SPEC §9.2.3, WP-AI-ANOMALY
 *
 * Detects a velocity anomaly deterministically (EWMA z-score), then
 * calls the LLM to rank systemic causes from a closed menu.
 */

import { createHash } from 'node:crypto'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Store } from '@lazy-flow/core'
import type { LlmClient } from '../client/LlmClient.js'
import { runVerdict } from '../harness.js'
import type { VerdictCache } from '../verdictCache.js'
import { detectAnomaly } from './detector.js'
import {
  ANOMALY_PROMPT_VERSION,
  ANOMALY_SYSTEM_PROMPT,
  anomalyOutputSchema,
  buildAnomalyUserMessage,
} from './prompt.js'
import type {
  AnomalyLlmOutput,
  AnomalyResult,
  AnomalySignalPack,
  CycleTimePoint,
  ThroughputPoint,
} from './types.js'

export interface RunAnomalyOptions {
  /**
   * Subject identifier — the sprint id, team slug, or window key
   * used as the subjectId in the audit row.
   */
  subjectId: string
  /** Throughput time-series (most recent last). */
  throughputSeries: ThroughputPoint[]
  /** Cycle-time time-series (most recent last). */
  cycleTimeSeries: CycleTimePoint[]
  /** Signal pack for the anomaly window. */
  signalPack: AnomalySignalPack
  /** Override model id (defaults to DEFAULT_MODEL). */
  modelId?: string
}

export async function runAnomaly(
  opts: RunAnomalyOptions,
  client: LlmClient,
  store: Store,
  cache: VerdictCache,
): Promise<AnomalyResult> {
  // 1. Deterministic detection
  const detection = detectAnomaly({
    throughputSeries: opts.throughputSeries,
    cycleTimeSeries: opts.cycleTimeSeries,
  })

  // 2. If no anomaly detected or sample suppressed, skip LLM
  if (!detection.isAnomaly) {
    return { detection }
  }

  // 3. Build user message
  const userMessage = buildAnomalyUserMessage(opts.signalPack)

  // 4. Content hash
  const contentHash = createHash('sha256').update(JSON.stringify(opts.signalPack)).digest('hex')

  // 5. Run LLM verdict
  const { value } = await runVerdict<AnomalyLlmOutput>(
    {
      subjectType: 'sprint',
      subjectId: opts.subjectId,
      metric: 'anomaly',
      promptVersion: ANOMALY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 1024,
      contentHash,
      featureVector: opts.signalPack as unknown as Record<string, unknown>,
      systemPrompt: ANOMALY_SYSTEM_PROMPT,
      userMessage,
      outputConfigFormat: zodOutputFormat(anomalyOutputSchema),
    },
    client,
    store,
    cache,
  )

  if (value === null) {
    return { detection }
  }

  return {
    detection,
    rankedCauses: value.ranked_causes,
    // Deterministic backstop for the prompt-only "NEVER name an individual"
    // rule: strip the concrete handles by which a person is named (@mentions,
    // email addresses) so the surfaced summary can't attribute the anomaly to a
    // named individual even if the model ignores the instruction.
    summary: redactIndividualRefs(value.summary),
  }
}

/** Replace @logins and email addresses in free text with a neutral placeholder. */
function redactIndividualRefs(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .replace(/(^|[^A-Za-z0-9_])@[A-Za-z0-9-]{1,39}\b/g, '$1[redacted]')
}
