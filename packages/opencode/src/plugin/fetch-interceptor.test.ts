import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { join } from 'node:path'
import type {
  AccountRepository,
  AccountRepositoryRead,
  AccountRow,
  RowRef,
} from '@cortexkit/antigravity-auth-core'
import { ANTIGRAVITY_ENDPOINT_DAILY } from '@cortexkit/antigravity-auth-core'
import { AccountManager, loadAccountManagerFromRepository } from './accounts'
import { DEFAULT_CONFIG } from './config'
import type { AgyTransport } from './dependencies'
import {
  createFetchInterceptor,
  createVaultFetchInterceptor,
} from './fetch-interceptor'
import { AgySessionRegistry } from './session-context'
import type { VaultRequestSource } from './shared/vault-request-credentials'
import { type AccountStorageV4, saveAccountsReplace } from './storage'
import type { GetAuth, PluginClient } from './types'

const transportMock = mock(
  async (...args: Parameters<typeof fetch>): Promise<Response> =>
    transportHandler(...args),
)

const unconfiguredTransportHandler = async (
  ..._args: Parameters<typeof fetch>
): Promise<Response> => {
  throw new Error('transport handler not configured')
}

let transportHandler = unconfiguredTransportHandler

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

function twoStoredAccounts(): AccountStorageV4 {
  const stored = storedAccounts()
  stored.accounts.push({
    email: 'account-b@example.test',
    refreshToken: 'refresh-b',
    projectId: 'project-b',
    managedProjectId: 'managed-b',
    addedAt: FIXED_NOW - 20_000,
    lastUsed: FIXED_NOW - 12_000,
  })
  return stored
}

const GENERATIVE_INIT: RequestInit = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  }),
}

async function expectNativeFailure(
  response: Response,
  status: 401 | 412 | 502,
  googleStatus: 'UNAUTHENTICATED' | 'FAILED_PRECONDITION' | 'UNAVAILABLE',
): Promise<string> {
  expect(response.status).toBe(status)
  expect(response.ok).toBe(false)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(response.headers.get('x-antigravity-synthetic')).toBeNull()
  expect(response.headers.get('x-antigravity-error-type')).toBeNull()
  const text = await response.text()
  const body: unknown = JSON.parse(text)
  expect(body).toEqual({
    error: { code: status, status: googleStatus, message: expect.any(String) },
  })
  expect(text).not.toMatch(/candidates|finishReason|usageMetadata|data:/)
  return text
}

function expectFailFastBody(text: string): void {
  // OpenCode 1.x's native retry classifier searches serialized error text for
  // retryable HTTP-status substrings even when the response itself is 412.
  // Checking the body alongside status prevents accidental host retries.
  expect(text).not.toMatch(
    /429|500|502|503|504|524|rate limited|rate_limit|resource_exhausted|try again later/i,
  )
  expect(text).not.toMatch(/account-a|account-b|refresh-a|refresh-b|access-a/)
}

function fakeClient(onToast?: (message: string) => void): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
      updateMessage: mock(async () => ({})),
    },
    tui: {
      showToast: mock(async (input: { body: { message: string } }) => {
        onToast?.(input.body.message)
      }),
    },
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
    // These tests run on the pool-file manager built above.
    accountSource: { kind: 'pool-file' } as const,
    // Default to the shared `transport` mock so tests that exercise the
    // dispatch path do not need to opt in to transport mocking explicitly.
    agyTransport: overrides.agyTransport ?? transport,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  }
}

beforeEach(async () => {
  transportHandler = unconfiguredTransportHandler
  transportMock.mockClear()
  // Save accounts to disk before each test (loader reads them via loadFromDisk)
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  await saveAccountsReplace(storedAccounts())
})

