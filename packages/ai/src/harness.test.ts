/**
 * AI harness tests (WP-AI-HARNESS)
 *
 * All tests use FakeLlmClient — no API key, no network.
 * Integration test gated on ANTHROPIC_API_KEY is at the bottom.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from './client/FakeLlmClient.js'
import { DEFAULT_MODEL, ENSEMBLE_MODEL } from './constants.js'
import { correctVerdict, runVerdict } from './harness.js'
import { requestShape } from './requestShape.js'
import { VerdictCache } from './verdictCache.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

/** A minimal zodOutputFormat-shaped fake (the harness never calls .parse on it). */
const fakeOutputFormat = { type: 'json_object', schema: {} }

interface SampleOutput {
  ordinal: string
  confidence: number
  evidence: string
}

function sampleOutput(): SampleOutput {
  return { ordinal: '3', confidence: 0.85, evidence: 'diff hunk A' }
}

function baseOptions(extra: Partial<Parameters<typeof runVerdict>[0]> = {}) {
  return {
    subjectType: 'pull_request' as const,
    subjectId: 'pr-abc-123',
    metric: 'test_metric',
    promptVersion: '1.0.0',
    modelId: DEFAULT_MODEL,
    maxTokens: 256,
    contentHash: 'hash-v1',
    featureVector: { haloc: 42, files: 3 },
    userMessage: 'Evaluate this PR.',
    outputConfigFormat: fakeOutputFormat,
    ...extra,
  }
}

// ─── requestShape unit tests ───────────────────────────────────────────────────

describe('requestShape', () => {
  it('strips all sampling params for claude-opus-* ids', () => {
    const shape = requestShape(ENSEMBLE_MODEL, {
      temperature: 0,
      topP: 0.9,
      topK: 40,
    })
    expect(shape).toEqual({})
    expect(Object.keys(shape)).toHaveLength(0)
  })

  it('passes temperature: 0 through for sonnet model', () => {
    const shape = requestShape(DEFAULT_MODEL, { temperature: 0 })
    expect(shape.temperature).toBe(0)
  })

  it('passes top_p and top_k for non-opus models', () => {
    const shape = requestShape('claude-haiku-3-5', { topP: 0.95, topK: 20 })
    expect(shape.top_p).toBe(0.95)
    expect(shape.top_k).toBe(20)
  })

  it('returns empty shape for opus with no opts', () => {
    expect(requestShape('claude-opus-4-8', {})).toEqual({})
  })

  it('does not include undefined keys in the returned shape', () => {
    const shape = requestShape(DEFAULT_MODEL, {})
    expect(Object.keys(shape)).toHaveLength(0)
  })
})

// ─── VerdictCache unit tests ───────────────────────────────────────────────────

describe('VerdictCache', () => {
  it('returns null on miss', () => {
    const cache = new VerdictCache()
    expect(
      cache.get({
        subjectType: 'pr',
        subjectId: 'x',
        contentHash: 'h',
        promptVersion: '1',
        modelId: 'm',
      }),
    ).toBeNull()
  })

  it('returns the verdict after set', () => {
    const cache = new VerdictCache()
    const key = {
      subjectType: 'pr',
      subjectId: 'x',
      contentHash: 'h',
      promptVersion: '1',
      modelId: 'm',
    }
    const verdict = {
      id: 'v1',
      subjectType: 'pr',
      subjectId: 'x',
      metric: 'm',
      promptVersion: '1',
      modelId: 'm',
      modelSnapshot: 's',
      requestShape: '{}',
      featureVectorJson: '{}',
      structuredVerdictJson: '{}',
      evidenceJson: '{}',
      confidence: 0.5,
      createdAt: 'now',
      correctedBy: null,
      correctionJson: null,
    }
    cache.set(key, verdict)
    expect(cache.get(key)?.id).toBe('v1')
  })
})

// ─── runVerdict end-to-end ─────────────────────────────────────────────────────

