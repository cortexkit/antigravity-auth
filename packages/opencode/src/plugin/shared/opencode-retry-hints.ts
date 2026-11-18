// OpenCode 1.19.5 tests messages and response bodies against these patterns
// even for API errors marked non-retryable.
const RETRY_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  // Non-API errors also have a branch that checks these substrings.
  /too_many_requests|exhausted|unavailable/i,
]

export function openCodeRetryHint(text: string): string | undefined {
  for (const pattern of RETRY_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return undefined
}
