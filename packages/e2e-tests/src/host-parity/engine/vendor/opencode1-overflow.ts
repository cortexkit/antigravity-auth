// OpenCode v1.19.5, packages/opencode/src/provider/error.ts (MIT).
// Tagged source SHA-256: eb04a3e8ec37aa50342a74d4d51b25d671fd30f032b170a0e9be9e0d32c0ddb4
// Its isContextOverflow dependency: packages/llm/src/provider-error.ts (MIT).
// Tagged source SHA-256: 652a9bbfa3fa2f5d1699e4ff20dc3361e7f8d2df1e1bf6dc3d2bbe99601494a8
const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

const exclusions = [
  /^(throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
]

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  (patterns.some((pattern) => pattern.test(message)) ||
    /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message))

// The overflow branch of parseAPICallError(), as applied to Google's JSON response.
export function openCode1IsOverflow(
  message: string,
  statusCode: number,
  body: { error?: { code?: unknown } },
) {
  return (
    isContextOverflow(message) ||
    statusCode === 413 ||
    body?.error?.code === 'context_length_exceeded'
  )
}
