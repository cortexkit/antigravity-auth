/**
 * The streaming transformer ends the reply it forwards right after the first
 * event whose response carries a finish reason. Vault routing uses the same
 * test on the upstream body to tell a finished reply from a cut-off one, so
 * both read it from here.
 */
export function responseHasFinishReason(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const resp = response as Record<string, unknown>

  if (Array.isArray(resp.candidates)) {
    return resp.candidates.some((candidate) => {
      const cand = candidate as Record<string, unknown> | null
      return (
        typeof cand?.finishReason === 'string' && cand.finishReason.length > 0
      )
    })
  }

  const stopReason = resp.stopReason ?? resp.stop_reason
  return typeof stopReason === 'string' && stopReason.length > 0
}

/**
 * Whether one upstream SSE line is the terminal event the streaming
 * transformer stops after: a `data:` line whose JSON has a `response` with a
 * finish reason.
 */
export function isTerminalSseLine(line: string): boolean {
  if (!line.startsWith('data:')) return false
  // Skip the JSON parse for the many content lines that cannot be terminal.
  if (!/"(?:finishReason|stopReason|stop_reason)"/.test(line)) return false
  try {
    const parsed = JSON.parse(line.slice(5).trim()) as {
      response?: unknown
    } | null
    return (
      parsed?.response !== undefined && responseHasFinishReason(parsed.response)
    )
  } catch {
    return false
  }
}