describe('runVerdict', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('persists an audit row on a successful run', async () => {
    const client = new FakeLlmClient([{ value: sampleOutput() }])
    const opts = baseOptions()

    const result = await runVerdict<SampleOutput>(opts, client, store, cache)

    expect(result.fromCache).toBe(false)
    expect(result.value?.ordinal).toBe('3')
    expect(result.verdict.subjectId).toBe('pr-abc-123')
    expect(result.verdict.metric).toBe('test_metric')
    expect(result.verdict.promptVersion).toBe('1.0.0')
    expect(result.verdict.modelId).toBe(DEFAULT_MODEL)
    expect(result.verdict.confidence).toBe(0.85)

    // Verify it was persisted
    const persisted = await store.getAiVerdict(result.verdict.id)
    expect(persisted?.id).toBe(result.verdict.id)
    expect(JSON.parse(persisted?.structuredVerdictJson ?? '{}')).toMatchObject({ ordinal: '3' })
  })

  it('returns fromCache=true on identical content re-run (no LLM call)', async () => {
    const client = new FakeLlmClient([{ value: sampleOutput() }])
    const opts = baseOptions()

    const first = await runVerdict<SampleOutput>(opts, client, store, cache)
    expect(first.fromCache).toBe(false)

    // Second run: same contentHash → should hit cache
    const client2 = new FakeLlmClient([]) // no responses — would throw if called
    const second = await runVerdict<SampleOutput>(opts, client2, store, cache)
    expect(second.fromCache).toBe(true)
    expect(second.verdict.id).toBe(first.verdict.id)
  })

  it('re-runs on changed contentHash', async () => {
    const client = new FakeLlmClient([
      { value: sampleOutput() },
      { value: { ordinal: '1', confidence: 0.5, evidence: 'diff B' } },
    ])
    const opts1 = baseOptions({ contentHash: 'hash-v1' })
    const opts2 = baseOptions({ contentHash: 'hash-v2' })

    const first = await runVerdict<SampleOutput>(opts1, client, store, cache)
    const second = await runVerdict<SampleOutput>(opts2, client, store, cache)

    expect(first.value?.ordinal).toBe('3')
    expect(second.value?.ordinal).toBe('1')
    expect(first.verdict.id).not.toBe(second.verdict.id)
    expect(second.fromCache).toBe(false)
  })

  it('handles refusal (parsed_output === null) without crashing', async () => {
    const client = new FakeLlmClient([{ value: null, stopReason: 'refusal' }])
    const opts = baseOptions()

    const result = await runVerdict<SampleOutput>(opts, client, store, cache)

    expect(result.value).toBeNull()
    expect(result.verdict.structuredVerdictJson).toBe('null')
    // Still persisted
    const persisted = await store.getAiVerdict(result.verdict.id)
    expect(persisted).not.toBeNull()
  })

  it('max_tokens stop reason is handled without crashing', async () => {
    const client = new FakeLlmClient([{ value: null, stopReason: 'max_tokens' }])
    const result = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)
    expect(result.value).toBeNull()
    expect(result.verdict.id).toBeTruthy()
  })
})

// ─── Ensemble gate ─────────────────────────────────────────────────────────────