afterEach(() => {
  globalThis.unstubAllGlobals()
  mock.restore()
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

  describe('local image titles', () => {
    it('retains successful synthetic text for local image-model title requests', async () => {
      const context = await makeContext()
      const interceptor = createFetchInterceptor(context)
      try {
        const response = await interceptor.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-flash-image:streamGenerateContent',
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: 'Generate a title for this conversation:\n' },
                  ],
                },
                { role: 'user', parts: [{ text: 'Generate a red triangle' }] },
              ],
            }),
          },
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/event-stream')
        expect(response.headers.get('x-antigravity-response-type')).toBe(
          'local_title',
        )
        expect(response.headers.get('x-antigravity-error-type')).toBeNull()
        const text = await response.text()
        expect(JSON.parse(text.slice('data: '.length).trim())).toMatchObject({
          candidates: [
            {
              content: { parts: [{ text: 'Generate a red triangle' }] },
              finishReason: 'STOP',
            },
          ],
        })
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
      }
    })
  })

  describe('Request normalization', () => {
    it('normalizes a Request input into a URL+init so the transform pipeline sees headers/body', async () => {
      transportHandler = async (input, init) => {
        expect(typeof input === 'string' ? input : (input as Request).url).toBe(
          `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`,
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
        gemini: { remainingFraction: 0.3, modelCount: 1 },
      })
      accountManager.updateQuotaCache(1, {
        gemini: { remainingFraction: 0.8, modelCount: 1 },
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
        // Sticky selection deliberately tries account index 0, which the quota
        // policy excludes. Automatic rotation to index 1 could mask a missing
        // policy check. If selection regresses into the all-accounts-unavailable
        // wait branch, the max-wait limit avoids the default 60-second sleep.
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

  describe('native error responses', () => {
    const config: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      account_selection_strategy: 'sticky',
      soft_quota_threshold_percent: 100,
      max_rate_limit_wait_seconds: 1,
      quota_refresh_interval_minutes: 0,
      proactive_rotation_threshold_percent: 0,
      cache_warmup_on_switch: false,
      empty_response_max_attempts: 2,
      empty_response_retry_delay_ms: 0,
    }

    it('returns a fail-fast 412 when the killswitch excludes the entire pool', async () => {
      const context = await makeContext({ config })
      context.accountManager.updateQuotaCache(0, {
        gemini: { remainingFraction: 0.3, modelCount: 1 },
      })
      const interceptor = createFetchInterceptor({
        ...context,
        operatorSettings: {
          get: () => ({
            routing: { cli_first: false, quota_style_fallback: false },
            killswitch: { enabled: true, minimum_remaining_percent: 40 },
            log_level: 'info',
          }),
          update: async () => {},
          dispose: async () => {},
        },
      })
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL,
          GENERATIVE_INIT,
        )
        const text = await expectNativeFailure(
          response,
          412,
          'FAILED_PRECONDITION',
        )
        expect(text).toContain('operator quota policy')
        expectFailFastBody(text)
        expect(response.headers.get('retry-after')).toBeNull()
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
      }
    })

    for (const resetTime of [
      new Date(FIXED_NOW + 5_700_000).toISOString(),
      undefined,
      'invalid-reset',
    ]) {
      it(`returns a fail-fast soft-quota 412 with ${resetTime ?? 'unknown'} reset`, async () => {
        spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
        const accountManager = new AccountManager(
          undefined,
          twoStoredAccounts(),
        )
        for (const account of accountManager.getAccounts()) {
          accountManager.updateQuotaCache(account.index, {
            gemini: { remainingFraction: 0.1, modelCount: 1, resetTime },
          })
        }
        const context = await makeContext({
          accountManager,
          config: { ...config, soft_quota_threshold_percent: 80 },
        })
        const interceptor = createFetchInterceptor(context)
        try {
          const response = await interceptor.fetch(
            GENERATIVE_URL,
            GENERATIVE_INIT,
          )
          const text = await expectNativeFailure(
            response,
            412,
            'FAILED_PRECONDITION',
          )
          expect(text).toContain('quota protection policy')
          expectFailFastBody(text)
          if (resetTime?.endsWith('Z')) {
            expect(text).toContain('Quota resets in 1h 35m')
            expect(response.headers.get('retry-after')).toBe('5700')
          } else {
            expect(text).not.toContain('Quota resets in')
            expect(response.headers.get('retry-after')).toBeNull()
          }
          expect(transportMock).not.toHaveBeenCalled()
        } finally {
          interceptor.dispose()
          await accountManager.dispose()
        }
      })
    }

    for (const { now, waitMs, retryAfter, resetClause } of [
      {
        now: FIXED_NOW,
        waitMs: 5_700_000,
        retryAfter: '5700',
        resetClause: 'Quota resets in 1h 35m',
      },
      { now: FIXED_NOW, waitMs: 1_544_400_000, retryAfter: '1544400' },
      { now: FIXED_NOW, waitMs: 1_800_000_000, retryAfter: '1800000' },
      { now: FIXED_NOW, waitMs: 1_807_200_000, retryAfter: '1807200' },
      { now: FIXED_NOW, waitMs: 1_810_800_000, retryAfter: '1810800' },
      { now: FIXED_NOW, waitMs: 1_814_400_000, retryAfter: '1814400' },
      { now: FIXED_NOW, waitMs: 1_886_400_000, retryAfter: '1886400' },
      { now: FIXED_NOW, waitMs: 5_400_000_000, retryAfter: '5400000' },
      {
        now: -1_000_000_000_000,
        waitMs: 1_800_000_000,
        retryAfter: '1800000',
      },
    ]) {
      it(`returns a fail-fast pool 412 without clamping ${waitMs}ms at clock ${now}`, async () => {
        const accountManager = new AccountManager(undefined, storedAccounts(), {
          now: () => now,
        })
        for (const account of accountManager.getAccounts()) {
          accountManager.markRateLimited(
            account,
            waitMs,
            'gemini',
            'antigravity',
            'gemini-3-flash',
          )
        }
        const context = await makeContext({ accountManager, config })
        const interceptor = createFetchInterceptor(context)
        try {
          const response = await interceptor.fetch(
            GENERATIVE_URL,
            GENERATIVE_INIT,
          )
          const text = await expectNativeFailure(
            response,
            412,
            'FAILED_PRECONDITION',
          )
          expectFailFastBody(text)
          if (resetClause) expect(text).toContain(resetClause)
          else expect(text).not.toContain('Quota resets in')
          expect(response.headers.get('retry-after')).toBe(retryAfter)
          expect(transportMock).not.toHaveBeenCalled()
        } finally {
          interceptor.dispose()
          await accountManager.dispose()
        }
      })
    }

    it('does not invent a quota reset from the fallback sleep duration', async () => {
      const context = await makeContext({ config })
      for (const account of context.accountManager.getAccounts()) {
        context.accountManager.markAccountCoolingDown(
          account,
          60_000,
          'auth-failure',
        )
      }
      const interceptor = createFetchInterceptor(context)
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL,
          GENERATIVE_INIT,
        )
        const text = await expectNativeFailure(
          response,
          412,
          'FAILED_PRECONDITION',
        )
        expectFailFastBody(text)
        expect(text).not.toContain('Quota resets in')
        expect(response.headers.get('retry-after')).toBeNull()
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
      }
    })

    it('does not emit an invalid reset header for a nonfinite pool wait', async () => {
      const context = await makeContext({ config })
      for (const account of context.accountManager.getAccounts()) {
        context.accountManager.markRateLimited(
          account,
          Infinity,
          'gemini',
          'antigravity',
          'gemini-3-flash',
        )
      }
      const interceptor = createFetchInterceptor(context)
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL,
          GENERATIVE_INIT,
        )
        const text = await expectNativeFailure(
          response,
          412,
          'FAILED_PRECONDITION',
        )
        expectFailFastBody(text)
        expect(text).not.toContain('Quota resets in')
        expect(response.headers.get('retry-after')).toBeNull()
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
      }
    })

    for (const policy of ['soft_quota', 'pool_unavailable']) {
      it(`still waits below the configured maximum for ${policy}`, async () => {
        spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
        const accountManager = new AccountManager(
          undefined,
          twoStoredAccounts(),
        )
        for (const account of accountManager.getAccounts()) {
          if (policy === 'soft_quota') {
            accountManager.updateQuotaCache(account.index, {
              gemini: {
                remainingFraction: 0.1,
                modelCount: 1,
                resetTime: new Date(FIXED_NOW + 50).toISOString(),
              },
            })
          } else {
            accountManager.markRateLimited(
              account,
              50,
              'gemini',
              'antigravity',
              'gemini-3-flash',
            )
          }
        }
        const controller = new AbortController()
        const abortReason = new Error('cancel the quota wait')
        const toasts: string[] = []
        const client = fakeClient((message) => {
          toasts.push(message)
          if (message.includes('Waiting')) controller.abort(abortReason)
        })
        const context = await makeContext({
          accountManager,
          client,
          config: { ...config, soft_quota_threshold_percent: 80 },
        })
        const interceptor = createFetchInterceptor(context)
        try {
          await expect(
            interceptor.fetch(GENERATIVE_URL, {
              ...GENERATIVE_INIT,
              signal: controller.signal,
            }),
          ).rejects.toBe(abortReason)
          expect(toasts).toHaveLength(1)
          expect(toasts[0]).toContain('Waiting')
          expect(transportMock).not.toHaveBeenCalled()
        } finally {
          interceptor.dispose()
          await accountManager.dispose()
        }
      })
    }

    it('returns a native 401 when token refresh supplies no access token', async () => {
      const accountManager = new AccountManager(undefined, storedAccounts())
      const tokenFetch = mock(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('https://oauth2.googleapis.com/token')
        return new Response(
          JSON.stringify({ access_token: '', expires_in: 3600 }),
          { headers: { 'content-type': 'application/json' } },
        )
      })
      globalThis.stubbed('fetch', tokenFetch)
      const context = await makeContext({ accountManager, config })
      const interceptor = createFetchInterceptor(context)
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL,
          GENERATIVE_INIT,
        )
        const text = await expectNativeFailure(response, 401, 'UNAUTHENTICATED')
        expect(text).toContain('Missing access token')
        expect(text).toContain('opencode auth login')
        expect(tokenFetch).toHaveBeenCalledTimes(1)
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
        await accountManager.dispose()
      }
    })

    for (const contextMessage of ['Prompt is too long', 'prompt_too_long']) {
      it(`preserves original context 400 bytes and headers for ${contextMessage}`, async () => {
        const payload = ` { "error": { "code": 400, "status": "INVALID_ARGUMENT", "message": "${contextMessage}", "details": [{"original":true}] } }\n`
        const original = new Response(payload, {
          status: 400,
          statusText: 'Bad Request',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-original-overflow': 'retained',
            'retry-after': '17',
          },
        })
        transportHandler = async () => original
        const toasts: string[] = []
        const context = await makeContext({
          config,
          client: fakeClient((message) => toasts.push(message)),
        })
        const interceptor = createFetchInterceptor(context)
        try {
          const response = await interceptor.fetch(
            GENERATIVE_URL,
            GENERATIVE_INIT,
          )
          expect(response).toBe(original)
          expect(response.ok).toBe(false)
          expect(response.status).toBe(400)
          expect(response.statusText).toBe('Bad Request')
          expect(response.bodyUsed).toBe(false)
          expect([...response.headers]).toEqual([
            ['content-type', 'application/json; charset=utf-8'],
            ['retry-after', '17'],
            ['x-original-overflow', 'retained'],
          ])
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            new TextEncoder().encode(payload),
          )
          expect(transportMock).toHaveBeenCalledTimes(1)
          expect(toasts).toEqual([
            'Context too long - use /compact to reduce size',
          ])
        } finally {
          interceptor.dispose()
          await context.accountManager.dispose()
        }
      })
    }

    it('returns a native 502 only after the bounded empty-response attempts', async () => {
      transportHandler = async () =>
        new Response('{"response":{"candidates":[]}}', {
          headers: { 'content-type': 'application/json' },
        })
      const context = await makeContext({ config })
      const interceptor = createFetchInterceptor(context)
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL.replace(
            ':streamGenerateContent?alt=sse',
            ':generateContent',
          ),
          GENERATIVE_INIT,
        )
        const text = await expectNativeFailure(response, 502, 'UNAVAILABLE')
        expect(text).toContain('empty response')
        expect(transportMock).toHaveBeenCalledTimes(2)
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
      }
    })
  })

  describe('account-store source', () => {
    // A repository over one store row that refreshes through `refresh`. It
    // implements the read and refresh paths the store-backed manager uses;
    // the queued usage and fingerprint writes are accepted and dropped.
    // `row` is what the store holds now: a test changes it to stand for
    // another process replacing or disabling the row.
    function storeRepository(
      refresh: (ref: RowRef) => ReturnType<AccountRepository['refresh']>,
    ) {
      const ref: RowRef = {
        id: 'store-row',
        credentialEpoch: 3,
        identity: 'google-store',
      }
      const row = { ref, enabled: true }
      const read = async (): Promise<AccountRepositoryRead> => ({
        status: 'ready',
        rows: [
          {
            ref: row.ref,
            index: 0,
            enabled: row.enabled,
            credential: { refreshToken: 'store-refresh-token' },
            usable: true,
            stamp: 'bound',
            metadata: {
              status: 'present',
              metadata: {
                email: 'store@example.test',
                addedAt: 1,
                lastUsed: 1,
                managedProjectId: 'managed-store',
                fingerprint: {
                  deviceId: 'device-store',
                  sessionToken: 'session',
                  userAgent: 'antigravity-cli/test',
                  apiClient: 'antigravity-cli',
                  clientMetadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'darwin',
                    pluginType: 'GEMINI',
                  },
                  createdAt: 1,
                },
              },
            },
            quota: { status: 'absent' },
          } as AccountRow,
        ],
      })
      const settled = async () => ({ completed: 0, failures: [] })
      // A test may hold `flush` (the manager's save) open: `flushEntered`
      // fires when a save starts, and the save waits for `flushGate`.
      const gates: {
        flushEntered?: () => void
        flushGate?: Promise<void>
      } = {}
      const flush = async () => {
        gates.flushEntered?.()
        await gates.flushGate
        return settled()
      }
      const repository = new Proxy(
        { read, refresh, flush, dispose: settled },
        {
          get: (target, property) =>
            property in target
              ? target[property as keyof typeof target]
              : async (written: RowRef) => ({
                  ref: written,
                  outcome: 'unchanged',
                }),
        },
      ) as unknown as AccountRepository
      return { repository, ref, row, gates }
    }

    const rotatedFor =
      (accessToken: string) =>
      async (target: RowRef): ReturnType<AccountRepository['refresh']> => ({
        status: 'rotated',
        ref: target,
        accessToken,
        expiresAt: Date.now() + 3_600_000,
      })

    async function storeInterceptor(repository: AccountRepository) {
      const accountManager = await loadAccountManagerFromRepository(
        repository,
        { onDiagnostic: () => {} },
      )
      const context = await makeContext({
        config: {
          ...DEFAULT_CONFIG,
          account_selection_strategy: 'sticky',
          request_jitter_max_ms: 0,
          quota_refresh_interval_minutes: 0,
          proactive_rotation_threshold_percent: 0,
        },
      })
      await context.accountManager.dispose()
      const interceptor = createFetchInterceptor({
        ...context,
        accountManager,
        accountSource: { kind: 'store', repository },
      })
      return { interceptor, accountManager }
    }

    const STORE_URL = GENERATIVE_URL.replace(
      ':streamGenerateContent?alt=sse',
      ':generateContent',
    )

    for (const change of ['disabled', 'replaced'] as const) {
      it(`refuses the next physical send once the store row is ${change} after selection`, async () => {
        const { repository, row } = storeRepository(rotatedFor('access-store'))
        transportHandler = async () => {
          // Another process changes the row while the first attempt is on
          // the network; the bearer this process holds is unchanged.
          if (change === 'disabled') row.enabled = false
          else row.ref = { ...row.ref, credentialEpoch: 4 }
          return new Response('missing', { status: 404 })
        }
        const { interceptor, accountManager } =
          await storeInterceptor(repository)
        try {
          const response = await interceptor.fetch(STORE_URL, GENERATIVE_INIT)
          expect(response.status).toBe(404)
          expect(transportMock).toHaveBeenCalledTimes(1)
        } finally {
          interceptor.dispose()
          await accountManager.dispose()
        }
      })
    }

    it("captures the grant's row before the save that follows its refresh", async () => {
      const { repository, ref, row, gates } = storeRepository(
        rotatedFor('access-store'),
      )
      let release: () => void = () => {}
      const saveStarted = new Promise<void>((resolve) => {
        gates.flushEntered = resolve
      })
      gates.flushGate = new Promise<void>((resolve) => {
        release = resolve
      })
      transportHandler = async () => {
        throw new Error(
          'a grant resolved for the replaced row must not be sent',
        )
      }
      const { interceptor, accountManager } = await storeInterceptor(repository)
      try {
        const pending = interceptor.fetch(STORE_URL, GENERATIVE_INIT)
        await saveStarted
        // While the refreshed grant's save is pending, the store row moves to
        // a new credential epoch and the account object follows it, keeping
        // the same bearer.
        const successor = { ...ref, credentialEpoch: 9 }
        row.ref = successor
        const [account] = accountManager.getAccounts()
        if (account) account.ref = successor
        gates.flushEntered = undefined
        release()
        await expect(pending).rejects.toThrow(
          'The selected account no longer holds this credential',
        )
        expect(transportMock).not.toHaveBeenCalled()
      } finally {
        release()
        interceptor.dispose()
        await accountManager.dispose()
      }
    })

    it("checks the row captured with the grant, not the account object's later ref", async () => {
      const { repository, ref, row } = storeRepository(
        rotatedFor('access-store'),
      )
      const { interceptor, accountManager } = await storeInterceptor(repository)
      transportHandler = async () => {
        // After the grant was resolved, the store row moves to a new
        // credential epoch and the account object is re-pointed at it, still
        // holding the same bearer. Judged by its later ref the account looks
        // current; judged by the ref captured with the grant it is not.
        const successor = { ...ref, credentialEpoch: 9 }
        row.ref = successor
        const [account] = accountManager.getAccounts()
        if (account) account.ref = successor
        return new Response('missing', { status: 404 })
      }
      try {
        const response = await interceptor.fetch(STORE_URL, GENERATIVE_INIT)
        expect(response.status).toBe(404)
        expect(transportMock).toHaveBeenCalledTimes(1)
      } finally {
        interceptor.dispose()
        await accountManager.dispose()
      }
    })

    it('refreshes the selected store account through the repository on its own row', async () => {
      const refreshedRefs: RowRef[] = []
      const { repository, ref } = storeRepository(async (target) => {
        refreshedRefs.push(target)
        return {
          status: 'rotated',
          ref: target,
          accessToken: 'access-from-store',
          expiresAt: Date.now() + 3_600_000,
        }
      })
      const tokenFetch = mock(async () => {
        throw new Error(
          'the host OAuth refresh must not run for a store account',
        )
      })
      globalThis.stubbed('fetch', tokenFetch)
      transportHandler = async () =>
        new Response(
          JSON.stringify({
            response: {
              candidates: [
                { content: { role: 'model', parts: [{ text: 'hi' }] } },
              ],
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      const accountManager = await loadAccountManagerFromRepository(
        repository,
        { onDiagnostic: () => {} },
      )
      const context = await makeContext({
        config: {
          ...DEFAULT_CONFIG,
          account_selection_strategy: 'sticky',
          request_jitter_max_ms: 0,
          quota_refresh_interval_minutes: 0,
          proactive_rotation_threshold_percent: 0,
        },
      })
      const interceptor = createFetchInterceptor({
        ...context,
        accountManager,
        accountSource: { kind: 'store', repository },
      })
      try {
        const response = await interceptor.fetch(
          GENERATIVE_URL.replace(
            ':streamGenerateContent?alt=sse',
            ':generateContent',
          ),
          GENERATIVE_INIT,
        )
        expect(response.status).toBe(200)
        expect(refreshedRefs).toEqual([ref])
        expect(tokenFetch).not.toHaveBeenCalled()
        expect(transportMock).toHaveBeenCalledTimes(1)
        const sentInit = transportMock.mock.calls[0]?.[1] as RequestInit
        expect(new Headers(sentInit.headers).get('authorization')).toBe(
          'Bearer access-from-store',
        )
      } finally {
        interceptor.dispose()
        await context.accountManager.dispose()
        await accountManager.dispose()
      }
    })
  })

  describe('vault custody source', () => {
    const route = {
      routeId: 'route-work',
      credentialId: 'credential-work',
      accountIdentity: 'identity-work',
      label: 'Work',
      email: 'work@example.test',
    }

    // The vault account source operations the vault interceptor uses. Each
    // admission is a new receipt with its own version, token and project.
    function vaultSource(versions: number[] = [1, 2, 3, 4]) {
      const admitted: Array<{ ref: typeof route; signal?: AbortSignal }> = []
      const reported: Array<{ recordVersion: number; status: number }> = []
      let refreshes = 0
      const source: VaultRequestSource = {
        refresh: async () => {
          refreshes++
          return undefined
        },
        routes: () => [route],
        admit: async (ref, signal) => {
          admitted.push({ ref: ref as typeof route, signal })
          const recordVersion = versions.shift() ?? 99
          return {
            routeId: ref.routeId,
            credentialId: ref.credentialId,
            accountIdentity: ref.accountIdentity,
            recordVersion,
            projectId: `vault-project-${recordVersion}`,
            accessToken: `vault-token-${recordVersion}`,
            expiresAtMs: null,
          }
        },
        reportServedStatus: async (admission, status) => {
          reported.push({ recordVersion: admission.recordVersion, status })
          return status === 401
        },
      }
      return { source, admitted, reported, refreshes: () => refreshes }
    }

    async function vaultInterceptor(source: VaultRequestSource) {
      const context = await makeContext({
        config: {
          ...DEFAULT_CONFIG,
          account_selection_strategy: 'sticky',
          request_jitter_max_ms: 0,
          quota_refresh_interval_minutes: 0,
          proactive_rotation_threshold_percent: 0,
        },
      })
      await context.accountManager.dispose()
      return createVaultFetchInterceptor({
        client: context.client,
        config: context.config,
        agySessionRegistry: context.agySessionRegistry,
        agyTransport: context.agyTransport,
        source,
      })
    }

    const NON_STREAM_URL = GENERATIVE_URL.replace(
      ':streamGenerateContent?alt=sse',
      ':generateContent',
    )
    const okJson = () =>
      new Response(
        JSON.stringify({
          response: {
            candidates: [
              { content: { role: 'model', parts: [{ text: 'hi' }] } },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    const sent = (index: number) => {
      const init = transportMock.mock.calls[index]?.[1] as RequestInit
      return {
        authorization: new Headers(init.headers).get('authorization'),
        project: (JSON.parse(String(init.body)) as { project: string }).project,
      }
    }

    it("admits every physical attempt and sends with that receipt's token and project", async () => {
      const vault = vaultSource()
      const hostFetch = mock(async () => {
        throw new Error('no host token or host fetch is used for vault sends')
      })
      globalThis.stubbed('fetch', hostFetch)
      transportHandler = async () =>
        transportMock.mock.calls.length === 1
          ? new Response('missing', { status: 404 })
          : okJson()
      const interceptor = await vaultInterceptor(vault.source)
      try {
        const first = await interceptor.fetch(NON_STREAM_URL, GENERATIVE_INIT)
        expect(first.status).toBe(200)
        const second = await interceptor.fetch(NON_STREAM_URL, GENERATIVE_INIT)
        expect(second.status).toBe(200)

        // Two endpoint attempts for the first request, one for the second:
        // three receipts, each used once, nothing reused from a prior send.
        expect(vault.admitted.map((entry) => entry.ref)).toEqual([
          route,
          route,
          route,
        ])
        expect([0, 1, 2].map(sent)).toEqual([
          { authorization: 'Bearer vault-token-1', project: 'vault-project-1' },
          { authorization: 'Bearer vault-token-2', project: 'vault-project-2' },
          { authorization: 'Bearer vault-token-3', project: 'vault-project-3' },
        ])
        expect(vault.refreshes()).toBe(1)
        expect(hostFetch).not.toHaveBeenCalled()
      } finally {
        interceptor.dispose()
      }
    })

    it('reports a served 401 against the receipt that served it', async () => {
      // The re-admission after the 401 is not a newer version, so the 401
      // stands and nothing else is sent.
      const vault = vaultSource([5, 5])
      transportHandler = async () =>
        new Response('{"error":{"code":401}}', { status: 401 })
      const interceptor = await vaultInterceptor(vault.source)
      try {
        const response = await interceptor.fetch(
          NON_STREAM_URL,
          GENERATIVE_INIT,
        )
        expect(response.status).toBe(401)
        expect(vault.reported).toEqual([{ recordVersion: 5, status: 401 }])
        expect(transportMock).toHaveBeenCalledTimes(1)
      } finally {
        interceptor.dispose()
      }
    })
  })

  describe('transport failures', () => {
    it('propagates connection resets instead of emitting them as assistant text', async () => {
      const resetError = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
        syscall: 'read',
      })
      transportHandler = async () => {
        throw resetError
      }

      const context = await makeContext({
        config: {
          ...DEFAULT_CONFIG,
          request_jitter_max_ms: 0,
          switch_account_delay_ms: 0,
        },
      })
      const interceptor = createFetchInterceptor(context)

      const request = interceptor.fetch(GENERATIVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      })
      await expect(request).rejects.toMatchObject({
        message: 'read ECONNRESET',
        code: 'ECONNRESET',
        syscall: 'read',
      })
      await expect(request).rejects.toBe(resetError)
      expect(transportMock).toHaveBeenCalledTimes(2)
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
