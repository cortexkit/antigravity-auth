import { describe, expect, it } from 'bun:test'
import { placeholderSecret } from '../../common-auth-embedded/opencode2/index.js'
import { createNativeGoogleErrorResponse } from '../../plugin/request-helpers.ts'
import {
  decideGaRetry,
  type GaBridgeJob,
  type GaHttpRequestEvent,
  GaRequestOwnership,
  type GaRetryEvent,
  gaPreHeaderFailureResponse,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from './index.ts'

const TEST_JOB: GaBridgeJob = {
  sessionID: 'ses_bridge_preheader_test',
  parentSessionID: null,
  kind: 'primary',
  modelID: 'antigravity-gemini-3.5-flash',
  variant: null,
  url: 'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse',
  body: '{}',
}

describe('gaPreHeaderFailureResponse', () => {
  it('maps HTTP status codes to corresponding Google RPC statuses', async () => {
    const cases = [
      { status: 400, expectedStatus: 400, expectedRpc: 'INVALID_ARGUMENT' },
      { status: 401, expectedStatus: 401, expectedRpc: 'UNAUTHENTICATED' },
      { status: 403, expectedStatus: 403, expectedRpc: 'PERMISSION_DENIED' },
      { status: 404, expectedStatus: 404, expectedRpc: 'NOT_FOUND' },
      { status: 412, expectedStatus: 412, expectedRpc: 'FAILED_PRECONDITION' },
      { status: 429, expectedStatus: 429, expectedRpc: 'RESOURCE_EXHAUSTED' },
      { status: 502, expectedStatus: 502, expectedRpc: 'UNAVAILABLE' },
      { status: 503, expectedStatus: 503, expectedRpc: 'UNAVAILABLE' },
      { status: 504, expectedStatus: 504, expectedRpc: 'UNAVAILABLE' },
      { status: 418, expectedStatus: 502, expectedRpc: 'UNAVAILABLE' },
      { status: 500, expectedStatus: 502, expectedRpc: 'UNAVAILABLE' },
    ]

    for (const c of cases) {
      const resp = gaPreHeaderFailureResponse({
        statusCode: c.status,
        message: 'Something went wrong',
      })
      expect(resp.status).toBe(c.expectedStatus)
      const data = await resp.json()
      expect(data).toEqual({
        error: {
          code: c.expectedStatus,
          message: 'Something went wrong',
          status: c.expectedRpc,
        },
      })
    }
  })

  it('supports status property as alternative to statusCode', async () => {
    const resp = gaPreHeaderFailureResponse({
      status: 403,
      message: 'Forbidden access',
    })
    expect(resp.status).toBe(403)
    const data = await resp.json()
    expect(data.error.status).toBe('PERMISSION_DENIED')
  })

  it('defaults to 502 UNAVAILABLE when error has no status', async () => {
    const resp = gaPreHeaderFailureResponse(new Error('Network error'))
    expect(resp.status).toBe(502)
    const data = await resp.json()
    expect(data.error.code).toBe(502)
    expect(data.error.status).toBe('UNAVAILABLE')
    expect(data.error.message).toBe('Network error')
  })

  it('uses default fallback message when error carries no message', async () => {
    const resp = gaPreHeaderFailureResponse({})
    expect(resp.status).toBe(502)
    const data = await resp.json()
    expect(data.error.message).toBe(
      'Antigravity request failed before a response arrived',
    )
  })

  it('normalizes duration wording on quota errors', async () => {
    const resp = gaPreHeaderFailureResponse({
      status: 429,
      message: 'Rate limit exceeded. Resets in 2h55m14s.',
    })
    const data = await resp.json()
    expect(data.error.message).toContain('quota resets in 2h 55m 14s.')
  })

  it('does not normalize reset duration on non-quota errors', async () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 400,
      message: 'Invalid parameters: Session resets in 5m.',
    })
    const data = await resp.json()
    expect(data.error.message).toBe('Invalid parameters: Session resets in 5m.')
    expect(data.error.message).not.toContain('quota resets in')
  })

  it('extracts validated retry-after and retry-after-ms headers from numeric fields', () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      retryAfterSeconds: 60,
      retryAfterMs: 60000,
    })
    expect(resp.headers.get('retry-after')).toBe('60')
    expect(resp.headers.get('retry-after-ms')).toBe('60000')
  })

  it('derives retry-after seconds from resetAfterMs when seconds omitted', () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      resetAfterMs: 45000,
    })
    expect(resp.headers.get('retry-after')).toBe('45')
    expect(resp.headers.get('retry-after-ms')).toBe('45000')
  })

  it('extracts and validates retry headers from Headers instance', () => {
    const headers = new Headers()
    headers.set('retry-after', '120')
    headers.set('retry-after-ms', '120000')

    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      headers,
    })
    expect(resp.headers.get('retry-after')).toBe('120')
    expect(resp.headers.get('retry-after-ms')).toBe('120000')
  })

  it('falls back to resetAfterMs when retryAfterMs is malformed', () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      retryAfterMs: 'invalid-delay',
      resetAfterMs: 30000,
    })
    expect(resp.headers.get('retry-after')).toBe('30')
    expect(resp.headers.get('retry-after-ms')).toBe('30000')
  })

  it('extracts and validates retry headers from a plain object record', () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      headers: {
        'retry-after': '75',
      },
    })
    expect(resp.headers.get('retry-after')).toBe('75')
    expect(resp.headers.get('retry-after-ms')).toBe('75000')
  })

  it('preserves executor source precedence (RetryInfo > error fields > message duration > headers)', () => {
    // 1. Error fields win over headers and message duration
    const respWithFields = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded. Resets in 2h.',
      headers: {
        'retry-after': '45',
      },
      retryAfterSeconds: 120,
    })
    expect(respWithFields.headers.get('retry-after')).toBe('120')
    expect(respWithFields.headers.get('retry-after-ms')).toBe('120000')

    // 2. RetryInfo wins over error fields
    const respWithRetryInfo = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded. Resets in 2h.',
      retryAfterSeconds: 120,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '15s',
        },
      ],
    })
    expect(respWithRetryInfo.headers.get('retry-after')).toBe('15')
    expect(respWithRetryInfo.headers.get('retry-after-ms')).toBe('15000')

    // 3. Message duration wins over headers when no error fields or RetryInfo
    const respWithMessage = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded. Resets in 30s.',
      headers: {
        'retry-after': '45',
      },
    })
    expect(respWithMessage.headers.get('retry-after')).toBe('30')
    expect(respWithMessage.headers.get('retry-after-ms')).toBe('30000')

    // 4. Headers win when no details, error fields, or message duration
    const respWithHeaders = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded.',
      headers: {
        'retry-after': '45',
      },
    })
    expect(respWithHeaders.headers.get('retry-after')).toBe('45')
    expect(respWithHeaders.headers.get('retry-after-ms')).toBe('45000')
  })

  it('rejects invalid or unsafe retry headers', () => {
    const resp = gaPreHeaderFailureResponse({
      statusCode: 429,
      message: 'Quota exceeded',
      retryAfterSeconds: -5,
      retryAfterMs: 'invalid',
    })
    expect(resp.headers.get('retry-after')).toBeNull()
    expect(resp.headers.get('retry-after-ms')).toBeNull()
  })
})

