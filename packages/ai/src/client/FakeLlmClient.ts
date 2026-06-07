/**
 * FakeLlmClient — deterministic in-process LLM client for tests.
 * NO network calls, NO API key required.
 *
 * Usage: construct with an ordered list of canned responses; each call to parse()
 * pops the next response.  Call reset() to replay.
 */

import { requestShape as buildRequestShape } from '../requestShape.js'
import type { LlmClient, LlmParseRequest, LlmParseResult } from './LlmClient.js'

export interface FakeResponse<T> {
  /** The structured value to return, or null to simulate refusal / parse failure. */
  value: T | null
  stopReason?: string
  /** Override the model snapshot string (defaults to `<model>-fake`). */
  modelSnapshot?: string
}

export class FakeLlmClient implements LlmClient {
  private queue: Array<FakeResponse<unknown>>

  constructor(responses: Array<FakeResponse<unknown>> = []) {
    this.queue = [...responses]
  }

  reset(responses: Array<FakeResponse<unknown>>): void {
    this.queue = [...responses]
  }

  async parse<T>(req: LlmParseRequest): Promise<LlmParseResult<T>> {
    const next = this.queue.shift()
    if (!next) throw new Error('FakeLlmClient: no more queued responses')

    const fake = next as FakeResponse<T>
    // Apply the per-model adapter so tests can assert that opus never gets sampling params.
    const shape = buildRequestShape(req.model, {
      temperature: req.requestShape.temperature,
      topP: req.requestShape.top_p,
      topK: req.requestShape.top_k,
    })

    const stopReason: string | null =
      fake.stopReason ?? (fake.value === null ? 'refusal' : 'end_turn')

    return {
      value: fake.value,
      stopReason,
      modelSnapshot: fake.modelSnapshot ?? `${req.model}-fake`,
      requestShape: shape,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}
