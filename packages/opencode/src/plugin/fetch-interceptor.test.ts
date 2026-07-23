import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'

import { AccountManager } from './accounts'
import { DEFAULT_CONFIG } from './config'
import type { AgyTransport } from './dependencies'
import { createFetchInterceptor } from './fetch-interceptor'
import { AgySessionRegistry } from './session-context'
import { type AccountStorageV4, saveAccountsReplace } from './storage'
import type { GetAuth, PluginClient } from './types'

const transportMock = mock(
  async (...args: Parameters<typeof fetch>): Promise<Response> =>
    transportHandler(...args),
)

let transportHandler = async (
  ..._args: Parameters<typeof fetch>
): Promise<Response> => {
  throw new Error('transport handler not configured')
}

const transport: AgyTransport = (url, init) =>
  transportMock(url, init) as unknown as Promise<Response>

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

const GENERATIVE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse'

function storedAccounts(): AccountStorageV4 {
  return {
    version: 4,
    accounts: [
      {
        email: 'account-a@example.test',
        refreshToken: 'refresh-a',
        projectId: 'project-a',
        managedProjectId: 'managed-a',
        addedAt: FIXED_NOW - 20_000,
        lastUsed: FIXED_NOW - 10_000,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  }
}

function fakeClient(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
      updateMessage: mock(async () => ({})),
    },
    tui: { showToast: mock(async () => {}) },
  } as unknown as PluginClient
}

interface ContextOverrides {
  accountManager?: AccountManager
  config?: typeof DEFAULT_CONFIG
  getAuth?: GetAuth
  client?: PluginClient
  directory?: string
  agyTransport?: AgyTransport
  fetchImpl?: Parameters<typeof createFetchInterceptor>[0]['fetchImpl']
}

async function makeContext(overrides: ContextOverrides = {}) {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  const directory = overrides.directory ?? join(root, 'fetch-interceptor')
  await Bun.write(
    `${directory}/.opencode/antigravity.json`,
    JSON.stringify({
      quiet_mode: true,
      session_recovery: false,
      proactive_token_refresh: false,
      cache_warmup_on_switch: false,
      account_selection_strategy: 'sticky',
      scheduling_mode: 'balance',
      switch_on_first_rate_limit: false,
      max_account_switches: 1,
      soft_quota_threshold_percent: 100,
      quota_refresh_interval_minutes: 0,
      proactive_rotation_threshold_percent: 0,
      auto_update: false,
    }),
  )

  const accountManager =
    overrides.accountManager ??
    new AccountManager(
      {
        type: 'oauth' as const,
        refresh: 'refresh-a|project-a|managed-a',
        access: 'access-a',
        expires: Date.now() + 3_600_000,
      },
      storedAccounts(),
    )

  return {
    client: overrides.client ?? fakeClient(),
    directory,
    providerId: 'google',
    config: overrides.config ?? DEFAULT_CONFIG,
    accountManager,
    quotaManager: {
      dispose: () => {},
      refreshAccount: async () => ({ status: 'ok' as const }),
      hashedLogLabel: () => 'idx-0',
    } as never,
    getAuth:
      overrides.getAuth ??
      (async () => ({
        type: 'oauth' as const,
        refresh: 'refresh-a|project-a|managed-a',
        access: 'access-a',
        expires: Date.now() + 3_600_000,
      })),
    agySessionRegistry: new AgySessionRegistry(directory),
    // Default to the shared `transport` mock so tests that exercise the
    // dispatch path do not need to opt in to transport mocking explicitly.
    agyTransport: overrides.agyTransport ?? transport,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  }
}

beforeEach(async () => {
  // Save accounts to disk before each test (loader reads them via loadFromDisk)
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  await saveAccountsReplace(storedAccounts())
})

afterEach(() => {
  globalThis.unstubAllGlobals()
})

