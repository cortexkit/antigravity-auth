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

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type * as Core from '@cortexkit/antigravity-auth-core'

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
const { LoopbackProxyGuardError } = await import('../proxy-guard.ts')

type GaSendInput = import('./index.ts').GaSendInput
type GaPluginOverrides = import('./index.ts').GaPluginOverrides
type ObserveRawSenderSignal = import('./index.ts').ObserveRawSenderSignal
type GaBridgeJob = import('./index.ts').GaBridgeJob
type GaLoopbackBridge = import('./index.ts').GaLoopbackBridge
type GaJobExecutor = import('./index.ts').GaJobExecutor
type GaHostContext = import('./index.ts').GaHostContext
type GaHttpRequestEvent = import('./index.ts').GaHttpRequestEvent
type GaRetryEvent = import('./index.ts').GaRetryEvent
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
    auth: { type: 'oauth', refresh: 'fake-refresh', access: 'fake-access' },
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

  afterEach(async () => {
    await bridge?.dispose()
    bridge = null
  })

  const registered = (modelID: string) =>
    modelID === 'antigravity-gemini-3.5-flash'

  function requestEvent(
    kind: GaHttpRequestEvent['kind'],
    modelID: string,
    request: Request = hostRequest(),
  ): GaHttpRequestEvent {
    return {
      sessionID: 'ses_child',
      kind,
      model: { id: modelID, providerID: 'google' },
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

  it('rewrites a registered primary and every title, and leaves other requests alone', async () => {
    const active = await startBridge()
    const cases: Array<[GaHttpRequestEvent['kind'], string, boolean]> = [
      ['primary', 'antigravity-gemini-3.5-flash', true],
      ['title', 'gemini-off-catalog-title-model', true],
      ['primary', 'gemini-2.5-pro', false],
      ['compaction', 'gemini-2.5-pro', false],
    ]
    for (const [kind, modelID, rewritten] of cases) {
      const event = requestEvent(kind, modelID)
      const original = event.request
      await server.rewriteGaHttpRequest(event, {
        bridge: active,
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
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    expect(event.request).toBe(original)
    const retry: GaRetryEvent = {
      model: { id: 'antigravity-gemini-3.5-flash', providerID: 'openrouter' },
      decision: { retry: true, delay: 2_000 },
    }
    server.decideGaRetry(retry, registered)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it('leaves non-content Google requests alone even for registered models', async () => {
    const active = await startBridge()
    const request = new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/x:countTokens',
      { method: 'POST', body: '{}' },
    )
    const event = requestEvent(
      'primary',
      'antigravity-gemini-3.5-flash',
      request,
    )
    await server.rewriteGaHttpRequest(event, {
      bridge: active,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    expect(event.request).toBe(request)
    expect(active.pendingJobs()).toBe(0)
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
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    await (await fetch(withParent.request)).text()
    const noParent = requestEvent(
      'primary',
      'antigravity-gemini-3.5-flash',
      new Request(JOB.url, { method: 'POST', body: JOB.body }),
    )
    await server.rewriteGaHttpRequest(noParent, {
      bridge: active,
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
        headers: { 'x-opencode-parent-session-id': 'ses_parent' },
      }),
    )
    await server.rewriteGaHttpRequest(parented, {
      bridge: active,
      isRegisteredModel: registered,
      env: NO_PROXY_ENV,
    })
    await (await fetch(parented.request)).text()
    expect(jobs[2]?.parentSessionID).toBe('ses_parent')
    expect(jobs[2]?.sessionID).toBe('ses_child')
  })

  it('throws on a proxy refusal without replacing or consuming the request', async () => {
    const active = await startBridge()
    const event = requestEvent('primary', 'antigravity-gemini-3.5-flash')
    const original = event.request
    await expect(
      server.rewriteGaHttpRequest(event, {
        bridge: active,
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

  it('leaves responses to requests it does not own unchanged', async () => {
    const active = await startBridge()
    const response = new Response('ok')
    const event = { request: hostRequest(), response }
    server.adaptGaHttpResponse(event, active)
    expect(event.response).toBe(response)
  })

  it('disables host retries only for registered models', () => {
    // Typed as the hook's event so `decision` keeps its declared union and
    // the hook's write of `{ retry: false }` is observable to the matcher.
    const own: GaRetryEvent = {
      model: { id: 'antigravity-gemini-3.5-flash', providerID: 'google' },
      decision: { retry: true, delay: 2_000 },
    }
    const other: GaRetryEvent = {
      model: { id: 'gemini-2.5-pro', providerID: 'google' },
      decision: { retry: true, delay: 2_000 },
    }
    server.decideGaRetry(own, registered)
    server.decideGaRetry(other, registered)
    expect(own.decision).toEqual({ retry: false })
    expect(other.decision).toEqual({ retry: true, delay: 2_000 })
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
  function fakeHost(
    directory: string,
    log: string[],
    failures: { register?: Error; hook?: string } = {},
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
        hook: async (name, _callback, options) => {
          const label = `hook ${String(name)} ${JSON.stringify(options)}`
          if (failures.hook === String(name)) throw new Error(`no ${label}`)
          log.push(label)
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
    }
  }

  function fakeServices(
    log: string[],
  ): GaLocationServicesFactory & { calls: string[] } {
    const calls: string[] = []
    const factory: GaLocationServicesFactory = async ({ directory }) => {
      calls.push(directory)
      const services: GaLocationServices = {
        runtime: {
          sidebarStateFile: join(directory, 'sidebar-state.json'),
          fetchAccountQuota: async () => ({ index: 0, status: 'disabled' }),
          refreshToken: async () => undefined,
        },
        start: async () => ({
          execute: async () => new Response('{}'),
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
                routing: { cliFirst: false, quotaStyleFallback: true },
                killswitch: { enabled: false, minimumRemainingPercent: 5 },
                logLevel: 'info',
                dump: { enabled: false },
              },
            }),
          },
          commands: {
            apply: async () => ({
              command: 'antigravity-dump',
              status: 'applied',
              text: '',
              dump: { enabled: false },
            }),
            applyAccountAction: async () => ({
              command: 'antigravity-account',
              status: 'rejected',
              text: '',
              accounts: null,
              authorizationUrl: null,
              targetOutcome: 'unknown-target',
            }),
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
      'hook http.request {"providerID":"google"}',
      'hook http.response {"providerID":"google"}',
      'hook retry {"providerID":"google"}',
    ])
    log.length = 0
    await cleanup?.()
    await cleanup?.()
    expect(log).toEqual([
      'dispose hook retry',
      'dispose hook http.response',
      'dispose hook http.request',
      'dispose provider transform',
      'dispose rpc antigravity-auth',
      'dispose services',
    ])
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
        fakeHost(locationDirectory('a'), log, { hook: 'retry' }),
        fakeServices(log),
      ),
    ).rejects.toThrow('no hook retry')
    expect(log).toEqual([
      'register antigravity-auth',
      'transform provider',
      'reload provider',
      'hook http.request {"providerID":"google"}',
      'hook http.response {"providerID":"google"}',
      'dispose hook http.response',
      'dispose hook http.request',
      'dispose provider transform',
      'dispose rpc antigravity-auth',
      'dispose services',
    ])
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
    expect(logA.filter((line) => line.startsWith('dispose'))).toHaveLength(6)
    expect(logB).toEqual([])
  })
})

describe('model registration', () => {
  const catalog = server.gaCatalogModels()

  it('registers every public catalog id on the Google provider with only enabled variants', () => {
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
    const disabled = Object.entries(
      realCore.getPublicModelDefinitions(),
    ).flatMap(([id, definition]) =>
      Object.entries(definition.variants ?? {})
        .filter(([, variant]) => variant.disabled === true)
        .map(([variantID]) => [id, variantID] as const),
    )
    expect(disabled.length).toBeGreaterThan(0)
    for (const [id, variantID] of disabled) {
      expect(
        catalog.get(id)?.variants.some((variant) => variant.id === variantID),
      ).toBe(false)
    }
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
