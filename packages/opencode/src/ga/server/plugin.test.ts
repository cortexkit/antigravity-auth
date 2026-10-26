/**
 * The OpenCode 2 server plugin in `./index.ts`, without a real host:
 * - the default sender hands `observeRawSenderSignal` the same signal it
 *   passes to the raw Antigravity sender, and a `send` override bypasses both;
 * - the loopback bridge rewrites requests, runs each job once, propagates
 *   cancellation, reports failures before and after response headers, and
 *   shuts down cleanly;
 * - the request, response and retry hook bodies;
 * - setup against a fake host context typed from the published
 *   `Plugin.Context`: what it registers, the Cleanup order, and rollback
 *   when setup fails part way.
 * Only this file's module mock replaces the raw sender, so no request leaves
 * the machine. The bridge is a real server on 127.0.0.1, and every file lives
 * under a disposable test root.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type * as Core from '@cortexkit/antigravity-auth-core'
import type {
  SessionHooks,
  SessionHttpRequest,
  SessionRetry,
} from '@opencode/plugin/promise/session'
import { placeholderSecret } from '../../common-auth-embedded/opencode2/index.js'

type SenderCall = {
  url: string
  init: RequestInit
  options: Core.AgyTransportOptions
  order: number
}

const senderCalls: SenderCall[] = []
let order = 0
const observations: Array<{ signal: AbortSignal; order: number }> = []
let senderResult: () => Promise<Response> = async () =>
  new Response('data: {}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })

const realCore = await import('@cortexkit/antigravity-auth-core')
mock.module('@cortexkit/antigravity-auth-core', () => ({
  ...realCore,
  fetchWithAgyCliTransport: (
    url: string,
    init: RequestInit,
    options: Core.AgyTransportOptions,
  ) => {
    order += 1
    senderCalls.push({ url, init, options, order })
    return senderResult()
  },
}))

const server = await import('./index.ts')
const { createGaLocationServices } = await import(
  '../../plugin/ga-location-services.ts'
)
const { createMemoryQuotaSnapshots } = await import(
  '../../plugin/shared/runtime.ts'
)
const { LoopbackProxyGuardError } = await import('../proxy-guard.ts')
const heartbeats = await import('../../process-heartbeat.ts')

type GaSendInput = import('./index.ts').GaSendInput
type GaPluginOverrides = import('./index.ts').GaPluginOverrides
type ObserveRawSenderSignal = import('./index.ts').ObserveRawSenderSignal
type GaBridgeJob = import('./index.ts').GaBridgeJob
type GaLoopbackBridge = import('./index.ts').GaLoopbackBridge
type GaJobExecutor = import('./index.ts').GaJobExecutor
type GaHostContext = import('./index.ts').GaHostContext
type GaHttpRequestEvent = import('./index.ts').GaHttpRequestEvent
type GaRetryEvent = import('./index.ts').GaRetryEvent
type AntigravityRpcScope = import('../rpc/protocol.ts').AntigravityRpcScope
type GaLocationServices = import('./index.ts').GaLocationServices
type GaLocationServicesFactory = import('./index.ts').GaLocationServicesFactory

// Compile-time declaration checks. `tsc` fails if either flips.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assignable<A, B> = [A] extends [B] ? true : false
const observerIsDirectProperty: Same<
  NonNullable<GaPluginOverrides['observeRawSenderSignal']>,
  (signal: AbortSignal) => undefined
> = true
const asyncObserverRejected: Assignable<
  (signal: AbortSignal) => Promise<undefined>,
  ObserveRawSenderSignal
> = false
const syncObserverAccepted: Assignable<
  (signal: AbortSignal) => undefined,
  ObserveRawSenderSignal
> = true

function sendInput(signal: AbortSignal): GaSendInput {
  return {
    envelope: {
      project: 'fake-project',
      requestId: 'req-1',
      request: { contents: [] },
      model: 'gemini-3.5-flash-low',
      userAgent: 'antigravity',
      requestType: 'agent',
    },
    auth: { access: 'fake-access' },
    endpoint: 'https://fake-endpoint.invalid',
    signal,
    kind: 'primary',
  }
}

beforeAll(() => {
  expect(observerIsDirectProperty).toBe(true)
  expect(asyncObserverRejected).toBe(false)
  expect(syncObserverAccepted).toBe(true)
})

afterEach(() => {
  senderCalls.length = 0
  observations.length = 0
  order = 0
  senderResult = async () =>
    new Response('data: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
})

describe('default raw sender', () => {
  it('observes the signal of the exact options object handed to the original sender, first', async () => {
    const send = server.createGaRawSender({
      observeRawSenderSignal: (signal) => {
        order += 1
        observations.push({ signal, order })
        return undefined
      },
    })
    const controller = new AbortController()
    await send(sendInput(controller.signal))
    expect(senderCalls).toHaveLength(1)
    expect(observations).toHaveLength(1)
    const call = senderCalls[0]
    const observed = observations[0]
    expect(observed?.signal).toBe(controller.signal)
    expect(call?.options.signal).toBe(observed?.signal)
    expect(observed?.order).toBeLessThan(call?.order ?? 0)
    expect(call?.options.idleTimeoutMs).toBe(server.GA_RAW_IDLE_TIMEOUT_MS)
  })

  it('calls the observer synchronously, before the sender, with no await between', () => {
    let observedSynchronously = false
    const send = server.createGaRawSender({
      observeRawSenderSignal: () => {
        observedSynchronously = senderCalls.length === 0
        return undefined
      },
    })
    void send(sendInput(new AbortController().signal))
    // Both ran inside the synchronous part of the call.
    expect(observedSynchronously).toBe(true)
    expect(senderCalls).toHaveLength(1)
  })

  it('dispatches unchanged when the observer throws', async () => {
    const send = server.createGaRawSender({
      observeRawSenderSignal: () => {
        throw new Error('diagnostic bug')
      },
    })
    const signal = new AbortController().signal
    const response = await send(sendInput(signal))
    expect(response.status).toBe(200)
    expect(senderCalls[0]?.options.signal).toBe(signal)
  })

  it('sends the AGY request with the original wire shape', async () => {
    const send = server.createGaRawSender()
    await send(sendInput(new AbortController().signal))
    const call = senderCalls[0]
    expect(call?.url).toBe(
      `https://fake-endpoint.invalid${server.GA_STREAM_PATH}`,
    )
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fake-access')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(call?.init.body))).toEqual(
      sendInput(new AbortController().signal).envelope,
    )
  })

  it('a supplied send override never runs the production sender or the observer', async () => {
    const received: GaSendInput[] = []
    const send = server.createGaRawSender({
      send: async (input) => {
        received.push(input)
        return new Response('override')
      },
      observeRawSenderSignal: (signal) => {
        observations.push({ signal, order: 0 })
        return undefined
      },
    })
    const input = sendInput(new AbortController().signal)
    expect(await (await send(input)).text()).toBe('override')
    expect(received).toEqual([input])
    expect(senderCalls).toHaveLength(0)
    expect(observations).toHaveLength(0)
  })
})

const JOB: GaBridgeJob = {
  sessionID: 'ses_child',
  parentSessionID: 'ses_parent',
  kind: 'title',
  modelID: 'antigravity-gemini-3.5-flash',
  variant: null,
  url: 'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent?alt=sse',
  body: '{"contents":[]}',
}

const NO_PROXY_ENV = {}

function hostRequest(signal?: AbortSignal): Request {
  return new Request(JOB.url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer host-key',
      'x-goog-api-key': 'host-key',
      'x-opencode-session-id': 'ses_child',
    },
    body: JOB.body,
    ...(signal ? { signal } : {}),
  })
}

describe('loopback bridge', () => {
  let bridge: GaLoopbackBridge | null = null

  afterEach(async () => {
    await bridge?.dispose()
    bridge = null
  })

  async function start(execute: GaJobExecutor): Promise<GaLoopbackBridge> {
    bridge = await server.startGaLoopbackBridge({
      execute,
      send: server.createGaRawSender(),
    })
    return bridge
  }

  it('matches only POSTs to a Google content path', () => {
    expect(server.isGaGoogleContentRequest(hostRequest())).toBe(true)
    expect(
      server.isGaGoogleContentRequest(
        new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/x:countTokens',
          { method: 'POST' },
        ),
      ),
    ).toBe(false)
    expect(
      server.isGaGoogleContentRequest(new Request(JOB.url, { method: 'GET' })),
    ).toBe(false)
  })

  it('rewrites to its own ephemeral port with only content-type and an empty object body', async () => {
    const active = await start(async () => new Response('{}'))
    const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
    const url = new URL(rewritten.url)
    expect(url.origin).toBe(active.origin)
    expect(url.hostname).toBe('127.0.0.1')
    expect(Number(url.port)).toBe(active.port)
    expect(active.port).toBeGreaterThan(0)
    expect(url.pathname).toMatch(/^\/agy\/[0-9a-f-]{36}$/)
    expect(rewritten.method).toBe('POST')
    expect([...rewritten.headers.keys()]).toEqual(['content-type'])
    expect(rewritten.headers.get('content-type')).toBe('application/json')
    expect(await rewritten.text()).toBe('{}')
  })

  it('conforms to the accepted loopback dispatch contract', async () => {
    // The end-to-end tests check every rewritten request with
    // `assertRewriteConformance` and `normalizedRewrite` in
    // `packages/e2e-tests/docker/ga-loopback-request-contract.ts`
    // (sha256 88a365b6bc792008399e1cdf72f24a5cfb2b0f27f9ed4e205447fd97bd85ce9b).
    // This package cannot import that file, so the same checks are repeated
    // here: loopback URL with a job path, POST, only a JSON content type and
    // an empty-object body.
    const active = await start(async () => new Response('{}'))
    const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
    const url = new URL(rewritten.url)
    expect(url.protocol).toBe('http:')
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).not.toBe('')
    expect(url.pathname).toMatch(/^\/agy\/[0-9a-f-]{36}$/)
    expect([url.search, url.hash, url.username, url.password]).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(rewritten.method).toBe('POST')
    expect(JSON.stringify(Object.fromEntries(rewritten.headers))).toBe(
      JSON.stringify({ 'content-type': 'application/json' }),
    )
    expect(await rewritten.clone().text()).toBe('{}')
  })

  it('refuses the rewrite when a proxy would capture the bridge, registering nothing', async () => {
    const active = await start(async () => new Response('{}'))
    expect(() =>
      active.rewrite(hostRequest(), JOB, { HTTP_PROXY: 'http://proxy:3128' }),
    ).toThrow(LoopbackProxyGuardError)
    expect(active.pendingJobs()).toBe(0)
    expect(() =>
      active.rewrite(hostRequest(), JOB, {
        HTTP_PROXY: 'http://proxy:3128',
        NO_PROXY: '127.0.0.1',
      }),
    ).not.toThrow()
  })

  it('runs a job once with its recorded fields and streams the answer back', async () => {
    const seen: GaBridgeJob[] = []
    const active = await start(async (job) => {
      seen.push(job)
      return new Response('data: {"a":1}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
    const url = rewritten.url
    const response = await fetch(rewritten)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: {"a":1}\n\n')
    expect(seen).toEqual([JOB])
    const again = await fetch(url, { method: 'POST', body: '{}' })
    expect(again.status).toBe(404)
    await again.text()
  })

  it('adds the final SSE separator when the stream ends without one', async () => {
    const active = await start(
      async () =>
        new Response('data: {"a":1}\n\ndata: {"b":2}', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const response = await fetch(
      active.rewrite(hostRequest(), JOB, NO_PROXY_ENV),
    )
    expect(await response.text()).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n')
  })

  it('masks project IDs in pre-header bridge errors', async () => {
    const active = await start(async () => {
      throw new Error('Project: my-real-project-123456 could not be resolved')
    })
    const response = await fetch(
      active.rewrite(hostRequest(), JOB, NO_PROXY_ENV),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        code: 502,
        message: 'Project: my-r****3456 could not be resolved',
        status: 'UNAVAILABLE',
      },
    })
  })

  it('answers 502 with the original message for a failure before upstream headers', async () => {
    const active = await start(async () => {
      throw new Error('connect ECONNREFUSED fake-endpoint')
    })
    const response = await fetch(
      active.rewrite(hostRequest(), JOB, NO_PROXY_ENV),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        code: 502,
        message: 'connect ECONNREFUSED fake-endpoint',
        status: 'UNAVAILABLE',
      },
    })
  })

  it('refuses unknown job paths', async () => {
    const active = await start(async () => new Response('{}'))
    for (const path of ['/agy/not-a-job', '/agy/', '/other']) {
      const response = await fetch(`${active.origin}${path}`, {
        method: 'POST',
        body: '{}',
      })
      expect(response.status).toBe(404)
      await response.text()
    }
  })

  it('aborts the default sender’s transport signal when the host abandons the request', async () => {
    let releaseSender: (() => void) | undefined
    senderResult = () =>
      new Promise((resolve) => {
        releaseSender = () => resolve(new Response('late'))
      })
    bridge = await server.startGaLoopbackBridge({
      execute: (_job, context) => context.send(sendInput(context.signal)),
      send: server.createGaRawSender(),
    })
    const host = new AbortController()
    const pending = fetch(
      bridge.rewrite(hostRequest(host.signal), JOB, NO_PROXY_ENV),
    ).catch(() => undefined)
    try {
      await waitFor(() => senderCalls.length === 1)
      const transportSignal = senderCalls[0]?.options.signal
      expect(transportSignal?.aborted).toBe(false)
      host.abort(new Error('user pressed escape'))
      await waitFor(() => transportSignal?.aborted === true)
      expect(transportSignal?.aborted).toBe(true)
    } finally {
      // Settle everything this case started, whatever it asserted.
      host.abort()
      releaseSender?.()
      await pending
    }
  })

  it('disposal aborts running jobs, closes the port and refuses new rewrites', async () => {
    let jobSignal: AbortSignal | undefined
    const active = await start(
      (_job, context) =>
        new Promise((_resolve, reject) => {
          jobSignal = context.signal
          context.signal.addEventListener('abort', () =>
            reject(context.signal.reason),
          )
        }),
    )
    const origin = active.origin
    const pending = fetch(
      active.rewrite(hostRequest(), JOB, NO_PROXY_ENV),
    ).catch((error: unknown) => error)
    await waitFor(() => jobSignal !== undefined)
    await active.dispose()
    expect(jobSignal?.aborted).toBe(true)
    await pending
    expect(() => active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)).toThrow(
      'disposed',
    )
    const refused = await fetch(`${origin}/agy/x`, { method: 'POST' }).catch(
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    expect(active.pendingJobs()).toBe(0)
  })
})

/**
 * The host types a location directory as an absolute-path brand. This guard
 * grants the brand only after checking the property it stands for, so the
 * fake host receives a genuinely absolute path without a type assertion.
 */
