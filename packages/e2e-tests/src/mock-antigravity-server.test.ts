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
  assertGaDatabase,
  assertGaObservations,
  assertGaRawBindingControl,
  assertGaTlsSequence,
  assertNativeGa,
  collectGaRawCancelAssertions,
  createGaSenderSignalObserver,
  GA_CASE_IDS,
  gaChildEnvironment,
  gaDetachedDispatchSignalMutation,
  gaTimestamp,
  ownedPath,
  parseGaPin,
  prepareGaRoot,
  readGaPin,
  startGaMock,
  verifiedArchiveMember,
  verifyExecutable,
  verifySri,
} from './opencode-ga-harness.ts'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

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

  it('refuses TLS verification-disable presence for every value', () => {
    const paths = prepareGaRoot(freshRoot())
    for (const value of ['', '0', '1']) {
      expect(() =>
        gaChildEnvironment(paths, { NODE_TLS_REJECT_UNAUTHORIZED: value }),
      ).toThrow('presence forbids host launch')
    }
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
    // The expected count is written here by hand rather than derived from
    // GA_CASE_IDS, so adding or dropping a case changes this test.
    expect(GA_CASE_IDS).toHaveLength(102)
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

  it('mutates only the same options signal observed and passed to unchanged agyTransport', () => {
    const source =
      'async function dispatch(job) {\nconst options = { signal: job.signal };\ndeps.observeRawSenderSignal?.(options.signal);\nreturn agyTransport(job.endpoint, options);\n}'
    const mutation = gaDetachedDispatchSignalMutation(source)
    expect(mutation.control).toBe('ga.raw-cancel.detached-dispatch-signal')
    expect(mutation.line).toBe(3)
    expect(mutation.source).toContain(
      'options.signal = new AbortController().signal',
    )
    expect(mutation.source).toContain(
      'deps.observeRawSenderSignal?.(options.signal)',
    )
    expect(mutation.source).toContain('agyTransport(job.endpoint, options)')
    expect(() =>
      gaDetachedDispatchSignalMutation(
        source.replace(
          'agyTransport(job.endpoint, options)',
          'agyTransport(job.endpoint, otherOptions)',
        ),
      ),
    ).toThrow('share one dispatch-options object')
    expect(() =>
      gaDetachedDispatchSignalMutation(
        `${source}\n${source.replace('dispatch(job)', 'second(job)')}`,
      ),
    ).toThrow('ambiguous actual dispatch-signal')
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
