import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  type MockServerHandle,
  startMockAntigravityServer,
} from './mock-antigravity-server'
import {
  assertCompleteGaInventory,
  assertGaCancellation,
  assertGaCleanupEvents,
  assertGaDatabase,
  assertGaRawBindingControl,
  assertGaTlsSequence,
  assertNativeGa,
  collectGaRawCancelAssertions,
  createGaSenderSignalObserver,
  GA_CASE_IDS,
  gaChildEnvironment,
  gaDetachedDispatchSignalMutation,
  gaTimestamp,
  loadGaOverflowFixture,
  ownedPath,
  parseGaPin,
  prepareGaRoot,
  readGaPin,
  startGaMock,
  verifiedArchiveMember,
  verifyExecutable,
  verifySri,
  waitForGaObservation,
} from './opencode-ga-harness.ts'
import { cleanupE2eRootsForCurrentFile } from './setup'
import { assertGaObservations } from './support/ga-observations.ts'

afterAll(cleanupE2eRootsForCurrentFile)

describe('GA revised oracle transport fixtures (mock-only)', () => {
  it('returns the exact canned first-title 400 then allows fallback and primary success', async () => {
    const mock = await startGaMock(
      'title-primary-fallback',
      'title-control',
      process.cwd(),
    )
    try {
      const fixture = loadGaOverflowFixture(process.cwd(), 'gemini')
      const first = await fetch(`${mock.url}/agy/title`, {
        method: 'POST',
        body: '{}',
      })
      expect(first.status).toBe(400)
      expect(first.headers.get('content-type')).toBe(fixture.contentType)
      expect(Buffer.from(await first.arrayBuffer()).equals(fixture.bytes)).toBe(
        true,
      )
      const fallback = await fetch(`${mock.url}/agy/title`, {
        method: 'POST',
        body: '{}',
      })
      expect(fallback.status).toBe(200)
      expect(await fallback.text()).toContain('GA_TITLE_title-control')
      const primary = await fetch(`${mock.url}/agy/primary`, {
        method: 'POST',
        body: '{}',
      })
      expect(primary.status).toBe(200)
      expect(await primary.text()).toContain('GA_OK_title-control')
    } finally {
      await mock.close()
    }
  })
  it('attributes a held HTTP connection and its natural close to the same physical record', async () => {
    const mock = await startGaMock(
      'pty-interrupt-recovery',
      'peer-control',
      process.cwd(),
    )
    const signal = new AbortController()
    try {
      await (
        await fetch(`${mock.url}/agy/primary`, { method: 'POST', body: '{}' })
      ).text()
      const held = await fetch(`${mock.url}/agy/primary`, {
        method: 'POST',
        body: '{}',
        signal: signal.signal,
      })
      expect(held.status).toBe(200)
      await waitForGaObservation(
        () => mock.events.some((event) => event.event === 'held-content'),
        'mock held peer',
      )
      const record = mock.requests[1]!
      const observation = mock.events.find(
        (event) => event.event === 'held-content',
      )!
      expect(observation).toMatchObject({ requestIndex: 1, peer: record.peer })
      expect(record.peer).toBeGreaterThan(0)
      signal.abort()
      await waitForGaObservation(
        () =>
          mock.events.some(
            (event) =>
              event.event === 'peer-close' &&
              event.peer === record.peer &&
              event.requestIndex === 1,
          ),
        'mock natural-close of held peer',
        2000,
      )
      expect(mock.events.some((event) => event.event === 'forced-close')).toBe(
        false,
      )
    } finally {
      signal.abort()
      await mock.close()
    }
  })
})

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

  for (const order of [
    'summary-first',
    'model-list-first',
    'concurrent',
  ] as const) {
    it(`attributes scoped quota responses to each credential (${order})`, async () => {
      await withServer(async (server) => {
        const expected = [
          {
            endpoint: '/v1internal:retrieveUserQuotaSummary',
            bearer: 'Bearer access-a',
            project: 'managed-a',
            body: { summary: 0.7 },
          },
          {
            endpoint: '/v1internal:fetchAvailableModels',
            bearer: 'Bearer access-a',
            project: 'managed-a',
            body: { models: 0.4 },
          },
          {
            endpoint: '/v1internal:retrieveUserQuotaSummary',
            bearer: 'Bearer access-b',
            project: 'managed-b',
            body: { summary: 0.8 },
          },
          {
            endpoint: '/v1internal:fetchAvailableModels',
            bearer: 'Bearer access-b',
            project: 'managed-b',
            body: { models: 0.5 },
          },
        ] as const
        for (const entry of expected) {
          server.enqueue({
            kind: 'json',
            match: {
              method: 'POST',
              endpoint: entry.endpoint,
              bearer: entry.bearer,
            },
            body: entry.body,
          })
        }
        const arrivals =
          order === 'summary-first'
            ? [expected[0], expected[2], expected[1], expected[3]]
            : [expected[3], expected[1], expected[2], expected[0]]
        const send = async (entry: (typeof expected)[number]) => {
          const response = await fetch(`${server.baseUrl}${entry.endpoint}`, {
            method: 'POST',
            headers: {
              authorization: entry.bearer,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ project: entry.project }),
          })
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual(entry.body)
        }
        if (order === 'concurrent') await Promise.all(arrivals.map(send))
        else for (const entry of arrivals) await send(entry)
        expect(
          server.requests
            .map((request) => ({
              method: request.method,
              endpoint: request.path,
              bearer: request.headers.authorization,
              body: request.body,
            }))
            .sort((a, b) =>
              `${a.bearer}:${a.endpoint}`.localeCompare(
                `${b.bearer}:${b.endpoint}`,
              ),
            ),
        ).toEqual(
          expected
            .map((entry) => ({
              method: 'POST',
              endpoint: entry.endpoint,
              bearer: entry.bearer,
              body: JSON.stringify({ project: entry.project }),
            }))
            .sort((a, b) =>
              `${a.bearer}:${a.endpoint}`.localeCompare(
                `${b.bearer}:${b.endpoint}`,
              ),
            ),
        )
        expect(
          server.requests.every((request) =>
            Number.isFinite(request.receivedAt),
          ),
        ).toBe(true)
      })
    })
  }

  it('unmatched method, endpoint, or bearer cannot steal a scoped fixture', async () => {
    await withServer(async (server) => {
      const endpoint = '/v1internal:retrieveUserQuotaSummary'
      server.enqueue({
        kind: 'json',
        match: { method: 'POST', endpoint, bearer: 'Bearer access-a' },
        body: { summary: 0.7 },
      })
      for (const mismatch of [
        { method: 'GET', endpoint, bearer: 'Bearer access-a' },
        {
          method: 'POST',
          endpoint: '/v1internal:fetchAvailableModels',
          bearer: 'Bearer access-a',
        },
        { method: 'POST', endpoint, bearer: 'Bearer access-a-extra' },
      ]) {
        const response = await fetch(`${server.baseUrl}${mismatch.endpoint}`, {
          method: mismatch.method,
          headers: { authorization: mismatch.bearer },
        })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({
          error: { code: 8, message: 'mock-queue-empty', status: 'INTERNAL' },
        })
      }
      const response = await fetch(`${server.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { authorization: 'Bearer access-a' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ summary: 0.7 })
      expect(
        server.requests.map(({ method, path, headers }) => ({
          method,
          path,
          bearer: headers.authorization,
        })),
      ).toEqual([
        { method: 'GET', path: endpoint, bearer: 'Bearer access-a' },
        {
          method: 'POST',
          path: '/v1internal:fetchAvailableModels',
          bearer: 'Bearer access-a',
        },
        { method: 'POST', path: endpoint, bearer: 'Bearer access-a-extra' },
        { method: 'POST', path: endpoint, bearer: 'Bearer access-a' },
      ])
    })
  })

  it('prioritizes an exact scoped response over an earlier plain FIFO fixture', async () => {
    await withServer(async (server) => {
      server.enqueue({ kind: 'json', body: { plain: true } })
      server.enqueue({
        kind: 'json',
        match: {
          method: 'POST',
          endpoint: '/quota',
          bearer: 'Bearer access-a',
        },
        body: { scoped: true },
      })
      const scoped = await fetch(`${server.baseUrl}/quota`, {
        method: 'POST',
        headers: { authorization: 'Bearer access-a' },
      })
      expect(await scoped.json()).toEqual({ scoped: true })
      const plain = await fetch(`${server.baseUrl}/plain`)
      expect(await plain.json()).toEqual({ plain: true })
      expect(
        server.requests.map(({ method, path }) => ({ method, path })),
      ).toEqual([
        { method: 'POST', path: '/quota' },
        { method: 'GET', path: '/plain' },
      ])
    })
  })

  it('keeps ordinary FIFO fixtures available behind unmatched scoped fixtures', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'json',
        match: {
          method: 'POST',
          endpoint: '/quota',
          bearer: 'Bearer access-a',
        },
        body: { scoped: true },
      })
      server.enqueue({ kind: 'json', body: { count: 1 } })
      server.repeat({ kind: 'json', body: { count: 2 } }, 2)
      for (const count of [1, 2, 2]) {
        expect(await (await fetch(`${server.baseUrl}/plain`)).json()).toEqual({
          count,
        })
      }
      expect(
        await (
          await fetch(`${server.baseUrl}/quota`, {
            method: 'POST',
            headers: { authorization: 'Bearer access-a' },
          })
        ).json(),
      ).toEqual({ scoped: true })
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
})

// ===========================================================================
// quotaSummaryWindow — managedProjectId 403 gate
// ===========================================================================

describe('quotaSummaryWindow managedProjectId 403 gate', () => {
  it('returns 200 when project matches managedProjectId', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'quotaSummaryWindow',
        managedProjectId: 'managed-rpc',
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit',
                window: 'weekly',
                resetTime: '2026-07-31T00:00:00Z',
                remainingFraction: 0.7,
              },
            ],
          },
        ],
      })
      const response = await fetch(
        `${server.baseUrl}/v1internal:retrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: 'managed-rpc' }),
        },
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        groups: Array<{
          displayName: string
          buckets: Array<{ bucketId: string; remainingFraction: number }>
        }>
      }
      expect(body.groups).toHaveLength(1)
      expect(body.groups[0]!.buckets[0]!.bucketId).toBe('gemini-weekly')
      expect(body.groups[0]!.buckets[0]!.remainingFraction).toBe(0.7)
    })
  })

  it('returns 403 when project field is omitted', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'quotaSummaryWindow',
        managedProjectId: 'managed-rpc',
        groups: [],
      })
      const response = await fetch(
        `${server.baseUrl}/v1internal:retrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      expect(response.status).toBe(403)
      const body = (await response.json()) as {
        error: { code: number; message: string }
      }
      expect(body.error.code).toBe(7)
      expect(body.error.message).toBe('PERMISSION_DENIED')
    })
  })

  it('returns 403 when project does not match managedProjectId', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'quotaSummaryWindow',
        managedProjectId: 'managed-rpc',
        groups: [],
      })
      const response = await fetch(
        `${server.baseUrl}/v1internal:retrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: 'wrong-project' }),
        },
      )
      expect(response.status).toBe(403)
    })
  })

  it('returns 400 when the request body is unparseable JSON', async () => {
    await withServer(async (server) => {
      server.enqueue({
        kind: 'quotaSummaryWindow',
        managedProjectId: 'managed-rpc',
        groups: [],
      })
      const response = await fetch(
        `${server.baseUrl}/v1internal:retrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json',
        },
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        error: { code: number; message: string }
      }
      expect(body.error.code).toBe(3)
      expect(body.error.message).toBe('INVALID_ARGUMENT')
    })
  })
})

// No CLI, Docker or adapter is invoked by these clean-room controls.
describe('GA host safety controls (synthetic, not runtime certification)', () => {
  function freshRoot(): string {
    return realpathSync(
      mkdtempSync(join(process.env.ANTIGRAVITY_TEST_ROOT!, 'ga-safety-')),
    )
  }

  it('refuses missing, nonempty and symlinked DB roots', () => {
    expect(() => prepareGaRoot('')).toThrow('Missing owned GA root')
    const root = freshRoot()
    writeFileSync(join(root, 'profile'), 'not empty')
    expect(() => prepareGaRoot(root)).toThrow('GA root must be empty')
    const clean = freshRoot()
    const link = join(root, 'alias')
    symlinkSync(clean, link)
    expect(() => prepareGaRoot(link)).toThrow('Unsafe owned GA root')
  })

  it('refuses lexical, ancestor and dangling symlink DB escapes', () => {
    const root = freshRoot()
    expect(() => ownedPath(root, join(root, '..', 'outside.db'))).toThrow(
      'escapes owned root',
    )
    symlinkSync('/missing/ga-safety-target', join(root, 'data'))
    expect(() => ownedPath(root, join(root, 'data', 'host.db'))).toThrow(
      'Symlink in owned path',
    )
  })

  it('constructs a child environment with its own DB and no inherited host settings', () => {
    const paths = prepareGaRoot(freshRoot())
    const inherited = {
      OPENCODE_DB: '/live/profile.db',
      OPENCODE_CONFIG_CONTENT: '{"plugins":["live"]}',
      OPENCODE_SERVER: 'https://live.example',
      NODE_OPTIONS: '--require /live/inject.js',
      NODE_EXTRA_CA_CERTS: '/live/ca.pem',
      HTTPS_PROXY: 'http://live.example',
      GOOGLE_GENERATIVE_AI_API_KEY: 'live-key',
      PATH: '/live/bin',
      HOME: '/live/home',
      SECRET: 'live-secret',
    }
    const environment = gaChildEnvironment(paths, inherited)
    expect(environment.OPENCODE_DB).toBe(
      join(paths.root, 'data', 'opencode.db'),
    )
    expect(environment.HOME).toBe(paths.home)
    expect(environment.GOOGLE_GENERATIVE_AI_API_KEY).toBe('synthetic-ga-key')
    for (const key of [
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_SERVER',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'HTTPS_PROXY',
      'SECRET',
    ]) {
      expect(Object.hasOwn(environment, key)).toBe(false)
    }
    expect(inherited.OPENCODE_DB).toBe('/live/profile.db')
    expect(() =>
      gaChildEnvironment({ ...paths, database: '' }, inherited),
    ).toThrow('Missing isolated OPENCODE_DB')
    expect(() =>
      gaChildEnvironment({ ...paths, database: '/live/profile.db' }, inherited),
    ).toThrow('escapes owned root')
    expect(() =>
      gaChildEnvironment(
        paths,
        {},
        { proxy: { OPENCODE_DB: '/live/profile.db' } },
      ),
    ).toThrow('Unexpected environment injection')
  })

  it('requires a nonempty actual DB created within the owned root', () => {
    const paths = prepareGaRoot(freshRoot())
    expect(() => assertGaDatabase(paths)).toThrow(
      'Host did not create isolated OPENCODE_DB',
    )
    writeFileSync(paths.database, '')
    expect(() => assertGaDatabase(paths)).toThrow(
      'Host did not create isolated OPENCODE_DB',
    )
    writeFileSync(paths.database, 'synthetic-database')
    expect(() => assertGaDatabase(paths)).not.toThrow()
  })

  it('rejects emulated x64 with arm64 measuring host or Docker daemon', () => {
    const native = {
      hostUname: 'x86_64',
      daemonArchitecture: 'x86_64',
      containerUname: 'x86_64',
      elfMachine: 62,
      runtimeIdentity: 'synthetic-runtime',
    }
    expect(() => assertNativeGa(native, 'synthetic-runtime')).not.toThrow()
    for (const field of [
      'hostUname',
      'daemonArchitecture',
      'containerUname',
    ] as const) {
      expect(() =>
        assertNativeGa({ ...native, [field]: 'arm64' }, 'synthetic-runtime'),
      ).toThrow('not native x86_64')
    }
    expect(() =>
      assertNativeGa({ ...native, elfMachine: 183 }, 'synthetic-runtime'),
    ).toThrow('Wrong host ELF architecture')
    expect(() => assertNativeGa(native, 'wrong-runtime')).toThrow(
      'Wrong pinned runtime identity',
    )
  })

  it('checks archive integrity before extraction and ELF digest before binary use', () => {
    const archive = Buffer.from('synthetic archive, never extracted')
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    expect(() => verifySri(archive, integrity)).not.toThrow()
    expect(() => verifySri(Buffer.from('wrong archive'), integrity)).toThrow(
      'Tarball SRI mismatch',
    )
    expect(() => verifySri(archive, 'sha256-placeholder')).toThrow(
      'Malformed SHA-512 SRI',
    )
    const path = join(freshRoot(), 'synthetic-elf')
    const elf = Buffer.alloc(32)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    elf.writeUInt16LE(62, 18)
    writeFileSync(path, elf)
    const digest = createHash('sha256').update(elf).digest('hex')
    expect(() => verifyExecutable(path, digest, 62)).not.toThrow()
    expect(() => verifyExecutable(path, '0'.repeat(64), 62)).toThrow(
      'Executable digest mismatch',
    )
    expect(() => verifyExecutable(path, digest, 183)).toThrow(
      'Wrong host ELF architecture',
    )
  })
})

describe('GA mock observation controls', () => {
  it('preserves exact canned-response bytes, status and content type', async () => {
    await withServer(async (server) => {
      const bytes = Buffer.from('{ "error": {"code":400} }\r\n')
      server.enqueue({
        kind: 'rawResponse',
        status: 400,
        contentType: 'application/json; charset=utf-8',
        body: bytes,
      })
      const response = await fetch(`${server.baseUrl}/canned`)
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      )
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    })
  })

  it('observes a natural peer close after genuine post-header content', async () => {
    await withServer(async (server) => {
      const events: string[] = []
      let closeResolve!: () => void
      const peerClosed = new Promise<void>((resolve) => {
        closeResolve = resolve
      })
      server.enqueue({
        kind: 'heldResponse',
        phase: 'post-header',
        content:
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"genuine"}]}}]}}\r\n\r\n',
        observe(event) {
          events.push(event)
          if (event === 'peer-close') closeResolve()
        },
      })
      const controller = new AbortController()
      const response = await fetch(`${server.baseUrl}/hold`, {
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'genuine',
      )
      controller.abort()
      await Promise.race([
        peerClosed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('missing natural peer close')),
            2000,
          ),
        ),
      ])
      expect(events).toEqual(['parsed', 'content', 'peer-close'])
    })
  })

  it('labels harness teardown separately from a natural cancellation', async () => {
    const server = await startMockAntigravityServer()
    const events: string[] = []
    let parsedResolve!: () => void
    const parsed = new Promise<void>((resolve) => {
      parsedResolve = resolve
    })
    server.enqueue({
      kind: 'heldResponse',
      phase: 'pre-header',
      observe(event) {
        events.push(event)
        if (event === 'parsed') parsedResolve()
      },
    })
    const pending = fetch(`${server.baseUrl}/hold`).catch(() => undefined)
    await parsed
    await server.close()
    await server.close()
    await pending
    expect(events).toEqual(['parsed', 'forced-close'])
  })
})

describe('GA inventory and evidence controls', () => {
  it('rejects omitted, duplicate, unknown and empty case inventories', () => {
    expect(() => assertCompleteGaInventory(GA_CASE_IDS)).not.toThrow()
    expect(() => assertCompleteGaInventory([])).toThrow(
      'Incomplete or unexpected',
    )
    expect(() => assertCompleteGaInventory(GA_CASE_IDS.slice(1))).toThrow(
      'Incomplete or unexpected',
    )
    expect(() =>
      assertCompleteGaInventory([...GA_CASE_IDS, GA_CASE_IDS[0]]),
    ).toThrow('Duplicate GA case')
    expect(() =>
      assertCompleteGaInventory([...GA_CASE_IDS.slice(1), 'success-stub']),
    ).toThrow('Incomplete or unexpected')
  })

  it('rejects source-prepared cases and missing actual scenario observations', () => {
    const root = realpathSync(
      mkdtempSync(join(process.env.ANTIGRAVITY_TEST_ROOT!, 'ga-evidence-')),
    )
    const database = join(root, 'synthetic.db')
    writeFileSync(database, 'synthetic database')
    const observations = GA_CASE_IDS.map((id, index) => ({
      id,
      state: 'source-prepared' as const,
      nonce: (index + 1).toString(16).padStart(32, '0'),
      databaseFile: database,
      evidenceFiles: [],
      primaryRequests: 0,
      directProviderRequests: 0,
      elapsedMs: 1,
    }))
    expect(() => assertGaObservations(root, observations)).toThrow(
      'Source-prepared is not runtime-verified',
    )
    expect(() =>
      assertGaObservations(
        root,
        observations.map((observation) => ({
          ...observation,
          state: 'runtime-verified',
        })),
      ),
    ).toThrow('Missing actual scenario observations')
  })
})

describe('GA raw-sender proof parser controls (synthetic only)', () => {
  it('rejects missing cleanup and producer activity after cleanup through the live validator', () => {
    const events = [
      { event: 'send.start', scope: 'a', at: 1 },
      { event: 'cleanup.end', scope: 'a', at: 2 },
      { event: 'send.start', scope: 'b', at: 3 },
    ]
    expect(() => assertGaCleanupEvents(events, 'a')).not.toThrow()
    expect(() =>
      assertGaCleanupEvents(
        events.filter((event) => event.event !== 'cleanup.end'),
        'a',
      ),
    ).toThrow('did not naturally invoke returned Cleanup')
    for (const event of ['send.start', 'signal.abort', 'native.request']) {
      expect(() =>
        assertGaCleanupEvents([...events, { event, scope: 'a', at: 3 }], 'a'),
      ).toThrow('after Cleanup completion')
    }
  })

  it('rejects absent raw sender and peer-close observations without a host launch', async () => {
    const outcomes = await collectGaRawCancelAssertions({
      interruptedAt: gaTimestamp() - 2_001,
      signals: [],
      peerClosedAt: () => undefined,
      forcedTeardown: () => false,
    })
    expect(outcomes.length).toBeGreaterThan(0)
    expect(outcomes.every((outcome) => !outcome.passed)).toBe(true)
  })

  it('requires distinct connecting, parsed pre-header and genuine post-header prerequisites', () => {
    const connecting = {
      phase: 'connecting' as const,
      tcpAcceptedAt: 1,
      interruptedAt: 100,
      senderAbortedAt: 101,
      peerClosedAt: 102,
      applicationBytes: 0,
      bytesAfterPeerClose: 0,
      forcedTeardown: false,
    }
    expect(() => assertGaCancellation(connecting)).not.toThrow()
    expect(() =>
      assertGaCancellation({ ...connecting, tcpAcceptedAt: undefined }),
    ).toThrow('Missing naturally accepted')
    expect(() =>
      assertGaCancellation({ ...connecting, senderAbortedAt: undefined }),
    ).toThrow('Missing sender AbortSignal')
    expect(() =>
      assertGaCancellation({ ...connecting, peerClosedAt: 2101 }),
    ).toThrow('within 2000 ms')
    expect(() =>
      assertGaCancellation({ ...connecting, forcedTeardown: true }),
    ).toThrow('Missing natural raw peer close')
    expect(() =>
      assertGaCancellation({ ...connecting, applicationBytes: 1 }),
    ).toThrow('Connecting proof emitted')
    const parsed = {
      ...connecting,
      phase: 'pre-header' as const,
      parsedPrimaryAt: 2,
      applicationBytes: 200,
    }
    expect(() => assertGaCancellation(parsed)).not.toThrow()
    expect(() =>
      assertGaCancellation({ ...parsed, parsedPrimaryAt: undefined }),
    ).toThrow('Missing genuinely parsed primary')
    expect(() => assertGaCancellation({ ...parsed, contentAt: 3 })).toThrow(
      'Pre-header proof sent content',
    )
    expect(() =>
      assertGaCancellation({ ...parsed, phase: 'post-header' }),
    ).toThrow('Missing genuine post-header content')
    expect(() =>
      assertGaCancellation({ ...parsed, phase: 'post-header', contentAt: 3 }),
    ).not.toThrow()
  })

  it('requires nonce-matched TLS positives around all three actual rejection observations', () => {
    const nonce = 'a'.repeat(32)
    const positive = {
      nonce,
      primaryBodies: [
        JSON.stringify({
          model: 'synthetic-primary-model',
          request: { contents: [{ role: 'user', parts: [{ text: nonce }] }] },
        }),
      ],
      nativeErrors: [],
    }
    const chain = {
      nonce,
      primaryBodies: [],
      nativeErrors: [
        {
          type: 'provider.transport',
          message: 'unable to verify certificate issuer',
        },
      ],
    }
    const identity = {
      nonce,
      primaryBodies: [],
      nativeErrors: [
        { type: 'provider.transport', message: 'hostname does not match SAN' },
      ],
    }
    const traces = [positive, chain, identity, identity, positive]
    expect(() => assertGaTlsSequence(traces)).not.toThrow()
    expect(() => assertGaTlsSequence(traces.slice(1))).toThrow('Incomplete TLS')
    expect(() =>
      assertGaTlsSequence([
        { ...positive, primaryBodies: ['title-only'] },
        ...traces.slice(1),
      ]),
    ).toThrow('Missing nonce-matched primary TLS positive')
    expect(() =>
      assertGaTlsSequence([
        positive,
        { ...chain, nativeErrors: [] },
        identity,
        identity,
        positive,
      ]),
    ).toThrow('TLS negative did not reject')
    expect(() =>
      assertGaTlsSequence([
        positive,
        { ...chain, primaryBodies: ['decrypted'] },
        identity,
        identity,
        positive,
      ]),
    ).toThrow('TLS negative did not reject')
    expect(() =>
      assertGaTlsSequence([
        positive,
        chain,
        {
          ...identity,
          nativeErrors: [{ message: 'assistant said hostname mismatch' }],
        },
        identity,
        positive,
      ]),
    ).toThrow('native provider error')
  })
})

describe('GA verified archive parser (no binary execution)', () => {
  function archive(name: string, content: string, type = '0'): Buffer {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000755\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(
      `${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`,
      124,
      12,
      'ascii',
    )
    header.write('00000000000\0', 136, 12, 'ascii')
    header.fill(32, 148, 156)
    header.write(type, 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const payload = Buffer.alloc(
      Math.ceil(Buffer.byteLength(content) / 512) * 512,
    )
    payload.write(content)
    return gzipSync(Buffer.concat([header, payload, Buffer.alloc(1024)]))
  }
  const sri = (bytes: Buffer) =>
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`

  it('extracts only verified ordinary members and rejects escape, links and missing binaries', () => {
    const bytes = archive('package/bin/opencode', 'synthetic, not executable')
    expect(
      verifiedArchiveMember(
        bytes,
        sri(bytes),
        'package/bin/opencode',
      ).toString(),
    ).toBe('synthetic, not executable')
    expect(() =>
      verifiedArchiveMember(
        bytes,
        sri(Buffer.from('changed')),
        'package/bin/opencode',
      ),
    ).toThrow('SRI mismatch')
    for (const path of ['../escape', 'package/../escape', '/absolute']) {
      const unsafe = archive(path, 'bad')
      expect(() =>
        verifiedArchiveMember(unsafe, sri(unsafe), 'package/bin/opencode'),
      ).toThrow('Unsafe archive path')
    }
    const link = archive('package/bin/opencode', 'target', '2')
    expect(() =>
      verifiedArchiveMember(link, sri(link), 'package/bin/opencode'),
    ).toThrow('Unsupported archive member type')
    expect(() =>
      verifiedArchiveMember(bytes, sri(bytes), 'package/bin/absent'),
    ).toThrow('Missing executable archive member')
  })
})

describe('GA scenario mock preparation (no adapter or host pass)', () => {
  it('records primary, title and forbidden direct-provider traffic independently', async () => {
    const nonce = 'b'.repeat(32)
    const server = await startGaMock('terminal-frame', nonce, process.cwd())
    try {
      const primary = await fetch(`${server.url}/agy/primary`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'synthetic-primary',
          request: { contents: [{ parts: [{ text: nonce }] }] },
        }),
      })
      const primaryBody = await primary.text()
      expect(primaryBody).toContain(`GA_OK_${nonce}`)
      expect(primaryBody).toContain('"finishReason":"STOP"')
      const title = await fetch(`${server.url}/agy/title`, {
        method: 'POST',
        body: '{}',
      })
      expect(await title.text()).toContain(`GA_TITLE_${nonce}`)
      const bypass = await fetch(
        `${server.url}/direct/v1/streamGenerateContent`,
        { method: 'POST', body: '{}' },
      )
      expect(bypass.status).toBe(418)
      await bypass.text()
      expect(server.requests.map((request) => request.kind)).toEqual([
        'primary',
        'title',
        'direct-provider',
      ])
    } finally {
      await server.close()
    }
  })

  it('prepares late failure bytes without synthesizing a terminal frame', async () => {
    const server = await startGaMock(
      'late-error-after-content',
      'c'.repeat(32),
      process.cwd(),
    )
    try {
      const response = await fetch(`${server.url}/agy/primary`, {
        method: 'POST',
        body: '{}',
      })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('GENUINE_')
      expect(body).toContain('GENUINE_FAILURE_')
      expect(body).not.toContain('finishReason')
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})

describe('GA proposed pin schema controls (synthetic, no archive or binary use)', () => {
  function syntheticPin() {
    return {
      schema: 1,
      package: '@opencode/cli-linux-x64',
      version: '2.0.22',
      tarballURL:
        'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.22.tgz',
      sri: `sha512-${'A'.repeat(86)}==`,
      binaryPath: 'package/bin/opencode',
      binarySha256: 'a'.repeat(64),
      binaryBytes: 204482016,
      elfMachine: 62,
      platform: 'linux/amd64',
      reportedVersion: 'opencode v2.0.22',
      runtime: {
        name: 'Bun',
        version: '1.4.2',
        revision: '744846f844374847c902b5e7fd59b4342a51ef99',
      },
      source: {
        repository: 'https://github.com/anomalyco/opencode',
        tag: 'v2.0.22',
        commit: '527f0b931d1f9b3ebd34e106c51b31ce5db5b075',
      },
      provenance: {
        artifact: 'Synthetic schema fixture, not an artifact pin',
        artifactRecordSha256: 'b'.repeat(64),
        runtime: 'Synthetic runtime record',
        runtimeRecordSha256: 'c'.repeat(64),
        limits: 'No execution or certification',
      },
    }
  }

  it('requires an actual tracked pin with all fields and no unknown keys', () => {
    const pin = syntheticPin()
    expect(() => parseGaPin(pin)).not.toThrow()
    expect(() => readGaPin(process.env.ANTIGRAVITY_TEST_ROOT!)).toThrow(
      'Missing tracked GA pin',
    )
    expect(() => parseGaPin({ ...pin, success: true })).toThrow(
      'Absent or unknown GA pin field',
    )
    expect(() =>
      parseGaPin({ ...pin, runtime: { ...pin.runtime, unknown: 1 } }),
    ).toThrow('Absent or unknown GA pin field')
    for (const key of Object.keys(pin)) {
      const incomplete: Record<string, unknown> = { ...pin }
      delete incomplete[key]
      expect(() => parseGaPin(incomplete)).toThrow(
        'Absent or unknown GA pin field',
      )
    }
  })

  it('rejects malformed pins, wrong architecture/runtime, and non-registry URLs', () => {
    const pin = syntheticPin()
    for (const patch of [
      { schema: 0 },
      { version: '2.0.20' },
      { elfMachine: 183 },
      { platform: 'linux/arm64' },
      { binaryPath: '../host' },
    ])
      expect(() => parseGaPin({ ...pin, ...patch })).toThrow(
        'identity or architecture',
      )
    expect(() =>
      parseGaPin({ ...pin, tarballURL: 'https://unverified.example/host.tgz' }),
    ).toThrow('registry artifact URL')
    expect(() => parseGaPin({ ...pin, sri: 'placeholder' })).toThrow(
      'Malformed GA pin SRI',
    )
    expect(() => parseGaPin({ ...pin, binarySha256: 'not-a-hash' })).toThrow(
      'Malformed GA pin executable',
    )
    expect(() =>
      parseGaPin({ ...pin, runtime: { ...pin.runtime, version: 'wrong' } }),
    ).toThrow('runtime identity')
  })
})

describe('GA cancellation ruling preparation (mock-only, not production binding proof)', () => {
  it('records both detached-signal failures before teardown and preserves an uncancelled request control', async () => {
    const server = await startMockAntigravityServer()
    const observer = createGaSenderSignalObserver()
    const job = new AbortController()
    const dispatch = new AbortController()
    let closedAt: number | undefined
    let forced = false
    let parsedResolve!: () => void
    const parsed = new Promise<void>((resolveParsed) => {
      parsedResolve = resolveParsed
    })
    server.enqueue({
      kind: 'heldResponse',
      phase: 'pre-header',
      observe(event) {
        if (event === 'parsed') parsedResolve()
        if (event === 'peer-close') closedAt = gaTimestamp()
        if (event === 'forced-close') forced = true
      },
    })
    const options = { signal: dispatch.signal }
    expect(observer.observeRawSenderSignal(options.signal)).toBeUndefined()
    const pending = fetch(
      `${server.baseUrl}/synthetic-detached-binding`,
      options,
    ).catch(() => undefined)
    try {
      await parsed
      const interruptedAt = gaTimestamp()
      job.abort()
      const assertions = await collectGaRawCancelAssertions({
        interruptedAt,
        signals: observer.records,
        peerClosedAt: () => closedAt,
        forcedTeardown: () => forced,
      })
      expect(assertions).toEqual([
        {
          name: 'ga.raw-cancel.sender-signal-aborted',
          passed: false,
          observedAt: null,
        },
        {
          name: 'ga.raw-cancel.peer-closed-before-teardown',
          passed: false,
          observedAt: null,
        },
      ])
      expect(forced).toBe(false)
      const before = server.requests.length
      server.enqueue({
        kind: 'generateContent',
        model: 'synthetic-primary',
        text: 'UNCANCELLED_REQUEST_OK',
      })
      const live = new AbortController()
      observer.observeRawSenderSignal(live.signal)
      const response = await fetch(
        `${server.baseUrl}/synthetic-uncancelled-control`,
        { signal: live.signal },
      )
      expect(await response.text()).toContain('UNCANCELLED_REQUEST_OK')
      const unaffected = {
        name: 'ga.raw-cancel.uncancelled-request-completes',
        completed: true,
        primaryRequests: server.requests.length - before,
        infrastructureFailures: [],
      }
      expect(() =>
        assertGaRawBindingControl(assertions, unaffected),
      ).not.toThrow()
      expect(() =>
        assertGaRawBindingControl(
          [{ ...assertions[0]!, passed: true }, assertions[1]!],
          unaffected,
        ),
      ).toThrow('both required mechanisms')
    } finally {
      observer.dispose()
      await server.close()
      await pending
    }
  }, 5000)

  // These emitted function shapes have separate observer bindings: the engine
  // collaborator forwards url/init/options, while createGaRawSender derives
  // the request from input. Both dispatch through fetchWithAgyCliTransport.
  const transport = `function gaEngineCollaborators(input2) {
  const observe = input2.overrides.observeRawSenderSignal;
  return {
    transport: (url, init, options) => {
      const transportOptions = {
        ...options,
        idleTimeoutMs: options?.idleTimeoutMs ?? GA_TRANSPORT_IDLE_TIMEOUT_MS
      };
      if (observe && transportOptions.signal) {
        try {
          observe(transportOptions.signal);
        } catch {}
      }
      return fetchWithAgyCliTransport(url, init, transportOptions);
    }
  };
}`
  const sender = `function createGaRawSender(overrides = {}) {
  const send = overrides.send;
  if (send) return (input) => send(input);
  const observe = overrides.observeRawSenderSignal;
  return (input) => {
    const transportOptions = {
      signal: input.signal,
      idleTimeoutMs: GA_RAW_IDLE_TIMEOUT_MS
    };
    if (observe) {
      try {
        observe(transportOptions.signal);
      } catch {}
    }
    return fetchWithAgyCliTransport(
      input.endpoint + GA_STREAM_PATH,
      { method: "POST", headers: { Authorization: "Bearer " + input.auth.access }, body: JSON.stringify(input.envelope) },
      transportOptions
    );
  };
}`
  const packed = `${transport}\n${sender}`
  it('selects only the packed three-parameter physical transport observation', () => {
    const source = packed
    const mutation = gaDetachedDispatchSignalMutation(source)
    expect(mutation.control).toBe('ga.raw-cancel.detached-dispatch-signal')
    expect(mutation.line).toBe(11)
    expect(mutation.source).toContain(
      'transportOptions.signal = new AbortController().signal',
    )
    expect(mutation.source).toContain(sender)
    expect(mutation.source).toContain(
      'fetchWithAgyCliTransport(url, init, transportOptions)',
    )
  })

  it('refuses missing, ambiguous and non-forwarding packed transport candidates', () => {
    expect(() => gaDetachedDispatchSignalMutation(sender)).toThrow('Missing')
    expect(() =>
      gaDetachedDispatchSignalMutation(
        `${packed}\n${transport.replace('gaEngineCollaborators', 'secondCollaborator')}`,
      ),
    ).toThrow('ambiguous')
    for (const changed of [
      transport.replace('...options,', '...otherOptions,'),
      transport.replace(
        'fetchWithAgyCliTransport(url, init, transportOptions)',
        'fetchWithAgyCliTransport(otherUrl, init, transportOptions)',
      ),
      transport.replace(
        'fetchWithAgyCliTransport(url, init, transportOptions)',
        'fetchWithAgyCliTransport(url, otherInit, transportOptions)',
      ),
      transport.replace(
        'fetchWithAgyCliTransport(url, init, transportOptions)',
        'fetchWithAgyCliTransport(url, init, otherOptions)',
      ),
      transport
        .replace(
          'return fetchWithAgyCliTransport',
          'const nested = () => fetchWithAgyCliTransport(url, init, transportOptions);\nreturn fetchWithAgyCliTransport',
        )
        .replace(
          'return fetchWithAgyCliTransport(url, init, transportOptions)',
          'return nested()',
        ),
    ])
      expect(() =>
        gaDetachedDispatchSignalMutation(`${changed}\n${sender}`),
      ).toThrow('Missing')
    expect(() => gaDetachedDispatchSignalMutation(transport)).toThrow(
      'unchanged raw sender',
    )
  })

  it('rejects cancellation attribution when the unrelated packed sender is targeted', async () => {
    const attribute = async (source: string) => {
      let observed: AbortSignal | undefined
      let dispatched: AbortSignal | undefined
      const create = new Function(
        'fetchWithAgyCliTransport',
        'GA_TRANSPORT_IDLE_TIMEOUT_MS',
        'GA_RAW_IDLE_TIMEOUT_MS',
        'GA_STREAM_PATH',
        `${source}; return gaEngineCollaborators;`,
      )
      const engine = create(
        (_url: string, _init: unknown, options: { signal: AbortSignal }) => {
          dispatched = options.signal
        },
        60_000,
        60_000,
        '/streamGenerateContent',
      )
      const original = new AbortController()
      engine({
        overrides: {
          observeRawSenderSignal: (signal: AbortSignal) => {
            observed = signal
          },
        },
      }).transport(
        'https://example.invalid',
        { method: 'POST' },
        { signal: original.signal },
      )
      original.abort()
      expect(dispatched).toBe(observed)
      // Only signal attribution is simulated here. runGaDetachedBindingControl
      // separately measures the real native sender's signal and peer closure
      // before closing its fixture.
      const assertions = [
        {
          name: 'ga.raw-cancel.sender-signal-aborted' as const,
          passed: observed?.aborted === true,
          observedAt: null,
        },
        {
          name: 'ga.raw-cancel.peer-closed-before-teardown' as const,
          passed: false,
          observedAt: null,
        },
      ]
      assertGaRawBindingControl(assertions, {
        name: 'ga.raw-cancel.uncancelled-request-completes',
        completed: true,
        primaryRequests: 1,
        infrastructureFailures: [],
      })
    }
    await attribute(gaDetachedDispatchSignalMutation(packed).source)
    const wrongTarget = `${transport}\n${sender.replace('observe(transportOptions.signal);', 'transportOptions.signal = new AbortController().signal; // NON-VACUITY BREAK: unrelated sender\nobserve(transportOptions.signal);')}`
    await expect(attribute(wrongTarget)).rejects.toThrow(
      'both required mechanisms',
    )
  })

  it('removes only its own passive signal listener at teardown', () => {
    const observer = createGaSenderSignalObserver()
    const signal = new AbortController()
    observer.observeRawSenderSignal(signal.signal)
    observer.dispose()
    signal.abort()
    expect(observer.records[0]?.abortedAt).toBeUndefined()
    expect(signal.signal.aborted).toBe(true)
    expect(observer.failures).toEqual([])
  })
})

describe('e2e native Pi environment boundary', () => {
  it('pins the dynamically resolved native agent root beside the extension root', () => {
    const root = process.env.ANTIGRAVITY_TEST_ROOT
    expect(root).toBeDefined()
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root!, 'pi-agent'))
    expect(process.env.PI_CODING_AGENT_DIR).toBe(process.env.PI_AGENT_DIR)
    // This checks only the environment the preload sets. It does not load
    // the Pi SDK, so it does not show the SDK resolving this directory.
    expect(process.env.PI_CODING_AGENT_DIR).not.toBe(process.env.HOME)
  })
})

describe('GA ownership mock policies (synthetic HTTP controls)', () => {
  it('returns Google-native success and a nonce-scoped generic 500 only for passthrough', async () => {
    const nonce = 'a'.repeat(32)
    const second = 'b'.repeat(32)
    const server = await startGaMock(
      'ga-ownership-passthrough',
      nonce,
      process.cwd(),
    )
    const headers = {
      'content-type': 'application/json',
      'x-goog-api-key': 'synthetic-ga-key',
      'x-opencode-session-id': 'fixed-session',
      'x-fixture-full-capture': 'retained',
    }
    const body = (text: string) =>
      JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] })
    const send = (text: string) =>
      fetch(`${server.url}/direct/v1/models/native:streamGenerateContent`, {
        method: 'POST',
        headers,
        body: body(text),
        signal: AbortSignal.timeout(2000),
      })
    try {
      server.failNextDirectProvider(second)
      const first = await send(nonce)
      expect(first.status).toBe(200)
      const bytes = await first.text()
      const frame = JSON.parse(bytes.slice('data: '.length).trim())
      expect(frame.response).toBeUndefined()
      expect(frame.candidates).toEqual([
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: `GA_DIRECT_OK_${nonce}` }],
          },
          finishReason: 'STOP',
        },
      ])
      const failed = await send(second)
      expect(failed.status).toBe(500)
      expect(failed.headers.get('retry-after')).toBeNull()
      expect(failed.headers.get('x-should-retry')).toBeNull()
      expect(await failed.json()).toEqual({
        error: { message: 'Synthetic internal failure' },
      })
      const retried = await send(second)
      expect(retried.status).toBe(200)
      expect(await retried.text()).toContain(`GA_DIRECT_OK_${nonce}`)
      expect(server.requests.map((request) => request.responseStatus)).toEqual([
        200, 500, 200,
      ])
      expect(
        server.requests.every((request) => request.kind === 'direct-provider'),
      ).toBe(true)
      for (const request of server.requests) {
        expect(request.headers['x-goog-api-key']).toBe('synthetic-ga-key')
        expect(request.headers['x-opencode-session-id']).toBe('fixed-session')
        expect(request.headers['x-fixture-full-capture']).toBe('retained')
        expect(request.rawHeaders).toContain('retained')
      }
      expect(server.requests[1]?.body).toBe(server.requests[2]?.body)
      expect(server.requests[1]?.headers).toEqual(server.requests[2]?.headers)
    } finally {
      await server.close()
    }
    const owned = await startGaMock('terminal-frame', nonce, process.cwd())
    try {
      expect(() => owned.failNextDirectProvider(second)).toThrow(
        'GA_DIRECT_POLICY_NOT_ADMITTED',
      )
      const response = await fetch(`${owned.url}/direct/v1`, {
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(418)
      expect(await response.text()).toContain(
        'native driver bypassed Antigravity',
      )
    } finally {
      await owned.close()
    }
  })

  it('holds the original successful unrelated response until explicit release and captures prepared headers', async () => {
    const server = await startGaMock(
      'late-unrelated-response',
      'c'.repeat(32),
      process.cwd(),
    )
    let received = false
    const pending = fetch(`${server.url}/foreign/v1`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': 'synthetic-ga-key',
        'x-fixture-header': 'unchanged',
      },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    }).then(async (response) => {
      received = true
      return { status: response.status, text: await response.text() }
    })
    try {
      await waitForGaObservation(
        () => server.events.some((event) => event.event === 'unrelated-held'),
        'foreign request held',
        2000,
      )
      expect(received).toBe(false)
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.headers['x-goog-api-key']).toBe(
        'synthetic-ga-key',
      )
      expect(server.requests[0]?.headers['x-fixture-header']).toBe('unchanged')
      server.releaseUnrelated()
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.text).toContain('UNRELATED_NATIVE_SUCCESS')
      expect(response.text).toContain('STOP')
      expect(() => server.releaseUnrelated()).toThrow('GA_UNRELATED_NOT_HELD')
    } finally {
      await server.close()
      await pending.catch(() => undefined)
    }
  })
})
