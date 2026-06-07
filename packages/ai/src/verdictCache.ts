/**
 * Verdict cache (SPEC §9.3)
 *
 * Keyed on (subject_type, subject_id, content_hash, prompt_version, model_id).
 * Re-runs only on content change — content-addressed for the shared-ingester path.
 *
 * This is an in-process cache backed by a Map.  The content_hash must be provided
 * by callers (e.g. SHA-256 of the serialised feature vector).
 */

import type { AiVerdict } from '@lazy-flow/core'

export interface CacheKey {
  subjectType: string
  subjectId: string
  contentHash: string
  promptVersion: string
  modelId: string
}

function toCacheKey(k: CacheKey): string {
  return `${k.subjectType}:${k.subjectId}:${k.contentHash}:${k.promptVersion}:${k.modelId}`
}

/**
 * In-process verdict cache.  One instance per harness; reset between tests.
 */
export class VerdictCache {
  private readonly mem = new Map<string, AiVerdict>()

  get(key: CacheKey): AiVerdict | null {
    return this.mem.get(toCacheKey(key)) ?? null
  }

  set(key: CacheKey, verdict: AiVerdict): void {
    this.mem.set(toCacheKey(key), verdict)
  }

  invalidate(key: CacheKey): void {
    this.mem.delete(toCacheKey(key))
  }

  clear(): void {
    this.mem.clear()
  }
}
