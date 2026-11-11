import { afterEach, describe, expect, it } from 'bun:test'
import { geminiBillingUsage, VaultBillingAttempt } from './vault-billing'

const symbol = Symbol.for('cortexkit.routing')
const previous = Object.getOwnPropertyDescriptor(globalThis, symbol)
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, symbol, previous)
  else Reflect.deleteProperty(globalThis, symbol)
})

function fixture(signal?: AbortSignal) {
  const reports: Array<Record<string, unknown>> = []
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    value: () => ({
      report: (value: Record<string, unknown>) => {
        reports.push(value)
      },
    }),
  })
  const attempt = new VaultBillingAttempt(
    'session',
    {
      credentialId: 'credential',
      accountIdentity: 'account',
    },
    'generate',
    'gemini-3-flash',
    1,
    signal,
  )
  return { attempt, reports }
}

describe('Gemini billing usage', () => {
  it('never invents absent, invalid or fractional counters', () => {
    for (const value of [
      undefined,
      {},
      { promptTokenCount: -1 },
      { candidatesTokenCount: 1.5 },
      { thoughtsTokenCount: Infinity },
    ])
      expect(geminiBillingUsage(value)).toBeUndefined()
    expect(geminiBillingUsage({ candidatesTokenCount: 0 })).toEqual({
      output: 0,
      reasoningIncludedInOutput: false,
    })
    expect(geminiBillingUsage({ promptTokenCount: 12 })).toEqual({
      input: 12,
      reasoningIncludedInOutput: false,
    })
    expect(
      geminiBillingUsage({ promptTokenCount: 12, cachedContentTokenCount: 20 }),
    ).toEqual({ cacheRead: 20, reasoningIncludedInOutput: false })
  })
})

describe('VaultBillingAttempt raw response observation', () => {
  it('observes split UTF-8 SSE with partial then final usage without changing bytes', async () => {
    const { attempt, reports } = fixture()
    const text =
      'data: {"response":{"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":3,"thoughtsTokenCount":11},"candidates":[{"content":{"parts":[{"text":"héllo"}]}}]}}\r\n\r\n' +
      'data: {"response":{"usageMetadata":{"cachedContentTokenCount":30},"candidates":[{"finishReason":"STOP"}]}}\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    let reads = 0
    const response = attempt.observe(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (reads < bytes.length)
                controller.enqueue(bytes.slice(reads, ++reads))
              else controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    expect(reads).toBe(0)
    expect(await response.text()).toBe(text)
    attempt.end(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.usage).toEqual({
      input: 12,
      output: 3,
      cache_read: 30,
      reasoning: 11,
      reasoning_included_in_output: false,
    })
  })

  it('maps JSON usage for non-streaming sends', async () => {
    const { attempt, reports } = fixture()
    const text =
      '{"response":{"usageMetadata":{"promptTokenCount":42,"cachedContentTokenCount":30,"candidatesTokenCount":3,"thoughtsTokenCount":11}}}'
    expect(
      await attempt
        .observe(
          new Response(text, {
            headers: { 'content-type': 'application/json' },
          }),
        )
        .text(),
    ).toBe(text)
    expect(reports[0]?.outcome).toBe('completed')
    expect(reports[0]?.usage).toEqual({
      input: 12,
      output: 3,
      cache_read: 30,
      reasoning: 11,
      reasoning_included_in_output: false,
    })
  })

  for (const terminal of [true, false]) {
    it(`reports ${terminal ? 'completed' : 'cut'} when the downstream cancels after ${terminal ? 'terminal' : 'partial'} output`, async () => {
      const { attempt, reports } = fixture()
      const response = attempt.observe(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: {"response":{"candidates":[${terminal ? '{"finishReason":"STOP"}' : '{"content":{"parts":[{"text":"hi"}]}}'}]}}\n\n`,
                ),
              )
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      )
      const reader = response.body!.getReader()
      await reader.read()
      await reader.cancel()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.outcome).toBe(terminal ? 'completed' : 'cut')
      expect(reports[0]).not.toHaveProperty('usage')
    })
  }

  it('reports failed for an upstream stream error without swallowing it', async () => {
    const { attempt, reports } = fixture()
    const failure = new Error('upstream disconnected')
    const response = attempt.observe(
      new Response(
        new ReadableStream({
          pull() {
            throw failure
          },
        }),
      ),
    )
    await expect(response.text()).rejects.toThrow('upstream disconnected')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe('failed')
  })

  it('reports failed for an error envelope even when the HTTP status is successful', async () => {
    const { attempt, reports } = fixture()
    await attempt
      .observe(
        new Response('data: {"error":{"message":"refused"}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .text()
    expect(reports[0]?.outcome).toBe('failed')
  })

  it('reports once if the signal aborts before the body is consumed', async () => {
    const controller = new AbortController()
    const { attempt, reports } = fixture(controller.signal)
    const response = attempt.observe(new Response('body'))
    controller.abort()
    await response.body?.cancel()
    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe('failed')
  })
})
