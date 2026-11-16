import { expect } from 'bun:test'

// OpenCode 1.19.5's session retry check matches both the message and response
// body against these patterns, even for an explicitly non-retryable API error.
const RETRY_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

export function expectNoOpenCodeRetryHints(text: string): void {
  for (const pattern of RETRY_PATTERNS) {
    expect(text).not.toMatch(pattern)
  }
  // OpenCode's non-API-error branch uses plain lowercase substring checks.
  for (const hint of ['too_many_requests', 'exhausted', 'unavailable']) {
    expect(text.toLowerCase()).not.toContain(hint)
  }
}
