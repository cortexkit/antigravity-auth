import { expect, it, mock, spyOn } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
  type AccountLoginInput,
  type AccountRepository,
  type AccountRepositoryRead,
  type AccountTokenExchange,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
} from '@cortexkit/antigravity-auth-core'

import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '../constants'
import { prepareVaultFolder } from '../vault-folder'
import type { AgyTransport } from './dependencies'
import { getStoragePath, openAccountStore } from './storage'
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

const agyTransport: AgyTransport = (url, init) => transport(url, init)

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')
const GENERATIVE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse'
const TERMINAL_SSE = [
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]}}]}}',
  'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}}',
  '',
].join('\n\n')

function storedAccounts(): AccountLoginInput[] {
  return [
    {
      id: crypto.randomUUID(),
      refreshToken: 'refresh-a',
      metadata: {
        email: 'account-a@example.test',
        projectId: 'project-a',
        managedProjectId: 'managed-a',
        addedAt: FIXED_NOW - 20_000,
        lastUsed: FIXED_NOW - 10_000,
      },
    },
    {
      id: crypto.randomUUID(),
      refreshToken: 'refresh-b',
      metadata: {
        email: 'account-b@example.test',
        projectId: 'project-b',
        managedProjectId: 'managed-b',
        addedAt: FIXED_NOW - 19_000,
        lastUsed: FIXED_NOW - 9_000,
      },
    },
  ]
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

function normalizedStorage(storage: AccountRepositoryRead) {
  if (storage.status !== 'ready') throw new Error(storage.status)
  const [accountA, accountB] = storage.rows
  if (
    accountA?.metadata.status !== 'present' ||
    accountB?.metadata.status !== 'present'
  ) {
    throw new Error('account metadata missing from the store')
  }
  const resetEntry = Object.entries(
    accountA.metadata.metadata.rateLimitResetTimes ?? {},
  ).find(([, reset]) => typeof reset === 'number')
  const selectedIndex = (family: 'claude' | 'gemini') => {
    const selected = storage.routing?.activeRowByFamily?.[family]
    const row = storage.rows.find(
      ({ ref }) =>
        ref.id === selected?.id &&
        ref.credentialEpoch === selected?.credentialEpoch &&
        ref.identity === selected?.identity,
    )
    if (!row) throw new Error(`selected ${family} row is not in the roster`)
    return row.index
  }

  return {
    activeIndexByFamily: {
      claude: selectedIndex('claude'),
      gemini: selectedIndex('gemini'),
    },
    accountA: {
      id: 'A',
      rateLimit: {
        key: resetEntry?.[0],
        resetAt: resetEntry?.[1],
      },
    },
    accountB: {
      id: 'B',
      current:
        storage.routing?.activeRowByFamily?.gemini?.id === accountB.ref.id,
      lastUsed: accountB.metadata.metadata.lastUsed,
      dailyRequestCounts: accountB.metadata.metadata.dailyRequestCounts,
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
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')

  const projectDirectory = `${root}/behavior-snapshot-project`
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = `${projectDirectory}/.opencode`
  const nowSpy = spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
  const plugins: Array<{ dispose?(): Promise<void> | void }> = []
  const repositories: AccountRepository[] = []
  const cleanupFailures: unknown[] = []
  try {
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
    const modules = await loadCommonAuthStoreModules()
    let legacyPath = getStoragePath()
    const initialized = await initializeFreshAccountStore(modules, {
      legacyPath,
      now: Date.now,
    })
    expect(initialized.status).toBe('completed')
    // The harness must bind after startup relocation, just like the plugin.
    await prepareVaultFolder({ accountFile: legacyPath })
    legacyPath = getStoragePath()
    const exchange: AccountTokenExchange = async ({ refreshToken, row }) => {
      expect(refreshToken).toBe('refresh-a')
      expect(row.credential?.refreshToken).toBe(refreshToken)
      return {
        accessToken: 'access-a',
        refreshToken,
        expiresAt: FIXED_NOW + 3_600_000,
      }
    }
    const opening = await openAccountStore({
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange,
      legacyPath,
      now: Date.now,
    })
    if (opening.status !== 'ready') throw new Error(opening.status)
    const repository = opening.repository
    repositories.push(repository)
    const initialAccounts = storedAccounts()
    for (const account of initialAccounts) await repository.login(account)

    const readStore = async () => {
      const read = await repository.read()
      if (read.status !== 'ready') throw new Error(read.status)
      expect(read.rows).toHaveLength(2)
      expect(read.rows.map((row) => row.credential?.refreshToken)).toEqual([
        'refresh-a',
        'refresh-b',
      ])
      return read
    }
    const seedAccessA = async () => {
      const read = await readStore()
      const [accountA, accountB] = read.rows
      if (!accountA || !accountB) throw new Error('account roster missing')
      expect(accountB.credential?.accessToken).toBeUndefined()
      expect((await repository.refresh(accountA.ref)).status).toBe('rotated')
      for (const target of ['active', 'claude', 'gemini'] as const) {
        await repository.selectAccount(target, accountA.ref)
      }
      expect((await repository.flush()).failures).toEqual([])
      const seeded = await readStore()
      expect(seeded.rows[0]?.credential).toEqual({
        refreshToken: 'refresh-a',
        accessToken: 'access-a',
        expiresAt: FIXED_NOW + 3_600_000,
      })
      expect(seeded.routing?.activeRowByFamily).toEqual({
        claude: accountA.ref,
        gemini: accountA.ref,
      })
      return seeded
    }
    const initialStorage = await seedAccessA()
    expect(initialStorage.rows.map((row) => row.ref.id)).toEqual(
      initialAccounts.map((account) => account.id),
    )
    expect(
      initialStorage.rows.map((row) =>
        row.metadata.status === 'present' ? row.metadata.metadata : undefined,
      ),
    ).toEqual(initialAccounts.map((account) => account.metadata))

    const events: string[] = []
    const hostFetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === 'https://oauth2.googleapis.com/token') {
          expect(init?.method).toBe('POST')
          expect(new Headers(init?.headers).get('content-type')).toBe(
            'application/x-www-form-urlencoded',
          )
          const form = new URLSearchParams(String(init?.body))
          expect(Object.fromEntries(form)).toEqual({
            grant_type: 'refresh_token',
            refresh_token: 'refresh-b',
            client_id: ANTIGRAVITY_CLIENT_ID,
            client_secret: ANTIGRAVITY_CLIENT_SECRET,
          })
          events.push('refresh B')
          return Response.json({ access_token: 'access-b', expires_in: 3600 })
        }
        return new Response('', { status: 404 })
      },
    )
    globalThis.stubbed('fetch', hostFetch)

    let getAuthCalls = 0
    const getAuth = async () => {
      getAuthCalls++
      if (getAuthCalls === 1) events.push('auth loader reads A,B')
      return {
        type: 'oauth' as const,
        // Keep the native OpenCode login distinct from the two seeded repository
        // accounts. The transport's bearer checks then reject any request that
        // uses host credentials instead of the selected stored credential.
        refresh: 'host-only-refresh|host-project|host-managed',
        access: 'host-only-access',
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
      const beforeRotation = await readStore()
      const accountA = beforeRotation.rows[0]
      if (accountA?.metadata.status !== 'present') {
        throw new Error('account A metadata missing before B transport')
      }
      expect(accountA.metadata.metadata.rateLimitResetTimes).toEqual({
        'gemini:gemini-3-flash': FIXED_NOW + 60_000,
      })
      events.push(
        'rate-limit A persisted',
        'request rotates to B',
        'transport B',
      )
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
    plugins.push(first)

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
    expect((await repository.flush()).failures).toEqual([])
    const beforeDispose = await readStore()
    const accountB = beforeDispose.rows[1]
    if (accountB?.metadata.status !== 'present') {
      throw new Error('account B metadata missing after streaming')
    }
    expect(accountB.metadata.metadata.dailyRequestCounts?.gemini).toBe(1)
    events.push('usage/quota state recorded')

    await first.dispose?.()
    plugins.splice(plugins.indexOf(first), 1)
    expect((await repository.flush()).failures).toEqual([])
    const finalStorage = await readStore()
    events.push('dispose flushes storage and timers')

    expect(events).toEqual([
      'config catalog merge',
      'auth loader reads A,B',
      'request selects A',
      'transport A',
      'refresh B',
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
          key: 'gemini:gemini-3-flash',
          resetAt: FIXED_NOW + 60_000,
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
    expect(finalStorage.routing?.activeRowByFamily).toEqual({
      claude: initialStorage.rows[0]?.ref,
      gemini: initialStorage.rows[1]?.ref,
    })
    expect(finalStorage.routing?.activeRowByFamily?.gemini).not.toEqual(
      initialStorage.routing?.activeRowByFamily?.gemini,
    )
    expect(firstTransportCalls).toBe(2)
    expect(
      hostFetch.mock.calls.filter(
        ([input]) => String(input) === 'https://oauth2.googleapis.com/token',
      ),
    ).toHaveLength(1)
    expect(finalStorage.rows[1]?.credential).toEqual({
      refreshToken: 'refresh-b',
      accessToken: 'access-b',
      expiresAt: FIXED_NOW + 3_600_000,
    })
    expect(firstClient.tui.showToast).not.toHaveBeenCalled()
    expect(firstClient.session.prompt).not.toHaveBeenCalled()

    const replacementAccounts = storedAccounts()
    await repository.replacePool(replacementAccounts)
    const resetStorage = await readStore()
    expect(resetStorage.rows.map((row) => row.ref.id)).toEqual(
      replacementAccounts.map((account) => account.id),
    )
    for (const row of resetStorage.rows) {
      if (row.metadata.status !== 'present') {
        throw new Error('replacement account metadata missing')
      }
      expect(row.metadata.metadata.rateLimitResetTimes).toBeUndefined()
      expect(row.metadata.metadata.coolingDownUntil).toBeUndefined()
      expect(row.metadata.metadata.dailyRequestCounts).toBeUndefined()
    }
    const secondSeed = await seedAccessA()
    const secondClient = fakeClient()
    const second = await createAntigravityPlugin('google', {
      dependencies: { agyTransport },
    })(buildInput(secondClient, projectDirectory))
    plugins.push(second)
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
    const secondForwarded = await secondResponse.text()
    expect(secondForwarded).toContain('"text":"done"')
    expect(secondForwarded).toContain('"finishReason":"STOP"')
    expect(secondResponse.status).toBe(200)
    await second.dispose?.()
    plugins.splice(plugins.indexOf(second), 1)
    expect((await repository.flush()).failures).toEqual([])
    const secondStorage = await readStore()
    expect(secondStorage.routing?.activeRowByFamily?.gemini).toEqual(
      secondSeed.rows[0]?.ref,
    )
    expect(secondStorage.rows[1]?.credential?.accessToken).toBeUndefined()

    expect({
      transportCalls: secondCalls,
      toasts: secondClient.tui.showToast.mock.calls.length,
      sessionPrompts: secondClient.session.prompt.mock.calls.length,
    }).toEqual({
      transportCalls: ['Bearer access-a'],
      toasts: 0,
      sessionPrompts: 0,
    })
  } finally {
    try {
      const pluginDisposals = await Promise.allSettled(
        plugins.map((plugin) => plugin.dispose?.()),
      )
      const repositoryDisposals = await Promise.allSettled(
        repositories.map((repository) => repository.dispose()),
      )
      for (const result of [...pluginDisposals, ...repositoryDisposals]) {
        if (result.status === 'rejected') cleanupFailures.push(result.reason)
      }
      for (const result of repositoryDisposals) {
        if (result.status === 'fulfilled') {
          cleanupFailures.push(...result.value.failures)
        }
      }
    } finally {
      nowSpy.mockRestore()
      globalThis.unstubAllGlobals()
      transport.mockClear()
      transportHandler = async () => {
        throw new Error('transport handler not configured')
      }
      if (previousConfigDir === undefined)
        delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      await rm(projectDirectory, { recursive: true, force: true })
    }
  }
  expect(cleanupFailures).toEqual([])
}, 10_000)
