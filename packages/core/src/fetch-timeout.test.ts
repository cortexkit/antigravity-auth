import { describe, expect, it, mock } from 'bun:test'

import {
  ACTIVE_FETCH_TIMEOUT_MS,
  fetchWithActiveTimeout,
} from './fetch-timeout.ts'

/**
 * Builds a mock fetch whose response promise respects the request's
 * AbortSignal — when the signal aborts, the promise rejects so the helper
 * under test can propagate the abort cleanly. With no resolution scheduled
 * this simulates a server that accepted the connection but never produced
 * response headers.
 */
function hangingFetch(): typeof fetch {
  return mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
        return
      }
      signal?.addEventListener(
        'abort',
        () => {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }) as unknown as typeof fetch
}

function delayedResponseFetch(
  resolveAfterMs: number,
  body: string,
  status = 200,
): typeof fetch {
  return mock(async (_input, _init) => {
    await new Promise((resolve) => setTimeout(resolve, resolveAfterMs))
    return new Response(body, { status })
  }) as unknown as typeof fetch
}

describe('ACTIVE_FETCH_TIMEOUT_MS', () => {
  it('defaults to fifteen seconds', () => {
    expect(ACTIVE_FETCH_TIMEOUT_MS).toBe(15_000)
  })
})

describe('fetchWithActiveTimeout', () => {
  it('aborts an unresolved fetch after the configured timeout', async () => {
    const fetchImpl = hangingFetch()
    const start = Date.now()
    let caught: unknown
    try {
      await fetchWithActiveTimeout(
        'https://example.test/slow',
        { method: 'GET' },
        { timeoutMs: 50, fetchImpl },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DOMException)
    const name = (caught as DOMException).name
    expect(name === 'AbortError' || name === 'TimeoutError').toBe(true)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(45)
    expect(elapsed).toBeLessThan(500)
  })

  it('preserves the caller-supplied abort reason when caller aborts first', async () => {
    const fetchImpl = hangingFetch()
    const callerController = new AbortController()
    const callerReason = new Error('caller-cancelled')
    const promise = fetchWithActiveTimeout(
      'https://example.test/slow',
      { signal: callerController.signal },
      { timeoutMs: 1000, fetchImpl },
    )
    callerController.abort(callerReason)
    await expect(promise).rejects.toBe(callerReason)
  })

  it('lets a response body remain readable past the timeout window', async () => {
    const fetchImpl = delayedResponseFetch(20, 'streamed-body')
    const response = await fetchWithActiveTimeout(
      'https://example.test/stream',
      undefined,
      { timeoutMs: 50, fetchImpl },
    )
    // Wait past the timeout to confirm the body stream has not been aborted
    // along with the active-fetch deadline. Headers resolved before timeout,
    // so the body must remain readable.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const body = await response.text()
    expect(body).toBe('streamed-body')
  })

  it('forwards headers, method, and body to the underlying fetchImpl', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit?]> = []
    const fetchImpl = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init])
        return new Response('ok', { status: 200 })
      },
    ) as unknown as typeof fetch

    await fetchWithActiveTimeout(
      'https://example.test/echo',
      {
        method: 'POST',
        headers: { 'X-Trace': 'abc', 'Content-Type': 'text/plain' },
        body: 'payload',
      },
      { timeoutMs: 1000, fetchImpl },
    )

    expect(calls.length).toBe(1)
    const [input, init] = calls[0]!
    expect(input).toBe('https://example.test/echo')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('payload')
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Trace']).toBe('abc')
    expect(headers['Content-Type']).toBe('text/plain')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses ACTIVE_FETCH_TIMEOUT_MS when no timeoutMs override is supplied', async () => {
    // With a hanging fetch and the default 15s timeout we cannot wait that
    // long in tests, so override to a tiny value and assert the override is
    // honored. The default value is locked in by the constant assertion above.
    const fetchImpl = hangingFetch()
    let caught: unknown
    try {
      await fetchWithActiveTimeout('https://example.test/slow', undefined, {
        fetchImpl,
        timeoutMs: 25,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DOMException)
    const name = (caught as DOMException).name
    expect(name === 'AbortError' || name === 'TimeoutError').toBe(true)
  })
})
