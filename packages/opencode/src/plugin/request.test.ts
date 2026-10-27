import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import opusLow from '../../../../test-fixtures/agy-cli-1.3.3/native-opus-low.json'
import sonnetLow from '../../../../test-fixtures/agy-cli-1.3.3/native-sonnet-low.json'
import schemaDerived from '../../../../test-fixtures/agy-cli-1.3.3/schema-derived-thinking.json'
import { SKIP_THOUGHT_SIGNATURE } from '../constants'
import * as config from './config'
import { DEFAULT_CONFIG } from './config'
import type {
  SignatureStore,
  StreamingCallbacks,
  StreamingOptions,
  ThoughtBuffer,
} from './core/streaming/types'
import {
  closeDebugLog,
  initializeDebug,
  startAntigravityDebugRequest,
} from './debug'
import { generateFingerprint } from './fingerprint'
import {
  __testExports,
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getPluginSessionId,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from './request'
import { transformThinkingParts } from './request-helpers'

const AGY_1_1_13_WIRE_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../../test-fixtures/agy-cli-1.1.13-stream-request.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { envelopeKeys: string[]; requestKeys: string[] }

const {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasToolUseInContents,
  hasSignedThinkingInContents,
  hasToolUseInMessages,
  hasSignedThinkingInMessages,
  MIN_SIGNATURE_LENGTH,
  transformStreamingPayload,
  createStreamingTransformer,
  transformSseLine,
} = __testExports

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>()
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) =>
      store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
  }
}

function createMockThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>()
  return {
    get: (idx: number) => buffer.get(idx),
    set: (idx: number, text: string) => buffer.set(idx, text),
    clear: () => buffer.clear(),
  }
}

const defaultCallbacks: StreamingCallbacks = {}
const defaultOptions: StreamingOptions = {}
const defaultDebugState = { injected: false }

function withKeepThinking<T>(enabled: boolean, fn: () => T): T {
  const keepThinkingSpy = spyOn(config, 'getKeepThinking').mockReturnValue(
    enabled,
  )
  try {
    return fn()
  } finally {
    keepThinkingSpy.mockRestore()
  }
}

