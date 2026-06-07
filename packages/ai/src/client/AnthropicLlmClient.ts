/**
 * AnthropicLlmClient — wraps @anthropic-ai/sdk with the per-model request-shape adapter
 * and structured outputs (SPEC §9.3).
 */

import Anthropic from '@anthropic-ai/sdk'
import { requestShape } from '../requestShape.js'
import type { LlmClient, LlmParseRequest, LlmParseResult } from './LlmClient.js'

export interface AnthropicLlmClientOptions {
  apiKey?: string
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic

  constructor(opts: AnthropicLlmClientOptions = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey })
  }

  async parse<T>(req: LlmParseRequest): Promise<LlmParseResult<T>> {
    // Apply the per-model request-shape adapter to the sampling params before building the call.
    // req.requestShape already carries the caller's intent; we use it as the stored shape
    // but also need the raw values to pass to the API.
    const shape = requestShape(req.model, {
      temperature: req.requestShape.temperature,
      topP: req.requestShape.top_p,
      topK: req.requestShape.top_k,
    })

    // Build the API call params — only include sampling keys that survived the adapter.
    const createParams: Parameters<typeof this.client.messages.parse>[0] = {
      model: req.model,
      max_tokens: req.max_tokens,
      messages: req.messages,
      output_config: { format: req.outputConfigFormat },
    }
    if (req.system !== undefined) createParams.system = req.system
    if (shape.temperature !== undefined) createParams.temperature = shape.temperature
    if (shape.top_p !== undefined) createParams.top_p = shape.top_p
    if (shape.top_k !== undefined) createParams.top_k = shape.top_k

    let response: Awaited<ReturnType<typeof this.client.messages.parse>>
    try {
      response = await this.client.messages.parse(createParams)
    } catch (err) {
      // The SDK's structured-output parser THROWS an AnthropicError when the
      // model output fails schema validation or is truncated by max_tokens —
      // it never returns parsed_output:null. Degrade those to the contract's
      // `value: null` refusal path so the harness/run* fallbacks fire, instead
      // of crashing the whole insight pipeline. Genuine API failures
      // (network/auth/rate-limit — Anthropic.APIError) are real and rethrown.
      if (err instanceof Anthropic.APIError || !(err instanceof Anthropic.AnthropicError)) {
        throw err
      }
      return {
        value: null,
        // A truncated reply is the common cause; surface it so callers can tell
        // a parse failure from a clean refusal.
        stopReason: 'max_tokens',
        modelSnapshot: req.model,
        requestShape: shape,
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    }

    return {
      value: (response.parsed_output as T | null) ?? null,
      stopReason: response.stop_reason ?? null,
      modelSnapshot: response.model,
      requestShape: shape,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }
}
