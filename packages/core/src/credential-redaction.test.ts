import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../../../test/support/run-command.ts'
import {
  redactCredentialError,
  redactCredentialFrame,
  redactCredentialResponse,
  redactCredentialText,
  redactProjectIdText,
} from './credential-redaction.ts'

const selected = 'opaque-selected-token'
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
const detail = `${selected} Bearer other-token ${jwt}`

describe('credential redaction', () => {
  it('masks project identifiers with the shared debug-log shape', () => {
    const projectId = 'my-real-project-123456'
    const masked = 'my-r****3456'

    expect(redactProjectIdText(`echo ${projectId}`, [projectId])).toBe(
      `echo ${masked}`,
    )
    expect(redactProjectIdText(`Project: ${projectId}`)).toBe(
      `Project: ${masked}`,
    )
    expect(redactProjectIdText('Project: Unknown')).toBe('Project: Unknown')
    expect(
      redactProjectIdText('IDs project-0 and proj', ['project-0', 'proj']),
    ).toBe('IDs proj****ct-0 and ****')

    const error = Object.assign(new Error(`echo ${projectId}`), { projectId })
    expect(redactCredentialError(error, undefined, [projectId])).toMatchObject({
      message: `echo ${masked}`,
      projectId: masked,
    })
  })

  it('imports the same-job built core root through native Node ESM without a resolution shim', async () => {
    // The Node process fails at its own deadline, before this test's timeout.
    const ran = await runCommand(
      [
        'node',
        '--input-type=module',
        '--eval',
        `
      const core = await import('./packages/core/dist/index.js')
      if (core.redactCredentialText('echo opaque-runtime-token', 'opaque-runtime-token') !== 'echo [credential]') throw new Error('core redaction export did not execute')
      console.log('native-node-core-root-import: 1 check passed')
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        deadlineMs: 4_000,
      },
    )
    const result = { ...ran, status: ran.exitCode }
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(
      'native-node-core-root-import: 1 check passed',
    )
  }, 10_000)

  for (const frozen of [false, true]) {
    it(`preserves safe object and symbol classification metadata on ${frozen ? 'frozen' : 'writable'} errors`, () => {
      const classification = Object.freeze({
        retry: 'same-endpoint',
        overflow: true,
      })
      const marker = Symbol('retry-classification')
      const diagnosticKey = Symbol('diagnostic')
      const original = Object.assign(new Error(detail), {
        classification,
        [marker]: classification,
        [diagnosticKey]: detail,
      })
      if (frozen) Object.freeze(original)
      const safe = redactCredentialError(original, selected)
      expect(safe === original).toBe(!frozen)
      expect(Reflect.get(safe, 'classification')).toBe(classification)
      expect(Reflect.get(safe, marker)).toBe(classification)
      expect(Reflect.get(safe, diagnosticKey)).not.toContain(selected)
      expect(safe.message).not.toContain(selected)
    })
  }

  for (const body of [null, 'failed body']) {
    it(`redacts opaque selected-token failed diagnostic metadata with ${body === null ? 'no body' : 'a body'}`, async () => {
      const original = new Response(body, {
        status: 429,
        statusText: `echo ${selected}`,
        headers: {
          'x-error': `echo ${selected}`,
          'retry-after': '12',
          'x-safe': 'unchanged',
        },
      })
      const safe = await redactCredentialResponse(original, selected)
      expect(safe.status).toBe(429)
      expect(safe.statusText).toBe('echo [credential]')
      expect(safe.headers.get('x-error')).toBe('echo [credential]')
      expect(safe.headers.get('retry-after')).toBe('12')
      expect(safe.headers.get('x-safe')).toBe('unchanged')
      if (body === null) expect(safe.body).toBeNull()
      else expect(await safe.text()).toBe(body)
    })
  }

  it('leaves successful diagnostic-looking status and headers unchanged, including bodyless responses', async () => {
    for (const body of [null, 'success']) {
      const original = new Response(body, {
        status: 200,
        statusText: `echo ${selected}`,
        headers: { 'x-error': detail, 'retry-after': '12' },
      })
      const safe = await redactCredentialResponse(original, selected)
      expect(safe).toBe(original)
      expect(safe.statusText).toBe(`echo ${selected}`)
      expect(safe.headers.get('x-error')).toBe(detail)
      expect(safe.headers.get('retry-after')).toBe('12')
    }
  })

  it('releases the owned SSE reader after an unchanged safe body failure', async () => {
    const failure = new Error('safe body failure')
    const original = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure)
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const safe = await redactCredentialResponse(original, selected)
    await expect(safe.text()).rejects.toBe(failure)
    expect(original.body!.locked).toBe(false)
  })

  it('releases the owned SSE reader on cancellation without changing its reason', async () => {
    let cancelled: unknown
    const original = new Response(
      new ReadableStream({
        cancel(reason) {
          cancelled = reason
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const safe = await redactCredentialResponse(original, selected)
    const reason = new DOMException('user escape', 'AbortError')
    await safe.body!.cancel(reason)
    expect(cancelled).toBe(reason)
    expect(original.body!.locked).toBe(false)
  })

  it('redacts failed HTTP body-read errors while preserving safe classification', async () => {
    const classification = Object.freeze({ retry: false, status: 403 })
    const failure = Object.assign(new Error(`echo ${selected}`), {
      code: 'HTTP_BODY_FAILED',
      status: 403,
      classification,
    })
    const original = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure)
        },
      }),
      { status: 403 },
    )
    await expect(redactCredentialResponse(original, selected)).rejects.toBe(
      failure,
    )
    expect(failure.message).toBe('echo [credential]')
    expect(failure.code).toBe('HTTP_BODY_FAILED')
    expect(failure.status).toBe(403)
    expect(failure.classification).toBe(classification)
  })

  it('redacts upstream SSE cancellation failure while forwarding the exact caller reason and releasing its reader', async () => {
    const reason = new DOMException('user escape', 'AbortError')
    const failure = Object.assign(new Error(`echo ${selected}`), {
      code: 'CANCEL_FAILED',
    })
    let received: unknown
    const original = new Response(
      new ReadableStream({
        cancel(callerReason) {
          received = callerReason
          throw failure
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const safe = await redactCredentialResponse(original, selected)
    await expect(safe.body!.cancel(reason)).rejects.toBe(failure)
    expect(received).toBe(reason)
    expect(failure.message).toBe('echo [credential]')
    expect(failure.code).toBe('CANCEL_FAILED')
    expect(original.body!.locked).toBe(false)
  })

  it('removes stale SSE length while redacting fragmented error frames and preserving other metadata', async () => {
    const event = `data: ${JSON.stringify({ error: { message: selected } })}\r\n\r\n`
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const char of event)
            controller.enqueue(new TextEncoder().encode(char))
          controller.close()
        },
      }),
      {
        statusText: `echo ${selected}`,
        headers: {
          'content-type': 'text/event-stream',
          'content-length': String(new TextEncoder().encode(event).length),
          'retry-after': '12',
          'x-kept': selected,
        },
      },
    )
    const safe = await redactCredentialResponse(original, selected)
    expect(safe.headers.get('content-length')).toBeNull()
    expect(safe.statusText).toBe(`echo ${selected}`)
    expect(safe.headers.get('retry-after')).toBe('12')
    expect(safe.headers.get('x-kept')).toBe(selected)
    expect(await safe.text()).toBe(event.replace(selected, '[credential]'))
    expect(original.body!.locked).toBe(false)
  })

  it('scrubs exact selected credentials and JWT/Bearer shapes with the plain marker', () => {
    expect(redactCredentialText(detail, selected)).toBe(
      '[credential] [credential] [credential]',
    )
  })
  it('preserves writable Error identity and classification while scrubbing non-enumerable strings and secret cause', () => {
    const original = Object.assign(new Error(detail), {
      name: 'AbortError',
      status: 429,
      code: 'ECONNRESET',
      retryable: true,
      overflow: true,
      cause: new Error(jwt),
    })
    Object.defineProperty(original, 'diagnostic', {
      value: detail,
      writable: true,
      configurable: true,
    })
    expect(redactCredentialError(original, selected)).toBe(original)
    expect(original).toMatchObject({
      name: 'AbortError',
      status: 429,
      code: 'ECONNRESET',
      retryable: true,
      overflow: true,
    })
    expect(original.message).not.toContain(selected)
    expect(original.stack).not.toContain(jwt)
    expect(
      Object.getOwnPropertyDescriptor(original, 'diagnostic')?.value,
    ).not.toContain(selected)
    expect(original.cause).toBeUndefined()
  })
  it('retains frozen error cancellation and retry/overflow metadata in the immutable fallback', () => {
    const original = Object.freeze(
      Object.assign(new Error(detail), {
        name: 'AbortError',
        status: 413,
        code: 'ABORT_ERR',
        retryAfter: 12,
        overflow: true,
      }),
    )
    const safe = redactCredentialError(original, selected)
    expect(safe).not.toBe(original)
    expect(safe).toMatchObject({
      name: 'AbortError',
      status: 413,
      code: 'ABORT_ERR',
      retryAfter: 12,
      overflow: true,
    })
    expect(safe.message).not.toContain(selected)
    expect(safe.stack).not.toContain(jwt)
  })
  it('keeps safe causes and handles DOMException cancellation', () => {
    const cause = new Error('safe root')
    const error = new Error(detail, { cause })
    expect(redactCredentialError(error, selected).cause).toBe(cause)
    expect(
      redactCredentialError(new DOMException(detail, 'AbortError'), selected)
        .name,
    ).toBe('AbortError')
  })
  it('only rewrites genuine error frames, not error-looking model text or tool arguments', () => {
    for (const frame of [
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: detail },
                { functionCall: { args: { error: detail } } },
              ],
            },
          },
        ],
      }),
      `not JSON "error" ${detail}`,
    ]) {
      expect(redactCredentialFrame(frame, selected)).toBe(frame)
    }
    for (const frame of [
      { error: { message: detail } },
      { response: { error: { message: detail } } },
      { type: 'error', message: detail },
    ]) {
      const text = redactCredentialFrame(JSON.stringify(frame), selected)
      expect(text).not.toContain(selected)
      expect(text).not.toContain(jwt)
    }
  })
  for (const [name, frame] of [
    [
      'escaped error key',
      String.raw`{"\u0065rror":{"message":"${selected}","code":"UNCHANGED"}}`,
    ],
    [
      'escaped nested keys',
      String.raw`{"respon\u0073e":{"err\u006fr":{"message":"${selected}","code":"UNCHANGED"}}}`,
    ],
    [
      'escaped error type',
      String.raw`{"type":"\u0065rror","message":"${selected}","code":"UNCHANGED"}`,
    ],
    [
      'escaped credential',
      String.raw`{"error":{"message":"\u006fpaque-selected-token","code":"UNCHANGED"}}`,
    ],
  ] as const) {
    it(`redacts ${name} in a genuine JSON error frame`, () => {
      const output = redactCredentialFrame(frame, selected)
      const parsed = JSON.parse(output)
      const diagnostic = parsed.error ?? parsed.response?.error ?? parsed
      expect(diagnostic.message).toBe('[credential]')
      expect(diagnostic.code).toBe('UNCHANGED')
      expect(output).not.toContain(selected)
    })
  }
  it('redacts an escaped credential in a failed HTTP JSON body without changing status or retry headers', async () => {
    const original = new Response(
      String.raw`{"message":"\u006fpaque-selected-token","code":"UNCHANGED"}`,
      {
        status: 403,
        headers: { 'retry-after': '3' },
      },
    )
    const safe = await redactCredentialResponse(original, selected)
    expect(safe.status).toBe(403)
    expect(safe.headers.get('retry-after')).toBe('3')
    expect(await safe.json()).toEqual({
      message: '[credential]',
      code: 'UNCHANGED',
    })
  })
  it('leaves Unicode-escaped error-looking model and tool content byte-identical', () => {
    const frame = String.raw`{"candidates":[{"content":{"parts":[{"text":"\u006fpaque-selected-token"},{"functionCall":{"args":{"\u0065rror":"${selected}"}}}]}}]}`
    expect(redactCredentialFrame(frame, selected)).toBe(frame)
  })
  it('redacts fragmented SSE with an escaped error key and credential', async () => {
    const frame = String.raw`{"\u0065rror":{"message":"\u006fpaque-selected-token","code":"UNCHANGED"}}`
    const bytes = new TextEncoder().encode(`data: ${frame}\r\n\r\n`)
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 18))
          controller.enqueue(bytes.slice(18))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const safe = await redactCredentialResponse(original, selected)
    const output = await safe.text()
    expect(JSON.parse(output.slice('data: '.length).trim())).toEqual({
      error: { message: '[credential]', code: 'UNCHANGED' },
    })
    expect(original.body!.locked).toBe(false)
  })
  it('preserves transformed success bytes, response metadata and cancellation reason', async () => {
    const bytes = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `π ${detail} {"error":"${selected}"}` }] } }] })}\r\n\r\n`
    const original = new Response(bytes, {
      headers: { 'content-type': 'text/event-stream', 'x-kept': 'yes' },
    })
    Object.defineProperties(original, {
      url: { value: 'https://example.test/final' },
      redirected: { value: true },
      type: { value: 'cors' },
    })
    const safe = await redactCredentialResponse(original, selected)
    expect(new Uint8Array(await safe.arrayBuffer())).toEqual(
      new TextEncoder().encode(bytes),
    )
    expect([
      safe.url,
      safe.type,
      safe.redirected,
      safe.status,
      safe.headers.get('x-kept'),
    ]).toEqual([original.url, 'cors', true, 200, 'yes'])
    let cancelled: unknown
    const pending = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelled = reason
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const wrapped = await redactCredentialResponse(pending, selected)
    const reason = new DOMException('user escape', 'AbortError')
    await wrapped.body!.cancel(reason)
    expect(cancelled).toBe(reason)
  })
  it('redacts fragmented SSE errors and body failures without changing status or retry headers', async () => {
    const event = `data: ${JSON.stringify({ error: { code: 429, message: detail } })}\n\n`
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const char of event)
            controller.enqueue(new TextEncoder().encode(char))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    expect(
      await (await redactCredentialResponse(original, selected)).text(),
    ).not.toContain(selected)
    const http = await redactCredentialResponse(
      new Response(detail, { status: 429, headers: { 'retry-after': '12' } }),
      selected,
    )
    expect(http.status).toBe(429)
    expect(http.headers.get('retry-after')).toBe('12')
    expect(await http.text()).not.toContain(jwt)
    const failed = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(detail))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    await expect(
      (await redactCredentialResponse(failed, selected)).text(),
    ).rejects.toThrow('[credential]')
  })
})
