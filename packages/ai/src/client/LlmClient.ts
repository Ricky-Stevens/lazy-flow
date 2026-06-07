/**
 * LlmClient — narrow interface the harness depends on (SPEC §9.3)
 *
 * All harness logic depends on this interface; tests inject FakeLlmClient.
 * The production impl (AnthropicLlmClient) wraps @anthropic-ai/sdk.
 */

import type { RequestShape } from '../requestShape.js'

export interface LlmParseRequest {
  model: string
  max_tokens: number
  /**
   * Privileged system instructions, sent in the model's `system` channel — NOT
   * concatenated into the user turn. Keeping the rules out of the untrusted user
   * channel (which carries attacker-influenced commit/ticket/diff text) is the
   * structural defence against prompt injection of the judge.
   */
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Actual params sent (already shaped by requestShape(); stored verbatim). */
  requestShape: RequestShape
  /** The zodOutputFormat(...) output-config format, opaque to the interface. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque AutoParseableOutputFormat — Anthropic SDK provides no better public type
  outputConfigFormat: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface LlmParseResult<T> {
  /** Parsed structured output, or null on refusal / parse failure. */
  value: T | null
  /** SDK stop reason */
  stopReason: string | null
  /**
   * The resolved model id as returned by the API response (the snapshot),
   * e.g. 'claude-sonnet-4-6-20251110'. Recorded in ai_verdicts.model_snapshot.
   */
  modelSnapshot: string
  /** The params actually sent; mirrors the requestShape field from the request. */
  requestShape: RequestShape
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Narrow LLM client interface. The harness only ever depends on this;
 * AnthropicLlmClient and FakeLlmClient both implement it.
 */
export interface LlmClient {
  parse<T>(req: LlmParseRequest): Promise<LlmParseResult<T>>
}
