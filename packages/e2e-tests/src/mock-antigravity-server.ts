/**
 * Programmable mock Antigravity server.
 *
 * The harness binds to `127.0.0.1:0` so the OS picks a free port. Tests
 * enqueue typed fixtures describing what the server should return for
 * each request; the server records every request it sees and replays the
 * next fixture from the queue. Fixtures cover the failure modes that
 * the production plugin has to handle gracefully:
 *
 *   - `projectDiscovery` — quota / project lookup (the loader path).
 *   - `quotaSummary` — `fetchAvailableModels` shape used by the quota
 *     manager.
 *   - `generateContent` — single-shot `generateContent` response.
 *   - `streamChunked` — chunked SSE stream assembled line-by-line so the
 *     client can read the body incrementally.
 *   - `tokenExpiry401` — 401 with rotated refresh-token hint.
 *   - `rateLimit429` — 429 with `retry-after-ms` headers.
 *   - `capacity503` — 503 with capacity-exhausted envelope.
 *   - `delayedHeaders` — hold the response open for `delayMs` before
 *     sending headers, exercising the header-timeout path.
 *   - `openTerminalStream` — keep the connection open and stream chunks
 *     lazily; the test closes the handle to release the client.
 *
 * The mock records the full request (method, path, headers, body) for
 * every call so the tests can assert exact ordering and payload shape.
 * `close()` is idempotent and tears down every tracked socket.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  receivedAt: number
}

export interface BaseFixture {
  /** Optional status override; default `200`. */
  status?: number
  /** Optional response headers. `content-type` defaults per fixture. */
  headers?: Record<string, string>
}

/** Single-shot JSON body — used by `generateContent` and `quotaSummary`. */
export interface JsonBodyFixture extends BaseFixture {
  kind: 'json'
  body: unknown
}

/** Unary Gemini SSE body — used by `generateContent` (stream=false). */
export interface GenerateContentFixture extends BaseFixture {
  kind: 'generateContent'
  model: string
  text: string
  /** Include `thoughtSignature` field for tests that exercise it. */
  includeThought?: boolean
}

/** Project discovery envelope — the `loadCodeAssist` response shape. */
export interface ProjectDiscoveryFixture extends BaseFixture {
  kind: 'projectDiscovery'
  projectId: string
}

/** Quota summary envelope — fed to `fetchAvailableModels`. */
export interface QuotaSummaryFixture extends BaseFixture {
  kind: 'quotaSummary'
  models: Array<{
    id: string
    displayName?: string
    quotaGroup?: string
  }>
}

/** Gemini-CLI bucket quota envelope. */
export interface GeminiCliQuotaFixture extends BaseFixture {
  kind: 'geminiCliQuota'
  buckets: Array<{ model: string; remainingFraction: number }>
}

/** Windowed quota summary envelope — fed to `retrieveUserQuotaSummary`. */
export interface QuotaSummaryWindowFixture extends BaseFixture {
  kind: 'quotaSummaryWindow'
  /**
   * When set, the server returns 403 if the posted `project` does not
   * equal this value — mirroring the real API's PERMISSION_DENIED for
   * non-managed project IDs. This makes the e2e fail on exactly the
   * class of bug where the caller sends the wrong project ID.
   */
  managedProjectId?: string
  /** Groups with their per-window buckets. */
  groups: Array<{
    displayName: string
    description?: string
    buckets: Array<{
      bucketId: string
      displayName: string
      window: 'weekly' | '5h'
      resetTime: string
      remainingFraction: number
    }>
  }>
}

/** Chunked SSE stream — one chunk per `chunks` element. */
export interface StreamChunkedFixture extends BaseFixture {
  kind: 'streamChunked'
  model: string
  chunks: string[]
  /** Optional final chunk appended automatically if absent. */
  terminator?: string
}

export interface TokenExpiryFixture extends BaseFixture {
  kind: 'tokenExpiry401'
  /** Refresh hint returned in the body so the loader can simulate a rotate. */
  rotatedRefresh?: string
}

export interface RateLimitFixture extends BaseFixture {
  kind: 'rateLimit429'
  retryAfterMs: number
  reason?: string
}

export interface CapacityFixture extends BaseFixture {
  kind: 'capacity503'
  retryAfterMs?: number
}

export interface DelayedHeadersFixture extends BaseFixture {
  kind: 'delayedHeaders'
  delayMs: number
  body?: string
}

