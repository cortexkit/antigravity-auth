// OpenCode v1.19.5, packages/opencode/src/session/retry.ts (MIT).
// Tagged source SHA-256: 7e24b96622f7b46586eabb68d3c2464d1c68f5cc58262f2d305878d5e55b9aed
const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

// The branch conditions of retryable(), without the retry UI actions.
export function openCode1WouldRetry(error: {
  contextOverflow?: boolean
  api?: { status?: number; isRetryable: boolean; responseBody?: string }
  message: string
}): boolean {
  if (error.contextOverflow) return false
  if (error.api) {
    const { status, isRetryable, responseBody } = error.api
    return (
      isRetryable ||
      (status !== undefined && status >= 500) ||
      matchesRetryableMessage(error.message) ||
      matchesRetryableMessage(responseBody)
    )
  }
  const lower = error.message.toLowerCase()
  return (
    lower.includes('too_many_requests') ||
    lower.includes('exhausted') ||
    lower.includes('unavailable') ||
    matchesRetryableMessage(error.message)
  )
}

function matchesRetryableMessage(value: unknown) {
  return (
    typeof value === 'string' &&
    RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
  )
}
