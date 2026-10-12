import { describe, expect, it, mock } from 'bun:test'
import type { Context } from '@earendil-works/pi-ai'
import * as actualPiAi from '@earendil-works/pi-ai'

// Simulate a pre-0.86 pi-ai install that has no transcript helpers. The
// converter must still load and handle flat contexts, and must refuse a
// transcript it cannot replay instead of silently dropping the prompt and tools.
mock.module('@earendil-works/pi-ai', () => ({
  ...actualPiAi,
  getCurrentSystemPrompt: undefined,
  getCurrentTools: undefined,
}))

const { buildGeminiRequest } = await import('./convert.ts')

describe('buildGeminiRequest on a pi-ai runtime without transcript helpers', () => {
  it('converts a flat Context', () => {
    const context: Context = {
      systemPrompt: 'be terse',
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: actualPiAi.Type.Object({
            path: actualPiAi.Type.String(),
          }),
        },
      ],
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    }

    const request = buildGeminiRequest(context)
    expect(request.systemInstruction).toEqual({
      parts: [{ text: 'be terse' }],
    })
    expect(request.tools?.[0]?.functionDeclarations[0]?.name).toBe('read')
  })

  it('rejects a transcript with system messages', () => {
    expect(() =>
      buildGeminiRequest({
        messages: [
          { role: 'system', content: 'base', timestamp: 0 },
          { role: 'user', content: 'hi', timestamp: 1 },
        ],
      }),
    ).toThrow('getCurrentSystemPrompt/getCurrentTools')
  })
})
