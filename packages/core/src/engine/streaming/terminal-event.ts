/** A frame can mention only a secondary candidate; position is a fallback for unindexed replies. */
export function primaryCandidate<T extends { index?: number }>(
  candidates: readonly T[] | undefined,
): T | undefined {
  if (!Array.isArray(candidates)) return undefined
  return candidates.find((candidate, position) =>
    candidate?.index === undefined
      ? position === 0 && candidate != null
      : candidate.index === 0,
  )
}

export function responseHasFinishReason(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    const candidate = primaryCandidate(resp.candidates)
    return (
      typeof candidate?.finishReason === 'string' &&
      candidate.finishReason.length > 0
    )
  }

  const stopReason = resp.stopReason ?? resp.stop_reason
  return typeof stopReason === 'string' && stopReason.length > 0
}

/**
 * Credit a finished reply to the routing account even if the host did not
 * request the candidate that finished.
 */
export function isTerminalSseLine(line: string): boolean {
  if (!line.startsWith('data:')) return false
  // Skip the JSON parse for the many content lines that cannot be terminal.
  if (!/"(?:finishReason|stopReason|stop_reason)"/.test(line)) return false
  try {
    const parsed = JSON.parse(line.slice(5).trim()) as {
      response?: unknown
    } | null
    const response = parsed?.response ?? parsed
    if (!response || typeof response !== 'object') return false
    const candidates = (response as Record<string, unknown>).candidates
    if (Array.isArray(candidates))
      return (
        typeof candidates[0]?.finishReason === 'string' &&
        candidates[0].finishReason.length > 0
      )
    return responseHasFinishReason(response)
  } catch {
    return false
  }
}
