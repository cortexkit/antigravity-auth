// @earendil-works/pi-ai 1.6.0, dist/utils/retry.js (MIT).
// Published source SHA-256: 9d3cc0710b597f07fd7be6feb106908b737f0e95bf3e47cb0f5ab45f54382605
// Classifier only; the agent's retry scheduler is not needed here.
function buildProviderErrorPattern(patterns: readonly string[]) {
  return new RegExp(patterns.join('|'), 'i')
}
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  // OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
  // Zen API. These are subscription/account limits, not transient throttles.
  'GoUsageLimitError',
  'FreeUsageLimitError',
  // OpenCode Go subscription-limit text asks users to enable available-balance
  // usage after rolling/weekly/monthly limits are reached.
  'Monthly usage limit reached',
  'available balance',
  // Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
  // quota/billing error code; the other strings cover common gateway wording.
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing',
  // Sign in with ChatGPT: the subscription's shared usage limit, which resets
  // after hours rather than seconds.
  'subscription_sharing_usage_limit_exceeded',
  // Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
  // workspace admin. Only the admin can raise it.
  'subscription_sharing_workplace_individual_usage_limit_exceeded',
  // Zhipu/Z.ai (open.bigmodel.cn) error code 1308: the plan's usage limit is
  // reached, sent as HTTP 429. It resets after hours, not seconds (#11537).
  '"code"\\s*:\\s*"?1308(?![0-9])',
])
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  // Generic provider load, HTTP status, and server-side transient failures.
  'overloaded',
  'server_busy',
  'servers are currently busy',
  'currently experiencing high demand',
  'model is at capacity',
  'rate.?limit',
  'too many requests',
  // Status codes must not be part of a longer word or number, e.g. a request id or byte count (#11057).
  '(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])',
  // Also matches "The service is temporarily unavailable" (#10965).
  'service.?(?:is.?)?(?:temporarily.?)?unavailable',
  'server.?error',
  'internal.?error',
  // Wrapper/provider text for transient upstream failures, including OpenRouter
  // "Provider returned error" responses (#2264) and gateway wording such as
  // "The upstream provider returned an error" (#10842).
  'provider.?returned.?(?:an.?)?error',
  'exceeded request buffer limit while retrying upstream',
  // Gateway failure relaying the upstream response stream, sent as an OpenAI
  // Responses `response.failed` event without an error code (#10920).
  'unable to forward upstream',
  // Other gateway upstream failures relayed as `response.failed` error codes (#10920).
  'upstream.?request.?failed',
  'upstream_stream_read_error',
  'stream was interrupted',
  'http/?2 stream failed',
  // Network, proxy, and fetch transport failures. This includes OpenAI Codex
  // raw-fetch failures such as "upstream connect", "connection refused", and
  // "reset before headers" (#733), plus OpenRouter connection drops (#3317).
  'network.?error',
  'connection.?error',
  'connection.?refused',
  'connection.?lost',
  // Gateway mid-stream drop relayed as an Anthropic-style `api_error` event,
  // e.g. {"type":"error","error":{"type":"api_error","message":"Connection closed."}} (#12064).
  'connection.?closed',
  'other side closed',
  'fetch failed',
  // node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
  // google-vertex. The reason is often empty (#10996).
  'request to \\S+ failed, reason:',
  'getaddrinfo',
  // Bare Node socket error codes, e.g. "read ECONNRESET", "write EPIPE", or
  // "connect ETIMEDOUT 1.2.3.4:443" when a transport reports only the code (#12128).
  // The codes must not be part of a longer identifier.
  '(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![a-z0-9_])',
  'connection reset by peer',
  'ENOTFOUND',
  'EAI_AGAIN',
  'upstream.?connect',
  'reset before headers',
  'socket hang up',
  'socket connection was closed',
  'timed? out',
  'timeout',
  'terminated',
  // WebSocket transports can report close/error text instead of HTTP/fetch text.
  'websocket.?closed',
  'websocket.?error',
  // Codex 60-minute WebSocket lifetime limit, as code `websocket_connection_limit_reached` or as
  // text "Responses websocket connection limit reached". A retry opens a fresh connection (#12124).
  'websocket.?connection.?limit.?reached',
  // Premature stream endings from SDKs and transports. Anthropic can throw
  // "stream ended without ..." and "Anthropic stream ended before message_stop"
  // (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
  'ended without',
  'stream ended before message_stop',
  'stream ended before a terminal response event',
  'http2 request did not get a response',
  // Codex CLI mid-stream disconnect, relayed by proxies that wrap the Codex CLI,
  // e.g. "stream disconnected before completion: stream closed before response.completed" (#11057).
  'stream disconnected before completion',
  // Magpie gateway relaying a dropped upstream Anthropic stream, e.g.
  // "Claude Code's stream from Anthropic was cut short after the reply had begun" (#11879).
  'cut short after the reply had begun',
  // Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
  // sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
  'pending stream has been canceled',
  // Provider-requested retry delay cap failures should flow through the outer
  // retry policy so callers can surface/abort the backoff (#1123).
  'retry delay',
  // Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
  // stream exceptions (#6019).
  'you can retry your request',
  'try your request again',
  'please retry your request',
  // gRPC based providers (e.g. NVIDIA NIM)
  'ResourceExhausted',
  // Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
  // failures can arrive mid-stream without an HTTP 503 in the message.
  'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_unavailable',
])

export function isRetryableAssistantError(message: {
  stopReason: string
  errorMessage?: string
}) {
  if (message.stopReason !== 'error' || !message.errorMessage) return false
  const errorMessage = message.errorMessage
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))
    return false
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)
}
