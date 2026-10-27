import { describe, expect, it } from 'bun:test'
import { sanitizeCrossModelPayload } from './cross-model-sanitizer.ts'

describe('Cross-Model Session Integration', () => {
  describe('Claude → Gemini model switch', () => {
    it('sanitizes Claude thinking blocks when preparing Gemini request', () => {
      const payload = {
        extra_body: {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Analyzing the request...',
                  signature:
                    'claude-signature-abc123VeryLongSignatureStringThatExceeds50Characters',
                },
                {
                  type: 'tool_use',
                  id: 'tool_1',
                  name: 'bash',
                  input: { command: 'ls' },
                },
              ],
            },
          ],
        },
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'gemini-3-pro-low',
      })

      const sanitized = result.payload as typeof payload
      const content = sanitized.extra_body!.messages![0]!.content
      const thinkingBlock = content.find(
        (c: Record<string, unknown>) => c.type === 'thinking',
      ) as Record<string, unknown>

      expect(thinkingBlock.signature).toBeUndefined()
      expect(thinkingBlock.thinking).toBe('Analyzing the request...')

      const toolBlock = content.find(
        (c: Record<string, unknown>) => c.type === 'tool_use',
      ) as Record<string, unknown>
      expect(toolBlock.name).toBe('bash')
    })

    it('strips redacted_thinking blocks', () => {
      const payload = {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'redacted_thinking',
                data: 'encrypted_data_here',
                signature:
                  'redacted-sig-VeryLongSignatureStringThatExceeds50Characters',
              },
              { type: 'text', text: 'Here is my response' },
            ],
          },
        ],
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'gemini-3-flash',
      })

      const sanitized = result.payload as typeof payload
      const redactedBlock = sanitized.messages![0]!.content![0] as Record<
        string,
        unknown
      >

      expect(redactedBlock.signature).toBeUndefined()
      expect(redactedBlock.type).toBe('redacted_thinking')
    })
  })

  describe('Same model family - no sanitization needed', () => {
    it('preserves Gemini signatures when staying on Gemini', () => {
      const payload = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                thought: true,
                text: 'thinking...',
                thoughtSignature: 'valid-gemini-sig',
              },
            ],
          },
        ],
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'gemini-3-flash',
      })

      const sanitized = result.payload as typeof payload
      expect(
        (sanitized.contents![0]!.parts![0] as Record<string, unknown>)
          .thoughtSignature,
      ).toBe('valid-gemini-sig')
      expect(result.modified).toBe(false)
    })

    it('preserves Claude signatures when staying on Claude', () => {
      const payload = {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'analyzing...',
                signature: 'valid-claude-sig',
              },
            ],
          },
        ],
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'claude-opus-4-6-thinking-low',
      })

      const sanitized = result.payload as typeof payload
      expect(
        (sanitized.messages![0]!.content![0] as Record<string, unknown>)
          .signature,
      ).toBe('valid-claude-sig')
      expect(result.modified).toBe(false)
    })
  })

  describe('Edge cases', () => {
    it('handles empty payloads', () => {
      const result = sanitizeCrossModelPayload(
        {},
        { targetModel: 'claude-sonnet-4' },
      )
      expect(result.modified).toBe(false)
      expect(result.signaturesStripped).toBe(0)
    })

    it('handles null/undefined parts gracefully', () => {
      const payload = {
        contents: [
          { role: 'user', parts: null },
          { role: 'model', parts: undefined },
          { role: 'model' },
        ],
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'claude-sonnet-4',
      })

      expect(result.modified).toBe(false)
    })

    it('handles wrapped requests array (batch format)', () => {
      const payload = {
        requests: [
          {
            contents: [
              {
                role: 'model',
                parts: [
                  {
                    thoughtSignature: 'sig1',
                    thought: true,
                    text: 'thinking',
                  },
                ],
              },
            ],
          },
          {
            contents: [
              {
                role: 'model',
                parts: [
                  {
                    metadata: { google: { thoughtSignature: 'sig2' } },
                    functionCall: { name: 'test' },
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: 'claude-sonnet-4-6',
      })

      const sanitized = result.payload as typeof payload

      expect(
        (
          sanitized.requests![0]!.contents![0]!.parts![0] as Record<
            string,
            unknown
          >
        ).thoughtSignature,
      ).toBeUndefined()
      expect(
        (
          sanitized.requests![1]!.contents![0]!.parts![0] as Record<
            string,
            unknown
          >
        ).metadata,
      ).toBeUndefined()
      expect(result.signaturesStripped).toBe(2)
    })
  })
})