describe('loopback bridge pre-header, local refusals and retry veto', () => {
  it('preserves local 412 refusals with normal reset delay', async () => {
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () =>
        createNativeGoogleErrorResponse({
          status: 412,
          reason: 'soft_quota',
          resetAfterMs: 45000,
        }),
    })

    try {
      const req = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp = await fetch(req)
      expect(resp.status).toBe(412)
      expect(resp.headers.get('retry-after')).toBe('45')
      expect(resp.headers.get('retry-after-ms')).toBe('45000')
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(412)
      expect(body.error.status).toBe('FAILED_PRECONDITION')
      expect(body.error.message).toContain('quota protection policy')
    } finally {
      await bridge.dispose()
    }
  })

  it('preserves local 412 refusals with zero (0) reset delay', async () => {
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () =>
        createNativeGoogleErrorResponse({
          status: 412,
          reason: 'soft_quota',
          resetAfterMs: 0,
        }),
    })

    try {
      const req = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp = await fetch(req)
      expect(resp.status).toBe(412)
      expect(resp.headers.get('retry-after')).toBe('0')
      expect(resp.headers.get('retry-after-ms')).toBe('0')
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(412)
      expect(body.error.status).toBe('FAILED_PRECONDITION')
    } finally {
      await bridge.dispose()
    }
  })

  it('preserves local 412 refusals with unknown reset (no Retry-After)', async () => {
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () =>
        createNativeGoogleErrorResponse({
          status: 412,
          reason: 'model_unavailable',
        }),
    })

    try {
      const req = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp = await fetch(req)
      expect(resp.status).toBe(412)
      expect(resp.headers.get('retry-after')).toBeNull()
      expect(resp.headers.get('retry-after-ms')).toBeNull()
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(412)
      expect(body.error.status).toBe('FAILED_PRECONDITION')
    } finally {
      await bridge.dispose()
    }
  })

  it('preserves local 412 refusals with large finite reset (> 1 year)', async () => {
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () =>
        createNativeGoogleErrorResponse({
          status: 412,
          reason: 'soft_quota',
          resetAfterMs: 50_000_000_000,
        }),
    })

    try {
      const req = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp = await fetch(req)
      expect(resp.status).toBe(412)
      expect(resp.headers.get('retry-after')).toBe('50000000')
      expect(resp.headers.get('retry-after-ms')).toBe('50000000000')
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(412)
      expect(body.error.status).toBe('FAILED_PRECONDITION')
    } finally {
      await bridge.dispose()
    }
  })

  it('preserves local 412 refusals for Number.MAX_VALUE and hazardous 524h reset without losing exact Retry-After or safe body', async () => {
    const exactMaxSeconds =
      '179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124859'
    let call = 0
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () =>
        ++call === 1
          ? createNativeGoogleErrorResponse({
              status: 412,
              reason: 'pool_unavailable',
              resetAfterMs: Number.MAX_VALUE,
            })
          : createNativeGoogleErrorResponse({
              status: 412,
              reason: 'pool_unavailable',
              resetAfterMs: 1_886_400_000, // 524h
            }),
    })

    try {
      const req1 = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp1 = await fetch(req1)
      expect(resp1.status).toBe(412)
      expect(resp1.headers.get('retry-after')).toBe(exactMaxSeconds)
      const text1 = await resp1.text()
      expect(text1).not.toMatch(/429|500|502|503|504|524/)

      const req2 = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp2 = await fetch(req2)
      expect(resp2.status).toBe(412)
      expect(resp2.headers.get('retry-after')).toBe('1886400')
      expect(resp2.headers.get('retry-after-ms')).toBe('1886400000')
      const text2 = await resp2.text()
      expect(text2).not.toContain('Quota resets in')
      expect(text2).not.toMatch(/429|500|502|503|504|524/)
    } finally {
      await bridge.dispose()
    }
  })

  it('gaPreHeaderFailureResponse maps a status-bearing thrown exception to an HTTP status with retry headers', async () => {
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Not used')
      },
      execute: async () => {
        const error = new Error('Antigravity pool rate limited')
        throw Object.assign(error, {
          statusCode: 429,
          retryAfterMs: 5000,
        })
      },
    })

    try {
      const req = bridge.rewrite(
        new Request(TEST_JOB.url, { method: 'POST', body: TEST_JOB.body }),
        TEST_JOB,
        {},
      )
      const resp = await fetch(req)
      expect(resp.status).toBe(429)
      expect(resp.headers.get('retry-after')).toBe('5')
      expect(resp.headers.get('retry-after-ms')).toBe('5000')
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(429)
      expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
      expect(body.error.message).toContain('Antigravity pool rate limited')
    } finally {
      await bridge.dispose()
    }
  })

  it('forwards Retry-After on owned 429 and vetoes host retry without second physical dispatch', async () => {
    // Count real sends in the raw sender, so "physical dispatch" means a request
    // that actually left the bridge rather than a call into the injected execute.
    let rawSends = 0
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        rawSends++
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Quota exceeded for account',
            },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '30',
            },
          },
        )
      },
      execute: async (_job, ctx) => {
        return ctx.send({
          envelope: { contents: [] } as any,
          auth: { access: 'test' },
          endpoint: 'http://localhost',
          signal: ctx.signal,
          kind: 'primary',
        })
      },
    })

    try {
      const ownership = new GaRequestOwnership()
      const event: GaHttpRequestEvent = {
        sessionID: TEST_JOB.sessionID,
        kind: TEST_JOB.kind,
        model: { id: TEST_JOB.modelID, providerID: 'google' },
        request: new Request(TEST_JOB.url, {
          method: 'POST',
          headers: { 'x-goog-api-key': placeholderSecret('google') },
          body: TEST_JOB.body,
        }),
      }

      // Real rewrite marks ownership
      await rewriteGaHttpRequest(event, {
        bridge,
        ownership,
        isRegisteredModel: () => true,
        env: {},
      })
      expect(ownership.get(TEST_JOB.sessionID)).toBe(true)

      const resp = await fetch(event.request)
      expect(resp.status).toBe(429)
      expect(resp.headers.get('retry-after')).toBe('30')
      expect(resp.headers.get('retry-after-ms')).toBe('30000')
      expect(rawSends).toBe(1)

      // Verify the retry-hook veto prevents host retry loop from dispatching second time
      const retryEvent: GaRetryEvent = {
        sessionID: TEST_JOB.sessionID,
        model: { id: TEST_JOB.modelID, providerID: 'google' },
        decision: { retry: true, delay: 30000 },
      }
      decideGaRetry(retryEvent, ownership)
      expect(retryEvent.decision).toEqual({ retry: false })

      if (retryEvent.decision.retry) {
        await fetch(event.request)
      }
      expect(rawSends).toBe(1)

      // Negative control: retry-enabled foreign request WOULD dispatch again without veto
      const foreignSessionID = 'ses_foreign_request'
      const foreignRetryEvent: GaRetryEvent = {
        sessionID: foreignSessionID,
        model: { id: 'claude-3-5-sonnet', providerID: 'anthropic' },
        decision: { retry: true, delay: 5000 },
      }
      decideGaRetry(foreignRetryEvent, ownership)
      // Foreign request is not owned, so decision is untouched
      expect(foreignRetryEvent.decision).toEqual({ retry: true, delay: 5000 })
      if (foreignRetryEvent.decision.retry) {
        // A retry-enabled foreign request simulates second physical dispatch
        rawSends++
      }
      expect(rawSends).toBe(2)
    } finally {
      await bridge.dispose()
    }
  })

  it('vetoes host retry on generic thrown network error without second physical dispatch', async () => {
    // Count real sends in the raw sender, so "physical dispatch" means a request
    // that actually left the bridge rather than a call into the injected execute.
    let rawSends = 0
    const bridge = await startGaLoopbackBridge({
      send: async () => {
        rawSends++
        throw new Error('ECONNRESET: connection reset by peer')
      },
      execute: async (_job, ctx) => {
        return ctx.send({
          envelope: { contents: [] } as any,
          auth: { access: 'test' },
          endpoint: 'http://localhost',
          signal: ctx.signal,
          kind: 'primary',
        })
      },
    })

    try {
      const ownership = new GaRequestOwnership()
      const event: GaHttpRequestEvent = {
        sessionID: TEST_JOB.sessionID,
        kind: TEST_JOB.kind,
        model: { id: TEST_JOB.modelID, providerID: 'google' },
        request: new Request(TEST_JOB.url, {
          method: 'POST',
          headers: { 'x-goog-api-key': placeholderSecret('google') },
          body: TEST_JOB.body,
        }),
      }

      await rewriteGaHttpRequest(event, {
        bridge,
        ownership,
        isRegisteredModel: () => true,
        env: {},
      })
      expect(ownership.get(TEST_JOB.sessionID)).toBe(true)

      const resp = await fetch(event.request)
      expect(resp.status).toBe(502)
      expect(resp.headers.get('retry-after')).toBeNull()
      expect(resp.headers.get('retry-after-ms')).toBeNull()
      const body = (await resp.json()) as any
      expect(body.error.code).toBe(502)
      expect(body.error.status).toBe('UNAVAILABLE')
      expect(rawSends).toBe(1)

      const retryEvent: GaRetryEvent = {
        sessionID: TEST_JOB.sessionID,
        model: { id: TEST_JOB.modelID, providerID: 'google' },
        decision: { retry: true, delay: 2000 },
      }
      decideGaRetry(retryEvent, ownership)
      expect(retryEvent.decision).toEqual({ retry: false })

      if (retryEvent.decision.retry) {
        await fetch(event.request)
      }
      expect(rawSends).toBe(1)
    } finally {
      await bridge.dispose()
    }
  })
})
