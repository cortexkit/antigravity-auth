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
        /^antigravity\/cli\/1\.1\.6 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
      ),
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    })
    expect(headers['X-Goog-Api-Client']).toBeUndefined()
    expect(headers['Client-Metadata']).toBeUndefined()
    expect(body).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
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
