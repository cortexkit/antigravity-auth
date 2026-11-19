/**
 * Remembers which Gemini thinking texts were already shown in each session,
 * so a later response in the same session does not repeat them.
 *
 * Every session gets its own set, and both the number of remembered sessions
 * and the texts kept per session are capped: the memory stays bounded in a
 * long-running process, and identical thinking in another session is never
 * hidden. A response without a session key gets no set at all, so unrelated
 * unidentified requests never share one.
 */

export const MAX_DISPLAYED_THINKING_SESSIONS = 256
export const MAX_DISPLAYED_THINKING_PER_SESSION = 512

/** A set that forgets its oldest entry once it holds `limit` entries. */
class BoundedHashSet extends Set<string> {
  constructor(private readonly limit: number) {
    super()
  }

  override add(value: string): this {
    if (!this.has(value) && this.size >= this.limit) {
      const oldest = this.values().next().value
      if (oldest !== undefined) this.delete(oldest)
    }
    return super.add(value)
  }
}

export interface DisplayedThinkingRegistry {
  /** The session's set, or undefined when the response has no session key. */
  forSession(sessionKey: string | undefined): Set<string> | undefined
  /** Number of sessions currently remembered. */
  readonly sessionCount: number
}

export function createDisplayedThinkingRegistry(
  limits: { sessions?: number; perSession?: number } = {},
): DisplayedThinkingRegistry {
  const maxSessions = limits.sessions ?? MAX_DISPLAYED_THINKING_SESSIONS
  const perSession = limits.perSession ?? MAX_DISPLAYED_THINKING_PER_SESSION
  // Insertion order is recency order: a used session moves to the end.
  const sessions = new Map<string, BoundedHashSet>()

  return {
    forSession(sessionKey) {
      if (!sessionKey) return undefined
      let hashes = sessions.get(sessionKey)
      if (hashes) {
        sessions.delete(sessionKey)
      } else {
        hashes = new BoundedHashSet(perSession)
        if (sessions.size >= maxSessions) {
          const oldest = sessions.keys().next().value
          if (oldest !== undefined) sessions.delete(oldest)
        }
      }
      sessions.set(sessionKey, hashes)
      return hashes
    },
    get sessionCount() {
      return sessions.size
    },
  }
}
