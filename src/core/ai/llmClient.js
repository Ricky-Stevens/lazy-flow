/**
 * Minimal Anthropic Messages client for the AI-authorship classifier.
 *
 * Raw fetch (no SDK dependency — consistent with the rest of lazy-flow's
 * ingestion, which calls GitHub/Jira over raw fetch). The classifier is the
 * SEMANTIC tier that adjudicates the deterministic residual: changes the
 * stylometry detector couldn't confidently call. It is entirely OPT-IN — without
 * an API key `createAnthropicClassifier` returns null and the classifier pass is
 * skipped. Nothing leaves the machine unless a key is configured.
 *
 * Structured output is obtained by FORCING a single tool call (`tool_choice`),
 * which is robust across models without relying on output_config quirks.
 */

const ANTHROPIC_VERSION = '2023-06-01'

const VERDICT_TOOL = {
  name: 'record_ai_verdict',
  description:
    'Record the judgment of whether this change was written with the help of an AI coding assistant.',
  input_schema: {
    type: 'object',
    properties: {
      ai_assisted: {
        type: 'boolean',
        description: 'True if the text was likely written with AI assistance.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the verdict, 0.0 to 1.0.',
      },
      reasoning: { type: 'string', description: 'One or two sentences justifying the verdict.' },
      tells: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short labels for the stylistic tells observed (e.g. "em-dash", "section-headers").',
      },
    },
    required: ['ai_assisted', 'confidence', 'reasoning'],
  },
}

const SYSTEM_PROMPT =
  'You judge whether a git commit message or pull-request title/body was written with the help of an ' +
  'AI coding assistant (Claude, Codex, Gemini, Copilot, Cursor — any of them). Decide from WRITING ' +
  'STYLE and STRUCTURE, never from a single phrase: em dashes, polished multi-section markdown ' +
  '(## Summary / ## Test plan), exhaustive bullet lists, checkbox test plans, complete and ' +
  'grammatically perfect explanatory prose, precise enumeration ("updated 10 references across 5 ' +
  'files"). Human-written messages skew terse, lowercase, abbreviation-heavy, and structurally plain. ' +
  'Be calibrated — return a genuine confidence, not always high. Always call record_ai_verdict.'

/**
 * Create an AI-authorship classifier, or null when no API key is configured.
 * The returned object exposes `model` and `classify(text) -> verdict | null`.
 */
export function createAnthropicClassifier(opts = {}) {
  const apiKey = opts.apiKey
  if (!apiKey) return null
  const model = opts.model ?? 'claude-haiku-4-5'
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 30_000

  return {
    model,
    async classify(text) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: [VERDICT_TOOL],
          tool_choice: { type: 'tool', name: 'record_ai_verdict' },
          // Cap the text so a huge dependabot body can't blow the request.
          messages: [{ role: 'user', content: `<change>\n${String(text).slice(0, 6000)}\n</change>` }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new Error(`Anthropic Messages HTTP ${res.status}`)
      }
      const json = await res.json()
      const toolUse = (json.content ?? []).find(
        (b) => b.type === 'tool_use' && b.name === 'record_ai_verdict',
      )
      if (!toolUse) return null
      const input = toolUse.input ?? {}
      return {
        aiAssisted: input.ai_assisted === true,
        confidence: typeof input.confidence === 'number' ? input.confidence : 0.5,
        reasoning: typeof input.reasoning === 'string' ? input.reasoning : '',
        tells: Array.isArray(input.tells) ? input.tells.map(String) : [],
        modelId: typeof json.model === 'string' ? json.model : model,
      }
    },
  }
}
