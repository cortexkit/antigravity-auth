import { conversation, historySignature, type Turn } from '../cases.ts'

export const imageModel = 'antigravity-gemini-3.1-flash-image'
export const hosts = ['opencode1', 'opencode2', 'pi'] as const

export const retiredChat = conversation('retired image chat', {
  model: imageModel,
})

export const retiredTitle = conversation('retired image title', {
  model: imageModel,
  messages: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'Generate a title for this conversation:\n' },
      ],
    },
    { role: 'user', parts: [{ type: 'text', text: 'What is two plus two?' }] },
  ],
})

const webSearchHistory: Turn[] = [
  { role: 'user', parts: [{ type: 'text', text: 'Look up the weather.' }] },
  {
    role: 'assistant',
    parts: [
      {
        type: 'call',
        id: 'past-search',
        name: 'google_search',
        args: { query: 'the weather' },
        signature: historySignature,
      },
    ],
  },
  {
    role: 'tool',
    parts: [
      {
        type: 'result',
        id: 'past-search',
        name: 'google_search',
        content: [{ type: 'text', text: 'It is sunny.' }],
      },
    ],
  },
  { role: 'user', parts: [{ type: 'text', text: 'What did you find?' }] },
]

export const searchContinuation = (model: string) =>
  conversation('continue a completed search call without a search tool', {
    model,
    messages: webSearchHistory,
  })
