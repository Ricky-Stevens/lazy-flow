/**
 * Per-model request-shape adapter (SPEC §9.3, §9.1.3)
 *
 * Opus-family models (claude-opus-*) reject temperature/top_p/top_k/budget_tokens with HTTP 400.
 * Sonnet-tier models accept temperature: 0.
 *
 * This pure function returns the model-appropriate request params and is unit-tested.
 */

export interface RequestShapeOptions {
  temperature?: number
  topP?: number
  topK?: number
}

/**
 * The params actually sent to the model.  Stored as `request_shape` in ai_verdicts.
 */
export interface RequestShape {
  temperature?: number
  top_p?: number
  top_k?: number
}

/**
 * Returns the model-appropriate sampling params.
 * For `claude-opus-*` all sampling params are stripped.
 * For all other models, supplied params are included.
 */
export function requestShape(modelId: string, opts: RequestShapeOptions = {}): RequestShape {
  const isOpus = modelId.startsWith('claude-opus-')
  if (isOpus) {
    // Opus rejects temperature / top_p / top_k / budget_tokens — send nothing
    return {}
  }
  const shape: RequestShape = {}
  if (opts.temperature !== undefined) shape.temperature = opts.temperature
  if (opts.topP !== undefined) shape.top_p = opts.topP
  if (opts.topK !== undefined) shape.top_k = opts.topK
  return shape
}