describe('ensemble gate', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('does NOT trigger when shouldEscalate returns false', async () => {
    // Only one queued response — if ensemble runs it would throw (queue empty)
    const client = new FakeLlmClient([{ value: sampleOutput() }])
    const opts = baseOptions({ shouldEscalate: () => false })

    const result = await runVerdict<SampleOutput>(opts, client, store, cache)
    expect(result.value?.ordinal).toBe('3')
  })

  it('triggers and runs ensemble when shouldEscalate returns true', async () => {
    // Primary call + ensemble call (ensemble model = ENSEMBLE_MODEL)
    const client = new FakeLlmClient([
      { value: sampleOutput(), modelSnapshot: `${DEFAULT_MODEL}-fake` },
      {
        value: { ordinal: '2', confidence: 0.6, evidence: 'ensemble evidence' },
        modelSnapshot: `${ENSEMBLE_MODEL}-fake`,
      },
    ])

    const escalateCalled: boolean[] = []
    const opts = baseOptions({
      shouldEscalate: (v) => {
        escalateCalled.push(true)
        // Escalate when primary value is non-null (for test purposes)
        return v !== null
      },
    })

    const result = await runVerdict<SampleOutput>(opts, client, store, cache)
    // shouldEscalate was called
    expect(escalateCalled.length).toBeGreaterThan(0)
    // result still comes back (from primary since both differ → primary wins)
    expect(result.value).not.toBeNull()
    expect(result.fromCache).toBe(false)
  })

  it('default escalation adopts the higher-confidence ensemble verdict', async () => {
    // Primary is low-confidence (0.2 < 0.5 default threshold) → ensemble runs;
    // ensemble is higher-confidence (0.9) → its verdict must WIN (not be discarded).
    const client = new FakeLlmClient([
      {
        value: { ordinal: '3', confidence: 0.2, evidence: 'weak' },
        modelSnapshot: `${DEFAULT_MODEL}-fake`,
      },
      {
        value: { ordinal: '1', confidence: 0.9, evidence: 'strong' },
        modelSnapshot: `${ENSEMBLE_MODEL}-fake`,
      },
    ])
    // No shouldEscalate override → exercises the default predicate.
    const result = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)
    expect(result.value?.ordinal).toBe('1')
    expect(result.value?.confidence).toBe(0.9)
    // Provenance must follow the SERVED verdict: when the ensemble wins, the
    // persisted audit row records the ENSEMBLE model + snapshot, not the primary
    // (otherwise an Opus decision is misattributed to Sonnet in calibration).
    expect(result.verdict.modelId).toBe(ENSEMBLE_MODEL)
    expect(result.verdict.modelSnapshot).toBe(`${ENSEMBLE_MODEL}-fake`)
  })

  it('keeps PRIMARY provenance when the primary verdict is the one served', async () => {
    const client = new FakeLlmClient([
      {
        value: { ordinal: '3', confidence: 0.4, evidence: 'primary' },
        modelSnapshot: `${DEFAULT_MODEL}-fake`,
      },
      {
        value: { ordinal: '1', confidence: 0.1, evidence: 'worse' },
        modelSnapshot: `${ENSEMBLE_MODEL}-fake`,
      },
    ])
    const result = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)
    expect(result.value?.ordinal).toBe('3')
    expect(result.verdict.modelId).toBe(DEFAULT_MODEL)
    expect(result.verdict.modelSnapshot).toBe(`${DEFAULT_MODEL}-fake`)
  })

  it('default escalation keeps the primary when it is the higher-confidence verdict', async () => {
    const client = new FakeLlmClient([
      {
        value: { ordinal: '3', confidence: 0.4, evidence: 'primary' },
        modelSnapshot: `${DEFAULT_MODEL}-fake`,
      },
      {
        value: { ordinal: '1', confidence: 0.1, evidence: 'worse' },
        modelSnapshot: `${ENSEMBLE_MODEL}-fake`,
      },
    ])
    const result = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)
    expect(result.value?.ordinal).toBe('3')
  })

  it('default escalation does NOT fire on a refusal (null primary)', async () => {
    // Only one queued response — if the ensemble ran it would throw (empty queue).
    const client = new FakeLlmClient([{ value: null, stopReason: 'refusal' }])
    const result = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)
    expect(result.value).toBeNull()
  })

  it('ensemble model never receives sampling params (opus adapter enforced)', async () => {
    const sentRequests: Array<{ model: string; requestShape: unknown }> = []

    // Wrap FakeLlmClient to spy on requests
    const inner = new FakeLlmClient([
      { value: sampleOutput() },
      { value: { ordinal: '2', confidence: 0.4, evidence: 'e' } },
    ])

    const spyClient = {
      async parse<T>(req: Parameters<FakeLlmClient['parse']>[0]) {
        sentRequests.push({ model: req.model, requestShape: req.requestShape })
        return inner.parse<T>(req)
      },
    }

    const opts = baseOptions({
      samplingOpts: { temperature: 0 }, // valid for sonnet
      shouldEscalate: () => true,
    })

    await runVerdict<SampleOutput>(opts, spyClient, store, cache)

    const ensembleReq = sentRequests.find((r) => r.model === ENSEMBLE_MODEL)
    expect(ensembleReq).toBeDefined()
    // Opus must have NO temperature key in the actual shape sent
    const shape = ensembleReq?.requestShape as Record<string, unknown>
    expect(shape).not.toHaveProperty('temperature')
    expect(shape).not.toHaveProperty('top_p')
    expect(shape).not.toHaveProperty('top_k')
  })
})

// ─── correctVerdict ────────────────────────────────────────────────────────────

describe('correctVerdict', () => {
  it('writes corrected_by and correction_json to the existing row', async () => {
    const store = freshStore()
    const cache = new VerdictCache()
    const client = new FakeLlmClient([{ value: sampleOutput() }])

    const { verdict } = await runVerdict<SampleOutput>(baseOptions(), client, store, cache)

    await correctVerdict(verdict.id, 'user@example.com', '{"ordinal":"2"}', store)

    const updated = await store.getAiVerdict(verdict.id)
    expect(updated?.correctedBy).toBe('user@example.com')
    expect(updated?.correctionJson).toBe('{"ordinal":"2"}')
  })
})

// ─── Optional integration test (requires ANTHROPIC_API_KEY) ───────────────────

const runIntegration = !!process.env.ANTHROPIC_API_KEY

describe.skipIf(!runIntegration)('integration: AnthropicLlmClient', () => {
  it('makes a real API call and returns a parsed result', async () => {
    const { AnthropicLlmClient } = await import('./client/AnthropicLlmClient.js')
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod')
    const z = await import('zod/v4')

    const schema = z.object({ answer: z.string() })
    const format = zodOutputFormat(schema)

    const client = new AnthropicLlmClient()
    const result = await client.parse<{ answer: string }>({
      model: DEFAULT_MODEL,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Reply with JSON: {"answer": "hello"}' }],
      requestShape: requestShape(DEFAULT_MODEL, { temperature: 0 }),
      outputConfigFormat: format,
    })

    expect(result.stopReason).not.toBeNull()
    expect(result.modelSnapshot).toBeTruthy()
    // parsed_output may be null on some responses but request must not throw
  })
})
