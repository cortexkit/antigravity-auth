import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { ANTIGRAVITY_ENDPOINT_PROD } from './constants.ts'
import {
  clearProvisionFailedKeys,
  ensureProjectContext,
  invalidateProjectContextCache,
  loadManagedProject,
  onboardManagedProject,
} from './project.ts'

// `fetchWithAgyCliTransport` is imported dynamically inside each test so the
// `mock.module` patch below takes effect — bun resolves the import against the
// mocked module graph at call time.
mock.module('./agy-transport.ts', () => ({
  fetchWithAgyCliTransport: mock(),
}))

function mockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('project bootstrap', () => {
  beforeEach(() => {
    invalidateProjectContextCache()
    clearProvisionFailedKeys()
  })

  afterEach(() => {
    mock.restore()
    invalidateProjectContextCache()
    clearProvisionFailedKeys()
  })

  it('loads managed project with captured agy CLI loadCodeAssist fingerprint', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({ cloudaicompanionProject: 'proj' }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const result = await loadManagedProject('token', 'ignored-project')

    expect(result?.cloudaicompanionProject).toBe('proj')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    const body = JSON.parse(init.body as string)

    expect(headers).toEqual({
      'User-Agent': expect.stringMatching(
        /^antigravity\/cli\/1\.1\.24 \(aidev_client; os_type=.+; arch=.+; cl=974782877; auth_method=consumer\)$/,
      ),
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    })
    expect(headers['X-Goog-Api-Client']).toBeUndefined()
    expect(headers['Client-Metadata']).toBeUndefined()
    expect(body).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
  })

  it('forwards cancellation to managed-project lookup', async () => {
    const controller = new AbortController()
    const fetchSpy = mock(
      async (
        _url: string,
        _init: RequestInit,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          )
        }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const pending = loadManagedProject('token', undefined, {
      signal: controller.signal,
    })
    controller.abort(new Error('project lookup deadline'))

    await expect(pending).rejects.toThrow('project lookup deadline')
  })

  it('forwards the project lookup header timeout', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({ cloudaicompanionProject: 'proj' }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    await loadManagedProject('token', undefined, { timeoutMs: 123 })

    expect(fetchSpy.mock.calls[0][2]).toMatchObject({ timeoutMs: 123 })
  })

  it('onboards with minimal tier body on prod first', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({
        done: true,
        response: { cloudaicompanionProject: { id: 'managed-project' } },
      }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const result = await onboardManagedProject(
      'token',
      'free-tier',
      'legacy-project',
    )

    expect(result).toBe('managed-project')
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)

    expect(url).toBe(`${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:onboardUser`)
    expect(body).toEqual({ tierId: 'free-tier' })
  })

  it('reuses project context when discovery expands the packed refresh value', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({ cloudaicompanionProject: { id: 'managed-project' } }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const originalAuth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'refresh-token|legacy-project',
      expires: Date.now() + 60_000,
    }

    const first = await ensureProjectContext(originalAuth)
    const second = await ensureProjectContext(originalAuth)

    expect(first.effectiveProjectId).toBe('managed-project')
    expect(first.auth.refresh).toBe(
      'refresh-token|legacy-project|managed-project',
    )
    expect(second).toEqual(first)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches a completed lookup started with a cancellation signal', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({ cloudaicompanionProject: 'managed-project' }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)
    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'signal-cache-token',
      expires: Date.now() + 60_000,
    }
    const controller = new AbortController()

    await ensureProjectContext(auth, { signal: controller.signal })
    await ensureProjectContext(auth, { signal: controller.signal })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('evicts an aborted project-context lookup from the pending cache', async () => {
    const controller = new AbortController()
    let attempts = 0
    const fetchSpy = mock(
      async (
        _url: string,
        _init: RequestInit,
        options?: { signal?: AbortSignal },
      ) => {
        attempts += 1
        if (attempts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            )
          })
        }
        return mockResponse({ cloudaicompanionProject: 'managed-project' })
      },
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)
    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'cancelled-lookup-token',
      expires: Date.now() + 60_000,
    }

    const first = ensureProjectContext(auth, { signal: controller.signal })
    controller.abort(new Error('project lookup deadline'))
    await expect(first).rejects.toThrow('project lookup deadline')

    await expect(ensureProjectContext(auth)).resolves.toMatchObject({
      effectiveProjectId: 'managed-project',
    })
    expect(attempts).toBe(2)
  })

  it('does not attach a new caller to an already aborted lookup', async () => {
    const controller = new AbortController()
    let attempts = 0
    const fetchSpy = mock(
      (
        _url: string,
        _init: RequestInit,
        options?: { signal?: AbortSignal },
      ) => {
        attempts += 1
        if (attempts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            )
          })
        }
        return Promise.resolve(
          mockResponse({ cloudaicompanionProject: 'fresh-project' }),
        )
      },
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)
    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'aborted-pending-token',
      expires: Date.now() + 60_000,
    }

    const first = ensureProjectContext(auth, { signal: controller.signal })
    controller.abort(new Error('project lookup deadline'))
    const second = ensureProjectContext(auth)

    await expect(first).rejects.toThrow('project lookup deadline')
    await expect(second).resolves.toMatchObject({
      effectiveProjectId: 'fresh-project',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does not let an invalidated lookup overwrite fresh project context', async () => {
    let resolveStale: ((response: Response) => void) | undefined
    let attempts = 0
    const fetchSpy = mock(() => {
      attempts += 1
      if (attempts === 1) {
        return new Promise<Response>((resolve) => {
          resolveStale = resolve
        })
      }
      return Promise.resolve(
        mockResponse({ cloudaicompanionProject: 'fresh-project' }),
      )
    })
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)
    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'invalidation-token',
      expires: Date.now() + 60_000,
    }

    const stale = ensureProjectContext(auth)
    invalidateProjectContextCache(auth.refresh)
    await expect(ensureProjectContext(auth)).resolves.toMatchObject({
      effectiveProjectId: 'fresh-project',
    })
    if (!resolveStale) throw new Error('stale lookup did not start')
    resolveStale(mockResponse({ cloudaicompanionProject: 'stale-project' }))
    await expect(stale).resolves.toMatchObject({
      effectiveProjectId: 'stale-project',
    })
    await expect(ensureProjectContext(auth)).resolves.toMatchObject({
      effectiveProjectId: 'fresh-project',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('lets a concurrent caller cancel without retaining the shared lookup', async () => {
    let resolveLookup: ((response: Response) => void) | undefined
    const fetchSpy = mock(
      (_url: string, _init: RequestInit, options?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          resolveLookup = resolve
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          )
        }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)
    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'concurrent-lookup-token',
      expires: Date.now() + 60_000,
    }
    const controller = new AbortController()
    const first = ensureProjectContext(auth, { signal: controller.signal })
    const second = ensureProjectContext(auth)

    controller.abort(new Error('second caller deadline'))
    await expect(first).rejects.toThrow('second caller deadline')
    if (!resolveLookup) throw new Error('lookup did not start')
    resolveLookup(mockResponse({ cloudaicompanionProject: 'managed-project' }))
    await expect(second).resolves.toMatchObject({
      effectiveProjectId: 'managed-project',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('Fix2-tier-capture: capturedTier is returned from ensureProjectContext when loadCodeAssist returns currentTier', async () => {
    const capturedNow = 1_785_000_000_000
    spyOn(Date, 'now').mockImplementation(() => capturedNow)
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({
        cloudaicompanionProject: { id: 'my-project' },
        currentTier: { id: 'pro-tier' },
        paidTier: { id: 'g1-pro-tier' },
      }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'bare-token',
      expires: Date.now() + 60_000,
    }

    const result = await ensureProjectContext(auth)

    expect(result.capturedTier).toEqual({
      id: 'pro-tier',
      paidId: 'g1-pro-tier',
      capturedAt: capturedNow,
    })
  })

  it('Fix2-tier-absent: capturedTier is absent when loadCodeAssist returns no currentTier', async () => {
    const fetchSpy = mock().mockResolvedValue(
      mockResponse({ cloudaicompanionProject: { id: 'my-project' } }),
    )
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'bare-token-2',
      expires: Date.now() + 60_000,
    }

    const result = await ensureProjectContext(auth)

    // No tier in payload — must be absent, not defaulted.
    expect(result.capturedTier).toBeUndefined()
  })

  it('does not retry managed-project provisioning after a cached failure expires', async () => {
    let now = 1_000
    spyOn(Date, 'now').mockImplementation(() => now)
    const fetchSpy = mock(async (url: string) => {
      if (url.includes('loadCodeAssist')) {
        return mockResponse({
          allowedTiers: [{ id: 'free-tier', isDefault: true }],
        })
      }
      return new Response('busy', {
        status: 503,
        statusText: 'Service Unavailable',
      })
    })
    const { fetchWithAgyCliTransport } = await import('./agy-transport.ts')
    ;(fetchWithAgyCliTransport as any).mockImplementation(fetchSpy)

    const auth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'refresh-token',
      expires: now + 60_000,
    }

    const first = await ensureProjectContext(auth)
    const callsAfterFirstResolve = fetchSpy.mock.calls.length
    now += 31 * 60 * 1000

    const second = await ensureProjectContext(auth)

    expect(first.effectiveProjectId).toBe(second.effectiveProjectId)
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirstResolve)
  })
})
