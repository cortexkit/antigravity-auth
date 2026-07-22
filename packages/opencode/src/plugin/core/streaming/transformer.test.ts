import { describe, expect, it } from 'bun:test'

import { createStreamingTransformer } from './transformer.ts'
import type {
  SignatureStore,
  SignedThinking,
  StreamingCallbacks,
  StreamingUsageMetadata,
} from './types'

/**
 * Minimal in-memory SignatureStore — characterization tests use this rather
 * than mocking the module so failures point at transformer behavior, not
 * at mock wiring.
 */
function createInMemorySignatureStore(): SignatureStore & {
  entries(): SignedThinking[]
} {
  const map = new Map<string, SignedThinking>()
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value)
    },
    has: (key) => map.has(key),
    delete: (key) => {
      map.delete(key)
    },
    entries: () => [...map.values()],
  }
}

const noopCallbacks: StreamingCallbacks = {}

/** Filter and parse every `data: ...` line, regardless of envelope shape. */
function parseDataLines(output: string): unknown[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
}

async function runTransformer(
  chunks: Uint8Array[],
  callbacks: StreamingCallbacks = noopCallbacks,
  options: Parameters<typeof createStreamingTransformer>[2] = {},
): Promise<{ output: string; terminated: boolean }> {
  const store = createInMemorySignatureStore()
  const transformer = createStreamingTransformer(store, callbacks, options)
  const decoder = new TextDecoder()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const reader = source.pipeThrough(transformer).getReader()

  let output = ''
  let terminated = false
  while (true) {
    const result = await reader.read()
    if (result.done) {
      terminated = true
      break
    }
    output += decoder.decode(result.value)
  }
  return { output, terminated }
}

