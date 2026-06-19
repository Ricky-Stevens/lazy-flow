/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` calls
 * in flight at once, and returns results in the SAME ORDER as the input.
 *
 * This is the ingestion fast-path primitive: network round trips (commit detail,
 * PR sub-resources, file blobs) dominate sync wall-clock, and running them a few
 * at a time instead of strictly serially is a ~limit× speedup. Writes are NOT
 * parallelised here — SQLite is single-writer, so callers prefetch concurrently
 * then write sequentially.
 *
 * Rejection semantics match `Promise.all`: the first rejection aborts and
 * propagates (in-flight calls are not cancelled, but no new ones start once a
 * worker has thrown). Callers that must tolerate per-item failure should catch
 * inside `fn` and return a sentinel.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const n = items.length
  const results = new Array(n)
  if (n === 0) return results
  // Clamp the worker count to [1, n]; a non-positive limit would spawn zero
  // workers and hang.
  const workers = Math.max(1, Math.min(limit, n))
  let next = 0
  async function worker() {
    while (true) {
      const i = next
      next += 1
      if (i >= n) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}
