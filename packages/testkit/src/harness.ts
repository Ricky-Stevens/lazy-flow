/**
 * Test harness utilities for lazy-flow testkit.
 *
 * Exports:
 *   fakeClock(iso) — freeze Date.now() + new Date() to a fixed point in time
 *   seed           — stable seed for the vendored PRNG (SPEC §8.6 randomness)
 *   withMockServer — Vitest lifecycle wrapper around setupServer
 */

import type { RequestHandler } from 'msw'
import { setupServer } from 'msw/node'

// ---------------------------------------------------------------------------
// fakeClock
// ---------------------------------------------------------------------------

/**
 * Freeze the system clock to `iso` for the duration of a test.
 *
 * Replaces `Date.now()` and `new Date()` (no-arg) with deterministic values
 * so metric paths that inject a clock via `fakeClock` never diverge across
 * runs (SPEC §8.6 — no Date.now() in metric paths).
 *
 * Returns a restore function; call it in an afterEach/finally block.
 *
 * @example
 * const restore = fakeClock('2024-03-15T00:00:00Z')
 * try { ... } finally { restore() }
 */
export function fakeClock(iso: string): () => void {
  const fixedMs = new Date(iso).getTime()
  const OriginalDate = globalThis.Date

  // Build a patched Date that returns fixed values for no-arg construction
  // and Date.now(), but still parses strings/numbers correctly.
  // We use a class expression so instanceof checks keep working.
  const PatchedDate = class extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixedMs)
      } else {
        // @ts-expect-error — spread into Date constructor is variadic
        super(...args)
      }
    }

    static override now(): number {
      return fixedMs
    }

    static override parse(dateString: string): number {
      return OriginalDate.parse(dateString)
    }

    static override UTC(...args: Parameters<typeof OriginalDate.UTC>): number {
      return OriginalDate.UTC(...args)
    }
  } as unknown as typeof Date

  // Preserve Symbol.hasInstance so `date instanceof Date` still works
  Object.defineProperty(PatchedDate, Symbol.hasInstance, {
    value: (instance: unknown) => instance instanceof OriginalDate,
  })

  globalThis.Date = PatchedDate

  return () => {
    globalThis.Date = OriginalDate
  }
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

/**
 * Stable seed for the vendored PRNG (SPEC §8.6 randomness contract).
 *
 * All Monte Carlo / stochastic paths in the metric engine accept this seed
 * so test runs are deterministic across machines and Node versions.
 */
export const seed = 42

// ---------------------------------------------------------------------------
// withMockServer
// ---------------------------------------------------------------------------

/**
 * Wraps `setupServer` with the full Vitest lifecycle:
 *   - beforeAll: server.listen({ onUnhandledRequest: 'error' })
 *   - afterEach:  server.resetHandlers()
 *   - afterAll:   server.close()
 *
 * Returns the server instance so callers can add per-test handlers via
 * `server.use(...)` when needed.
 *
 * @example
 * import { withMockServer } from '@lazy-flow/testkit'
 * import { mockGitHub } from '@lazy-flow/testkit'
 *
 * const server = withMockServer(...mockGitHub())
 *
 * test('fetches commits', async () => { ... })
 */
export function withMockServer(...handlers: RequestHandler[]): ReturnType<typeof setupServer> {
  const server = setupServer(...handlers)

  // These globals are injected by Vitest at runtime.
  // Using dynamic access avoids a hard compile-time dependency on @vitest/globals.
  const g = globalThis as Record<string, unknown>
  const beforeAll = g.beforeAll as ((fn: () => void) => void) | undefined
  const afterEach = g.afterEach as ((fn: () => void) => void) | undefined
  const afterAll = g.afterAll as ((fn: () => void) => void) | undefined

  if (beforeAll) {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  }
  if (afterEach) {
    afterEach(() => server.resetHandlers())
  }
  if (afterAll) {
    afterAll(() => server.close())
  }

  return server
}