function isAbsoluteLocationDirectory(
  value: string,
): value is GaHostContext['location']['directory'] {
  return isAbsolute(value)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached')
}

describe('hook bodies', () => {
  let bridge: GaLoopbackBridge | null = null
  const ownership = new server.GaRequestOwnership()

  afterEach(async () => {
    await bridge?.dispose()
    bridge = null
    ownership.clear()
  })

  const registered = (modelID: string) =>
    modelID === 'antigravity-gemini-3.5-flash'

  function requestEvent(
    kind: GaHttpRequestEvent['kind'],
    modelID: string,
    request: Request = new Request(JOB.url, {
      method: 'POST',
      headers: { 'x-goog-api-key': placeholderSecret('google') },
      body: JOB.body,
    }),
    variant?: string,
  ): GaHttpRequestEvent {
    return {
      sessionID: 'ses_child',
      kind,
      model: {
        id: modelID,
        providerID: 'google',
        ...(variant === undefined ? {} : { variant }),
      },
      request,
    }
  }

  async function startBridge(
    execute: GaJobExecutor = async () => new Response('{}'),
  ) {
    bridge = await server.startGaLoopbackBridge({
      execute,
      send: server.createGaRawSender(),
    })
    return bridge
  }

  it('leaves prepared real keys and native OAuth untouched before title or model handling', async () => {
    const active = await startBridge()
    const preparedCredentials: Record<string, string>[] = [
      { 'x-goog-api-key': 'synthetic-ga-key' },
      { 'x-goog-api-key': 'native-google-oauth-access' },
      { 'x-goog-api-key': `${placeholderSecret('google')}-not-exact` },
      { 'x-goog-api-key': `Bearer ${placeholderSecret('google')}` },
      { 'x-goog-api-key': `x-${placeholderSecret('google')}` },
      { 'x-goog-api-key': placeholderSecret('google').toUpperCase() },
      {},
      { authorization: 'Bearer native-google-oauth-access' },
    ]
    for (const credentialHeaders of preparedCredentials) {
      for (const [kind, id] of [
        ['title', 'gemini-off-catalog-title-model'],
        ['primary', 'antigravity-gemini-3.5-flash'],
        ['generate', 'antigravity-gemini-3.1-pro'],
      ] as const) {
        const original = new Request(JOB.url, {
          method: 'POST',
          headers: { ...credentialHeaders, 'x-native-header': 'preserve' },
          body: '{ "native" : "bytes é" }',
        })
        const headers = [...original.headers]
        const clone = spyOn(original, 'clone')
        const text = spyOn(original, 'text')
        const event = requestEvent(kind, id, original)
        await server.rewriteGaHttpRequest(event, {
          bridge: active,
          ownership,
          isRegisteredModel: () => {
            throw new Error('unowned model inspected')
          },
          env: NO_PROXY_ENV,
        })
        expect(event.request).toBe(original)
        expect(original.bodyUsed).toBe(false)
        expect(clone).not.toHaveBeenCalled()
        expect(text).not.toHaveBeenCalled()
        expect(await original.text()).toBe('{ "native" : "bytes é" }')
        expect([...original.headers]).toEqual(headers)
        expect(active.pendingJobs()).toBe(0)
      }
    }
  })

  it('refuses owned custom Google origins locally before credentials or bridge jobs', async () => {
    const execute = mock(async () => new Response('{}'))
    const active = await startBridge(execute)
    const rewrite = spyOn(active, 'rewrite')
    const modelLookup = mock(registered)
    for (const baseURL of [
      'http://127.0.0.1:1234/direct/v1',
      'https://generativelanguage.googleapis.com.example.invalid/v1beta',
      'http://generativelanguage.googleapis.com/v1beta',
      'https://generativelanguage.googleapis.com:444/v1beta',
    ]) {
      for (const kind of [
        'primary',
        'compaction',
        'title',
        'generate',
      ] as const) {
        const original = new Request(
          `${baseURL}/models/antigravity-gemini-3.5-flash:streamGenerateContent`,
          {
            method: 'POST',
            headers: { 'x-goog-api-key': placeholderSecret('google') },
            body: JOB.body,
          },
        )
        const clone = spyOn(original, 'clone')
        const event = requestEvent(
          kind,
          'antigravity-gemini-3.5-flash',
          original,
        )
        await expect(
          server.rewriteGaHttpRequest(event, {
            bridge: active,
            ownership,
            isRegisteredModel: modelLookup,
            env: NO_PROXY_ENV,
          }),
        ).rejects.toEqual(
          new Error(
            'Antigravity pool requests need the default Google base URL. Remove the custom baseURL from the Google provider settings.',
          ),
        )
        expect(event.request).toBe(original)
        expect(original.bodyUsed).toBe(false)
        expect(clone).not.toHaveBeenCalled()
        expect(ownership.get(event.sessionID)).toBe(true)
        expect(retryFor(event.sessionID).decision).toEqual({ retry: false })
        expect(active.pendingJobs()).toBe(0)
      }
    }
    expect(modelLookup).not.toHaveBeenCalled()
    expect(rewrite).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(senderCalls).toHaveLength(0)
  })

  it('leaves unowned custom Google origins byte-for-byte unchanged', async () => {
    const execute = mock(async () => new Response('{}'))
    const active = await startBridge(execute)
    const rewrite = spyOn(active, 'rewrite')
    const nativeHeaders: Record<string, string>[] = [
      { 'x-goog-api-key': 'native-key' },
      { 'x-goog-api-key': `${placeholderSecret('google')}-not-exact` },
      { authorization: 'Bearer native-oauth' },
    ]
    for (const headers of nativeHeaders) {
      const original = new Request(
        'http://127.0.0.1:1234/direct/v1/models/native-model:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: { ...headers, 'x-native-header': 'preserve' },
          body: '{ "native" : "bytes é" }',
        },
      )
      const url = original.url
      const beforeHeaders = [...original.headers]
      const clone = spyOn(original, 'clone')
      const event = requestEvent('primary', 'native-model', original)
      await server.rewriteGaHttpRequest(event, {
        bridge: active,
        ownership,
        isRegisteredModel: () => {
          throw new Error('unowned model inspected')
        },
        env: NO_PROXY_ENV,
      })
      expect(event.request).toBe(original)
      expect(original.url).toBe(url)
      expect([...original.headers]).toEqual(beforeHeaders)
      expect(original.bodyUsed).toBe(false)
      expect(clone).not.toHaveBeenCalled()
      expect(await original.text()).toBe('{ "native" : "bytes é" }')
      expect(active.pendingJobs()).toBe(0)
    }
    expect(rewrite).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(senderCalls).toHaveLength(0)
  })

  it('bridges owned canonical Google origins normally', async () => {
    const execute = mock(async (_job: GaBridgeJob) => new Response('{}'))
    const active = await startBridge(execute)
    const event = requestEvent('primary', 'antigravity-gemini-3.5-flash')
    const original = event.request
    await server.rewriteGaHttpRequest(event, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    expect(event.request).not.toBe(original)
    expect(event.request.url.startsWith(`${active.origin}/agy/`)).toBe(true)
    expect(active.pendingJobs()).toBe(1)
    await (await fetch(event.request)).text()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      url: original.url,
      body: JOB.body,
      kind: 'primary',
    })
    expect(active.pendingJobs()).toBe(0)
  })

  it('bridges registered kinds, retired IDs and every title', async () => {
    const active = await startBridge()
    const cases: Array<[GaHttpRequestEvent['kind'], string, boolean]> = [
      ['primary', 'antigravity-gemini-3.5-flash', true],
      ['primary', 'antigravity-gemini-3.1-pro', true],
      ['primary', 'gemini-3.1-pro-low', true],
      ['primary', 'gemini-3.1-pro-high', true],
      ['primary', 'gemini-pro-agent', true],
      ['primary', 'antigravity-gemini-3.6-flash', true],
      ['primary', 'gemini-3.6-flash-low', true],
      ['primary', 'gemini-3.6-flash-medium', true],
      ['primary', 'gemini-3.6-flash-high', true],
      ['primary', 'antigravity-gemini-3.7-flash', true],
      ['primary', 'gemini-3.7-flash-low', true],
      ['primary', 'gemini-3.7-flash-medium', true],
      ['primary', 'gemini-3.7-flash-high', true],
      ['title', 'gemini-off-catalog-title-model', true],
      ['compaction', 'antigravity-gemini-3.5-flash', true],
      ['generate', 'antigravity-gemini-3.5-flash', true],
    ]
    for (const [kind, modelID, rewritten] of cases) {
      const event = requestEvent(kind, modelID)
      const original = event.request
      await server.rewriteGaHttpRequest(event, {
        bridge: active,
        ownership,
        isRegisteredModel: registered,
        env: NO_PROXY_ENV,
      })
      expect(event.request !== original).toBe(rewritten)
      if (rewritten)
        expect(event.request.url.startsWith(active.origin)).toBe(true)
    }
  })

  it('leaves another provider’s requests alone, even for a catalog model id', async () => {
    const active = await startBridge()
    const event = {
      ...requestEvent('title', 'antigravity-gemini-3.5-flash'),
      model: { id: 'antigravity-gemini-3.5-flash', providerID: 'openrouter' },
    }
    const original = event.request
    await server.rewriteGaHttpRequest(event, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    expect(event.request).toBe(original)
    const retry: GaRetryEvent = {
      sessionID: 'ses_child',
      model: { id: 'antigravity-gemini-3.5-flash', providerID: 'openrouter' },
      decision: { retry: true, delay: 2_000 },
    }
    server.decideGaRetry(retry, ownership)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it('refuses owned non-content before model handling and records retry ownership', async () => {
    const active = await startBridge()
    for (const kind of [
      'primary',
      'compaction',
      'title',
      'generate',
    ] as const) {
      const request = new Request(
        'https://generativelanguage.googleapis.com/v1beta/models/x:countTokens',
        {
          method: 'POST',
          headers: { 'x-goog-api-key': placeholderSecret('google') },
          body: '{}',
        },
      )
      const event = requestEvent(kind, 'antigravity-gemini-3.1-pro', request)
      await expect(
        server.rewriteGaHttpRequest(event, {
          bridge: active,
          ownership,
          isRegisteredModel: () => {
            throw new Error('non-content model inspected')
          },
          env: NO_PROXY_ENV,
        }),
      ).rejects.toThrow(server.GA_UNSUPPORTED_REQUEST_MESSAGE)
      expect(ownership.get(event.sessionID)).toBe(true)
      expect(retryFor(event.sessionID).decision).toEqual({ retry: false })
      expect(event.request).toBe(request)
      expect(request.bodyUsed).toBe(false)
      expect(active.pendingJobs()).toBe(0)
    }
  })

  it('records the original body, kind and parent session, and null without a parent header', async () => {
    const jobs: GaBridgeJob[] = []
    const active = await startBridge(async (job) => {
      jobs.push(job)
      return new Response('{}')
    })
    const withParent = requestEvent('title', 'any-title-model')
    await server.rewriteGaHttpRequest(withParent, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    await (await fetch(withParent.request)).text()
    const noParent = requestEvent(
      'primary',
      'antigravity-gemini-3.5-flash',
      new Request(JOB.url, {
        method: 'POST',
        headers: { 'x-goog-api-key': placeholderSecret('google') },
        body: JOB.body,
      }),
    )
    await server.rewriteGaHttpRequest(noParent, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    await (await fetch(noParent.request)).text()
    expect(
      jobs.map((job) => [job.kind, job.parentSessionID, job.body]),
    ).toEqual([
      ['title', null, JOB.body],
      ['primary', null, JOB.body],
    ])
    const parented = requestEvent(
      'primary',
      'antigravity-gemini-3.5-flash',
      new Request(JOB.url, {
        method: 'POST',
        body: JOB.body,
        headers: {
          'x-opencode-parent-session-id': 'ses_parent',
          'x-goog-api-key': placeholderSecret('google'),
        },
      }),
    )
    await server.rewriteGaHttpRequest(parented, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    await (await fetch(parented.request)).text()
    expect(jobs[2]?.parentSessionID).toBe('ses_parent')
    expect(jobs[2]?.sessionID).toBe('ses_child')
  })

  it('normalizes the native default variant before creating a GA bridge job', async () => {
    const jobs: GaBridgeJob[] = []
    const active = await startBridge(async (job) => {
      jobs.push(job)
      return new Response('{}')
    })
    const modelID = 'antigravity-gemini-3.8-flash'
    for (const variant of ['default', 'low', undefined] as const) {
      const event = requestEvent('primary', modelID, undefined, variant)
      await server.rewriteGaHttpRequest(event, {
        bridge: active,
        ownership,
        isRegisteredModel: (id) => id === modelID,
        env: NO_PROXY_ENV,
      })
      await (await fetch(event.request)).text()
    }
    expect(jobs.map((job) => job.variant)).toEqual([null, 'low', null])
    expect(jobs.every((job) => job.modelID === modelID)).toBe(true)
  })

  it('throws on a proxy refusal without replacing or consuming the request', async () => {
    const active = await startBridge()
    const event = requestEvent('primary', 'antigravity-gemini-3.5-flash')
    const original = event.request
    await expect(
      server.rewriteGaHttpRequest(event, {
        bridge: active,
        ownership,
        isRegisteredModel: registered,
        env: { http_proxy: 'http://proxy:3128' },
      }),
    ).rejects.toBeInstanceOf(LoopbackProxyGuardError)
    expect(event.request).toBe(original)
    expect(original.bodyUsed).toBe(false)
    expect(active.pendingJobs()).toBe(0)
  })

  it('fails an owned response read with the genuine post-header error, never a success', async () => {
    const genuine = new Error('upstream reset after 1 frame')
    const firstFrame = 'data: {"a":1}\n\n'
    // The upstream fails only after this gate opens. The test opens it once
    // the client has read the whole first frame through the adapted body, so
    // the failure is genuinely after headers and after delivered bytes.
    const faultGate = Promise.withResolvers<void>()
    // Declared outside the try so the finally can always release it.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const active = await startBridge(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(firstFrame))
              },
              async pull(controller) {
                await faultGate.promise
                controller.error(genuine)
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      )
      const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
      const response = await fetch(rewritten)
      const event = { request: rewritten, response }
      server.adaptGaHttpResponse(event, active)
      expect(event.response).not.toBe(response)
      expect(event.response.status).toBe(200)
      const body = event.response.body
      expect(body).not.toBeNull()
      if (!body) throw new Error('the adapted response has no body')
      reader = body.getReader()
      // Read until the complete first frame has arrived, never past it.
      const decoder = new TextDecoder()
      let received = ''
      while (received.length < firstFrame.length) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += decoder.decode(chunk.value, { stream: true })
      }
      expect(received).toBe(firstFrame)
      faultGate.resolve()
      const failure = await reader.read().then(
        (result) => result,
        (error: unknown) => error,
      )
      expect(failure).toBe(genuine)
    } finally {
      // Settle the upstream and the client stream whatever failed above, so
      // the bridge disposal in afterEach never waits on a pending upstream
      // read. Cleanup failures must not replace the primary failure.
      faultGate.resolve()
      await reader?.cancel().catch(() => undefined)
    }
  })

  it('delivers a first chunk and then the genuine error when the upstream fails immediately after it', async () => {
    const genuine = new Error('upstream reset right after the first frame')
    const firstFrame = 'data: {"a":1}\n\n'
    // No barrier: the upstream errors on the very next read after its first
    // chunk, before the client has read anything.
    const active = await startBridge(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(firstFrame))
            },
            pull(controller) {
              controller.error(genuine)
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
    // The host's dispatch must get a response, not a connection reset.
    const response = await fetch(rewritten)
    const event = { request: rewritten, response }
    server.adaptGaHttpResponse(event, active)
    expect(event.response).not.toBe(response)
    expect(event.response.status).toBe(200)
    const body = event.response.body
    expect(body).not.toBeNull()
    if (!body) throw new Error('the adapted response has no body')
    const reader = body.getReader()
    try {
      const decoder = new TextDecoder()
      let received = ''
      let failure: unknown = null
      while (failure === null) {
        const chunk = await reader.read().then(
          (result) => result,
          (error: unknown) => {
            failure = error
            return null
          },
        )
        if (!chunk || chunk.done) break
        received += decoder.decode(chunk.value, { stream: true })
      }
      // The real content arrives first, then the original error, never a
      // clean end.
      expect(received).toBe(firstFrame)
      expect(failure).toBe(genuine)
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  })

  it('delivers the genuine error when the upstream body fails before any byte', async () => {
    const genuine = new Error('upstream reset before the first frame')
    const active = await startBridge(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(genuine)
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const rewritten = active.rewrite(hostRequest(), JOB, NO_PROXY_ENV)
    const response = await fetch(rewritten)
    const event = { request: rewritten, response }
    server.adaptGaHttpResponse(event, active)
    expect(event.response.status).toBe(200)
    const failure = await event.response.text().then(
      (text) => text,
      (error: unknown) => error,
    )
    expect(failure).toBe(genuine)
  })

  it('leaves responses to requests it does not own unchanged', async () => {
    const active = await startBridge()
    const response = new Response('ok')
    const event = { request: hostRequest(), response }
    server.adaptGaHttpResponse(event, active)
    expect(event.response).toBe(response)
  })

  function retryFor(sessionID: string): GaRetryEvent {
    const event: GaRetryEvent = {
      sessionID,
      model: { id: 'gemini-off-catalog', providerID: 'google' },
      decision: { retry: true, delay: 1234 },
    }
    server.decideGaRetry(event, ownership)
    return event
  }

  it('tracks interleaved sessions and both ownership switch directions before retry', async () => {
    const active = await startBridge()
    const transport = async (sessionID: string, owned: boolean) => {
      const event = requestEvent('primary', 'antigravity-gemini-3.5-flash')
      const prepared = event.request
      if (!owned) prepared.headers.set('x-goog-api-key', 'native-key')
      await server.rewriteGaHttpRequest(
        { ...event, sessionID },
        {
          bridge: active,
          ownership,
          isRegisteredModel: registered,
          env: NO_PROXY_ENV,
        },
      )
    }
    expect(retryFor('missing').decision).toEqual({ retry: true, delay: 1234 })
    await transport('a', true)
    await transport('b', false)
    expect(retryFor('a').decision).toEqual({ retry: false })
    expect(retryFor('b').decision).toEqual({ retry: true, delay: 1234 })
    await transport('a', false)
    await transport('b', true)
    expect(retryFor('a').decision).toEqual({ retry: true, delay: 1234 })
    expect(retryFor('b').decision).toEqual({ retry: false })
  })

  it('retains title-before-primary and response-before-retry ownership without owning unrelated responses', async () => {
    const active = await startBridge(
      async () => new Response('upstream error', { status: 503 }),
    )
    const title = requestEvent('title', 'gemini-off-catalog')
    await server.rewriteGaHttpRequest(title, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    expect(retryFor(title.sessionID).decision).toEqual({ retry: false })
    const primary = requestEvent('primary', 'antigravity-gemini-3.5-flash')
    await server.rewriteGaHttpRequest(primary, {
      bridge: active,
      ownership,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    const response = {
      request: primary.request,
      response: await fetch(primary.request),
    }
    server.adaptGaHttpResponse(response, active)
    expect(response.response.status).toBe(503)
    await response.response.text()
    expect(retryFor(primary.sessionID).decision).toEqual({ retry: false })
    const foreignResponse = new Response('native success')
    const foreign = { request: hostRequest(), response: foreignResponse }
    server.adaptGaHttpResponse(foreign, active)
    expect(foreign.response).toBe(foreignResponse)
  })

  it('refuses every owned off-catalog non-title kind locally without consuming bytes or allowing host retry', async () => {
    const active = await startBridge()
    for (const kind of ['primary', 'compaction', 'generate'] as const) {
      const event = requestEvent(kind, 'gemini-off-catalog')
      const original = event.request
      await expect(
        server.rewriteGaHttpRequest(event, {
          bridge: active,
          ownership,
          isRegisteredModel: registered,
          env: NO_PROXY_ENV,
        }),
      ).rejects.toThrow(server.GA_UNSUPPORTED_REQUEST_MESSAGE)
      expect(original.bodyUsed).toBe(false)
      expect(event.request).toBe(original)
      expect(active.pendingJobs()).toBe(0)
      expect(retryFor(event.sessionID).decision).toEqual({ retry: false })
    }
  })

  it('evicts the oldest-updated session at the named 512-entry bound', () => {
    expect(server.GA_RETRY_OWNERSHIP_LIMIT).toBe(512)
    for (let i = 0; i < 512; i++) ownership.record(`session-${i}`, true)
    ownership.record('session-0', false)
    ownership.record('new-session', true)
    expect(ownership.get('session-1')).toBeUndefined()
    expect(ownership.get('session-0')).toBe(false)
    expect(retryFor('session-1').decision).toEqual({ retry: true, delay: 1234 })
    expect(retryFor('session-2').decision).toEqual({ retry: false })
    ownership.record('newer-session', false)
    expect(ownership.get('session-2')).toBeUndefined()
    expect(ownership.get('session-3')).toBe(true)
  })

  it('disables host retries only for latest-owned sessions, independent of model', () => {
    // Typed as the hook's event so `decision` keeps its declared union and
    // the hook's write of `{ retry: false }` is observable to the matcher.
    ownership.record('owned', true)
    ownership.record('unowned', false)
    const own: GaRetryEvent = {
      sessionID: 'owned',
      model: { id: 'antigravity-gemini-3.5-flash', providerID: 'google' },
      decision: { retry: true, delay: 2_000 },
    }
    const other: GaRetryEvent = {
      sessionID: 'unowned',
      model: { id: 'gemini-2.5-pro', providerID: 'google' },
      decision: { retry: true, delay: 2_000 },
    }
    server.decideGaRetry(own, ownership)
    server.decideGaRetry(other, ownership)
    expect(own.decision).toEqual({ retry: false })
    expect(other.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it('keeps latest-owned retry policy for withdrawn Gemini selectors and native routes', () => {
    ownership.record('owned', true)
    for (const id of [
      'antigravity-gemini-3.1-pro',
      'gemini-3.1-pro-low',
      'gemini-3.1-pro-high',
      'gemini-pro-agent',
      'antigravity-gemini-3.6-flash',
      'gemini-3.6-flash-low',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-high',
      'antigravity-gemini-3.7-flash',
      'gemini-3.7-flash-low',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-high',
    ]) {
      const event: GaRetryEvent = {
        sessionID: 'owned',
        model: { id, providerID: 'google' },
        decision: { retry: true, delay: 2000 },
      }
      server.decideGaRetry(event, ownership)
      expect(event.decision).toEqual({ retry: false })
    }
  })
})

describe('setup against a host context', () => {
  let root: string
  let savedConfigDir: string | undefined
  const cleanups: Array<() => unknown> = []

  beforeAll(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = savedConfigDir
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function prepareRoot(): void {
    root = mkdtempSync(join(tmpdir(), 'ga-setup-'))
    process.env.OPENCODE_CONFIG_DIR = join(root, 'user-config')
    mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
  }

  function locationDirectory(name: string): string {
    const directory = join(root, name)
    mkdirSync(join(directory, '.opencode'), { recursive: true })
    writeFileSync(
      join(directory, '.opencode', 'antigravity.json'),
      JSON.stringify({
        keep_thinking: false,
        debug: false,
        background_quota_refresh: false,
        proactive_token_refresh: false,
      }),
    )
    return directory
  }

  /** A host context that records registrations and their disposal. */
  /** Commands the fake host received, by name. */
  type RegisteredCommand = Parameters<
    Parameters<Parameters<GaHostContext['command']['transform']>[0]>[0]['add']
  >[0]
  type HookCallbacks = Partial<{
    [K in keyof SessionHooks]: (event: SessionHooks[K]) => void | Promise<void>
  }>

  function fakeHost(
    directory: string,
    log: string[],
    failures: { register?: Error; hook?: string } = {},
    commands: RegisteredCommand[] = [],
    hooks: HookCallbacks = {},
  ): GaHostContext {
    const registration = (name: string) => ({
      dispose: async () => {
        log.push(`dispose ${name}`)
      },
    })
    if (!isAbsoluteLocationDirectory(directory)) {
      throw new Error(`test location is not an absolute path: ${directory}`)
    }
    return {
      location: { directory },
      session: {
        hook: async (name, callback, options) => {
          const label = `hook ${String(name)} ${JSON.stringify(options)}`
          if (failures.hook === String(name)) throw new Error(`no ${label}`)
          log.push(label)
          Object.assign(hooks, { [name]: callback })
          return registration(`hook ${String(name)}`)
        },
      },
      provider: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            add: () => undefined,
            update: () => undefined,
            remove: () => undefined,
            models: {
              set: () => undefined,
              update: () => undefined,
              remove: () => undefined,
            },
          })
          log.push('transform provider')
          return registration('provider transform')
        },
        reload: async () => {
          log.push('reload provider')
        },
      },
      rpc: {
        register: async (definition, _handlers) => {
          if (failures.register) throw failures.register
          log.push(`register ${definition.id}`)
          return {
            ...registration(`rpc ${definition.id}`),
            events: { emit: async () => undefined },
          }
        },
      },
      command: {
        transform: async (callback) => {
          callback({
            add: (definition) => {
              commands.push(definition)
              log.push(`add command ${definition.name}`)
            },
          })
          return registration('command transform')
        },
        reload: async () => {
          log.push('reload commands')
        },
      },
    }
  }

  function fakeServices(
    log: string[],
    opened: Array<{ scope: AntigravityRpcScope; signal: AbortSignal }> = [],
    execute: GaJobExecutor = async () => new Response('{}'),
  ): GaLocationServicesFactory & { calls: string[] } {
    const calls: string[] = []
    const factory: GaLocationServicesFactory = async ({ directory }) => {
      calls.push(directory)
      const services: GaLocationServices = {
        runtime: {
          quotaSnapshots: createMemoryQuotaSnapshots(),
          fetchAccountQuota: async () => ({ index: 0, status: 'disabled' }),
          refreshToken: async () => undefined,
        },
        start: async () => ({
          execute,
          state: {
            read: async () => ({
              readSeq: 1,
              accounts: { kind: 'complete', rows: [] },
              route: null,
              status: {
                checkedAt: null,
                quotaBackoffUntil: null,
                routingAuthoritative: false,
              },
              settings: {
                selectionStrategy: 'hybrid',
                killswitch: { enabled: false, minimumRemainingPercent: 5 },
                logLevel: 'info',
                dump: { enabled: false },
              },
            }),
          },
          commands: {
            apply: async () => ({
              command: 'antigravity',
              ok: true,
              text: '',
              menu: {
                command: 'antigravity',
                title: 'Antigravity',
                sections: [],
              },
            }),
            open: async (input) => {
              opened.push(input)
              log.push(`open menu ${JSON.stringify(input.scope)}`)
            },
          },
        }),
        dispose: async () => {
          log.push('dispose services')
        },
      }
      return services
    }
    return Object.assign(factory, { calls })
  }

  function preparedEvent(key: string): SessionHttpRequest {
    return {
      ...JSON.parse(
        '{"sessionID":"ses_prepared","agent":"build","kind":"primary","model":{"id":"antigravity-gemini-3.5-flash","providerID":"google"}}',
      ),
      request: new Request(JOB.url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key },
        body: JOB.body,
      }),
    }
  }

  async function hostRetry(hooks: HookCallbacks): Promise<SessionRetry> {
    const retry: SessionRetry = JSON.parse(
      '{"sessionID":"ses_prepared","agent":"build","model":{"id":"antigravity-gemini-3.5-flash","providerID":"google"},"attempt":1,"error":{},"decision":{"retry":true,"delay":1234}}',
    )
    await hooks.retry?.(retry)
    return retry
  }

  it('uses prepared credentials in both active switch directions with no connection read or event facade', async () => {
    prepareRoot()
    const hooks: HookCallbacks = {}
    const jobs: GaBridgeJob[] = []
    const log: string[] = []
    let active = 'native-key'
    let connectionReads = 0
    const host = fakeHost(locationDirectory('prepared'), log, {}, [], hooks)
    const cleanup = await server.setupGaActivation(
      {
        ...host,
        integration: {
          connection: {
            active: async () => {
              connectionReads++
              return JSON.parse(
                JSON.stringify({ type: 'credential', id: active }),
              )
            },
            resolve: async () => {
              connectionReads++
              throw new Error('must not resolve active connection')
            },
            status: async () => {
              connectionReads++
              throw new Error('must not inspect connection status')
            },
          },
        },
      },
      fakeServices(log, [], async (job) => {
        jobs.push(job)
        return new Response('real upstream failure', { status: 503 })
      }),
    )
    if (cleanup) cleanups.push(cleanup)
    for (const [preparedKey, switchedActive] of [
      ['native-key', placeholderSecret('google')],
      [placeholderSecret('google'), 'native-key'],
      ['native-key', 'native-key'],
      [placeholderSecret('google'), placeholderSecret('google')],
    ] as const) {
      const event = preparedEvent(preparedKey)
      const original = event.request
      const clone = spyOn(original, 'clone')
      const text = spyOn(original, 'text')
      active = switchedActive
      const beforeJobs = jobs.length
      await hooks['http.request']?.(event)
      if (preparedKey === 'native-key') {
        expect(event.request).toBe(original)
        expect(clone).not.toHaveBeenCalled()
        expect(text).not.toHaveBeenCalled()
        expect(jobs).toHaveLength(beforeJobs)
        expect((await hostRetry(hooks)).decision).toEqual({
          retry: true,
          delay: 1234,
        })
      } else {
        expect(event.request).not.toBe(original)
        expect(event.request.headers.has('x-goog-api-key')).toBe(false)
        expect((await fetch(event.request)).status).toBe(503)
        expect(jobs).toHaveLength(beforeJobs + 1)
        expect((await hostRetry(hooks)).decision).toEqual({ retry: false })
      }
    }
    expect(connectionReads).toBe(0)
  })

  it('clears session ownership on genuine event subscription and aborts the subscriber on teardown', async () => {
    prepareRoot()
    const hooks: HookCallbacks = {}
    const log: string[] = []
    type HostEvent =
      ReturnType<
        NonNullable<GaHostContext['event']>['subscribe']
      > extends AsyncIterable<infer E>
        ? E
        : never
    let controller!: ReadableStreamDefaultController<HostEvent>
    let subscriptionSignal: AbortSignal | undefined
    let stopped = false
    const stream = new ReadableStream<HostEvent>({
      start: (value) => {
        controller = value
      },
    })
    const host = fakeHost(locationDirectory('events'), log, {}, [], hooks)
    const cleanup = await server.setupGaActivation(
      {
        ...host,
        event: {
          subscribe: async function* (options) {
            subscriptionSignal = options?.signal
            subscriptionSignal?.addEventListener(
              'abort',
              () => controller.close(),
              { once: true },
            )
            try {
              for await (const event of stream) yield event
            } finally {
              stopped = true
            }
          },
        },
      },
      fakeServices(log),
    )
    if (cleanup) cleanups.push(cleanup)
    await hooks['http.request']?.(preparedEvent(placeholderSecret('google')))
    expect((await hostRetry(hooks)).decision).toEqual({ retry: false })
    controller.enqueue(
      JSON.parse('{"type":"session.deleted","data":{"sessionID":"ses_other"}}'),
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect((await hostRetry(hooks)).decision).toEqual({ retry: false })
    controller.enqueue(
      JSON.parse(
        '{"type":"session.deleted","data":{"sessionID":"ses_prepared"}}',
      ),
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect((await hostRetry(hooks)).decision).toEqual({
      retry: true,
      delay: 1234,
    })
    await hooks['http.request']?.(preparedEvent(placeholderSecret('google')))
    await cleanup?.()
    expect(subscriptionSignal?.aborted).toBe(true)
    expect(stopped).toBe(true)
    expect((await hostRetry(hooks)).decision).toEqual({
      retry: true,
      delay: 1234,
    })
  })

  it('resolves undefined for a legacy context without building anything', async () => {
    const log: string[] = []
    const services = fakeServices(log)
    const plugin = server.createGaPluginFromServices(services)
    expect(plugin.id).toBe('cortexkit.antigravity-auth')
    // An OpenCode 1 core loader passes a context with neither `session` nor
    // `location`. JSON.parse yields an untyped value, which stands in for
    // that differently shaped host input without a type assertion.
    const legacy: GaHostContext = JSON.parse(
      '{"options":{},"command":{},"integration":{}}',
    )
    const result = await server.setupGaActivation(legacy, services)
    expect(result).toBeUndefined()
    expect(services.calls).toEqual([])
    expect(log).toEqual([])
  })

  it('writes the process heartbeat for the location and keeps it after Cleanup', async () => {
    prepareRoot()
    const target = heartbeats.processHeartbeatPath(process.pid)
    // Start from no heartbeat, whatever earlier setups in this file left.
    heartbeats.__resetProcessHeartbeatForTest()
    rmSync(target, { force: true })
    const log: string[] = []
    const cleanup = await server.setupGaActivation(
      fakeHost(locationDirectory('a'), log),
      fakeServices(log),
    )
    const manifest: { version: string } = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    )
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('prepareRoot did not set the config dir')
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      pid: process.pid,
      version: manifest.version,
      startedAt: expect.any(Number),
      layouts: { [realpathSync(configDir).toLowerCase()]: 'legacy' },
    })
    await cleanup?.()
    // The process keeps the OpenCode config folder layout until it exits.
    expect(readFileSync(target, 'utf8')).toContain('"legacy"')
  })

  it('registers the three Google-scoped hooks and the RPC, and its Cleanup removes exactly those', async () => {
    prepareRoot()
    const log: string[] = []
    const cleanup = await server.setupGaActivation(
      fakeHost(locationDirectory('a'), log),
      fakeServices(log),
    )
    expect(typeof cleanup).toBe('function')
    expect(log).toEqual([
      'register antigravity-auth',
      'transform provider',
      'reload provider',
      'add command antigravity',
      'reload commands',
      'hook http.response {"providerID":"google"}',
      'hook retry {"providerID":"google"}',
      'hook http.request {"providerID":"google"}',
    ])
    log.length = 0
    await cleanup?.()
    await cleanup?.()
    expect(log).toEqual([
      'dispose hook http.request',
      'dispose hook retry',
      'dispose hook http.response',
      'dispose command transform',
      'dispose provider transform',
      'dispose rpc antigravity-auth',
      'dispose services',
    ])
  })

  it('registers /antigravity, which opens the menu in the session that ran it, until Cleanup', async () => {
    prepareRoot()
    const log: string[] = []
    const commands: RegisteredCommand[] = []
    const opened: Array<{ scope: AntigravityRpcScope; signal: AbortSignal }> =
      []
    const cleanup = await server.setupGaActivation(
      fakeHost(locationDirectory('a'), log, {}, commands),
      fakeServices(log, opened),
    )
    expect(commands.map((command) => command.name)).toEqual(['antigravity'])
    const command = commands[0]
    if (!command) throw new Error('no command registered')
    // The host's branded session id is a plain string at runtime.
    const invocation: Parameters<RegisteredCommand['execute']>[0] = JSON.parse(
      '{"sessionID":"ses_cmd","prompt":[],"delivery":"queue"}',
    )
    await command.execute(invocation)
    expect(opened.map((entry) => entry.scope)).toEqual([
      { kind: 'session', sessionID: 'ses_cmd' },
    ])
    expect(opened[0]?.signal.aborted).toBe(false)
    log.length = 0
    await cleanup?.()
    // Cleanup removes the command before anything else it registered, and
    // aborts the signal its runs were given.
    expect(log[0]).toBe('dispose hook http.request')
    expect(log).toContain('dispose command transform')
    expect(opened[0]?.signal.aborted).toBe(true)
  })

  it('refuses a host without command registration before building anything', async () => {
    const log: string[] = []
    const services = fakeServices(log)
    const { command: _missing, ...withoutCommands } = fakeHost(
      locationDirectory('a'),
      log,
    )
    const error = await server
      .setupGaActivation(
        // A host whose command domain has no `transform`. JSON.parse yields
        // an untyped empty object for it, without a type assertion.
        { ...withoutCommands, command: JSON.parse('{}') },
        services,
      )
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(server.GaSetupContextError)
    expect(
      error instanceof server.GaSetupContextError && error.missing,
    ).toEqual(['command.transform'])
    expect(services.calls).toEqual([])
  })

  it('rolls back everything when RPC registration fails', async () => {
    prepareRoot()
    const log: string[] = []
    const failure = new Error('register refused')
    await expect(
      server.setupGaActivation(
        fakeHost(locationDirectory('a'), log, { register: failure }),
        fakeServices(log),
      ),
    ).rejects.toBe(failure)
    expect(log).toEqual(['dispose services'])
  })

  it('rolls back already-registered hooks and RPC when a later hook fails', async () => {
    prepareRoot()
    const log: string[] = []
    await expect(
      server.setupGaActivation(
        fakeHost(locationDirectory('a'), log, { hook: 'http.request' }),
        fakeServices(log),
      ),
    ).rejects.toThrow('no hook http.request')
    expect(log).toEqual([
      'register antigravity-auth',
      'transform provider',
      'reload provider',
      'add command antigravity',
      'reload commands',
      'hook http.response {"providerID":"google"}',
      'hook retry {"providerID":"google"}',
      'dispose hook retry',
      'dispose hook http.response',
      'dispose command transform',
      'dispose provider transform',
      'dispose rpc antigravity-auth',
      'dispose services',
    ])
  })

  it('createGaAntigravityPlugin is the plugin over the production services factory', async () => {
    // Compile time: the production export is a services factory and the
    // wrapper's result is the host plugin type.
    const factory: GaLocationServicesFactory = createGaLocationServices
    const plugin: import('@opencode/plugin').Plugin.Plugin =
      server.createGaAntigravityPlugin()
    expect(typeof factory).toBe('function')
    expect(plugin.id).toBe('cortexkit.antigravity-auth')
    // An OpenCode 1 core loader's context makes setup a no-op that never
    // reaches the services. JSON.parse yields an untyped value standing in
    // for that differently shaped host input.
    const legacy: GaHostContext = JSON.parse('{"options":{}}')
    expect(
      await server.setupGaActivation(legacy, createGaLocationServices),
    ).toBeUndefined()
  })

  it('registers the real services for an uninitialized location without opening its local store', async () => {
    prepareRoot()
    const log: string[] = []
    const directory = locationDirectory('uninitialized')
    const plugin = server.createGaAntigravityPlugin()
    // The production setup accepts the full host context type; the fake
    // host provides only the parts setup uses, through the same function.
    const cleanup = await server.setupGaActivation(
      fakeHost(directory, log),
      createGaLocationServices,
    )
    expect(typeof plugin.setup).toBe('function')
    if (!cleanup) throw new Error('the native host received no cleanup')
    try {
      expect(log.length).toBeGreaterThan(0)
      expect(
        readdirSync(directory, { recursive: true }).map((entry) =>
          String(entry),
        ),
      ).toEqual(['.opencode', join('.opencode', 'antigravity.json')])
    } finally {
      await cleanup()
    }
    expect(log).toContain('dispose rpc antigravity-auth')
  })

  it('one location’s Cleanup leaves another location’s registrations in place', async () => {
    prepareRoot()
    const logA: string[] = []
    const logB: string[] = []
    const cleanupA = await server.setupGaActivation(
      fakeHost(locationDirectory('a'), logA),
      fakeServices(logA),
    )
    const cleanupB = await server.setupGaActivation(
      fakeHost(locationDirectory('b'), logB),
      fakeServices(logB),
    )
    if (cleanupB) cleanups.push(cleanupB)
    logB.length = 0
    await cleanupA?.()
    expect(logA.filter((line) => line.startsWith('dispose'))).toHaveLength(7)
    expect(logB).toEqual([])
  })
})

describe('model registration', () => {
  const catalog = server.gaCatalogModels()

  it('registers every public catalog id on the Google provider with only enabled variants', () => {
    expect(catalog.has('antigravity-gemini-4-argon')).toBe(true)
    for (const id of [
      'antigravity-gemini-3.1-pro',
      'antigravity-gemini-3.6-flash',
      'antigravity-gemini-3.7-flash',
    ])
      expect(catalog.has(id)).toBe(false)
    const { getPublicModelDefinitions } = realCore
    const definitions = getPublicModelDefinitions()
    expect([...catalog.keys()].sort()).toEqual(Object.keys(definitions).sort())
    for (const [id, info] of catalog) {
      const definition = definitions[id]
      // Branded ids are strings at runtime; widening them to `string` keeps
      // the same strict equality checks without asserting a brand.
      const registeredID: string = info.id
      const registeredModelID: string = info.modelID
      const registeredProviderID: string = info.providerID
      expect(registeredID).toBe(id)
      expect(registeredModelID).toBe(id)
      expect(registeredProviderID).toBe('google')
      expect(info.enabled).toBe(true)
      const enabled = Object.entries(definition?.variants ?? {})
        .filter(([, variant]) => variant.disabled !== true)
        .map(([variantID]) => variantID)
      const variantIDs: string[] = info.variants.map((variant) => variant.id)
      expect(variantIDs).toEqual(enabled)
      expect(info.limit.context).toBe(definition?.limit.context ?? -1)
    }
  })

  it('never offers a disabled variant', () => {
    const definition = Object.values(realCore.getPublicModelDefinitions())[0]
    if (!definition) throw new Error('Missing source model definition')
    const info = server.toGaModelInfo('disabled-variant-probe', {
      ...definition,
      variants: {
        low: { thinkingLevel: 'low' },
        excluded: { thinkingLevel: 'high', disabled: true },
      },
    })
    const variantIDs: string[] = info.variants.map((variant) => variant.id)
    expect(variantIDs).toEqual(['low'])
  })

  it('keeps the provider’s other models and replaces only catalog ids', () => {
    const other = server.toGaModelInfo('gemini-2.5-pro', {
      ...[...Object.values(realCore.getPublicModelDefinitions())][0]!,
      name: 'Stock model',
    })
    const firstCatalogId = [...catalog.keys()][0] ?? ''
    const stale = server.toGaModelInfo(firstCatalogId, {
      ...realCore.getPublicModelDefinitions()[firstCatalogId]!,
      name: 'stale copy',
    })
    let written: readonly import('@opencode/plugin').Model.Info[] = []
    server.registerGaModels(
      {
        get: (providerID) =>
          providerID === 'google'
            ? {
                models: new Map([
                  [other.id, other],
                  [stale.id, stale],
                ]),
              }
            : undefined,
        models: {
          set: (_providerID, models) => {
            written = models
          },
        },
      },
      catalog,
    )
    expect(written.map((model) => model.name)).toContain('Stock model')
    expect(written.map((model) => model.name)).not.toContain('stale copy')
    expect(written).toHaveLength(catalog.size + 1)
  })

  it('registers nothing when the host has no Google provider', () => {
    let calls = 0
    server.registerGaModels(
      {
        get: () => undefined,
        models: {
          set: () => {
            calls += 1
          },
        },
      },
      catalog,
    )
    expect(calls).toBe(0)
  })
})
