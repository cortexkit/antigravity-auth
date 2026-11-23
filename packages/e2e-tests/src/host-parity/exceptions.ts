export const exceptions = [
  {
    host: 'opencode1',
    field: 'wire.thinkingLevel',
    cases: ['neon xhigh', 'hydrogen xhigh'],
    package: '@ai-sdk/google',
    version: '3.0.73',
    file: 'src/google-generative-ai-options.ts',
    reason:
      'The public Google option validates four strings and cannot express numeric XHigh.',
  },
  {
    host: 'opencode1',
    field: 'replay.textSignature',
    cases: ['Gemini tool loop', 'Gemini → Claude → Gemini'],
    package: 'ai',
    version: '6.0.168',
    file: 'src/generate-text/stream-text.ts',
    reason:
      'The public stream drops the empty text delta carrying the Gemini text-reply signature.',
  },
] as const

export function excepts(id: string, host: string, field: string) {
  return exceptions.some(
    (rule) =>
      rule.host === host &&
      rule.field === field &&
      rule.cases.some((item) => item === id),
  )
}
