import { describe, expect, it } from 'bun:test'

import {
  type MockServerHandle,
  startMockAntigravityServer,
} from './mock-antigravity-server'

interface RunningServer {
  server: MockServerHandle
  cleanup(): Promise<void>
}

async function withServer(
  fn: (server: MockServerHandle) => Promise<void>,
): Promise<void> {
  const server = await startMockAntigravityServer()
  try {
    await fn(server)
  } finally {
    await server.close()
  }
}

async function readText(response: Response): Promise<string> {
  return await response.text()
}

describe('mock antigravity server', () => {
  it('binds to loopback and exposes a stable baseUrl', async () => {
    await withServer(async (server) => {
      const url = new URL(server.baseUrl)
      expect(url.hostname).toBe('127.0.0.1')
      expect(server.port).toBeGreaterThan(0)
    })
  })

  it('records request method, path, headers, and body', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'json',
        body: { ok: true },
      })
      const response = await fetch(`${server.baseUrl}/probe`, {
        method: 'POST',
        headers: {
          'x-trace': 'abc-123',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ping: 'pong' }),
      })
      expect(response.status).toBe(200)
      await response.text()
      expect(server.requests).toHaveLength(1)
      const [entry] = server.requests
      expect(entry?.method).toBe('POST')
      expect(entry?.path).toBe('/probe')
      expect(entry?.headers['x-trace']).toBe('abc-123')
      expect(entry?.body).toBe('{"ping":"pong"}')
    })
  })

  it('serves queue fixtures in order with the next queue entry consumed per request', async () => {
    await withServer(async (server) => {
      server.enqueue({ kind: 'json', body: { count: 1 } })
      server.repeat({ kind: 'json', body: { count: 2 } }, 2)
      const r1 = await fetch(`${server.baseUrl}/one`)
      const r2 = await fetch(`${server.baseUrl}/two`)
      const r3 = await fetch(`${server.baseUrl}/three`)
      expect(await r1.json()).toEqual({ count: 1 })
      expect(await r2.json()).toEqual({ count: 2 })
      expect(await r3.json()).toEqual({ count: 2 })
    })
  })

  it('returns 500 with INTERNAL when the queue is empty', async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.baseUrl}/empty`)
      expect(response.status).toBe(500)
      const body = (await response.json()) as {
        error: { code: number; message: string }
      }
      expect(body.error.code).toBe(8)
      expect(body.error.message).toBe('mock-queue-empty')
    })
  })

  it('streams chunked SSE bodies with newline separators', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'streamChunked',
        model: 'gemini-3-flash',
        chunks: [
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" world"}]}}]}}',
        ],
        terminator: 'data: [DONE]',
      })
      const response = await fetch(`${server.baseUrl}/sse`)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      const text = await readText(response)
      expect(text).toContain('"text":"hello"')
      expect(text).toContain('"text":" world"')
      expect(text).toContain('[DONE]')
    })
  })

  it('emits 401 with rotated-refresh hint for token-expiry fixtures', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'tokenExpiry401',
        rotatedRefresh: 'refresh-rotated',
      })
      const response = await fetch(`${server.baseUrl}/expired`)
      expect(response.status).toBe(401)
      const body = (await response.json()) as {
        error: { details: Array<{ '@type': string; refresh?: string }> }
      }
      expect(body.error.details[0]?.refresh).toBe('refresh-rotated')
    })
  })

  it('emits 429 with retry-after-ms for rate-limit fixtures', async () => {
    await withServer(async (server) => {
      server.enqueue({ kind: 'rateLimit429', retryAfterMs: 1500 })
      const response = await fetch(`${server.baseUrl}/limited`)
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after-ms')).toBe('1500')
      expect(response.headers.get('retry-after')).toBe('2')
    })
  })

  it('emits 503 for capacity fixtures', async () => {
    await withServer(async (server) => {
      server.enqueue({ kind: 'capacity503', retryAfterMs: 4000 })
      const response = await fetch(`${server.baseUrl}/capacity`)
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after-ms')).toBe('4000')
    })
  })

  it('delays headers by the configured duration', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'delayedHeaders',
        delayMs: 250,
        body: '{"late":true}',
      })
      const start = Date.now()
      const response = await fetch(`${server.baseUrl}/slow`)
      const elapsed = Date.now() - start
      const body = (await response.json()) as { late: boolean }
      expect(body.late).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(240)
    })
  })

  it('close() is idempotent and tears down tracked sockets', async () => {
    const server = await startMockAntigravityServer()
    server.enqueue({ kind: 'json', body: { ok: true } })
    // Fire one request, leave it open, then close. The socket should be
    // torn down without throwing.
    const pending = fetch(`${server.baseUrl}/latch`).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 20))
    await server.close()
    await server.close()
    await pending
  })
})