describe('createStreamingTransformer', () => {
  it('reassembles a single data: JSON line split across three chunks without duplicating thinking text', async () => {
    const thinkingLine = `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: 'thinking chunk' }],
            },
          },
        ],
      },
    })}\n`

    const chunkA = new TextEncoder().encode(thinkingLine.slice(0, 30))
    const chunkB = new TextEncoder().encode(thinkingLine.slice(30, 80))
    const chunkC = new TextEncoder().encode(thinkingLine.slice(80))

    const { output } = await runTransformer([chunkA, chunkB, chunkC])
    const dataLines = parseDataLines(output)

    // One real data line (the reassembled thinking) + the synthetic usage
    // event the transformer emits on flush. The thinking text must NOT
    // appear twice — that would indicate the chunked line was emitted
    // more than once.
    expect(dataLines.length).toBeGreaterThanOrEqual(1)
    const transformed = dataLines[0] as {
      candidates: Array<{
        content: { parts: Array<{ thought?: boolean; text?: string }> }
      }>
    }
    expect(transformed.candidates[0]?.content.parts[0]?.text).toBe(
      'thinking chunk',
    )
    expect(transformed.candidates[0]?.content.parts[0]?.thought).toBe(true)

    const thinkingOccurrences = (output.match(/"thinking chunk"/g) ?? []).length
    expect(thinkingOccurrences).toBe(1)
  })

  it('passes CRLF line endings through cleanly and emits valid SSE frames', async () => {
    const payload = `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'hello world' }] },
            finishReason: 'STOP',
          },
        ],
      },
    })}\r\n`

    const { output, terminated } = await runTransformer([
      new TextEncoder().encode(payload),
    ])
    expect(terminated).toBe(true)
    // Every SSE frame must be followed by a blank-line separator so a
    // strict SSE parser sees a complete event boundary.
    expect(output).toMatch(/\n\n/)
    expect(output).toContain('hello world')
    expect(output).toContain('finishReason')
  })

  it('emits a complete blank-line separator and terminates after a terminal finishReason, even if the upstream body would stay open', async () => {
    // The source intentionally stays "open" — we only close it after the
    // transformer has already signaled termination.
    const terminal = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'goodbye' }] },
            finishReason: 'STOP',
          },
        ],
      },
    }

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n`),
        )
        // Note: NOT closing the controller. The transformer must terminate.
      },
    })

    const store = createInMemorySignatureStore()
    const transformer = createStreamingTransformer(store, noopCallbacks)
    const reader = source.pipeThrough(transformer).getReader()

    const decoder = new TextDecoder()
    let output = ''
    let done = false
    for (let i = 0; i < 6 && !done; i++) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('stream did not terminate')), 200),
        ),
      ])
      if (result.done) {
        done = true
        break
      }
      output += decoder.decode(result.value)
    }

    expect(done).toBe(true)
    expect(output).toContain('goodbye')
    expect(output).toContain('finishReason')
    // The final frame must end with a complete `\n\n` separator so
    // SSE parsers recognize the event boundary.
    expect(output.endsWith('\n\n')).toBe(true)
    // Synthetic usage is emitted because no usage was reported upstream.
    expect(output).toMatch(/"usageMetadata"/)
  })

  it('injects exactly one synthetic zero-usage event when no usage is ever seen', async () => {
    const terminal = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'no usage here' }] },
            finishReason: 'STOP',
          },
        ],
      },
    }

    const { output } = await runTransformer([
      new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n`),
    ])
    const dataLines = parseDataLines(output)

    // The synthetic event keeps its `{ response: { usageMetadata } }` wrapper;
    // non-synthetic transformed lines are emitted at the unwrapped level.
    const usageEvents = dataLines.filter(
      (line) =>
        typeof line === 'object' &&
        line !== null &&
        'response' in line &&
        typeof (line as { response?: { usageMetadata?: unknown } }).response
          ?.usageMetadata === 'object',
    )
    expect(usageEvents).toHaveLength(1)
    const usage = (
      usageEvents[0] as { response: { usageMetadata: Record<string, unknown> } }
    ).response.usageMetadata
    expect(usage).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    })
  })

  it('delays a content usage line that lacks cachedContentTokenCount and merges terminal cache usage into it', async () => {
    const contentEvent = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 7,
          totalTokenCount: 112,
          // cachedContentTokenCount intentionally missing
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
          promptTokenCount: 100,
          cachedContentTokenCount: 87,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 7,
          totalTokenCount: 112,
        },
      },
    }

    const { output } = await runTransformer([
      new TextEncoder().encode(
        `data: ${JSON.stringify(contentEvent)}\n\ndata: ${JSON.stringify(terminalStop)}\n`,
      ),
    ])
    const dataLines = parseDataLines(output)
    expect(dataLines.length).toBeGreaterThanOrEqual(2)

    // The first event must carry the merged cached usage — not the bare
    // partial. That is the point of the one-line buffer + terminal merge.
    // Note: transformed data lines are emitted at the unwrapped envelope
    // level (the `response:` wrapper is stripped during transform).
    const first = dataLines[0] as {
      candidates?: unknown[]
      usageMetadata?: Record<string, unknown>
    }
    const firstUsage = first.usageMetadata ?? {}
    expect(firstUsage.cachedContentTokenCount).toBe(87)

    // Last event is the finishReason frame, and it must still carry full usage.
    const last = dataLines[dataLines.length - 1] as {
      candidates: Array<{ finishReason?: string }>
      usageMetadata: Record<string, unknown>
    }
    expect(last.candidates[0]?.finishReason).toBe('STOP')
    expect(last.usageMetadata.cachedContentTokenCount).toBe(87)
  })

  it('stores thinking signatures through SignatureStore and fires onUsageMetadata once with final usage', async () => {
    const store = createInMemorySignatureStore()
    let usageCalls = 0
    let lastUsage: StreamingUsageMetadata | null = null
    const callbacks: StreamingCallbacks = {
      onCacheSignature: () => {
        // Not asserted — the store is the source of truth for caching.
      },
      onUsageMetadata: (usage) => {
        usageCalls++
        lastUsage = usage
      },
    }

    const thinkingEvent = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: 'reasoning...',
                  thoughtSignature: 'sig-1',
                },
              ],
            },
          },
        ],
      },
    }
    const partialUsageEvent = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'partial' }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 42,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 11,
          totalTokenCount: 56,
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
          promptTokenCount: 42,
          cachedContentTokenCount: 30,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 11,
          totalTokenCount: 56,
        },
      },
    }

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify(thinkingEvent)}\n\n` +
              `data: ${JSON.stringify(partialUsageEvent)}\n\n` +
              `data: ${JSON.stringify(terminalStop)}\n`,
          ),
        )
      },
    })

    const transformer = createStreamingTransformer(store, callbacks, {
      signatureSessionKey: 'session-1',
      cacheSignatures: true,
    })
    const reader = source.pipeThrough(transformer).getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    const entries = store.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      text: 'reasoning...',
      signature: 'sig-1',
    })

    // onUsageMetadata fires once with the FINAL terminal usage — the
    // merged cache-aware snapshot, not the earlier partial.
    expect(usageCalls).toBe(1)
    const observedUsage = lastUsage as StreamingUsageMetadata | null
    const expectedUsage: StreamingUsageMetadata = {
      cachedContentTokenCount: 30,
      promptTokenCount: 42,
      candidatesTokenCount: 3,
      totalTokenCount: 56,
    }
    expect(observedUsage).not.toBeNull()
    expect(observedUsage).toEqual(expectedUsage)
  })
})