describe('request.ts', () => {
  describe('getPluginSessionId', () => {
    it('returns consistent session ID across calls', () => {
      const id1 = getPluginSessionId()
      const id2 = getPluginSessionId()
      expect(id1).toBe(id2)
      expect(id1).toBeTruthy()
    })
  })

  describe('isGenerativeLanguageRequest', () => {
    it('returns true for generativelanguage.googleapis.com URLs', () => {
      expect(
        isGenerativeLanguageRequest(
          'https://generativelanguage.googleapis.com/v1/models',
        ),
      ).toBe(true)
    })

    it('returns false for other URLs', () => {
      expect(
        isGenerativeLanguageRequest('https://api.anthropic.com/v1/messages'),
      ).toBe(false)
    })

    it('requires the canonical HTTPS origin rather than a hostname substring', () => {
      for (const url of [
        'http://generativelanguage.googleapis.com/v1beta/models',
        'https://generativelanguage.googleapis.com:444/v1beta/models',
        'https://generativelanguage.googleapis.com.example.invalid/v1beta/models',
        'https://example.invalid/generativelanguage.googleapis.com/models',
        'https://example.invalid/?host=generativelanguage.googleapis.com',
        'not a URL generativelanguage.googleapis.com',
      ]) {
        expect(isGenerativeLanguageRequest(url)).toBe(false)
      }
      expect(
        isGenerativeLanguageRequest(
          'https://GENERATIVELANGUAGE.GOOGLEAPIS.COM:443/v1beta/models',
        ),
      ).toBe(true)
    })

    it('detects URL and Request inputs (not only strings)', () => {
      // Matching on string-only would let fetch(new Request(...)) / fetch(new URL(...))
      // bypass the interceptor entirely.
      expect(
        isGenerativeLanguageRequest(
          new URL('https://generativelanguage.googleapis.com/v1/models'),
        ),
      ).toBe(true)
      expect(
        isGenerativeLanguageRequest(
          new Request(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent',
          ),
        ),
      ).toBe(true)
    })

    it('returns false for non-API URL and Request inputs', () => {
      expect(
        isGenerativeLanguageRequest(
          new URL('https://api.anthropic.com/v1/messages'),
        ),
      ).toBe(false)
      expect(
        isGenerativeLanguageRequest(new Request('https://example.com')),
      ).toBe(false)
    })
  })

  describe('buildSignatureSessionKey', () => {
    it('builds key from sessionId, model, project, and conversation', () => {
      const key = buildSignatureSessionKey(
        'session-1',
        'claude-3',
        'conv-456',
        'proj-123',
      )
      expect(key).toBe('session-1:claude-3:proj-123:conv-456')
    })

    it('uses defaults for missing optional params', () => {
      expect(
        buildSignatureSessionKey('s1', undefined, undefined, undefined),
      ).toBe('s1:unknown:default:default')
      expect(
        buildSignatureSessionKey('s1', 'model', undefined, undefined),
      ).toBe('s1:model:default:default')
    })

    it('handles empty strings as defaults', () => {
      expect(buildSignatureSessionKey('s1', '', '', '')).toBe(
        's1:unknown:default:default',
      )
    })
  })

  describe('hashConversationSeed', () => {
    it('returns consistent hash for same input', () => {
      const hash1 = hashConversationSeed('test-seed')
      const hash2 = hashConversationSeed('test-seed')
      expect(hash1).toBe(hash2)
    })

    it('returns different hash for different inputs', () => {
      const hash1 = hashConversationSeed('seed-1')
      const hash2 = hashConversationSeed('seed-2')
      expect(hash1).not.toBe(hash2)
    })

    it('handles empty string', () => {
      const hash = hashConversationSeed('')
      expect(hash).toBeTruthy()
    })
  })

  describe('extractTextFromContent', () => {
    it('extracts text from string content', () => {
      expect(extractTextFromContent('hello world')).toBe('hello world')
    })

    it('extracts first text from content array with text blocks', () => {
      const content = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]
      expect(extractTextFromContent(content)).toBe('hello')
    })

    it('returns empty string for non-text blocks', () => {
      const content = [{ type: 'image', source: {} }]
      expect(extractTextFromContent(content)).toBe('')
    })

    it('returns first text block only (not concatenated)', () => {
      const content = [
        { type: 'text', text: 'before' },
        { type: 'image', source: {} },
        { type: 'text', text: 'after' },
      ]
      expect(extractTextFromContent(content)).toBe('before')
    })

    it('returns empty string for null/undefined', () => {
      expect(extractTextFromContent(null)).toBe('')
      expect(extractTextFromContent(undefined)).toBe('')
    })
  })

  describe('extractConversationSeedFromMessages', () => {
    it('extracts seed from first user message', () => {
      const messages = [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response' },
      ]
      const seed = extractConversationSeedFromMessages(messages)
      expect(seed).toContain('first message')
    })

    it('returns empty string when no user messages', () => {
      const messages = [{ role: 'assistant', content: 'response' }]
      expect(extractConversationSeedFromMessages(messages)).toBe('')
    })

    it('handles empty messages array', () => {
      expect(extractConversationSeedFromMessages([])).toBe('')
    })
  })

  describe('extractConversationSeedFromContents', () => {
    it('extracts seed from first user content', () => {
      const contents = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ]
      const seed = extractConversationSeedFromContents(contents)
      expect(seed).toContain('hello')
    })

    it('returns empty string when no user content', () => {
      const contents = [{ role: 'model', parts: [{ text: 'hi' }] }]
      expect(extractConversationSeedFromContents(contents)).toBe('')
    })
  })

  describe('resolveProjectKey', () => {
    it('returns candidate if it is a string', () => {
      expect(resolveProjectKey('my-project')).toBe('my-project')
    })

    it('returns fallback if candidate is not a string', () => {
      expect(resolveProjectKey(null, 'fallback')).toBe('fallback')
      expect(resolveProjectKey(undefined, 'fallback')).toBe('fallback')
      expect(resolveProjectKey({}, 'fallback')).toBe('fallback')
    })

    it('returns undefined if no valid candidate or fallback', () => {
      expect(resolveProjectKey(null)).toBeUndefined()
      expect(resolveProjectKey(undefined)).toBeUndefined()
    })
  })

  describe('isGeminiToolUsePart', () => {
    it('returns true for functionCall parts', () => {
      expect(isGeminiToolUsePart({ functionCall: { name: 'test' } })).toBe(true)
    })

    it('returns false for non-functionCall parts', () => {
      expect(isGeminiToolUsePart({ text: 'hello' })).toBe(false)
      expect(isGeminiToolUsePart({ thought: true })).toBe(false)
    })

    it('returns false for null/undefined', () => {
      expect(isGeminiToolUsePart(null)).toBe(false)
      expect(isGeminiToolUsePart(undefined)).toBe(false)
    })
  })

  describe('isGeminiThinkingPart', () => {
    it('returns true for thought:true parts', () => {
      expect(isGeminiThinkingPart({ thought: true, text: 'thinking...' })).toBe(
        true,
      )
    })

    it('returns false for thought:false parts', () => {
      expect(
        isGeminiThinkingPart({ thought: false, text: 'not thinking' }),
      ).toBe(false)
    })

    it('returns false for parts without thought property', () => {
      expect(isGeminiThinkingPart({ text: 'hello' })).toBe(false)
    })
  })

  describe('ensureThoughtSignature', () => {
    it('adds sentinel signature when no cached signature exists', () => {
      const part = { thought: true, text: 'thinking...' }
      const result = ensureThoughtSignature(part, 'no-cache-session')
      // Now uses sentinel fallback to prevent API rejection
      expect(result.thoughtSignature).toBe('skip_thought_signature_validator')
    })

    it('replaces untrusted thoughtSignature with sentinel', () => {
      const existingSignature = 'a'.repeat(MIN_SIGNATURE_LENGTH + 10)
      const part = {
        thought: true,
        text: 'thinking...',
        thoughtSignature: existingSignature,
      }
      const result = ensureThoughtSignature(part, 'session-key')
      expect(result.thoughtSignature).toBe('skip_thought_signature_validator')
    })

    it('does not modify non-thinking parts', () => {
      const part = { text: 'regular text' }
      const result = ensureThoughtSignature(part, 'session-key')
      expect(result.thoughtSignature).toBeUndefined()
    })

    it('returns null/undefined inputs unchanged', () => {
      expect(ensureThoughtSignature(null, 'key')).toBeNull()
      expect(ensureThoughtSignature(undefined, 'key')).toBeUndefined()
    })

    it('returns non-object inputs unchanged', () => {
      expect(ensureThoughtSignature('string', 'key')).toBe('string')
      expect(ensureThoughtSignature(123, 'key')).toBe(123)
    })
  })

  describe('hasSignedThinkingPart', () => {
    it('returns true for part with valid thoughtSignature', () => {
      const part = {
        thought: true,
        thoughtSignature: 'a'.repeat(MIN_SIGNATURE_LENGTH),
      }
      expect(hasSignedThinkingPart(part)).toBe(true)
    })

    it('returns true for type:thinking with valid signature field', () => {
      const part = {
        type: 'thinking',
        thinking: '...',
        signature: 'a'.repeat(MIN_SIGNATURE_LENGTH),
      }
      expect(hasSignedThinkingPart(part)).toBe(true)
    })

    it('returns true for type:reasoning with valid signature field', () => {
      const part = {
        type: 'reasoning',
        signature: 'a'.repeat(MIN_SIGNATURE_LENGTH),
      }
      expect(hasSignedThinkingPart(part)).toBe(true)
    })

    it('returns false for part with short signature', () => {
      const part = { thought: true, thoughtSignature: 'short' }
      expect(hasSignedThinkingPart(part)).toBe(false)
    })

    it('returns false for part without signature', () => {
      const part = { thought: true, text: 'no signature' }
      expect(hasSignedThinkingPart(part)).toBe(false)
    })
  })

  describe('hasToolUseInContents', () => {
    it('returns true when contents have functionCall', () => {
      const contents = [
        { role: 'model', parts: [{ functionCall: { name: 'test' } }] },
      ]
      expect(hasToolUseInContents(contents)).toBe(true)
    })

    it('returns false when no functionCall present', () => {
      const contents = [{ role: 'model', parts: [{ text: 'hello' }] }]
      expect(hasToolUseInContents(contents)).toBe(false)
    })

    it('handles empty contents', () => {
      expect(hasToolUseInContents([])).toBe(false)
    })
  })

  describe('hasSignedThinkingInContents', () => {
    it('returns true when contents have signed thinking', () => {
      const contents = [
        {
          role: 'model',
          parts: [
            {
              thought: true,
              thoughtSignature: 'a'.repeat(MIN_SIGNATURE_LENGTH),
            },
          ],
        },
      ]
      expect(hasSignedThinkingInContents(contents)).toBe(true)
    })

    it('returns false when no signed thinking present', () => {
      const contents = [
        { role: 'model', parts: [{ thought: true, text: 'unsigned' }] },
      ]
      expect(hasSignedThinkingInContents(contents)).toBe(false)
    })
  })

  describe('hasToolUseInMessages', () => {
    it('returns true when messages have tool_use blocks', () => {
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '123', name: 'test' }],
        },
      ]
      expect(hasToolUseInMessages(messages)).toBe(true)
    })

    it('returns false when no tool_use blocks', () => {
      const messages = [
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ]
      expect(hasToolUseInMessages(messages)).toBe(false)
    })

    it('handles string content', () => {
      const messages = [{ role: 'assistant', content: 'just text' }]
      expect(hasToolUseInMessages(messages)).toBe(false)
    })
  })

  describe('hasSignedThinkingInMessages', () => {
    it('returns true when messages have signed thinking blocks', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '...',
              signature: 'a'.repeat(MIN_SIGNATURE_LENGTH),
            },
          ],
        },
      ]
      expect(hasSignedThinkingInMessages(messages)).toBe(true)
    })

    it('returns false when thinking blocks are unsigned', () => {
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'no sig' }],
        },
      ]
      expect(hasSignedThinkingInMessages(messages)).toBe(false)
    })
  })

  describe('MIN_SIGNATURE_LENGTH', () => {
    it('is 50', () => {
      expect(MIN_SIGNATURE_LENGTH).toBe(50)
    })
  })

  describe('transformSseLine', () => {
    const callTransformSseLine = (
      line: string,
      callbacks: StreamingCallbacks = defaultCallbacks,
    ) => {
      const store = createMockSignatureStore()
      const buffer = createMockThoughtBuffer()
      const sentBuffer = createMockThoughtBuffer()
      return transformSseLine(
        line,
        store,
        buffer,
        sentBuffer,
        callbacks,
        defaultOptions,
        { ...defaultDebugState },
      )
    }

    it('returns empty lines unchanged', () => {
      expect(callTransformSseLine('')).toBe('')
      expect(callTransformSseLine('   ')).toBe('   ')
    })

    it('returns non-data lines unchanged', () => {
      expect(callTransformSseLine('event: message')).toBe('event: message')
      expect(callTransformSseLine(': heartbeat')).toBe(': heartbeat')
    })

    it('handles data: [DONE] unchanged', () => {
      expect(callTransformSseLine('data: [DONE]')).toBe('data: [DONE]')
    })

    it('handles invalid JSON gracefully', () => {
      expect(callTransformSseLine('data: not-json')).toBe('data: not-json')
      expect(callTransformSseLine('data: {invalid}')).toBe('data: {invalid}')
    })

    it('passes through valid JSON without thinking parts', () => {
      const payload = {
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      }
      const line = `data: ${JSON.stringify(payload)}`
      const result = callTransformSseLine(line)
      expect(result).toContain('data:')
      expect(result).toContain('hello')
    })

    it('transforms thinking parts in streaming data', () => {
      const payload = {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'reasoning...' },
                { text: 'answer' },
              ],
            },
          },
        ],
      }
      const line = `data: ${JSON.stringify({ response: payload })}`
      const result = callTransformSseLine(line, { transformThinkingParts })
      expect(JSON.parse(result.slice(5))).toEqual({
        candidates: [
          {
            content: {
              parts: [
                { type: 'reasoning', thought: true, text: 'reasoning...' },
                { text: 'answer' },
              ],
            },
            reasoning_content: 'reasoning...',
          },
        ],
      })
    })

    it('does not leak placeholder text into duplicate Claude thinking output', () => {
      const store = createMockSignatureStore()
      const buffer = createMockThoughtBuffer()
      const sentBuffer = createMockThoughtBuffer()
      const displayedThinkingHashes = new Set<string>()

      const line = `data: ${JSON.stringify({
        response: {
          content: [
            {
              type: 'thinking',
              thinking: 'The user wants OK',
              text: 'The user wants OK',
            },
            { type: 'text', text: 'OK' },
          ],
        },
      })}`

      const first = transformSseLine(
        line,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        { ...defaultOptions, displayedThinkingHashes },
        { ...defaultDebugState },
      )
      expect(first).toContain('"text":"OK"')

      const second = transformSseLine(
        line,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        { ...defaultOptions, displayedThinkingHashes },
        { ...defaultDebugState },
      )
      expect(second).not.toContain('"text":"."')
      expect(second).toContain('"text":"OK"')
    })

    it('omits empty duplicate Claude thinking chunks instead of creating blank text', () => {
      const store = createMockSignatureStore()
      const buffer = createMockThoughtBuffer()
      const sentBuffer = createMockThoughtBuffer()

      const firstLine = `data: ${JSON.stringify({
        response: {
          content: [
            {
              type: 'thinking',
              thinking: 'Only hidden thinking so far',
              text: 'Only hidden thinking so far',
            },
          ],
        },
      })}`

      transformSseLine(
        firstLine,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        defaultOptions,
        { ...defaultDebugState },
      )

      const duplicateLine = `data: ${JSON.stringify({
        response: {
          content: [
            {
              type: 'thinking',
              thinking: 'Only hidden thinking so far',
              text: 'Only hidden thinking so far',
            },
          ],
        },
      })}`

      const duplicate = transformSseLine(
        duplicateLine,
        store,
        buffer,
        sentBuffer,
        defaultCallbacks,
        defaultOptions,
        { ...defaultDebugState },
      )

      expect(duplicate).not.toContain('"type":"text","text":""')
      expect(duplicate).toContain('"content":[]')
    })
  })

  describe('transformStreamingPayload', () => {
    it('handles empty string', () => {
      expect(transformStreamingPayload('')).toBe('')
    })

    it('handles single line without data prefix', () => {
      expect(transformStreamingPayload('event: ping')).toBe('event: ping')
    })

    it('handles multiple lines', () => {
      const input = 'event: message\ndata: [DONE]\n'
      const result = transformStreamingPayload(input)
      expect(result).toContain('event: message')
      expect(result).toContain('data: [DONE]')
    })

    it('preserves line structure', () => {
      const input = 'line1\nline2\nline3'
      const result = transformStreamingPayload(input)
      const lines = result.split('\n')
      expect(lines.length).toBe(3)
    })
  })

  describe('createStreamingTransformer', () => {
    it('returns a TransformStream', () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      expect(transformer).toBeInstanceOf(TransformStream)
      expect(transformer.readable).toBeDefined()
      expect(transformer.writable).toBeDefined()
    })

    it('accepts optional signatureSessionKey', () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        signatureSessionKey: 'session-key',
      })
      expect(transformer).toBeInstanceOf(TransformStream)
    })

    it('accepts optional debugText', () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        signatureSessionKey: 'session-key',
        debugText: 'debug info',
      })
      expect(transformer).toBeInstanceOf(TransformStream)
    })

    it('accepts cacheSignatures flag', () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        signatureSessionKey: 'session-key',
        cacheSignatures: true,
      })
      expect(transformer).toBeInstanceOf(TransformStream)
    })

    it('processes chunks through the stream', async () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()

      const input = encoder.encode('data: [DONE]\n')
      const outputChunks: Uint8Array[] = []

      const writer = transformer.writable.getWriter()
      const reader = transformer.readable.getReader()

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) outputChunks.push(value)
        }
      })()

      await writer.write(input)
      await writer.close()
      await readPromise

      const output = outputChunks.map((chunk) => decoder.decode(chunk)).join('')
      expect(output).toContain('[DONE]')
    })

    it('terminates a finished stream even if the upstream body stays open', async () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const terminalToolCall = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'read',
                      args: { filePath: 'README.md' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      }

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(terminalToolCall)}\n`),
          )
        },
      })
      const reader = source.pipeThrough(transformer).getReader()
      let output = ''
      let done = false

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('stream did not terminate')),
              100,
            ),
          ),
        ])
        if (result.done) {
          done = true
          break
        }
        output += decoder.decode(result.value)
      }

      expect(done).toBe(true)
      expect(output).toContain('functionCall')
      expect(output).toContain('usageMetadata')
      expect(output.endsWith('\n\n')).toBe(true)
    })

    it('merges terminal cached usage into buffered Gemini tool-call events', async () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const toolCall = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'bash',
                      args: { command: 'printf cache' },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 41880,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 45,
            totalTokenCount: 41950,
          },
        },
      }
      const terminalStop = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: '' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 41880,
            cachedContentTokenCount: 40682,
            candidatesTokenCount: 25,
            thoughtsTokenCount: 45,
            totalTokenCount: 41950,
          },
        },
      }

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(toolCall)}\n\n`),
          )
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(terminalStop)}\n`),
          )
        },
      })
      const reader = source.pipeThrough(transformer).getReader()
      let output = ''
      let done = false

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('stream did not terminate')),
              100,
            ),
          ),
        ])
        if (result.done) {
          done = true
          break
        }
        output += decoder.decode(result.value)
      }

      expect(done).toBe(true)
      const dataLines = output
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))

      expect(
        dataLines[0].candidates[0].content.parts[0].functionCall.name,
      ).toBe('bash')
      expect(dataLines[0].usageMetadata.cachedContentTokenCount).toBe(40682)
      expect(dataLines[1].candidates[0].finishReason).toBe('STOP')
      expect(output.endsWith('\n\n')).toBe(true)
    })

    it('merges terminal cached usage into a short final text event', async () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const textEvent = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'CACHE_MERGE_TOOL_OK' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 41924,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 31,
            totalTokenCount: 41967,
          },
        },
      }
      const terminalStop = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: '' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 41975,
            cachedContentTokenCount: 40673,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 31,
            totalTokenCount: 42018,
          },
        },
      }

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(textEvent)}\n\n`),
          )
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(terminalStop)}\n`),
          )
        },
      })
      const reader = source.pipeThrough(transformer).getReader()
      let output = ''
      let done = false

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('stream did not terminate')),
              100,
            ),
          ),
        ])
        if (result.done) {
          done = true
          break
        }
        output += decoder.decode(result.value)
      }

      expect(done).toBe(true)
      const dataLines = output
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))

      expect(dataLines[0].candidates[0].content.parts[0].text).toBe(
        'CACHE_MERGE_TOOL_OK',
      )
      expect(dataLines[0].usageMetadata.cachedContentTokenCount).toBe(40673)
      expect(dataLines[1].candidates[0].finishReason).toBe('STOP')
      expect(output.endsWith('\n\n')).toBe(true)
    })

    it('terminates a finished empty-text stream even when there is no tool call', async () => {
      const store = createMockSignatureStore()
      const transformer = createStreamingTransformer(store, defaultCallbacks)
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const terminalEmptyText = {
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: '' }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      }

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(terminalEmptyText)}\n`),
          )
        },
      })
      const reader = source.pipeThrough(transformer).getReader()
      let output = ''
      let done = false

      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('stream did not terminate')),
              100,
            ),
          ),
        ])
        if (result.done) {
          done = true
          break
        }
        output += decoder.decode(result.value)
      }

      expect(done).toBe(true)
      expect(output).toContain('finishReason')
      expect(output).toContain('usageMetadata')
      expect(output.endsWith('\n\n')).toBe(true)
    })
  })

  describe('prepareAntigravityRequest', () => {
    const mockAccessToken = 'test-token'
    const mockProjectId = 'test-project'

    it('prepares both captured Claude low configurations through host variants and current persisted headers', () => {
      for (const fixture of [opusLow, sonnetLow]) {
        const fingerprint = generateFingerprint()
        fingerprint.userAgent = 'antigravity/cli/1.1.24 (historical account)'
        const previous = structuredClone(fingerprint)
        const selector = `antigravity-${fixture.model.replace(/-low$/, '')}`
        const result = prepareAntigravityRequest(
          `https://generativelanguage.googleapis.com/v1beta/models/${selector}:streamGenerateContent`,
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'test' }] }],
              providerOptions: { google: { thinkingLevel: 'low' } },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          false,
          { fingerprint },
        )
        const body = JSON.parse(String(result.init.body))
        expect(body.model).toBe(fixture.model)
        expect(body.request.generationConfig).toEqual(
          fixture.native_generation_config,
        )
        expect(body.request.labels.model_enum).toBe(fixture.native_model_enum)
        expect(Object.keys(body)).toEqual(fixture.envelope_keys)
        expect(body.request.providerOptions).toBeUndefined()
        expect(new Headers(result.init.headers).get('User-Agent')).toMatch(
          /^antigravity\/cli\/1\.3\.5 .*cl=998863838;/,
        )
        expect(fingerprint).toEqual(previous)
      }
    })

    it('preserves explicit Claude output caps in plain and wrapped requests', () => {
      for (const fixture of [opusLow, sonnetLow]) {
        for (const cap of [1, 2048]) {
          for (const wrapped of [false, true]) {
            for (const key of ['maxOutputTokens', 'max_output_tokens']) {
              const request = {
                contents: [{ role: 'user', parts: [{ text: 'test' }] }],
                generationConfig: { [key]: cap },
              }
              const result = prepareAntigravityRequest(
                `https://generativelanguage.googleapis.com/v1beta/models/antigravity-${fixture.model}:generateContent`,
                {
                  method: 'POST',
                  body: JSON.stringify(
                    wrapped ? { project: mockProjectId, request } : request,
                  ),
                },
                mockAccessToken,
                mockProjectId,
              )
              const body = JSON.parse(String(result.init.body))
              expect(body.request.generationConfig).toEqual({
                ...fixture.native_generation_config,
                maxOutputTokens: cap,
              })
            }
          }
        }
      }
    })

    it('routes Claude host medium/high variants with schema-derived thinking', () => {
      for (const family of ['opus', 'sonnet']) {
        for (const effort of ['medium', 'high'] as const) {
          const result = prepareAntigravityRequest(
            `https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-${family}-5-5:generateContent`,
            {
              method: 'POST',
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'test' }] }],
                providerOptions: { google: { thinkingLevel: effort } },
              }),
            },
            mockAccessToken,
            mockProjectId,
          )
          const body = JSON.parse(String(result.init.body))
          expect(body.model).toBe(`claude-${family}-5-5-${effort}`)
          expect(body.request.generationConfig).toEqual({
            maxOutputTokens: 128000,
            thinkingConfig: schemaDerived[effort],
          })
          expect(body.request.labels.model_enum).toBe(
            `MODEL_PLACEHOLDER_M${family === 'opus' ? (effort === 'medium' ? 401 : 402) : effort === 'medium' ? 404 : 405}`,
          )
        }
      }
    })

    it('returns unchanged request for non-generative-language URLs', () => {
      const result = prepareAntigravityRequest(
        'https://example.com/api',
        { method: 'POST' },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
      expect(result.request).toBe('https://example.com/api')
    })

    it('returns unchanged request for URLs without model pattern', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1/models',
        { method: 'POST' },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('uses the stable default project id when none is provided (no per-request random)', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:streamGenerateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        '', // empty projectId — must fall back to the stable default, not a random id
      )
      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.project).toBe('rising-fact-p41fc')
    })

    it('detects streaming from generateStreamContent action', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(true)
    })

    it('detects non-streaming from generateContent action', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('sets Authorization header with Bearer token', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      const headers = result.init.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer test-token')
    })

    it('removes x-api-key header', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({ contents: [] }),
          headers: { 'x-api-key': 'old-key' },
        },
        mockAccessToken,
        mockProjectId,
      )
      const headers = result.init.headers as Headers
      expect(headers.get('x-api-key')).toBeNull()
    })

    it('uses session-scoped AGY metadata and strips internal OpenCode session headers', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash-high:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'prompt' }] },
              {
                role: 'model',
                parts: [
                  { text: 'thinking', thought: true },
                  { functionCall: { name: 'read', args: {} } },
                ],
              },
              {
                role: 'user',
                parts: [{ functionResponse: { name: 'read', response: {} } }],
              },
            ],
          }),
          headers: {
            'x-session-affinity': 'session-child',
            'X-Session-Id': 'session-child',
            'x-parent-session-id': 'session-parent',
            'x-opencode-session-id': 'session-child',
            'x-opencode-parent-session-id': 'session-parent',
          },
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        false,
        {
          agySession: {
            conversationId: 'conversation-id',
            trajectoryId: 'trajectory-id',
            numericSessionId: '-3750763034362895579',
          },
          agyRequestTimestamp: 1_784_285_195_116,
        },
      )

      const headers = result.init.headers as Headers
      expect(headers.get('x-session-affinity')).toBeNull()
      expect(headers.get('x-session-id')).toBeNull()
      expect(headers.get('x-parent-session-id')).toBeNull()
      expect(headers.get('x-opencode-session-id')).toBeNull()
      expect(headers.get('x-opencode-parent-session-id')).toBeNull()

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.requestId).toBe(
        'agent/conversation-id/1784285195116/trajectory-id/5',
      )
      expect(wrapped.request.sessionId).toBe('-3750763034362895579')
      expect(wrapped.request.labels).toEqual({
        last_step_index: '4',
        model_enum: 'MODEL_PLACEHOLDER_M84',
        trajectory_id: 'trajectory-id',
        used_claude: 'false',
        used_claude_conservative: 'false',
        used_non_gemini_model: 'false',
      })
      expect(result.sessionId).not.toBe(wrapped.request.sessionId)
    })

    it('removes x-goog-user-project header for antigravity headerStyle', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({ contents: [] }),
          headers: { 'x-goog-user-project': 'my-project' },
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )
      const headers = result.init.headers as Headers
      expect(headers.get('x-goog-user-project')).toBeNull()
    })

    it('orders antigravity envelope and request fields like captured agy CLI', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            systemInstruction: { parts: [{ text: 'system' }] },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'read',
                    description: 'Read a file',
                    parameters: {
                      type: 'object',
                      properties: { path: { type: 'string' } },
                      required: ['path'],
                    },
                  },
                ],
              },
            ],
            generationConfig: { temperature: 0 },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const body = result.init.body as string
      const parsed = JSON.parse(body)
      expect(Object.keys(parsed)).toEqual(AGY_1_1_13_WIRE_FIXTURE.envelopeKeys)
      expect(Object.keys(parsed.request)).toEqual(
        AGY_1_1_13_WIRE_FIXTURE.requestKeys,
      )
      expect(parsed.requestId).toMatch(/^agent\/.+\/2$/)
      expect(parsed.userAgent).toBe('antigravity')
      expect(parsed.requestType).toBe('agent')
    })

    it('identifies Claude models correctly', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-20250514:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.effectiveModel).toContain('claude')
    })

    it('identifies Gemini models correctly', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.effectiveModel).toContain('gemini')
    })

    it('uses custom endpoint override', () => {
      const customEndpoint = 'https://custom.api.com'
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        customEndpoint,
      )
      expect(result.endpoint).toContain(customEndpoint)
    })

    it('handles wrapped Antigravity body format', () => {
      const wrappedBody = {
        project: 'my-project',
        request: { contents: [{ parts: [{ text: 'Hello' }] }] },
      }
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('handles unwrapped body format', () => {
      const unwrappedBody = {
        contents: [{ parts: [{ text: 'Hello' }] }],
      }
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('does not add Claude auto-caching to wrapped request by default', () => {
      const wrappedBody = {
        project: 'my-project',
        request: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
          ],
        },
      }
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent',
        { method: 'POST', body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.cache_control).toBeUndefined()
    })

    it('does not add Claude auto-caching to unwrapped request by default', () => {
      const unwrappedBody = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
      }
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent',
        { method: 'POST', body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.cache_control).toBeUndefined()
    })

    it('normalizes whitespace-only Claude text blocks before sending', () => {
      const unwrappedBody = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: '   \n\t  ' }] },
        ],
      }

      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
        { method: 'POST', body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.messages[0].content[0]).toEqual({
        type: 'text',
        text: '.',
      })
    })

    it('does not inject Claude auto-caching markers on the Antigravity proxy even when enabled', () => {
      const unwrappedBody = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
      }
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent',
        { method: 'POST', body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
        undefined,
        false,
        { claudePromptAutoCaching: true },
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.cache_control).toBeUndefined()
      expect(
        wrapped.request.messages[0].content[0].cache_control,
      ).toBeUndefined()
    })

    it('strips host-only cache fields and configures VALIDATED tool calls on the agy path', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            providerOptions: { google: { thinkingLevel: 'high' } },
            cached_content: 'top-snake',
            cachedContent: 'top-camel',
            extra_body: {
              cached_content: 'extra-snake',
              cachedContent: 'extra-camel',
              keep: 'preserved',
            },
            systemInstruction: {
              parts: [{ text: 'system', cacheControl: { type: 'ephemeral' } }],
            },
            contents: [
              {
                role: 'user',
                parts: [
                  { text: 'hello', cache_control: { type: 'ephemeral' } },
                ],
              },
              {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'lookup',
                      args: { cacheControl: 'tool-data' },
                    },
                  },
                ],
              },
            ],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'lookup',
                    description: 'Look something up',
                    parameters: {
                      type: 'object',
                      properties: { query: { type: 'string' } },
                      required: ['query'],
                    },
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      const request = wrapped.request
      expect(result.effectiveModel).toBe('gemini-3-flash-agent')
      expect(request.providerOptions).toBeUndefined()
      expect(request.cached_content).toBeUndefined()
      expect(request.cachedContent).toBeUndefined()
      expect(request.extra_body).toEqual({ keep: 'preserved' })
      expect(request.systemInstruction.parts[0].cacheControl).toBeUndefined()
      expect(request.contents[0].parts[0].cache_control).toBeUndefined()
      expect(request.contents[1].parts[0].functionCall.args.cacheControl).toBe(
        'tool-data',
      )
      expect(request.toolConfig).toEqual({
        functionCallingConfig: { mode: 'VALIDATED' },
      })
    })

    it.each([
      [
        'antigravity-gemini-3.6-flash',
        'gemini-3.6-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M72',
      ],
      [
        'antigravity-gemini-3.6-flash-low',
        'gemini-3.6-flash-low',
        1000,
        'MODEL_PLACEHOLDER_M73',
      ],
      [
        'antigravity-gemini-3.6-flash-medium',
        'gemini-3.6-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M72',
      ],
      [
        'antigravity-gemini-3.6-flash-high',
        'gemini-3.6-flash-high',
        -1,
        'MODEL_PLACEHOLDER_M71',
      ],
    ])('uses current catalog thinking with the historical Gemini 3.6 enum and caller cap for %s', (requestedModel, wireModel, thinkingBudget, modelEnum) => {
      const result = prepareAntigravityRequest(
        `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent`,
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'Reply with AGY36_OK' }] },
            ],
            generationConfig: { maxOutputTokens: 1024 },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe(wireModel)
      expect(wrapped.model).toBe(wireModel)
      expect(wrapped.request.generationConfig).toMatchObject({
        maxOutputTokens: 1024,
        thinkingConfig: { includeThoughts: true, thinkingBudget },
      })
      expect(
        wrapped.request.generationConfig.thinkingConfig,
      ).not.toHaveProperty('thinkingLevel')
      expect(wrapped.request.labels.model_enum).toBe(modelEnum)
    })

    it.each([
      [
        'antigravity-gemini-3.7-flash',
        'gemini-3.7-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M299',
      ],
      [
        'antigravity-gemini-3.7-flash-low',
        'gemini-3.7-flash-low',
        1000,
        'MODEL_PLACEHOLDER_M300',
      ],
      [
        'antigravity-gemini-3.7-flash-medium',
        'gemini-3.7-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M299',
      ],
      [
        'antigravity-gemini-3.7-flash-high',
        'gemini-3.7-flash-high',
        -1,
        'MODEL_PLACEHOLDER_M298',
      ],
    ])('preserves the captured Gemini 3.7 enum and caller cap for %s', (requestedModel, wireModel, thinkingBudget, modelEnum) => {
      const result = prepareAntigravityRequest(
        `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent`,
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'Reply with AGY37_OK' }] },
            ],
            generationConfig: { maxOutputTokens: 1024 },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe(wireModel)
      expect(wrapped.model).toBe(wireModel)
      expect(wrapped.request.generationConfig).toMatchObject({
        maxOutputTokens: 1024,
        thinkingConfig: { includeThoughts: true, thinkingBudget },
      })
      expect(
        wrapped.request.generationConfig.thinkingConfig,
      ).not.toHaveProperty('thinkingLevel')
      expect(wrapped.request.labels.model_enum).toBe(modelEnum)
    })

    it.each([
      [
        'antigravity-gemini-3.8-flash',
        'gemini-3.8-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M319',
      ],
      [
        'antigravity-gemini-3.8-flash-low',
        'gemini-3.8-flash-low',
        1000,
        'MODEL_PLACEHOLDER_M320',
      ],
      [
        'antigravity-gemini-3.8-flash-medium',
        'gemini-3.8-flash-medium',
        4000,
        'MODEL_PLACEHOLDER_M319',
      ],
      [
        'antigravity-gemini-3.8-flash-high',
        'gemini-3.8-flash-high',
        -1,
        'MODEL_PLACEHOLDER_M318',
      ],
    ])('preserves the captured Gemini 3.8 enum and caller cap for %s', (requestedModel, wireModel, thinkingBudget, modelEnum) => {
      const result = prepareAntigravityRequest(
        `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent`,
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'Reply with AGY38_OK' }] },
            ],
            generationConfig: { maxOutputTokens: 1024 },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe(wireModel)
      expect(wrapped.model).toBe(wireModel)
      expect(wrapped.request.generationConfig).toMatchObject({
        maxOutputTokens: 1024,
        thinkingConfig: { includeThoughts: true, thinkingBudget },
      })
      expect(
        wrapped.request.generationConfig.thinkingConfig,
      ).not.toHaveProperty('thinkingLevel')
      expect(wrapped.request.labels.model_enum).toBe(modelEnum)
    })

    it('appends a user continuation when a Gemini AGY request ends with a model turn', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.6-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'Summarize this context' }] },
              { role: 'model', parts: [{ text: 'Summary complete' }] },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.contents).toEqual([
        { role: 'user', parts: [{ text: 'Summarize this context' }] },
        { role: 'model', parts: [{ text: 'Summary complete' }] },
        { role: 'user', parts: [{ text: '[Continue]' }] },
      ])
    })

    it('preserves uppercase Gemini schemas for properties named thinking', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.6-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Search' }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'google_search',
                    parameters: {
                      type: 'object',
                      properties: {
                        query: { type: 'string' },
                        thinking: { type: 'string' },
                      },
                      required: ['query'],
                    },
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(
        wrapped.request.tools[0].functionDeclarations[0].parameters.properties
          .thinking,
      ).toEqual({
        type: 'STRING',
      })
    })

    it('builds the live Gemini 3.1 Flash Image request shape', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-flash-image:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: 'Generate a blue circle' }] },
            ],
            generationConfig: {
              thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
            },
            tools: [
              {
                functionDeclarations: [
                  { name: 'read', parameters: { type: 'OBJECT' } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe('gemini-3.1-flash-image')
      expect(wrapped.request.generationConfig).toMatchObject({
        candidateCount: 1,
        imageConfig: { aspectRatio: '1:1' },
      })
      expect(wrapped.request.generationConfig.thinkingConfig).toBeUndefined()
      expect(wrapped.request.tools).toBeUndefined()
      expect(wrapped.request.toolConfig).toBeUndefined()
      expect(wrapped.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M21')
    })

    it('routes OpenCode title generation away from the image model', () => {
      const input =
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-flash-image:streamGenerateContent'
      const init = {
        method: 'POST',
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Generate a title for this conversation:\n' }],
            },
            { role: 'user', parts: [{ text: '"Generate a red triangle"' }] },
          ],
        }),
      }
      expect(getImageModelLocalTitle(input, init)).toBe(
        'Generate a red triangle',
      )
      expect(
        getImageModelLocalTitle(input, {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Generate image' }] }],
          }),
        }),
      ).toBeUndefined()

      const result = prepareAntigravityRequest(
        input,
        init,
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe('gemini-3.5-flash-low')
      expect(wrapped.model).toBe('gemini-3.5-flash-low')
      expect(wrapped.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M20')
      expect(wrapped.request.generationConfig?.imageConfig).toBeUndefined()
    })

    it('builds the captured GPT-OSS medium generation config', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gpt-oss-120b-medium:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply GPT_OK' }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'prompt_tool',
                    parameters: {
                      type: 'object',
                      properties: {
                        prompt: { type: 'string', minLength: '1' },
                      },
                      required: ['prompt'],
                    },
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(result.effectiveModel).toBe('gpt-oss-120b-medium')
      expect(wrapped.request.generationConfig).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
        maxOutputTokens: 32768,
      })
      expect(wrapped.request.labels).toMatchObject({
        model_enum: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
        used_non_gemini_model: 'true',
      })
      expect(
        wrapped.request.tools[0].functionDeclarations[0].parameters,
      ).toEqual({
        type: 'OBJECT',
        properties: { prompt: { type: 'STRING', description: 'minLength: 1' } },
        required: ['prompt'],
      })
    })

    it('omits toolConfig for every Argon route and grouped selector but keeps VALIDATED for other Gemini', () => {
      for (const [model, effort] of [
        ['gemini-4-argon-low', 'LOW'],
        ['gemini-4-argon-medium', 'MEDIUM'],
        ['gemini-4-argon-high', 'HIGH'],
        ['antigravity-gemini-4-argon', 'MEDIUM'],
        ['gemini-3.8-flash-low', undefined],
      ] as const) {
        for (const wrapped of [false, true]) {
          const request = {
            contents: [{ role: 'user', parts: [{ text: 'Use read' }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'read',
                    parameters: { type: 'OBJECT', properties: {} },
                  },
                ],
              },
            ],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          }
          const result = prepareAntigravityRequest(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: 'POST',
              body: JSON.stringify(
                wrapped ? { project: mockProjectId, model, request } : request,
              ),
            },
            mockAccessToken,
            mockProjectId,
            undefined,
          )
          const body = JSON.parse(result.init.body as string)
          if (effort) {
            expect(body.request).not.toHaveProperty('toolConfig')
            expect(body.request.generationConfig).toEqual({
              maxOutputTokens: 65536,
              thinkingConfig: { includeThoughts: true, thinkingLevel: effort },
            })
          } else {
            expect(body.request.toolConfig).toEqual({
              functionCallingConfig: { mode: 'VALIDATED' },
            })
          }
        }
      }
    })

    it('sanitizes already-wrapped agy requests and preserves existing tool config fields', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            project: mockProjectId,
            request: {
              providerOptions: { google: { thinkingLevel: 'medium' } },
              cachedContent: 'cached-resource',
              contents: [
                {
                  role: 'user',
                  parts: [{ text: 'hi', cacheControl: { type: 'ephemeral' } }],
                },
              ],
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'read',
                      parameters: { type: 'OBJECT', properties: {} },
                    },
                  ],
                },
              ],
              toolConfig: {
                functionCallingConfig: { allowedFunctionNames: ['read'] },
              },
            },
            model: 'gemini-3-flash-agent',
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.providerOptions).toBeUndefined()
      expect(wrapped.request.cachedContent).toBeUndefined()
      expect(wrapped.request.contents[0].parts[0].cacheControl).toBeUndefined()
      expect(wrapped.request.toolConfig).toEqual({
        functionCallingConfig: {
          allowedFunctionNames: ['read'],
          mode: 'VALIDATED',
        },
      })
    })

    it('does not send toolConfig when an agy request has no tools', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.toolConfig).toBeUndefined()
    })

    it('strips Claude thinking blocks when keep_thinking is false (unwrapped)', () => {
      const result = withKeepThinking(false, () =>
        prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [
                {
                  role: 'model',
                  parts: [
                    {
                      thought: true,
                      text: 'foreign-thought-unwrapped',
                      thoughtSignature: 'f'.repeat(MIN_SIGNATURE_LENGTH + 8),
                    },
                    { functionCall: { name: 'weather', args: {} } },
                  ],
                },
              ],
            }),
          },
          mockAccessToken,
          mockProjectId,
        ),
      )

      const wrapped = JSON.parse(result.init.body as string)
      const parts = wrapped.request.contents[0].parts as Array<
        Record<string, unknown>
      >
      // Sentinel replacement: thinking parts are replaced with plain empty text parts (not deleted) to preserve array indices for cache
      // Plain text sentinels avoid the proxy converting them to Claude thinking blocks with missing fields
      expect(parts).toHaveLength(2) // Array length preserved (1 sentinel + 1 functionCall)
      expect(parts[0]).toMatchObject({ text: '.' }) // Thinking replaced with plain space text
      expect(parts[0]).not.toHaveProperty('thought')
      expect(parts[0]).not.toHaveProperty('thoughtSignature')
      expect(result.needsSignedThinkingWarmup).toBe(false)
    })

    it('strips Claude thinking blocks when keep_thinking is false (wrapped)', () => {
      const result = withKeepThinking(false, () =>
        prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              project: 'my-project',
              request: {
                contents: [
                  {
                    role: 'model',
                    parts: [
                      {
                        thought: true,
                        text: 'foreign-thought-wrapped',
                        thoughtSignature: 'w'.repeat(MIN_SIGNATURE_LENGTH + 8),
                      },
                      { functionCall: { name: 'weather', args: {} } },
                    ],
                  },
                ],
              },
            }),
          },
          mockAccessToken,
          mockProjectId,
        ),
      )

      const wrapped = JSON.parse(result.init.body as string)
      const parts = wrapped.request.contents[0].parts as Array<
        Record<string, unknown>
      >

      // Sentinel replacement: thinking parts are replaced with plain empty text parts (not deleted) to preserve array indices for cache
      expect(parts).toHaveLength(2) // Array length preserved (1 sentinel + 1 functionCall)
      expect(parts[0]).toMatchObject({ text: '.' }) // Thinking replaced with plain space text
      expect(parts[0]).not.toHaveProperty('thought')
      expect(parts[0]).not.toHaveProperty('thoughtSignature')
      expect(result.needsSignedThinkingWarmup).toBe(false)
    })

    it('does not trust foreign Gemini thoughtSignature when keep_thinking is true', () => {
      const foreignSignature = 'x'.repeat(MIN_SIGNATURE_LENGTH + 8)
      const result = withKeepThinking(true, () =>
        prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [
                {
                  role: 'model',
                  parts: [
                    {
                      thought: true,
                      text: 'foreign-thought-keep-true',
                      thoughtSignature: foreignSignature,
                    },
                    { functionCall: { name: 'weather', args: {} } },
                  ],
                },
              ],
            }),
          },
          mockAccessToken,
          mockProjectId,
        ),
      )

      const wrapped = JSON.parse(result.init.body as string)
      const parts = wrapped.request.contents[0].parts as Array<
        Record<string, unknown>
      >
      const thinkingBlock = parts.find(
        (part) =>
          part.thought === true ||
          part.type === 'thinking' ||
          part.type === 'redacted_thinking',
      )
      const signature =
        typeof thinkingBlock?.signature === 'string'
          ? thinkingBlock.signature
          : thinkingBlock?.thoughtSignature

      expect(JSON.stringify(wrapped)).not.toContain(foreignSignature)
      if (thinkingBlock) {
        expect(signature).toBe(SKIP_THOUGHT_SIGNATURE)
      }
    })

    it('replaces foreign Claude signatures with sentinel when keep_thinking is true', () => {
      const foreignSignature = 'y'.repeat(MIN_SIGNATURE_LENGTH + 8)
      const result = withKeepThinking(true, () =>
        prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'thinking',
                      thinking: 'foreign-message-thinking',
                      signature: foreignSignature,
                    },
                    {
                      type: 'tool_use',
                      id: 'tool-1',
                      name: 'weather',
                      input: {},
                    },
                  ],
                },
              ],
            }),
          },
          mockAccessToken,
          mockProjectId,
        ),
      )

      const wrapped = JSON.parse(result.init.body as string)
      const content = wrapped.request.messages[0].content as Array<
        Record<string, unknown>
      >

      // Sentinel replacement: thinking blocks become plain empty text parts
      // This avoids the proxy converting them to Claude thinking blocks with missing required fields
      const textSentinel = content.find(
        (block) => block.text === '.' && !block.type,
      )
      expect(textSentinel).toBeTruthy()
      expect(JSON.stringify(content)).not.toContain(foreignSignature)
      // Without a signed replayable block, the compatibility path requests a warmup.
      expect(result.needsSignedThinkingWarmup).toBe(true)
    })

    it('returns requestedModel matching URL model', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.requestedModel).toBe('gemini-2.5-flash')
    })

    it('handles empty body gracefully', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({}) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('handles minimal valid JSON body', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
      )
      expect(result.streaming).toBe(false)
    })

    it('removes contents entries with empty or invalid parts', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [] },
              { role: 'model', parts: [null, { text: 'kept' }] },
              { role: 'user', parts: null },
            ],
            systemInstruction: {
              role: 'user',
              parts: [null, { text: 'system kept' }],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      // Fix F: content entries preserved (not filtered) to avoid index shifts that bust cache
      expect(wrapped.request.contents).toHaveLength(3)
      // Entry with empty parts preserved as-is
      expect(wrapped.request.contents[0].role).toBe('user')
      // Entry with valid parts keeps them (invalid parts replaced with sentinel to preserve indices)
      expect(wrapped.request.contents[1]).toEqual({
        role: 'model',
        parts: [{ text: '.' }, { text: 'kept' }],
      })
      // systemInstruction parts: null replaced with sentinel, valid parts kept
      expect(wrapped.request.systemInstruction.parts).toEqual([
        { text: '.' },
        { text: 'system kept' },
      ])
    })

    it('drops systemInstruction when all parts are invalid', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            systemInstruction: {
              role: 'user',
              parts: [null],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
      )

      const wrapped = JSON.parse(result.init.body as string)
      expect(wrapped.request.systemInstruction).toBeUndefined()
    })

    it('reports the stable Antigravity sidebar style', () => {
      const result = prepareAntigravityRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
      )
      expect(result.headerStyle).toBe('antigravity')
    })

    describe('Issue #103: model name transformation during quota fallback', () => {
      it('transforms gemini-3-flash-preview to gemini-3-flash for antigravity headerStyle', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        expect(result.effectiveModel).toBe('gemini-3-flash-medium')
      })

      it('transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity headerStyle', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        expect(result.effectiveModel).toBe('gemini-3-pro-low')
      })

      it('transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity headerStyle', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        expect(result.effectiveModel).toBe('gemini-3.1-pro-low')
      })

      it('transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity headerStyle', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        expect(result.effectiveModel).toBe('gemini-3.1-pro-low')
      })

      it('maps Gemini 3.5 Flash to the captured agy medium model', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        const wrapped = JSON.parse(result.init.body as string)
        expect(result.effectiveModel).toBe('gemini-3.5-flash-low')
        expect(wrapped.model).toBe('gemini-3.5-flash-low')
        expect(
          wrapped.request.generationConfig.thinkingConfig.thinkingBudget,
        ).toBe(4000)
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(65536)
      })

      it('maps Claude Sonnet 4.6 Thinking to the captured agy thinking config', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({ contents: [], generationConfig: {} }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        const wrapped = JSON.parse(result.init.body as string)
        expect(result.effectiveModel).toBe('claude-sonnet-4-6')
        expect(wrapped.model).toBe('claude-sonnet-4-6')
        expect(wrapped.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 1024,
        })
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(64000)
      })

      it('uses captured agy Claude Opus config while retaining the OpenCode cache boundary', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-opus-4-6-thinking:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              generationConfig: {},
              systemInstruction: { parts: [{ text: 'base system' }] },
              contents: [
                { role: 'user', parts: [{ text: 'read the file' }] },
                {
                  role: 'model',
                  parts: [{ functionCall: { name: 'read', args: {} } }],
                },
                {
                  role: 'user',
                  parts: [
                    {
                      functionResponse: {
                        name: 'read',
                        response: { output: 'ok' },
                      },
                    },
                  ],
                },
              ],
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'read',
                      description: 'Read a file',
                      parameters: {
                        type: 'object',
                        properties: { filePath: { type: 'string' } },
                        required: ['filePath'],
                      },
                    },
                  ],
                },
              ],
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
        )

        const wrapped = JSON.parse(result.init.body as string)
        const serialized = JSON.stringify(wrapped.request)
        expect(result.effectiveModel).toBe('claude-opus-4-6-thinking')
        expect(result.needsSignedThinkingWarmup).toBe(false)
        expect(wrapped.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 1024,
        })
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(64000)
        expect(
          wrapped.request.contents.map(
            (content: { role: string }) => content.role,
          ),
        ).toEqual(['user', 'model', 'user', 'model', 'user'])
        expect(serialized).toContain('Interleaved thinking is enabled')
        expect(serialized).toContain('[Tool execution completed.]')
        expect(serialized).toContain('[Continue]')
      })

      it('maps Gemini 3.5 Flash medium variant to the live Antigravity medium-tier model', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [],
              generationConfig: {},
              providerOptions: { google: { thinkingLevel: 'medium' } },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        const wrapped = JSON.parse(result.init.body as string)
        expect(result.effectiveModel).toBe('gemini-3.5-flash-low')
        expect(wrapped.model).toBe('gemini-3.5-flash-low')
        expect(
          wrapped.request.generationConfig.thinkingConfig.thinkingBudget,
        ).toBe(4000)
        expect(wrapped.request.generationConfig.maxOutputTokens).toBe(65536)
        expect(
          wrapped.request.generationConfig.thinkingConfig.thinkingLevel,
        ).toBeUndefined()
      })

      it('keeps non-Gemini-3 models unchanged regardless of headerStyle', () => {
        const result = prepareAntigravityRequest(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
          { method: 'POST', body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
        )
        expect(result.effectiveModel).toBe('gemini-2.5-flash')
      })
    })
  })

  describe('buildThinkingWarmupBody', () => {
    it('uses a separate valid AGY trajectory instead of reusing stale main-request metadata', () => {
      const body = JSON.stringify({
        project: 'project',
        requestId: 'agent/main-conversation/100/main-trajectory/5',
        request: {
          contents: [
            { role: 'user', parts: [{ text: 'prompt' }] },
            {
              role: 'model',
              parts: [{ text: 'thought' }, { functionCall: { name: 'read' } }],
            },
            { role: 'user', parts: [{ functionResponse: { name: 'read' } }] },
          ],
          tools: [{ functionDeclarations: [{ name: 'read' }] }],
          toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
          labels: {
            last_step_index: '4',
            model_enum: 'MODEL_PLACEHOLDER_M35',
            trajectory_id: 'main-trajectory',
          },
          generationConfig: {},
          sessionId: '-3750763034362895579',
        },
        model: 'claude-sonnet-5-5-low',
        userAgent: 'antigravity',
        requestType: 'agent',
      })

      const warmup = JSON.parse(buildThinkingWarmupBody(body, true)!)

      expect(warmup.requestId).toMatch(
        /^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/2$/,
      )
      expect(warmup.requestId).not.toContain('main-trajectory')
      expect(warmup.request.contents).toHaveLength(1)
      expect(warmup.request.tools).toBeUndefined()
      expect(warmup.request.toolConfig).toBeUndefined()
      expect(warmup.request.labels.last_step_index).toBe('1')
      expect(warmup.model).toBe('claude-sonnet-5-5-low')
      expect(warmup.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M403')
      expect(warmup.request.labels.trajectory_id).not.toBe('main-trajectory')
      expect(warmup.request.sessionId).toBe('-3750763034362895579')
      expect(warmup.request.generationConfig).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 0,
          thinkingLevel: 'LOW',
        },
        maxOutputTokens: 128000,
      })
    })
  })

  describe('transformAntigravityResponse', () => {
    it('masks project IDs in failed request text', async () => {
      const projectId = 'my-real-project-123456'
      const response = new Response(
        JSON.stringify({
          error: { message: `Upstream rejected project ${projectId}` },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )
      const transformed = await transformAntigravityResponse(
        response,
        false,
        null,
        'gemini-3-flash',
        projectId,
        'https://generativelanguage.googleapis.com',
        'gemini-3-flash',
      )
      const error = (await transformed.json()) as {
        error: { message: string }
      }

      expect(error.error.message).not.toContain(projectId)
      expect(error.error.message).toContain(
        'Upstream rejected project my-r****3456',
      )
      expect(error.error.message).toContain('Project: my-r****3456')
    })

    it('keeps Unknown when a failed request has no project ID', async () => {
      const transformed = await transformAntigravityResponse(
        new Response(
          JSON.stringify({ error: { message: 'Upstream rejected' } }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        ),
        false,
        null,
        'gemini-3-flash',
      )
      const error = (await transformed.json()) as {
        error: { message: string }
      }

      expect(error.error.message).toContain('Project: Unknown')
    })

    it('bounds tool-rich HTTP 400 and 429 errors without tool JSON', async () => {
      const logDir = mkdtempSync(join(tmpdir(), 'agy-tool-error-debug-'))
      const schemaMarker = 'private_tool_schema_marker_000'
      const sourceUrl =
        'https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-5-5-low:generateContent'
      const tools = Array.from({ length: 200 }, (_, index) => ({
        function: {
          name: `debug_tool_${String(index).padStart(3, '0')}`,
          description: `Tool ${index}`,
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: `${index === 0 ? schemaMarker : `schema_${index}`} ${'x'.repeat(96)}`,
              },
            },
            required: ['input'],
          },
        },
      }))

      try {
        initializeDebug({
          ...DEFAULT_CONFIG,
          debug: true,
          debug_tui: false,
          log_dir: logDir,
        })

        const prepared = prepareAntigravityRequest(
          sourceUrl,
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Use the tools' }] }],
              tools,
            }),
          },
          'access-token',
          'tool-error-project',
          undefined,
          false,
          { claudeToolHardening: false },
        )
        const debugContext = startAntigravityDebugRequest({
          originalUrl: sourceUrl,
          resolvedUrl: String(prepared.request),
          method: 'POST',
          headers: prepared.init.headers,
          body: String(prepared.init.body),
          streaming: prepared.streaming,
          projectId: prepared.projectId,
        })

        for (const status of [400, 429]) {
          const response = new Response(
            JSON.stringify({
              error: {
                code: status,
                message: 'Upstream rejected request',
                status:
                  status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT',
              },
            }),
            {
              status,
              headers: {
                'content-type': 'application/json',
                'x-request-id': `request-${status}`,
              },
            },
          )
          const transformed = await transformAntigravityResponse(
            response,
            prepared.streaming,
            debugContext,
            prepared.requestedModel,
            prepared.projectId,
            prepared.endpoint,
            prepared.effectiveModel,
            prepared.sessionId,
            prepared.toolDebugMissing,
            prepared.toolDebugSummary,
          )
          const errorBody = (await transformed.json()) as {
            error: { code: number; message: string; status: string }
          }

          expect(transformed.status).toBe(status)
          expect(errorBody.error.code).toBe(status)
          expect(errorBody.error.status).toBe(
            status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT',
          )
          expect(errorBody.error.message.length).toBeLessThan(4_000)
          expect(errorBody.error.message).not.toContain(schemaMarker)
          expect(errorBody.error.message).toContain('[Debug Info]')
          expect(errorBody.error.message).toContain('Requested Model:')
          expect(errorBody.error.message).toContain('Effective Model:')
          expect(errorBody.error.message).toContain('Project: tool****ject')
          expect(errorBody.error.message).toContain('Endpoint:')
          expect(errorBody.error.message).toContain(`Status: ${status}`)
          expect(errorBody.error.message).toContain(
            `Request ID: request-${status}`,
          )
          expect(errorBody.error.message).toContain('Tool Debug Missing: 0')
          expect(errorBody.error.message).toContain(
            'Tool Debug Summary: decl=debug_tool_000,src=function/custom,hasSchema=y',
          )
        }

        await closeDebugLog()
        const logFile = readdirSync(logDir).find((file) =>
          file.endsWith('.log'),
        )
        expect(logFile).toBeTruthy()
        const debugLog = readFileSync(join(logDir, logFile!), 'utf8')
        expect(debugLog).toContain(schemaMarker)
      } finally {
        await closeDebugLog()
        initializeDebug(DEFAULT_CONFIG)
        rmSync(logDir, { recursive: true, force: true })
      }
    })

    it('injects [ThinkingResolution] details when debug_tui is enabled', async () => {
      initializeDebug({
        ...DEFAULT_CONFIG,
        debug: false,
        debug_tui: true,
      })

      const response = new Response(
        JSON.stringify({
          error: {
            code: 500,
            message: 'Upstream error',
            status: 'INTERNAL',
          },
        }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      )

      const transformed = await transformAntigravityResponse(
        response,
        false,
        undefined,
        'gemini-2.5-pro',
        'test-project',
        'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
        'gemini-2.5-pro',
        'session-1',
        0,
        'summary',
        [
          'status=500 INTERNAL',
          'endpoint=https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
          'account=test@example.com',
        ],
      )

      const bodyText = await transformed.text()
      expect(bodyText).toContain('[ThinkingResolution]')
      expect(bodyText).toContain('status=500 INTERNAL')
      expect(bodyText).toContain(
        'endpoint=https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
      )
      expect(bodyText).toContain('account=test@example.com')

      initializeDebug(DEFAULT_CONFIG)
    })

    it('does not misclassify generic INVALID_ARGUMENT as thinking recovery from debug metadata', async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: 'Request contains an invalid argument.',
            status: 'INVALID_ARGUMENT',
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      )

      const transformed = await transformAntigravityResponse(
        response,
        true,
        undefined,
        'antigravity-claude-opus-4-6-thinking',
        'test-project',
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'claude-opus-4-6-thinking',
        'session-1',
        0,
        'expected=1 found=0',
      )

      await expect(transformed.text()).resolves.toContain(
        'Request contains an invalid argument.',
      )
    })

    it('rethrows THINKING_RECOVERY_NEEDED for outer retry handling', async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message:
              'Thinking must start with a thinking block before tool use.',
            status: 'INVALID_ARGUMENT',
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      )

      await expect(
        transformAntigravityResponse(
          response,
          true,
          undefined,
          'antigravity-claude-opus-4-6-thinking',
          'test-project',
          'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
          'claude-opus-4-6-thinking',
          'session-1',
        ),
      ).rejects.toMatchObject({ message: 'THINKING_RECOVERY_NEEDED' })
    })
  })
})

