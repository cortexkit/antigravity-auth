import { describe, expect, it } from 'bun:test'
import type { Context } from '@earendil-works/pi-ai'

import { buildGeminiRequest } from './convert.ts'

function ctx(partial: Partial<Context>): Context {
  return { messages: [], ...partial }
}

describe('buildGeminiRequest', () => {
  it('converts a string user message into a Gemini user content', () => {
    const request = buildGeminiRequest(
      ctx({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }),
    )
    expect(request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ])
  })

  it('drops empty user messages', () => {
    const request = buildGeminiRequest(
      ctx({ messages: [{ role: 'user', content: '   ', timestamp: 0 }] }),
    )
    expect(request.contents).toEqual([])
  })

  it('converts assistant text and tool calls into a model content', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'thinking out loud' },
              {
                type: 'toolCall',
                id: 'c1',
                name: 'read',
                arguments: { path: 'a.ts' },
              },
            ],
            api: 'google-generative-ai',
            provider: 'google-antigravity',
            model: 'antigravity-gemini-3.5-flash',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'toolUse',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'thinking out loud' },
          { functionCall: { name: 'read', args: { path: 'a.ts' } } },
        ],
      },
    ])
  })

  it('echoes the thoughtSignature on a replayed tool call', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'c1',
                name: 'read',
                arguments: { path: 'a.ts' },
                thoughtSignature: 'SIG123',
              },
            ],
            api: 'google-generative-ai',
            provider: 'google-antigravity',
            model: 'antigravity-gemini-3.5-flash',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'toolUse',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(request.contents[0]?.parts[0]).toEqual({
      functionCall: { name: 'read', args: { path: 'a.ts' } },
      thoughtSignature: 'SIG123',
    })
  })

  it('groups consecutive tool results into a single user turn', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'read',
            content: [{ type: 'text', text: 'file A' }],
            isError: false,
            timestamp: 0,
          },
          {
            role: 'toolResult',
            toolCallId: 'c2',
            toolName: 'grep',
            content: [{ type: 'text', text: 'match' }],
            isError: false,
            timestamp: 0,
          },
        ],
      }),
    )
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'read', response: { output: 'file A' } },
          },
          { functionResponse: { name: 'grep', response: { output: 'match' } } },
        ],
      },
    ])
  })

  it('maps error tool results to an error response', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'boom' }],
            isError: true,
            timestamp: 0,
          },
        ],
      }),
    )
    expect(request.contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'bash', response: { error: 'boom' } },
    })
  })

  it('emits systemInstruction and tool declarations', () => {
    const request = buildGeminiRequest(
      ctx({
        systemPrompt: 'be terse',
        tools: [
          {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            } as never,
          },
        ],
        messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      }),
    )
    expect(request.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] })
    const decl = request.tools?.[0]?.functionDeclarations[0]
    expect(decl?.name).toBe('read')
    // Must match the agy wire format: field name `parameters`, sanitized to
    // Gemini shape with UPPERCASE types (not raw `parametersJsonSchema`).
    expect(decl).not.toHaveProperty('parametersJsonSchema')
    expect(decl?.parameters).toEqual({
      type: 'OBJECT',
      properties: { path: { type: 'STRING' } },
    })
  })

  it('converts image content into inlineData', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', data: 'BASE64', mimeType: 'image/png' },
            ],
            timestamp: 0,
          },
        ],
      }),
    )
    expect(request.contents[0]?.parts).toEqual([
      { text: 'look' },
      { inlineData: { mimeType: 'image/png', data: 'BASE64' } },
    ])
  })
})
