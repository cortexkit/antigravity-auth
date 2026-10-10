import { describe, expect, it } from 'bun:test'
import {
  type Context,
  normalizeContext,
  type SystemMessage,
  type Tool,
  Type,
} from '@earendil-works/pi-ai'

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
            provider: 'google',
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
          { functionCall: { name: 'read', args: { path: 'a.ts' }, id: 'c1' } },
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
            provider: 'google',
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
      functionCall: { name: 'read', args: { path: 'a.ts' }, id: 'c1' },
      thoughtSignature: 'SIG123',
    })
  })

  it('replays same-model thinking and signed text', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'answer', textSignature: 'SIG123' },
            ],
            api: 'google-generative-ai',
            provider: 'google',
            model: 'antigravity-claude-opus-4-6-thinking',
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
            stopReason: 'stop',
            timestamp: 0,
          },
        ],
      }),
      {
        provider: 'google',
        model: 'antigravity-claude-opus-4-6-thinking',
      },
    )

    expect(request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'reasoning', thought: true },
          { text: 'answer', thoughtSignature: 'SIG123' },
        ],
      },
    ])
  })

  it('strips foreign thinking and signatures and uses user-role tool results', () => {
    const request = buildGeminiRequest(
      ctx({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'claude reasoning' },
              { type: 'text', text: 'before tool', textSignature: 'TEXT_SIG' },
              {
                type: 'toolCall',
                id: 'c1',
                name: 'read',
                arguments: { path: 'a.ts' },
                thoughtSignature: 'TOOL_SIG',
              },
            ],
            api: 'google-generative-ai',
            provider: 'google',
            model: 'antigravity-claude-opus-4-6-thinking',
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
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'read',
            content: [{ type: 'text', text: 'file A' }],
            isError: false,
            timestamp: 1,
          },
        ],
      }),
      {
        provider: 'google',
        model: 'antigravity-gemini-3.6-flash',
      },
    )

    expect(request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'before tool' },
          { functionCall: { name: 'read', args: { path: 'a.ts' }, id: 'c1' } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read',
              response: { output: 'file A' },
              id: 'c1',
            },
          },
        ],
      },
    ])
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
            functionResponse: {
              name: 'read',
              response: { output: 'file A' },
              id: 'c1',
            },
          },
          {
            functionResponse: {
              name: 'grep',
              response: { output: 'match' },
              id: 'c2',
            },
          },
        ],
      },
    ])
  })

  it('preserves matching IDs across parallel tool calls and results', () => {
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
              },
              {
                type: 'toolCall',
                id: 'c2',
                name: 'grep',
                arguments: { pattern: 'TODO' },
              },
            ],
            api: 'google-generative-ai',
            provider: 'google',
            model: 'antigravity-claude-opus-4-6-thinking',
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
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'read',
            content: [{ type: 'text', text: 'file A' }],
            isError: false,
            timestamp: 1,
          },
          {
            role: 'toolResult',
            toolCallId: 'c2',
            toolName: 'grep',
            content: [{ type: 'text', text: 'match' }],
            isError: false,
            timestamp: 1,
          },
        ],
      }),
    )

    expect(request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read', args: { path: 'a.ts' }, id: 'c1' } },
          {
            functionCall: { name: 'grep', args: { pattern: 'TODO' }, id: 'c2' },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'read',
              response: { output: 'file A' },
              id: 'c1',
            },
          },
          {
            functionResponse: {
              name: 'grep',
              response: { output: 'match' },
              id: 'c2',
            },
          },
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
      functionResponse: { name: 'bash', response: { error: 'boom' }, id: 'c1' },
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

function tool(
  name: string,
  parameters: Tool['parameters'] = Type.Object({ path: Type.String() }),
): Tool {
  return { name, description: `${name} tool`, parameters }
}

function system(fields: Omit<SystemMessage, 'role'>): SystemMessage {
  return { role: 'system', ...fields }
}

function declarationNames(request: ReturnType<typeof buildGeminiRequest>) {
  return request.tools?.[0]?.functionDeclarations.map((decl) => decl.name)
}

describe('buildGeminiRequest with Pi transcript system messages', () => {
  it('joins the leading prompt with later system content and keeps system messages out of contents', () => {
    const request = buildGeminiRequest(
      normalizeContext({
        systemPrompt: 'base prompt',
        messages: [
          { role: 'user', content: 'hi', timestamp: 1 },
          system({ content: 'extra instruction', timestamp: 2 }),
          {
            role: 'system',
            content: [
              { type: 'text', text: 'first block' },
              { type: 'text', text: 'second block' },
            ],
            timestamp: 3,
          },
          { role: 'user', content: 'again', timestamp: 4 },
        ],
      }),
    )

    expect(request.systemInstruction).toEqual({
      parts: [
        {
          text: 'base prompt\n\nextra instruction\n\nfirst block\nsecond block',
        },
      ],
    })
    expect(request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ])
  })

  it('replaces and removes named prompt sections', () => {
    const request = buildGeminiRequest(
      normalizeContext({
        messages: [
          system({
            content: 'base',
            sections: { rules: '<rules>old</rules>', env: '<env>x</env>' },
            timestamp: 0,
          }),
          { role: 'user', content: 'hi', timestamp: 1 },
          system({
            content: '',
            sections: { rules: '<rules>new</rules>', env: null },
            timestamp: 2,
          }),
        ],
      }),
    )

    expect(request.systemInstruction).toEqual({
      parts: [{ text: 'base\n\n<rules>new</rules>' }],
    })
  })

  it('applies tool additions, removals, and redefinitions in order', () => {
    const request = buildGeminiRequest(
      normalizeContext({
        systemPrompt: 'base',
        tools: [tool('read'), tool('write')],
        messages: [
          { role: 'user', content: 'hi', timestamp: 1 },
          system({
            content: '',
            // A changed definition is expressed as a removal plus an addition.
            toolsRemoved: [{ name: 'write' }, { name: 'read' }],
            toolsAdded: [
              tool('read', Type.Object({ file: Type.Number() })),
              tool('grep'),
            ],
            timestamp: 2,
          }),
        ],
      }),
    )

    expect(declarationNames(request)).toEqual(['read', 'grep'])
    expect(request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'OBJECT',
      properties: { file: { type: 'NUMBER' } },
      required: ['file'],
    })
  })

  it('does not revive flat systemPrompt/tools once the transcript removed them', () => {
    const request = buildGeminiRequest({
      systemPrompt: 'stale flat prompt',
      tools: [tool('stale')],
      messages: [
        system({
          content: '',
          sections: { rules: '<rules>r</rules>' },
          toolsAdded: [tool('read')],
          timestamp: 0,
        }),
        { role: 'user', content: 'hi', timestamp: 1 },
        system({
          content: '',
          sections: { rules: null },
          toolsRemoved: [{ name: 'read' }],
          timestamp: 2,
        }),
      ],
    })

    expect(request).not.toHaveProperty('systemInstruction')
    expect(request).not.toHaveProperty('tools')
  })

  it('reads a flat pre-0.86 Context the same as its normalized transcript', () => {
    const flat = ctx({
      systemPrompt: 'be terse',
      tools: [tool('read')],
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    })

    const fromFlat = buildGeminiRequest(flat)
    expect(fromFlat.systemInstruction).toEqual({
      parts: [{ text: 'be terse' }],
    })
    expect(declarationNames(fromFlat)).toEqual(['read'])
    expect(buildGeminiRequest(normalizeContext(flat))).toEqual(fromFlat)
  })
})
