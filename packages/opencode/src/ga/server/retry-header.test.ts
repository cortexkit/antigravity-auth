import { afterEach, describe, expect, it } from 'bun:test'
import { placeholderSecret } from '../../common-auth-embedded/opencode2/index.js'
import { createNativeGoogleErrorResponse } from '../../plugin/request-helpers.ts'
import { OpenCode230Retryability } from './__fixtures__/opencode-230-retryability.test.ts'
import {
  adaptGaHttpResponse,
  type GaHttpRequestEvent,
  type GaJobExecutor,
  type GaLoopbackBridge,
  GaRequestOwnership,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from './index.ts'

const BODY = '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
const URL =
  'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:generateContent'
const bridges: GaLoopbackBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()))
})

async function start(execute: GaJobExecutor): Promise<GaLoopbackBridge> {
  const bridge = await startGaLoopbackBridge({
    execute,
    send: async () => {
      throw new Error('Unexpected physical send')
    },
  })
  bridges.push(bridge)
  return bridge
}

function requestEvent(request: Request): GaHttpRequestEvent {
  return {
    sessionID: 'ses_retry_header',
    kind: 'generate',
    model: { providerID: 'google', id: 'antigravity-gemini-3.8-flash' },
    request,
  }
}

async function rewrite(event: GaHttpRequestEvent, bridge: GaLoopbackBridge) {
  await rewriteGaHttpRequest(event, {
    bridge,
    ownership: new GaRequestOwnership(),
    isRegisteredModel: () => true,
    env: {},
  })
}

async function ownedResponse(bridge: GaLoopbackBridge): Promise<Response> {
  const event = requestEvent(
    new Request(URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': placeholderSecret('google') },
      body: BODY,
    }),
  )
  await rewrite(event, bridge)
  expect(event.request.url.startsWith(bridge.origin)).toBe(true)
  const responseEvent = {
    request: event.request,
    response: await fetch(event.request),
  }
  adaptGaHttpResponse(responseEvent, bridge)
  return responseEvent.response
}

describe('owned GA bridge retry header', () => {
  it.each([
    400, 401, 403, 404, 412, 429, 500, 502, 503, 504,
  ])('vetoes host retries for a returned failure with status %i', async (status) => {
    const body = '{"error":{"message":"upstream rejected request"}}'
    const bridge = await start(
      async () =>
        new Response(body, {
          status,
          headers: {
            'content-type': 'application/json',
            'retry-after': '3',
            'x-should-retry': 'true',
          },
        }),
    )
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(status)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(response.headers.get('retry-after')).toBe('3')
    expect(response.headers.get('retry-after-ms')).toBe('3000')
    expect(await response.text()).toBe(body)
  })

  it.each([
    400, 401, 403, 404, 412, 429, 502, 503, 504,
  ])('vetoes host retries for a thrown failure with status %i', async (status) => {
    const bridge = await start(async () => {
      throw Object.assign(new Error('upstream rejected request'), { status })
    })
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(status)
    expect(response.headers.get('x-should-retry')).toBe('false')
    await response.text()
  })

  it('vetoes host retries for an unmarked pre-header executor failure', async () => {
    const bridge = await start(async () => {
      // This comes from the executor, not the upstream sender.
      throw new Error('connect ECONNREFUSED fake-endpoint')
    })
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(502)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(await response.json()).toEqual({
      error: {
        code: 502,
        status: 'UNAVAILABLE',
        message:
          'antigravity-auth could not complete the operation. Check the plugin log for details.',
      },
    })
  })

  it('vetoes host retries for a local refusal without losing its wait metadata', async () => {
    const bridge = await start(async () =>
      createNativeGoogleErrorResponse({
        status: 412,
        reason: 'soft_quota',
        resetAfterMs: 45000,
      }),
    )
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(412)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(response.headers.get('retry-after')).toBe('45')
    expect(response.headers.get('retry-after-ms')).toBe('45000')
    expect((await response.json()).error.status).toBe('FAILED_PRECONDITION')
  })

  it.each([
    [429, 'RateLimit'],
    [502, 'ProviderInternal'],
  ] as const)('makes status %i non-retryable in the OpenCode 2.3.0 retryability getter', async (status, tag) => {
    // Ordinary status-only failures classify as these tags in provider-error.ts:
    // https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/provider-error.ts#L251-L282
    // This exercises the copied retryability getter, not the full classifier.
    const upstream = new Response('upstream rejected request', { status })
    expect(
      new OpenCode230Retryability({
        _tag: tag,
        http: { headers: Object.fromEntries(upstream.headers) },
      }).isRetryable,
    ).toBe(true)
    const bridge = await start(async () => upstream)
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(status)
    expect(
      new OpenCode230Retryability({
        _tag: tag,
        http: { headers: Object.fromEntries(response.headers) },
      }).isRetryable,
    ).toBe(false)
    await response.text()
  })

  it('leaves successful response bytes and recorded request bytes unchanged without a veto header', async () => {
    const body = 'data: {"candidates":[]}\n\n'
    let executions = 0
    const bridge = await start(async (job) => {
      executions++
      expect(job.body).toBe(BODY)
      expect(job.kind).toBe('generate')
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const response = await ownedResponse(bridge)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-should-retry')).toBeNull()
    expect(await response.text()).toBe(body)
    expect(executions).toBe(1)
  })

  it('leaves an unowned passthrough failure without a veto header', async () => {
    let executions = 0
    let nativeSends = 0
    const bridge = await start(async () => {
      executions++
      throw new Error('Unowned requests must not execute a bridge job')
    })
    const native = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        nativeSends++
        expect(request.headers.get('x-goog-api-key')).toBe('native-key')
        expect(await request.text()).toBe(BODY)
        return new Response('native failure', {
          status: 429,
          headers: { 'retry-after': '2' },
        })
      },
    })
    try {
      const original = new Request(
        `${native.url}v1beta/models/native:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': 'native-key' },
          body: BODY,
        },
      )
      const event = requestEvent(original)
      await rewrite(event, bridge)
      expect(event.request).toBe(original)
      const response = await fetch(event.request)
      const responseEvent = { request: event.request, response }
      adaptGaHttpResponse(responseEvent, bridge)
      expect(responseEvent.response).toBe(response)
      expect(response.status).toBe(429)
      expect(response.headers.get('x-should-retry')).toBeNull()
      expect(response.headers.get('retry-after')).toBe('2')
      expect(await response.text()).toBe('native failure')
      expect(nativeSends).toBe(1)
      expect(executions).toBe(0)
    } finally {
      await native.stop(true)
    }
  })
})
