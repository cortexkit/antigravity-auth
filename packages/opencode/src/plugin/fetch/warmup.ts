/**
 * Per-interceptor warmup attempt + success bookkeeping.
 *
 * The plugin used to keep two module-level sets: one for sessions that already
 * attempted a thinking warmup and another for sessions that succeeded. They
 * leaked across plugin lifetimes and across concurrent interceptors. This
 * factory scopes the same sets to a single interceptor; `dispose()` evicts
 * everything so the next interceptor starts clean.
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
  /** Drops a single session's attempt counter (used on warmup failure). */
  clearWarmupAttempt(sessionId: string): void
  /** Drops every session entry. */
  clear(): void
  /** Marks the instance as torn down; subsequent mutations are no-ops. */
  dispose(): void
}

export function createWarmupState(): WarmupState {
  const warmupAttemptedSessionIds = new Set<string>()
  const warmupSucceededSessionIds = new Set<string>()
  let disposed = false

  function trackAttempt(sessionId: string): boolean {
    if (disposed) return false
    if (warmupSucceededSessionIds.has(sessionId)) {
      return false
    }
    if (warmupAttemptedSessionIds.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupAttemptedSessionIds.values().next().value
      if (first) {
        warmupAttemptedSessionIds.delete(first)
        warmupSucceededSessionIds.delete(first)
      }
    }
    const attempts = getAttemptCount(sessionId)
    if (attempts >= MAX_WARMUP_RETRIES) {
      return false
    }
    warmupAttemptedSessionIds.add(sessionId)
    return true
  }

  function getAttemptCount(sessionId: string): number {
    return warmupAttemptedSessionIds.has(sessionId) ? 1 : 0
  }

  function markSuccess(sessionId: string): void {
    if (disposed) return
    warmupSucceededSessionIds.add(sessionId)
    if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupSucceededSessionIds.values().next().value
      if (first) warmupSucceededSessionIds.delete(first)
    }
  }

  function clearWarmupAttempt(sessionId: string): void {
    if (disposed) return
    warmupAttemptedSessionIds.delete(sessionId)
  }

  function clear(): void {
    warmupAttemptedSessionIds.clear()
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
    clearWarmupAttempt,
    clear,
    dispose,
  }
}
