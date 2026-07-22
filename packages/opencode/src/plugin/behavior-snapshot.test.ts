import { expect, it, mock, spyOn } from 'bun:test'

import type { AgyTransport } from './dependencies'
import type { AccountStorageV4 } from './storage'
import { loadAccounts, saveAccountsReplace } from './storage'
import type { PluginInput, Provider } from './types'

const transport = mock(
  async (...args: Parameters<typeof fetch>): Promise<Response> =>
    transportHandler(...args),
)

let transportHandler = async (
  ..._args: Parameters<typeof fetch>
): Promise<Response> => {
  throw new Error('transport handler not configured')
}

const agyTransport: AgyTransport = (url, init) =>
  transport(url, init) as unknown as Promise<Response>

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')
const GENERATIVE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse'
const TERMINAL_SSE = [
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]}}]}}',
  'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}}',
  '',
].join('\n\n')

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
      {
        email: 'account-b@example.test',
        refreshToken: 'refresh-b',
        projectId: 'project-b',
        managedProjectId: 'managed-b',
        addedAt: FIXED_NOW - 19_000,
        lastUsed: FIXED_NOW - 9_000,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  }
}

function fakeClient() {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
      updateMessage: mock(async () => ({})),
    },
    tui: { showToast: mock(async () => {}) },
  }
}

function emptyProvider(): Provider {
  return {
    id: 'google',
    name: 'Google',
    source: 'custom',
    env: [],
    options: {},
    models: {},
  }
}

function normalizedStorage(storage: AccountStorageV4) {
  const resetEntry = Object.entries(
    storage.accounts[0]?.rateLimitResetTimes ?? {},
  ).find(([, reset]) => typeof reset === 'number')

  return {
    activeIndexByFamily: storage.activeIndexByFamily,
    accountA: {
      id: 'A',
      rateLimit: {
        key: resetEntry?.[0],
        resetAt: resetEntry?.[1],
        reason: 'QUOTA_EXHAUSTED',
      },
    },
    accountB: {
      id: 'B',
      current: storage.activeIndexByFamily?.gemini === 1,
      lastUsed: storage.accounts[1]?.lastUsed,
      dailyRequestCounts: storage.accounts[1]?.dailyRequestCounts,
    },
  }
}

function buildInput(
  client: ReturnType<typeof fakeClient>,
  directory: string,
): PluginInput {
  return {
    client: client as never,
    project: {} as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  }
}