describe('current Claude warmup admission', () => {
  it('does not replace a retired explicit target with another Claude family', () => {
    expect(
      buildThinkingWarmupBody(
        JSON.stringify({ model: 'claude-sonnet-4-6', request: {} }),
        true,
      ),
    ).toBeNull()
  })

  it('preserves an explicit output cap for an adaptive-thinking warmup', () => {
    const body = buildThinkingWarmupBody(
      JSON.stringify({
        model: 'claude-sonnet-5-5-low',
        request: { generationConfig: { maxOutputTokens: 2048 } },
      }),
      true,
    )
    expect(body).not.toBeNull()
    expect(JSON.parse(body!).request.generationConfig).toEqual({
      maxOutputTokens: 2048,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 0,
        thinkingLevel: 'LOW',
      },
    })
  })
})

describe('tool schema wire normalization', () => {
  for (const [family, model] of [
    ['Gemini', 'antigravity-gemini-3.8-flash-low'],
    ['Claude', 'antigravity-claude-sonnet-5-5-low'],
    ['GPT-OSS', 'antigravity-gpt-oss-120b-medium'],
  ]) {
    describe(family!, () => {
      function wireSchema(properties: Record<string, unknown>) {
        const prepared = prepareAntigravityRequest(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Use the tool' }] }],
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'report_tool',
                      parameters: { type: 'object', properties },
                    },
                  ],
                },
              ],
            }),
          },
          'access-token',
          'schema-test-project',
          undefined,
        )
        return JSON.parse(prepared.init.body as string).request.tools[0]
          .functionDeclarations[0].parameters
      }

      if (family === 'Gemini') {
        it('Gemini wire omits items on non-array parameter nodes', () => {
          const schema = wireSchema({
            nested: {
              type: 'object',
              properties: {
                label: { type: 'string', items: { type: 'string' } },
                choice: {
                  anyOf: [
                    { type: 'boolean', items: { type: 'number' } },
                    { type: 'array', items: { type: 'integer' } },
                  ],
                },
              },
            },
          })
          expect(schema.properties.nested).toEqual({
            type: 'OBJECT',
            properties: {
              label: { type: 'STRING' },
              choice: {
                anyOf: [
                  { type: 'BOOLEAN' },
                  { type: 'ARRAY', items: { type: 'INTEGER' } },
                ],
              },
            },
          })
        })

        it('Gemini wire retains items on array parameter nodes', () => {
          const schema = wireSchema({
            nested: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'integer' } },
                  choice: { oneOf: [{ type: 'array' }, { type: 'string' }] },
                },
              },
            },
          })
          expect(schema.properties.nested).toEqual({
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                items: { type: 'ARRAY', items: { type: 'INTEGER' } },
                choice: {
                  anyOf: [
                    { type: 'ARRAY', items: { type: 'STRING' } },
                    { type: 'STRING' },
                  ],
                },
              },
            },
          })
        })

        it('Gemini wire omits object structure on non-object parameter nodes', () => {
          const schema = wireSchema({
            nested: {
              type: 'array',
              items: {
                type: 'number',
                properties: { x: { type: 'string' } },
                required: ['x'],
                propertyOrdering: ['x'],
                minimum: 1,
                maximum: 9,
              },
            },
          })
          expect(schema.properties.nested).toEqual({
            type: 'ARRAY',
            items: { type: 'NUMBER', minimum: 1, maximum: 9 },
          })
        })
      }

      it('retains documented Gemini Schema fields with the appropriate validation mode', () => {
        const schema = wireSchema({
          value: {
            type: 'object',
            title: 'Ordered input',
            propertyOrdering: ['timestamp'],
            example: { timestamp: '2026-10-13T00:00:00Z' },
            examples: [{}],
            properties: {
              timestamp: {
                type: 'string',
                format: 'date-time',
                pattern: '^2026-',
                title: 'Timestamp',
                nullable: true,
                example: '2026-10-13T00:00:00Z',
              },
            },
          },
        })
        expect(schema.properties.value).toEqual(
          family === 'Claude'
            ? {
                type: 'OBJECT',
                propertyOrdering: ['timestamp'],
                example: { timestamp: '2026-10-13T00:00:00Z' },
                properties: {
                  timestamp: {
                    type: 'STRING',
                    nullable: true,
                    example: '2026-10-13T00:00:00Z',
                    description: 'format: date-time, pattern: ^2026-',
                  },
                },
              }
            : {
                type: 'OBJECT',
                title: 'Ordered input',
                propertyOrdering: ['timestamp'],
                example: { timestamp: '2026-10-13T00:00:00Z' },
                properties: {
                  timestamp: {
                    type: 'STRING',
                    format: 'date-time',
                    pattern: '^2026-',
                    title: 'Timestamp',
                    nullable: true,
                    example: '2026-10-13T00:00:00Z',
                  },
                },
              },
        )
      })

      it('merges zod-style intersections without losing later required properties', () => {
        const schema = wireSchema({
          value: {
            allOf: [
              {
                type: 'object',
                additionalProperties: false,
                $schema: 'ignored',
                title: 'First',
                properties: { a: { type: 'string' } },
                required: ['a'],
              },
              {
                type: 'object',
                additionalProperties: false,
                title: 'Second',
                properties: { b: { type: 'integer' } },
                required: ['b'],
              },
            ],
          },
        })
        expect(schema.properties.value).toEqual({
          type: 'OBJECT',
          ...(family === 'Claude'
            ? { description: 'No extra properties allowed' }
            : { title: 'First' }),
          properties: {
            a: { type: 'STRING' },
            b: { type: 'INTEGER' },
          },
          required: ['a', 'b'],
        })
      })

      it('restricts enums to strings without changing value types', () => {
        const schema = wireSchema({
          nested: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                off: { type: 'boolean', const: false },
                on: { type: 'boolean', const: true },
                count: { type: 'integer', const: 3 },
                label: { type: 'string', const: 'x' },
                choices: { type: 'integer', enum: [1, 2] },
                mixed: { type: 'string', enum: ['x', false] },
              },
            },
          },
        })
        const props = schema.properties.nested.items.properties
        expect(props.off).toEqual({
          type: 'BOOLEAN',
          description: 'Must be false.',
        })
        expect(props.on).toEqual({
          type: 'BOOLEAN',
          description: 'Must be true.',
        })
        expect(props.count).toEqual({
          type: 'INTEGER',
          description: 'Must be 3.',
        })
        expect(props.label).toEqual({ type: 'STRING', enum: ['x'] })
        expect(props.choices).toEqual({
          type: 'INTEGER',
          description: 'Allowed values: 1, 2.',
        })
        expect(props.mixed).toEqual({
          type: 'STRING',
          description: 'Allowed values: "x", false.',
        })
      })

      it('drops unknown keywords at every schema depth', () => {
        const schema = wireSchema({
          thinking: {
            type: 'object',
            examples: [{}],
            readOnly: true,
            vendorExtension: 'bad',
            properties: {
              value: {
                type: 'array',
                $schema: 'ignored',
                additionalProperties: false,
                items: {
                  type: 'string',
                  examples: ['x'],
                  readOnly: true,
                  vendorExtension: 'bad',
                },
              },
            },
          },
        })
        expect(schema.properties.thinking).toEqual({
          type: 'OBJECT',
          properties: {
            value: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              ...(family === 'Claude'
                ? { description: 'No extra properties allowed' }
                : {}),
            },
          },
        })
        expect(schema.type).toBe('OBJECT')
      })

      it('handles exclusive bounds and unsupported numeric constraints', () => {
        const props = wireSchema({
          count: {
            type: 'integer',
            minimum: 0,
            exclusiveMinimum: 0,
            maximum: 20,
            exclusiveMaximum: 10,
            multipleOf: 2,
          },
          amount: {
            type: 'number',
            minimum: 0,
            exclusiveMinimum: true,
            maximum: 10,
            exclusiveMaximum: 9.5,
          },
          tighter: {
            type: 'integer',
            minimum: 5,
            exclusiveMinimum: 0,
            maximum: 6,
            exclusiveMaximum: 10,
          },
        }).properties
        if (family === 'GPT-OSS') {
          expect(props.count).toEqual({
            type: 'INTEGER',
            description:
              'minimum: 0, exclusiveMinimum: 0, maximum: 20, exclusiveMaximum: 10, multipleOf: 2',
          })
          expect(props.amount.description).toContain('exclusiveMinimum: true')
          expect(props.amount.minimum).toBeUndefined()
        } else {
          expect(props.count).toEqual({
            type: 'INTEGER',
            minimum: 1,
            maximum: 9,
            description: 'multipleOf: 2',
          })
          expect(props.amount).toEqual({
            type: 'NUMBER',
            minimum: 0,
            maximum: 10,
            description: 'exclusiveMinimum: true, exclusiveMaximum: 9.5',
          })
          expect(props.tighter).toEqual({
            type: 'INTEGER',
            minimum: 5,
            maximum: 6,
          })
        }
      })

      it('normalizes deeply nested unions and disjoint intersections', () => {
        const props = wireSchema({
          data: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: { flag: { type: 'boolean', const: false } },
                },
                {
                  oneOf: [
                    { type: 'boolean', const: true },
                    { type: 'integer', const: 3 },
                    { type: 'string', const: 'x' },
                  ],
                },
              ],
            },
          },
          joined: {
            allOf: [
              {
                type: 'object',
                properties: { a: { type: 'string', const: 'x' } },
                required: ['a'],
              },
              {
                type: 'object',
                properties: { b: { type: 'boolean', const: true } },
                required: ['b'],
              },
            ],
          },
        }).properties
        expect(props.data.items).toEqual(
          family === 'Claude'
            ? {
                type: 'OBJECT',
                properties: {
                  flag: { type: 'BOOLEAN', description: 'Must be false.' },
                },
                description: 'Accepts: object | boolean',
              }
            : {
                anyOf: [
                  {
                    type: 'OBJECT',
                    properties: {
                      flag: { type: 'BOOLEAN', description: 'Must be false.' },
                    },
                  },
                  {
                    anyOf: [
                      { type: 'BOOLEAN', description: 'Must be true.' },
                      { type: 'INTEGER', description: 'Must be 3.' },
                      { type: 'STRING', enum: ['x'] },
                    ],
                  },
                ],
              },
        )
        expect(props.joined).toEqual({
          type: 'OBJECT',
          properties: {
            a: { type: 'STRING', enum: ['x'] },
            b: { type: 'BOOLEAN', description: 'Must be true.' },
          },
          required: ['a', 'b'],
        })
      })
    })
  }
})

