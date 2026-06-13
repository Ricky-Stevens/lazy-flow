import { afterAll, afterEach, beforeAll } from 'bun:test'
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
export function fakeClock(iso) {
  const fixedMs = new Date(iso).getTime()
  const OriginalDate = globalThis.Date

  // Build a patched Date that returns fixed values for no-arg construction
  // and Date.now(), but still parses strings/numbers correctly.
  // We use a class expression so instanceof checks keep working.
  const PatchedDate = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs)
      } else {
        super(...args)
      }
    }

    static now() {
      return fixedMs
    }

    static parse(dateString) {
      return OriginalDate.parse(dateString)
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args)
    }
  }

  // Preserve Symbol.hasInstance so `date instanceof Date` still works
  Object.defineProperty(PatchedDate, Symbol.hasInstance, {
    value: (instance) => instance instanceof OriginalDate,
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
 * import { withMockServer } from './index.js'
 * import { mockGitHub } from './index.js'
 *
 * const server = withMockServer(...mockGitHub())
 *
 * test('fetches commits', async () => { ... })
 */
export function withMockServer(...handlers) {
  const server = setupServer(...handlers)

  // Lifecycle hooks come from the bun:test runner. They are only valid when
  // called from within a test file's module scope, which is the only place
  // withMockServer() is ever invoked.
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  return server
}
