import { describe, expect, it } from 'bun:test'

import {
  AgyRequestSessionStore,
  resolveModelForHeaderStyle,
  SKIP_THOUGHT_SIGNATURE,
} from '@cortexkit/antigravity-auth-core'

import { buildEnvelope } from '../src/plugin.ts'

function scopeForRequest() {
  const sessions = new AgyRequestSessionStore('opencode-v2-request-test')
  return sessions.beginRequest('session')
}

describe('OpenCode 2 Antigravity request envelope', () => {
  it('cleans snake_case tool schemas emitted by OpenCode 2.0', () => {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      tools: [
        {
          function_declarations: [
            {
              name: 'read_file',
              parameters_json_schema: {
                type: 'object',
                properties: {
                  offset: { type: 'integer', exclusiveMinimum: 0 },
                },
                required: ['offset'],
              },
            },
          ],
        },
      ],
    }
    const envelope = buildEnvelope(
      payload,
      resolveModelForHeaderStyle('gemini-3.8-flash', 'antigravity'),
      'test-project',
      scopeForRequest(),
    )
    const tools = envelope.request.tools as Array<{
      functionDeclarations: Array<{
        name: string
        parameters: {
          properties: {
            offset: {
              type: string
              description?: string
              exclusiveMinimum?: number
            }
          }
        }
      }>
    }>
    expect(tools[0]?.functionDeclarations[0]?.name).toBe('read_file')
    expect(
      tools[0]?.functionDeclarations[0]?.parameters.properties.offset.type,
    ).toBe('INTEGER')
    expect(
      tools[0]?.functionDeclarations[0]?.parameters.properties.offset
        .exclusiveMinimum,
    ).toBeUndefined()
    expect(
      tools[0]?.functionDeclarations[0]?.parameters.properties.offset
        .description,
    ).toContain('exclusiveMinimum')
    expect(JSON.stringify(tools)).not.toContain('parameters_json_schema')
    expect(
      payload.tools[0]?.function_declarations[0]?.parameters_json_schema
        .properties.offset.exclusiveMinimum,
    ).toBe(0)
  })

  it('appends a real user turn when the host payload ends with a model turn', () => {
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'Start' }] },
        { role: 'model', parts: [{ text: 'Previous answer' }] },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.7-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('applies the shared Claude thinking and schema transform', () => {
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              text: 'foreign thought',
              thought: true,
              thoughtSignature: 'gemini-signature',
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'claude-sonnet-4-6-thinking',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
    )
    const generationConfig = envelope.request.generationConfig
    expect(generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    expect(generationConfig?.maxOutputTokens).toBe(64_000)
    expect(
      envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature,
    ).toBeUndefined()
    expect(
      (
        envelope.request.toolConfig?.functionCallingConfig as
          | { mode?: string }
          | undefined
      )?.mode,
    ).toBe('VALIDATED')
  })

  it('normalizes replay signatures across parallel function calls', () => {
    const validSignature = 's'.repeat(64)
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'first', args: {} },
              thoughtSignature: validSignature,
            },
            {
              functionCall: { name: 'second', args: {} },
              thoughtSignature: 'other'.repeat(20),
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.8-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-gemini',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.[0]?.parts).toEqual([
      {
        functionCall: { name: 'first', args: {} },
        thoughtSignature: validSignature,
      },
      { functionCall: { name: 'second', args: {} } },
    ])
  })

  it('injects the supported sentinel when Claude replay has no valid signature', () => {
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read_file', args: { path: 'a.ts' } },
              thoughtSignature: 'c'.repeat(64),
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'claude-sonnet-4-6-thinking',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature).toBe(
      SKIP_THOUGHT_SIGNATURE,
    )

    const sameModelEnvelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
      { preserveFunctionCallSignatures: true },
    )
    expect(
      sameModelEnvelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature,
    ).toBe('c'.repeat(64))
  })

  it('uses the native model role for same-target function responses', () => {
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'Read the file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read', args: { path: 'README.md' } },
              thoughtSignature: 's'.repeat(64),
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { output: 'contents' },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.8-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-gemini',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.at(-2)?.role).toBe('model')
    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('removes unsupported tools and thinking from image requests', () => {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Draw a lighthouse' }] }],
      tools: [{ functionDeclarations: [{ name: 'read' }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.1-flash-image',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.tools).toBeUndefined()
    expect(envelope.request.toolConfig).toBeUndefined()
    expect(envelope.request.generationConfig).toMatchObject({
      imageConfig: { aspectRatio: '1:1' },
      candidateCount: 1,
    })
    expect(envelope.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('sets VALIDATED on tool requests and removes host provider options', () => {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Use a tool' }] }],
      providerOptions: { google: { opaque: true } },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.7-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.providerOptions).toBeUndefined()
    expect(envelope.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    })
  })
})
