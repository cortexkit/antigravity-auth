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
  {
    host: 'opencode1',
    field: 'wire.toolIds',
    cases: [
      'Gemini tool loop',
      'parallel calls',
      'unsigned call',
      'Claude tool reply ending the history: raw',
      'Claude tool reply ending the history: wrapped',
      'tool-result image: image-only',
      'tool-result image: mixed',
      'object tool arguments with a thinking key',
    ],
    package: '@ai-sdk/google',
    version: '3.0.73',
    file: 'src/convert-to-google-generative-ai-messages.ts:132–141,316–322',
    reason:
      'The serialized function calls and legacy responses omit host tool IDs before the fetch interceptor sees them.',
  },
  {
    host: 'opencode1',
    field: 'wire.emptyTextSignature',
    cases: ['empty and whitespace turns: signature-bearing empty part'],
    package: '@ai-sdk/google',
    version: '3.0.73',
    file: 'src/convert-to-google-generative-ai-messages.ts:247–270',
    reason:
      'The SDK omits empty replayed assistant text before serialization, even when it carries a signature.',
  },
  {
    host: 'opencode1',
    field: 'wire.toolResultAttachmentLayout',
    cases: ['tool-result image: image-only', 'tool-result image: mixed'],
    package: '@ai-sdk/google',
    version: '3.0.73',
    file: 'src/google-generative-ai-language-model.ts:164–173; src/convert-to-google-generative-ai-messages.ts:122–158,406–411',
    reason:
      'Antigravity model IDs use legacy serialization, which emits the images as sibling parts and discards their tool-result association.',
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
