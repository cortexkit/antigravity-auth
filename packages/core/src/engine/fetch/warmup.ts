/**
 * Per-interceptor warmup attempt + success bookkeeping.
 *
 * The plugin used to keep two module-level sets: one for sessions that already
 * attempted a thinking warmup and another for sessions that succeeded. They
 * leaked across plugin lifetimes and across concurrent interceptors. This
 * factory scopes the same sets to a single interceptor; `dispose()` evicts
 * everything so the next interceptor starts clean.
 *
 * Attempts are counted per session, so a warmup that keeps failing stops after
 * `MAX_WARMUP_RETRIES` physical sends instead of retrying on every turn.
 */

const MAX_WARMUP_SESSIONS = 1000
const MAX_WARMUP_RETRIES = 2

export interface WarmupState {
  readonly disposed: boolean
  /**
   * Records an attempt for the given session id. Returns false when the
   * session already succeeded (no further attempts permitted) or when the
   * retry budget is exhausted.
   */
  trackAttempt(sessionId: string): boolean
  /** Returns the number of tracked attempts for the session. */
  getAttemptCount(sessionId: string): number
  /** Marks the session as warmed-up; subsequent attempts are rejected. */
  markSuccess(sessionId: string): void
  /**
   * Gives back one attempt recorded by `trackAttempt`. Only for a warmup that
   * failed before anything was sent; a warmup that reached the network keeps
   * its count even when it fails.
   */
  refundAttempt(sessionId: string): void
  /** Drops every session entry. */
  clear(): void
  /** Marks the instance as torn down; subsequent mutations are no-ops. */
  dispose(): void
}

export function createWarmupState(): WarmupState {
  // Insertion order doubles as eviction order once the session cap is hit.
  const warmupAttemptCounts = new Map<string, number>()
  const warmupSucceededSessionIds = new Set<string>()
  let disposed = false

  function trackAttempt(sessionId: string): boolean {
    if (disposed) return false
    if (warmupSucceededSessionIds.has(sessionId)) {
      return false
    }
    const attempts = getAttemptCount(sessionId)
    if (attempts >= MAX_WARMUP_RETRIES) {
      return false
    }
    if (attempts === 0 && warmupAttemptCounts.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupAttemptCounts.keys().next().value
      if (first !== undefined) {
        warmupAttemptCounts.delete(first)
        warmupSucceededSessionIds.delete(first)
      }
    }
    warmupAttemptCounts.set(sessionId, attempts + 1)
    return true
  }

  function getAttemptCount(sessionId: string): number {
    return warmupAttemptCounts.get(sessionId) ?? 0
  }

  function markSuccess(sessionId: string): void {
    if (disposed) return
    warmupSucceededSessionIds.add(sessionId)
    if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupSucceededSessionIds.values().next().value
      if (first) warmupSucceededSessionIds.delete(first)
    }
  }

  function refundAttempt(sessionId: string): void {
    if (disposed) return
    const attempts = getAttemptCount(sessionId)
    if (attempts <= 1) warmupAttemptCounts.delete(sessionId)
    else warmupAttemptCounts.set(sessionId, attempts - 1)
  }

  function clear(): void {
    warmupAttemptCounts.clear()
    warmupSucceededSessionIds.clear()
  }

  function dispose(): void {
    if (disposed) return
    clear()
    disposed = true
  }

  return {
    get disposed() {
      return disposed
    },
    trackAttempt,
    getAttemptCount,
    markSuccess,
    refundAttempt,
    clear,
    dispose,
  }
}
