import { expect, test } from 'bun:test'
import {
  hasVaultRoutingAccessor,
  observeVaultServed,
  reportVaultExhaustion,
  routingExhaustionFields,
  routingQuotaScope,
} from './vault-routing'

const key = Symbol.for('cortexkit.routing')
const identity = {
  sessionId: 'session',
  accountId: 'vault-account',
  credentialId: 'credential',
}

async function bridge(run: (reports: unknown[]) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const reports: unknown[] = []
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: () => ({ report: (input: unknown) => reports.push(input) }),
  })
  try {
    await run(reports)
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
}

test('routing absent: only presence gates run and the transport body is untouched', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  let lookups = 0
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get: () => {
      lookups++
      return undefined
    },
  })
  try {
    const transportResponse = new Response(
      'data: {"error":"do not inspect"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const body = transportResponse.body
    const observed = observeVaultServed(identity, transportResponse)
    expect(observed).toBe(transportResponse)
    expect(observed.body).toBe(body)
    expect(lookups).toBe(1)
    expect(await observed.text()).toContain('do not inspect')
    expect(lookups).toBe(1)
    expect(hasVaultRoutingAccessor()).toBe(false)
    expect(lookups).toBe(2)
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('routing served: reports only after clean body completion with rate headers only', async () =>
  bridge(async (reports) => {
    const parts = Promise.withResolvers<void>()
    const bytes = new TextEncoder().encode('data: {"text":"hi"}\n\n')
    const original = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(bytes)
          await parts.promise
          controller.close()
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'x-ratelimit-remaining': '17',
          'retry-after': '3',
          authorization: 'private',
          'set-cookie': 'secret',
          'x-label': 'email',
        },
      },
    )
    const observed = observeVaultServed(identity, original)
    expect(reports).toEqual([])
    const reading = observed.text()
    await Promise.resolve()
    expect(reports).toEqual([])
    parts.resolve()
    expect(await reading).toBe(new TextDecoder().decode(bytes))
    expect(reports).toEqual([
      {
        account_id: 'vault-account',
        credential_id: 'credential',
        outcome: 'served',
        headers: { 'x-ratelimit-remaining': '17', 'retry-after': '3' },
      },
    ])
  }))

test('routing served: no report for thrown stream errors, SSE errors, cancellation, or bridge removal', async () =>
  bridge(async (reports) => {
    const failing = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('stream broke'))
        },
      }),
    )
    await expect(observeVaultServed(identity, failing).text()).rejects.toThrow(
      'stream broke',
    )
    for (const data of [
      'event: error\n\ndata: {}\n\n',
      'data: {"error":{"message":"failed"}}\n\n',
    ]) {
      await observeVaultServed(
        identity,
        new Response(data, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ).text()
    }
    const cancelled = observeVaultServed(identity, new Response('unused'))
    await cancelled.body!.cancel()
    const abort = new AbortController()
    const aborted = observeVaultServed(
      identity,
      new Response('cancelled'),
      abort.signal,
    )
    abort.abort()
    await aborted.text()
    const removed = observeVaultServed(identity, new Response('bridge left'))
    Reflect.deleteProperty(globalThis, key)
    await removed.text()
    expect(reports).toEqual([])
  }))

test('routing quota scope maps every pool and known window to the next accessor shape', () => {
  for (const [group, pool] of [
    ['gemini', 'gemini'],
    ['non-gemini', '3p'],
    ['gemini-argon', 'gemini-argon'],
  ] as const) {
    for (const [window, length, wire] of [
      ['5h', 'five_hour', '5h'],
      ['weekly', 'seven_day', '7d'],
    ] as const) {
      const scope = routingQuotaScope(group, window)
      expect(scope).toEqual({ pool, limitWindow: length })
      expect(routingExhaustionFields(scope!)).toEqual({ pool, window: wire })
    }
    expect(routingQuotaScope(group, 'unknown')).toBeUndefined()
  }
})

test('routing exhausted: switch off sends nothing even for a dated zero window', async () =>
  bridge(async (reports) => {
    reportVaultExhaustion({
      identity,
      status: 429,
      reason: 'QUOTA_EXHAUSTED',
      group: 'gemini',
      observedAt: Date.now(),
      quota: {
        modelCount: 1,
        windows: [
          {
            window: '5h',
            remainingFraction: 0,
            resetTime: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
    })
    expect(reports).toEqual([])
  }))

test('routing exhausted: test-only enablement prepares separate pool/window and reading reset', async () =>
  bridge(async (reports) => {
    const nextAccessor: unknown[] = []
    const reset = Date.now() + 3_600_000
    for (const group of ['gemini', 'non-gemini', 'gemini-argon'] as const) {
      reportVaultExhaustion(
        {
          identity,
          status: 429,
          reason: 'QUOTA_EXHAUSTED',
          group,
          observedAt: Date.now(),
          quota: {
            modelCount: 1,
            windows: [
              {
                window: 'weekly',
                remainingFraction: 0,
                resetTime: new Date(reset).toISOString(),
              },
            ],
          },
        },
        true,
        (input) => {
          nextAccessor.push(input)
        },
      )
    }
    expect(nextAccessor).toEqual(
      ['gemini', '3p', 'gemini-argon'].map((pool) => ({
        ...identity,
        outcome: 'exhausted',
        window: '7d',
        pool,
        resetsAt: reset,
      })),
    )
    expect(reports).toEqual([])
  }))

test('routing exhausted: strict classification rejects quota left, unknown or stale windows and other refusals', async () =>
  bridge(async () => {
    const reports: unknown[] = []
    const valid = {
      identity,
      status: 429,
      reason: 'QUOTA_EXHAUSTED',
      group: 'gemini' as const,
      observedAt: Date.now(),
      quota: {
        modelCount: 1,
        windows: [
          {
            window: '5h' as const,
            remainingFraction: 0,
            resetTime: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
    }
    for (const change of [
      { status: 404 },
      { status: 403 },
      { status: 401 },
      { status: 503 },
      { reason: 'RATE_LIMIT_EXCEEDED' },
      { observedAt: undefined },
      { observedAt: NaN },
      { observedAt: Date.now() + 60_000 },
      { quota: { modelCount: 1, remainingFraction: 0 } },
      {
        quota: {
          modelCount: 1,
          windows: [{ ...valid.quota.windows[0]!, remainingFraction: 0.25 }],
        },
      },
      {
        quota: {
          modelCount: 1,
          windows: [{ ...valid.quota.windows[0]!, resetTime: 'unknown' }],
        },
      },
      {
        quota: {
          modelCount: 1,
          windows: [
            {
              ...valid.quota.windows[0]!,
              resetTime: new Date(1).toISOString(),
            },
          ],
        },
      },
    ])
      reportVaultExhaustion({ ...valid, ...change }, true, (input) => {
        reports.push(input)
      })
    expect(reports).toEqual([])
  }))