it('preserves the plugin hook mutation sequence across extraction', async () => {
  const nowSpy = spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')

  const projectDirectory = `${root}/behavior-snapshot-project`
  await Bun.write(
    `${projectDirectory}/.opencode/antigravity.json`,
    JSON.stringify({
      quiet_mode: true,
      session_recovery: false,
      proactive_token_refresh: false,
      cache_warmup_on_switch: false,
      account_selection_strategy: 'sticky',
      scheduling_mode: 'balance',
      switch_on_first_rate_limit: true,
      switch_account_delay_ms: 1250,
      soft_quota_threshold_percent: 100,
      quota_refresh_interval_minutes: 0,
      proactive_rotation_threshold_percent: 0,
      auto_update: false,
    }),
  )
  await saveAccountsReplace(storedAccounts())

  const events: string[] = []
  const hostFetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'access-b', expires_in: 3600 })
    }
    return new Response('', { status: 404 })
  })
  globalThis.stubbed('fetch', hostFetch)

  let getAuthCalls = 0
  const getAuth = async () => {
    getAuthCalls++
    if (getAuthCalls === 1) events.push('auth loader reads A,B')
    return {
      type: 'oauth' as const,
      refresh: 'refresh-a|project-a|managed-a',
      access: 'access-a',
      expires: FIXED_NOW + 3_600_000,
    }
  }

  let firstTransportCalls = 0
  transportHandler = async (_input, init) => {
    firstTransportCalls++
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization === 'Bearer access-a') {
      events.push('request selects A', 'transport A')
      return Response.json(
        {
          error: {
            code: 429,
            message: 'Quota exhausted',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ reason: 'QUOTA_EXHAUSTED' }],
          },
        },
        {
          status: 429,
          headers: { 'retry-after': '60' },
        },
      )
    }

    expect(authorization).toBe('Bearer access-b')
    const beforeRotation = await loadAccounts()
    expect(beforeRotation?.accounts[0]?.rateLimitResetTimes).toBeDefined()
    events.push('rate-limit A persisted', 'request rotates to B', 'transport B')
    return new Response(TERMINAL_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const { createAntigravityPlugin } = await import('../plugin')
  const firstClient = fakeClient()
  const first = await createAntigravityPlugin('google', {
    dependencies: { agyTransport },
  })(buildInput(firstClient, projectDirectory))

  const mutableConfig = {
    provider: {
      google: {
        models: { existing: { name: 'Existing' } },
      },
    },
    command: { existing: { template: 'existing' } },
  } as unknown as Parameters<NonNullable<typeof first.config>>[0]
  await first.config?.(mutableConfig)
  const postConfig = mutableConfig as unknown as {
    provider: { google: { models: Record<string, unknown> } }
    command: Record<string, unknown>
  }
  expect(postConfig.provider.google.models.existing).toEqual({
    name: 'Existing',
  })
  expect(postConfig.command.existing).toEqual({ template: 'existing' })
  events.push('config catalog merge')

  const loader = await first.auth.loader(getAuth, emptyProvider())
  expect('fetch' in loader).toBe(true)
  const fetchHook = (loader as { fetch: typeof fetch }).fetch
  const response = await fetchHook(GENERATIVE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-id': 'recorded-session',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'recorded prompt' }] }],
    }),
  })
  const forwarded = await response.text()
  expect(response.status).toBe(200)
  expect(forwarded).toContain('"text":"done"')
  expect(forwarded).toContain('"finishReason":"STOP"')
  events.push('terminal SSE forwarded')

  await Bun.sleep(1100)
  const beforeDispose = await loadAccounts()
  expect(beforeDispose?.accounts[1]?.dailyRequestCounts?.gemini).toBe(1)
  events.push('usage/quota state recorded')

  await first.dispose?.()
  const finalStorage = await loadAccounts()
  if (!finalStorage) throw new Error('account storage missing after dispose')
  events.push('dispose flushes storage and timers')

  expect(events).toEqual([
    'config catalog merge',
    'auth loader reads A,B',
    'request selects A',
    'transport A',
    'rate-limit A persisted',
    'request rotates to B',
    'transport B',
    'terminal SSE forwarded',
    'usage/quota state recorded',
    'dispose flushes storage and timers',
  ])
  expect(normalizedStorage(finalStorage)).toEqual({
    activeIndexByFamily: { claude: 0, gemini: 1 },
    accountA: {
      id: 'A',
      rateLimit: {
        key: 'gemini-antigravity:gemini-3-flash',
        resetAt: FIXED_NOW + 60_000,
        reason: 'QUOTA_EXHAUSTED',
      },
    },
    accountB: {
      id: 'B',
      current: true,
      lastUsed: FIXED_NOW,
      dailyRequestCounts: {
        date: '2026-07-22',
        claude: 0,
        gemini: 1,
      },
    },
  })
  expect(firstTransportCalls).toBe(2)

  await saveAccountsReplace(storedAccounts())
  const secondClient = fakeClient()
  const second = await createAntigravityPlugin('google', {
    dependencies: { agyTransport },
  })(buildInput(secondClient, projectDirectory))
  const secondAuth = await second.auth.loader(getAuth, emptyProvider())
  const secondCalls: string[] = []
  transportHandler = async (_input, init) => {
    secondCalls.push(
      new Headers(init?.headers).get('authorization') ?? 'missing',
    )
    return new Response(TERMINAL_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const secondResponse = await (secondAuth as { fetch: typeof fetch }).fetch(
    GENERATIVE_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'recorded-session',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'recorded prompt' }] }],
      }),
    },
  )
  expect(await secondResponse.text()).toContain('"finishReason":"STOP"')
  await second.dispose?.()

  expect({
    transportCalls: secondCalls,
    toasts: secondClient.tui.showToast.mock.calls.length,
    sessionPrompts: secondClient.session.prompt.mock.calls.length,
  }).toEqual({
    transportCalls: ['Bearer access-a'],
    toasts: 0,
    sessionPrompts: 0,
  })

  nowSpy.mockRestore()
  globalThis.unstubAllGlobals()
}, 10_000)