describe('historical tool schema wire fixes', () => {
  function request(model: string, tools: unknown[]) {
    const prepared = prepareAntigravityRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Use the tool' }] }],
          tools,
        }),
      },
      'access-token',
      'schema-history-project',
      undefined,
    )
    return JSON.parse(prepared.init.body as string).request
  }

  it('Claude preserves WebFetch format choices and the property named format', () => {
    const body = request('antigravity-claude-sonnet-5-5-low', [
      {
        functionDeclarations: [
          {
            name: 'WebFetch',
            parameters: {
              type: 'object',
              properties: {
                format: {
                  anyOf: [
                    { const: 'text' },
                    { const: 'markdown' },
                    { const: 'html' },
                  ],
                },
              },
              required: ['format'],
            },
          },
        ],
      },
    ])
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: 'OBJECT',
      properties: {
        format: { type: 'STRING', enum: ['text', 'markdown', 'html'] },
      },
      required: ['format'],
    })
  })

  it('Claude retains scalar VALIDATED constraint hints and union flattening', () => {
    const body = request('antigravity-claude-sonnet-5-5-low', [
      {
        functionDeclarations: [
          {
            name: 'validated',
            parameters: {
              type: 'object',
              title: 'Not a validated field',
              properties: {
                text: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 10,
                  pattern: '^x',
                  format: 'date',
                  default: 'x',
                },
                list: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 2,
                  items: { type: 'string' },
                },
                choice: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              },
            },
          },
        ],
      },
    ])
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: 'OBJECT',
      properties: {
        text: {
          type: 'STRING',
          description:
            'minLength: 1, maxLength: 10, pattern: ^x, format: date, default: x',
        },
        list: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'minItems: 1, maxItems: 2',
        },
        choice: { type: 'STRING', description: 'Accepts: string | number' },
      },
    })
  })

  for (const [family, model] of [
    ['Gemini', 'antigravity-gemini-3.8-flash-low'],
    ['Claude', 'antigravity-claude-sonnet-5-5-low'],
    ['GPT-OSS', 'antigravity-gpt-oss-120b-medium'],
  ]) {
    it(`${family} strips additionalProperties and missing required names from the final schema`, () => {
      const body = request(model!, [
        {
          functionDeclarations: [
            {
              name: 'mcp_tool',
              parameters: {
                type: 'object',
                additionalProperties: false,
                $schema: 'ignored',
                properties: {
                  name: { type: 'string' },
                  data: { type: 'array' },
                },
                required: ['name', 'missing', 'data'],
              },
            },
          ],
        },
      ])
      expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          data: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['name', 'data'],
        ...(family === 'Claude'
          ? { description: 'No extra properties allowed' }
          : {}),
      })
    })

    it(`${family} does not reintroduce wrapper-level parameters or raw schemas`, () => {
      const body = request(model!, [
        {
          type: 'function',
          parameters: { type: 'string', readOnly: true },
          function: {
            name: 'wrapped_tool',
            parameters: {
              type: 'object',
              properties: { enabled: { type: 'boolean', const: false } },
              additionalProperties: false,
            },
          },
        },
      ])
      expect(body.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'wrapped_tool',
              description:
                family === 'Claude'
                  ? '\n\n⚠️ STRICT PARAMETERS: enabled (BOOLEAN).'
                  : '',
              parameters: {
                type: 'OBJECT',
                properties: {
                  enabled: { type: 'BOOLEAN', description: 'Must be false.' },
                },
                ...(family === 'Claude'
                  ? { description: 'No extra properties allowed' }
                  : {}),
              },
            },
          ],
        },
      ])
    })
  }
})