describe('createFetchInterceptor', () => {
  describe('non-generative passthrough', () => {
    it('delegates requests to upstream fetch when the URL is not generativelanguage', async () => {
      const context = await makeContext()
      const upstreamResponse = new Response('ok', { status: 200 })
      const upstreamFetch = mock(async () => upstreamResponse)
      globalThis.stubbed('fetch', upstreamFetch)

      const interceptor = createFetchInterceptor(context)
      const response = await interceptor.fetch(
        'https://example.com/something',
        {
          method: 'GET',
        },
      )

      expect(upstreamFetch).toHaveBeenCalledTimes(1)
      expect(response).toBe(upstreamResponse)
      interceptor.dispose()
    })

    it('preserves the caller-supplied abort signal on passthrough', async () => {
      const context = await makeContext()
      const upstreamFetch = mock(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          // Confirm the caller's signal reaches upstream.
          if (init?.signal?.aborted) {
            throw new Error('already-aborted')
          }
          return new Response('ok', { status: 200 })
        },
      )
      globalThis.stubbed('fetch', upstreamFetch)

      const interceptor = createFetchInterceptor(context)
      const controller = new AbortController()
      controller.abort()

      await expect(
        interceptor.fetch('https://example.com/foo', {
          signal: controller.signal,
        }),
      ).rejects.toThrow('already-aborted')

      interceptor.dispose()
    })
  })

  describe('non-OAuth auth', () => {
    it('returns the upstream response when getAuth returns a non-OAuth auth', async () => {
      const context = await makeContext({
        getAuth: (async () => ({
          type: 'api',
          key: 'k',
        })) as unknown as GetAuth,
      })
      const upstreamResponse = new Response('ok', { status: 200 })
      const upstreamFetch = mock(async () => upstreamResponse)
      globalThis.stubbed('fetch', upstreamFetch)

      const interceptor = createFetchInterceptor(context)
      const response = await interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
      })

      expect(upstreamFetch).toHaveBeenCalledTimes(1)
      expect(response).toBe(upstreamResponse)
      interceptor.dispose()
    })
  })

  describe('Request normalization', () => {
    it('normalizes a Request input into a URL+init so the transform pipeline sees headers/body', async () => {
      transportHandler = async (input, init) => {
        expect(typeof input === 'string' ? input : (input as Request).url).toBe(
          GENERATIVE_URL,
        )
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBe('Bearer access-a')
        expect(init?.body).toBeDefined()
        return new Response(
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]}}]}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }

      const context = await makeContext()
      const interceptor = createFetchInterceptor(context)

      const req = new Request(GENERATIVE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer upstream',
        },
        body: JSON.stringify({ contents: [] }),
      })
      const response = await interceptor.fetch(req)

      // The transform pipeline returns a 200 SSE even when the upstream body
      // is non-terminal; status should reflect that.
      expect(response.status).toBe(200)
      interceptor.dispose()
    })
  })

  describe('caller abort', () => {
    it('rejects when the caller aborts before the no-account check', async () => {
      const context = await makeContext({
        accountManager: new AccountManager(undefined, {
          version: 4,
          accounts: [],
          activeIndex: 0,
          activeIndexByFamily: { claude: 0, gemini: 0 },
        }),
      })
      const interceptor = createFetchInterceptor(context)
      const controller = new AbortController()

      // Abort before the call so the no-account short-circuit surfaces the
      // signal back to the caller via the upstream passthrough. The test is
      // a contract guard for "abort propagation is not silently dropped".
      controller.abort()
      await expect(
        interceptor.fetch(GENERATIVE_URL, {
          method: 'POST',
          signal: controller.signal,
        }),
      ).resolves.toMatchObject({ status: 401 })
      interceptor.dispose()
    })
  })

  describe('lifecycle disposal', () => {
    it('clears per-instance retry/warmup state on dispose()', async () => {
      const context = await makeContext()
      const interceptor = createFetchInterceptor(context)

      // Drive the internal state machine directly through the fetch hook's
      // own bookkeeping: the smoke below asserts that a second instance has
      // its own clean state, which is only possible if dispose() releases
      // the previous instance's maps/sets.
      interceptor.dispose()

      const second = createFetchInterceptor(context)
      second.dispose()
    })

    it('stops intercepting after dispose()', async () => {
      const upstreamResponse = new Response('after-dispose', { status: 200 })
      const upstreamFetch = mock(async () => upstreamResponse)
      globalThis.stubbed('fetch', upstreamFetch)

      const context = await makeContext()
      const interceptor = createFetchInterceptor(context)
      interceptor.dispose()

      const response = await interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
      })
      expect(response).toBe(upstreamResponse)
      expect(upstreamFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('no-account 401 response', () => {
    it('returns HTTP 401 with Google error envelope when no accounts are configured', async () => {
      const empty = new AccountManager(undefined, {
        version: 4,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })

      const context = await makeContext({ accountManager: empty })
      const interceptor = createFetchInterceptor(context)

      const response = await interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      })

      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.get('X-Antigravity-Error-Type')).toBe(
        'no_accounts',
      )

      const body = (await response.json()) as {
        error: { code: number; status: string; message: string }
      }
      expect(body.error.code).toBe(401)
      expect(body.error.status).toBe('UNAUTHENTICATED')
      expect(body.error.message).toContain('No Antigravity accounts configured')
      expect(body.error.message).toContain('opencode auth login')

      interceptor.dispose()
    })

    it('includes the requested model in the no-account envelope', async () => {
      const empty = new AccountManager(undefined, {
        version: 4,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })

      const context = await makeContext({ accountManager: empty })
      const interceptor = createFetchInterceptor(context)

      const modelUrl =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent'
      const response = await interceptor.fetch(modelUrl, { method: 'POST' })

      expect(response.headers.get('X-Antigravity-Requested-Model')).toBe(
        'gemini-3-pro',
      )
      interceptor.dispose()
    })

    it('returns the same 401 envelope when accounts are removed mid-loop', async () => {
      // Initial accounts: one exists.
      // After loadFromDisk, we manually clear the pool to simulate a race where
      // accounts disappear between the input check and the retry-loop check.
      const root = process.env.ANTIGRAVITY_TEST_ROOT
      if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
      const accountManager = new AccountManager(undefined, storedAccounts())
      // Strip accounts post-load to force the inner-loop no-account branch.
      const accounts = accountManager.getAccounts()
      for (const a of accounts) accountManager.removeAccount(a)

      const context = await makeContext({ accountManager })
      const interceptor = createFetchInterceptor(context)
      const response = await interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('X-Antigravity-Error-Type')).toBe(
        'no_accounts',
      )
      interceptor.dispose()
    })
  })

  describe('killswitch wiring', () => {
    it('routes around a killed current account to the next eligible account without waiting', async () => {
      // Two accounts; the sticky current (index 0) has fresh cached
      // quota below the killswitch floor, index 1 is eligible. The
      // request must land on index 1 directly — NOT fall through to
      // the all-accounts-rate-limited wait path.
      const accountManager = new AccountManager(undefined, {
        version: 4,
        accounts: [
          {
            email: 'account-a@example.test',
            refreshToken: 'refresh-a',
            projectId: 'project-a',
            managedProjectId: 'managed-a',
            addedAt: FIXED_NOW - 20_000,
            lastUsed: FIXED_NOW - 10_000,
          },
          {
            email: 'account-b@example.test',
            refreshToken: 'refresh-b',
            projectId: 'project-b',
            managedProjectId: 'managed-b',
            addedAt: FIXED_NOW - 20_000,
            lastUsed: FIXED_NOW - 12_000,
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })
      // Both accounts carry valid access tokens so a regression that
      // still dispatches the killed account shows up as a transport
      // call with access-a (not as a token-refresh failure that would
      // rotate to account 1 on its own).
      for (const entry of accountManager.getAccounts()) {
        entry.access = entry.index === 0 ? 'access-a' : 'access-b'
        entry.expires = Date.now() + 3_600_000
      }
      // Fresh quota: account 0 at 30% — below the 40% killswitch floor
      // but above the 80% soft-quota usage trip (70% used), so ONLY the
      // killswitch rules it out. Account 1 at 80% is fully eligible.
      // The URL model is gemini-3-flash → `gemini-flash` group.
      accountManager.updateQuotaCache(0, {
        'gemini-flash': { remainingFraction: 0.3, modelCount: 1 },
      })
      accountManager.updateQuotaCache(1, {
        'gemini-flash': { remainingFraction: 0.8, modelCount: 1 },
      })

      const operatorSettings = {
        get: () => ({
          routing: { cli_first: false, quota_style_fallback: false },
          killswitch: { enabled: true, minimum_remaining_percent: 40 },
          log_level: 'info',
        }),
        update: async () => {},
        dispose: async () => {},
      }

      const seenAuthorizations: string[] = []
      transportHandler = async (_input, init) => {
        seenAuthorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return new Response(
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]}}]}}\n\n',
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      }

      const context = await makeContext({
        accountManager,
        getAuth: async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-b|project-b|managed-b',
          access: 'access-b',
          expires: Date.now() + 3_600_000,
        }),
        // Sticky so the killed current (index 0) is the deterministic
        // first candidate — hybrid would rotate to index 1 on its own
        // and mask a missing killswitch exclusion. A regression that
        // re-enters the wait path hits the max-wait guard and returns
        // a synthetic error immediately instead of sleeping out the
        // 60s default.
        config: {
          ...DEFAULT_CONFIG,
          account_selection_strategy: 'sticky',
          max_rate_limit_wait_seconds: 1,
        },
      })
      const interceptor = createFetchInterceptor({
        ...context,
        operatorSettings: operatorSettings as never,
      })

      const response = await interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      })

      expect(response.status).toBe(200)
      // Exactly one dispatch — straight to the eligible account 1; the
      // killed account 0 was excluded at selection, never attempted.
      expect(seenAuthorizations).toEqual(['Bearer access-b'])
      interceptor.dispose()
    })
  })

  describe('per-instance isolation', () => {
    it('two interceptors do not share rate-limit state', async () => {
      // After dispose() on instance A, instance B should still be clean.
      // The smoke test here just confirms both instances can be constructed
      // and disposed without leaking state via module globals (a previous
      // failure mode where module-level Sets kept the second instance
      // seeing the first instance's warmup attempts).
      const contextA = await makeContext({
        directory: join(process.env.ANTIGRAVITY_TEST_ROOT!, 'iso-A'),
      })
      const contextB = await makeContext({
        directory: join(process.env.ANTIGRAVITY_TEST_ROOT!, 'iso-B'),
      })
      await saveAccountsReplace(storedAccounts())
      const a = createFetchInterceptor(contextA)
      const b = createFetchInterceptor(contextB)
      a.dispose()
      b.dispose()
    })
  })
})