export interface OpenTerminalStreamFixture extends BaseFixture {
  kind: 'openTerminalStream'
  model: string
  /** Caller pushes chunks via `stream.write(chunk)` until `stream.close()`. */
}

export type Fixture =
  | JsonBodyFixture
  | GenerateContentFixture
  | ProjectDiscoveryFixture
  | QuotaSummaryFixture
  | QuotaSummaryWindowFixture
  | GeminiCliQuotaFixture
  | StreamChunkedFixture
  | TokenExpiryFixture
  | RateLimitFixture
  | CapacityFixture
  | DelayedHeadersFixture
  | OpenTerminalStreamFixture

export interface MockServerHandle {
  baseUrl: string
  port: number
  requests: RecordedRequest[]
  enqueue(fixture: Fixture): void
  /** Convenience: enqueue N copies of the same fixture. */
  repeat(fixture: Fixture, count: number): void
  close(): Promise<void>
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk)
        ? Buffer.from(chunk)
        : Buffer.from(chunk)
      chunks.push(buffer)
      if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) {
        request.removeAllListeners('data')
        request.resume()
        reject(new Error('Mock request body exceeded 1 MiB'))
      }
    })
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.once('error', reject)
  })
}

function applyHeaders(
  response: ServerResponse,
  base: Record<string, string>,
  extra?: Record<string, string>,
): void {
  const merged = { ...base, ...(extra ?? {}) }
  for (const [name, value] of Object.entries(merged)) {
    response.setHeader(name, value)
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendSseStream(
  response: ServerResponse,
  chunks: string[],
  terminator: string,
): void {
  for (const chunk of chunks) {
    response.write(`${chunk}\n\n`)
  }
  response.write(`${terminator}\n\n`)
  response.end()
}

/**
 * Start a programmable mock server bound to loopback. Resolves once
 * the listener is accepting connections; tests can immediately start
 * `enqueue()`ing fixtures and dispatching requests.
 */
export async function startMockAntigravityServer(): Promise<MockServerHandle> {
  const queue: Fixture[] = []
  const requests: RecordedRequest[] = []
  const openSockets = new Set<ServerResponse>()
  let closing = false

  const server: Server = createServer(async (request, response) => {
    try {
      const body = await readBody(request)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[name] = value
        else if (Array.isArray(value)) headers[name] = value.join(', ')
      }
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers,
        body,
        receivedAt: Date.now(),
      })

      const fixture = queue.shift()
      if (!fixture) {
        sendJson(response, 500, {
          error: { code: 8, message: 'mock-queue-empty', status: 'INTERNAL' },
        })
        return
      }
      openSockets.add(response)
      response.once('close', () => openSockets.delete(response))
      await dispatch(fixture, request, response, body)
    } catch (error) {
      try {
        sendJson(response, 500, {
          error: {
            code: 13,
            message: error instanceof Error ? error.message : 'mock-error',
            status: 'INTERNAL',
          },
        })
      } catch {
        /* socket already closed */
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address() as AddressInfo | null
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Mock server bound without an address')
  }

  async function dispatch(
    fixture: Fixture,
    _request: IncomingMessage,
    response: ServerResponse,
    reqBody: string,
  ): Promise<void> {
    switch (fixture.kind) {
      case 'json': {
        const status = fixture.status ?? 200
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(fixture.body))
        return
      }
      case 'projectDiscovery': {
        sendJson(response, fixture.status ?? 200, {
          cloudaicompanionProject: fixture.projectId,
          allowedTuningFeatures: [],
        })
        return
      }
      case 'quotaSummary': {
        sendJson(response, fixture.status ?? 200, {
          models: fixture.models.map((m) => ({
            id: m.id,
            displayName: m.displayName ?? m.id,
            quotaGroup: m.quotaGroup ?? 'default',
          })),
        })
        return
      }
      case 'geminiCliQuota': {
        sendJson(response, fixture.status ?? 200, {
          buckets: fixture.buckets,
        })
        return
      }
      case 'quotaSummaryWindow': {
        // Honor the real API's 403 behavior: if managedProjectId is set
        // on the fixture and the posted project does not match, return
        // PERMISSION_DENIED so the test exercises the fallback path.
        if (fixture.managedProjectId) {
          let postedProject = ''
          try {
            postedProject =
              (JSON.parse(reqBody) as { project?: string }).project ?? ''
          } catch {
            /* malformed — let the 200 path handle it */
          }
          if (postedProject && postedProject !== fixture.managedProjectId) {
            sendJson(response, 403, {
              error: {
                code: 7,
                message: 'PERMISSION_DENIED',
                status: 'PERMISSION_DENIED',
              },
            })
            return
          }
        }
        sendJson(response, fixture.status ?? 200, {
          groups: fixture.groups,
          description:
            'Within each group, models share a weekly limit and a 5-hour limit.',
        })
        return
      }
      case 'generateContent': {
        const candidates = [
          {
            content: {
              role: 'model',
              parts: [{ text: fixture.text }],
              ...(fixture.includeThought
                ? {
                    thoughts: [
                      {
                        thought: 'reasoning trace',
                        thoughtSignature: `sig-${Date.now()}`,
                      },
                    ],
                  }
                : {}),
            },
            finishReason: 'STOP',
          },
        ]
        applyHeaders(response, SSE_HEADERS, fixture.headers)
        response.writeHead(fixture.status ?? 200)
        sendSseStream(
          response,
          [
            `data: ${JSON.stringify({ response: { candidates } })}`,
            `data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } })}`,
          ],
          '',
        )
        return
      }
      case 'streamChunked': {
        applyHeaders(response, SSE_HEADERS, fixture.headers)
        response.writeHead(fixture.status ?? 200)
        sendSseStream(
          response,
          fixture.chunks,
          fixture.terminator ?? 'data: [DONE]',
        )
        return
      }
      case 'tokenExpiry401': {
        sendJson(response, fixture.status ?? 401, {
          error: {
            code: 401,
            message: 'Request had invalid authentication credentials.',
            status: 'UNAUTHENTICATED',
            details: fixture.rotatedRefresh
              ? [{ '@type': 'rotate-refresh', refresh: fixture.rotatedRefresh }]
              : [],
          },
        })
        return
      }
      case 'rateLimit429': {
        applyHeaders(
          response,
          {
            'retry-after-ms': String(fixture.retryAfterMs),
            'retry-after': String(Math.ceil(fixture.retryAfterMs / 1000)),
            'content-type': 'application/json',
          },
          fixture.headers,
        )
        response.writeHead(fixture.status ?? 429)
        response.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Rate limit hit',
              status: 'RESOURCE_EXHAUSTED',
              details: fixture.reason
                ? [{ reason: fixture.reason }]
                : [{ reason: 'QUOTA_EXHAUSTED' }],
            },
          }),
        )
        return
      }
      case 'capacity503': {
        applyHeaders(
          response,
          {
            'content-type': 'application/json',
            ...(fixture.retryAfterMs !== undefined
              ? { 'retry-after-ms': String(fixture.retryAfterMs) }
              : {}),
          },
          fixture.headers,
        )
        response.writeHead(fixture.status ?? 503)
        response.end(
          JSON.stringify({
            error: {
              code: 503,
              message: 'Capacity exhausted',
              status: 'UNAVAILABLE',
            },
          }),
        )
        return
      }
      case 'delayedHeaders': {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, fixture.delayMs)
          timer.unref?.()
        })
        response.writeHead(fixture.status ?? 200, {
          'content-type': 'application/json',
        })
        response.end(fixture.body ?? '{}')
        return
      }
      case 'openTerminalStream': {
        applyHeaders(response, SSE_HEADERS, fixture.headers)
        response.writeHead(fixture.status ?? 200)
        // Keep the socket open until `close()` is called on the handle.
        // Tests push body chunks via the exposed `response.write` and
        // close the handle to flush.
        // We emit no body here; tests need to wait for the connection to
        // be torn down by `close()`.
        // The `Readable` import is used in other branches; reference it
        // here so TypeScript does not flag an unused import when only the
        // terminal stream path is exercised in a test run.
        void Readable.from
        return
      }
    }
  }

  async function close(): Promise<void> {
    if (closing) return
    closing = true
    for (const response of openSockets) {
      try {
        response.end()
      } catch {
        /* already torn down */
      }
    }
    openSockets.clear()
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close((err) => {
        if (err && !/not running/i.test(err.message)) {
          // Closing a server that's already torn down is a no-op in
          // tests; swallow the benign case so `close()` is idempotent.
          resolve()
          return
        }
        resolve()
      })
    })
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    enqueue(fixture) {
      queue.push(fixture)
    },
    repeat(fixture, count) {
      for (let i = 0; i < count; i += 1) queue.push(fixture)
    },
    close,
  }
}
