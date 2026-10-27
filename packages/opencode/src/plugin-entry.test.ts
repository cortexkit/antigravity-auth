import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountRepositoryFactory,
  getAntigravityOpencodeModelIds,
  initializeFreshAccountStore,
  loadCommonAuthClaustrum,
  loadCommonAuthStoreModules,
  OPENCODE_MODEL_DEFINITIONS,
  readAccountStoreAdmission,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import * as packageRoot from '../index'
import { ANTIGRAVITY_PROVIDER_ID } from './constants.ts'
import { RELEASE_MODEL_IDS } from './plugin/__fixtures__/release-model-ids'
import { startMenuVaultFixture } from './plugin/__fixtures__/vault-menu-daemon.test'
import type { BackgroundQuotaRefresh } from './plugin/background-quota-refresh'
import { ANTIGRAVITY_MENU_COMMAND } from './plugin/commands.ts'
import type { FetchImpl } from './plugin/dependencies'
import { GEMINI_DUMP_COMMAND_NAME } from './plugin/gemini-dump.ts'
import { createAntigravityPlugin } from './plugin/index'
import { getStoragePath } from './plugin/storage'
import type { PluginClient, PluginInput, Provider } from './plugin/types.ts'
import { V1_VAULT_ACTIVATION_LABEL } from './plugin/vault-activation'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
} from './plugin/vault-custody'
import { drainNotifications } from './rpc/notifications'
import { createRpcClient } from './rpc/rpc-client'
import { getVaultDir } from './runtime-paths'

// The store binds its timers on import; load it before the quota-tick test
// temporarily replaces the global timer function.
beforeAll(async () => {
  await loadCommonAuthStoreModules()
})

/**
 * A host-client stand-in for entry wiring tests. These methods record calls
 * without dispatching real sessions, authentication writes or terminal output.
 */
function createMinimalClient(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      abort: mock(async () => {}),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => {}),
    },
    tui: {
      showToast: mock(async () => {}),
    },
  } as unknown as PluginClient
}

function createPluginInput(
  client: PluginClient,
  directory: string,
): PluginInput {
  return {
    client,
    project: {} as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  }
}

function watchSidebarFixture(directory: string) {
  const markerName = '.sidebar-watcher-ready'
  const finishedMarkerName = '.sidebar-watcher-finished'
  const marker = join(directory, markerName)
  const changes: string[] = []
  let markerObserved: () => void = () => {}
  let seedObserved: () => void = () => {}
  let finishObserved: () => void = () => {}
  const sidebarSeedObserved = new Promise<void>((done) => {
    seedObserved = done
  })
  const finished = new Promise<void>((done) => {
    finishObserved = done
  })
  const watcher = watch(directory, (_event, name) => {
    const filename = name?.toString()
    if (filename === markerName) {
      markerObserved()
      return
    }
    if (filename === finishedMarkerName) {
      finishObserved()
      return
    }
    if (filename?.startsWith('sidebar-state')) changes.push(filename)
    if (filename === 'sidebar-state.json') seedObserved()
  })

  // Bun's macOS FSEvents stream starts asynchronously and can deliver earlier
  // setup writes after watch() returns: a production-free probe did so 17/40 times.
  // Observe a separate marker before seeding any watched product file.
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((done, reject) => {
    const deadline = performance.now() + 4_000
    markerObserved = () => {
      clearTimeout(probeTimer)
      done()
    }
    const probe = () => {
      if (performance.now() >= deadline) {
        reject(new Error('Sidebar watcher did not become ready'))
        return
      }
      try {
        writeFileSync(marker, 'ready', { mode: 0o600 })
        probeTimer = setTimeout(probe, 1)
      } catch (error) {
        reject(error)
      }
    }
    probe()
  }).finally(() => {
    clearTimeout(probeTimer)
    rmSync(marker, { force: true })
  })
  return {
    watcher,
    changes,
    ready,
    sidebarSeedObserved,
    async finish() {
      // An observed end marker drains delayed product events, not just JS tasks.
      const path = join(directory, finishedMarkerName)
      writeFileSync(path, 'finished', { mode: 0o600 })
      await finished
      await new Promise<void>((done) => setImmediate(done))
      unlinkSync(path)
    },
  }
}

async function withUnmigratedComposition(
  run: (
    send: FetchImpl,
    upstream: ReturnType<typeof mock<FetchImpl>>,
    hostAuthReads: { value: number },
  ) => Promise<void>,
) {
  const owned = realpathSync(mkdtempSync('/tmp/agy-unmigrated-composition-'))
  const overrides = {
    OPENCODE_CONFIG_DIR: join(owned, 'config'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(owned, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(owned, 'sidebar-state.json'),
  }
  const prior = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, overrides)
  mkdirSync(overrides.OPENCODE_CONFIG_DIR)
  writeFileSync(
    getStoragePath(),
    JSON.stringify({
      version: 4,
      accounts: [
        {
          refreshToken: 'synthetic-composition-refresh',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
    }),
    { mode: 0o600 },
  )
  const upstream = mock<FetchImpl>(
    async () => new Response('configured-upstream'),
  )
  const globalFetch = spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('global passthrough must not run'),
  )
  const hostAuthReads = { value: 0 }
  const getAuth = async () => {
    hostAuthReads.value += 1
    return {
      type: 'oauth' as const,
      access: 'synthetic-composition-access',
      refresh: 'synthetic-composition-refresh',
      expires: Date.now() + 3600000,
    }
  }
  let plugin:
    | Awaited<ReturnType<ReturnType<typeof createAntigravityPlugin>>>
    | undefined
  try {
    plugin = await createAntigravityPlugin('google', {
      dependencies: { fetchImpl: upstream },
    })(createPluginInput(createMinimalClient(), owned))
    const provider: Provider = {
      id: 'google',
      name: 'Google',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    }
    const loaded = await plugin.auth.loader(getAuth, provider)
    if (typeof loaded.fetch !== 'function')
      throw new Error('Production composition supplied no delegating fetch')
    await run(loaded.fetch, upstream, hostAuthReads)
  } finally {
    await plugin?.dispose?.()
    globalFetch.mockRestore()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(owned, { recursive: true, force: true })
  }
}

it('V1 still intercepts the default Google URL', async () => {
  await withUnmigratedComposition(async (send, upstream) => {
    const response = await send(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      { method: 'POST', body: '{"contents":[]}' },
    )

    expect(response.status).toBe(412)
    expect((await response.json()).error.message).toContain('offline migration')
    expect(upstream).not.toHaveBeenCalled()
  })
})

it('V1 passes a lookalike proxy URL through unchanged', async () => {
  await withUnmigratedComposition(async (send, upstream, hostAuthReads) => {
    const url =
      'https://proxy.example.invalid/generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
    const body = '{"contents":[{"role":"user","parts":[{"text":"proxy"}]}]}'
    const bodyBytes = Array.from(new TextEncoder().encode(body))
    const headers = new Headers({
      'content-type': 'application/json',
      'x-proxy-test': 'unchanged',
    })
    const headerEntries = [...headers.entries()]
    const init: RequestInit = { method: 'POST', headers, body }
    const authReadsBeforeRequest = hostAuthReads.value

    const response = await send(url, init)

    expect(await response.text()).toBe('configured-upstream')
    expect(upstream).toHaveBeenCalledTimes(1)
    const [forwardedUrl, forwardedInit] = upstream.mock.calls[0] ?? []
    expect(forwardedUrl).toBe(url)
    expect(forwardedInit).toBe(init)
    expect(forwardedInit?.method).toBe('POST')
    expect(forwardedInit?.headers).toBe(headers)
    expect([...headers.entries()]).toEqual(headerEntries)
    expect(headers.has('authorization')).toBe(false)
    expect(
      Array.from(new TextEncoder().encode(String(forwardedInit?.body))),
    ).toEqual(bodyBytes)
    expect(hostAuthReads.value).toBe(authReadsBeforeRequest)
  })
})

it('unmigrated production composition preserves configured non-generative passthrough when global fetch refuses', async () => {
  await withUnmigratedComposition(async (send, upstream) => {
    const input = new Request(
      'https://configured-upstream.invalid/non-generative',
    )
    const init = { headers: { 'x-configured': 'preserved' } }
    const response = await send(input, init)
    expect(await response.text()).toBe('configured-upstream')
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(upstream).toHaveBeenCalledWith(input, init)
  })
})

for (const override of ['live', 'null'] as const) {
  it(`unmigrated production composition honors explicit ${override} init signal over an aborted Request`, async () => {
    await withUnmigratedComposition(async (send, upstream) => {
      const inherited = new AbortController()
      inherited.abort(new Error('inherited request cancellation'))
      const input = new Request(
        'https://generativelanguage.googleapis.com/v1/models/example:streamGenerateContent',
        { signal: inherited.signal },
      )
      const response = await send(input, {
        signal: override === 'null' ? null : new AbortController().signal,
      })
      expect(response.status).toBe(412)
      expect((await response.json()).error.message).toBe(
        'Antigravity accounts require offline migration. Stop OpenCode, then run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`.',
      )
      expect(upstream).not.toHaveBeenCalled()
    })
  })
}

it('unmigrated production composition retains inherited and explicit-aborted cancellation controls', async () => {
  await withUnmigratedComposition(async (send, upstream) => {
    const inherited = new AbortController()
    const inheritedReason = new Error('inherited cancellation')
    inherited.abort(inheritedReason)
    await expect(
      send(
        new Request('https://generativelanguage.googleapis.com/example', {
          signal: inherited.signal,
        }),
      ),
    ).rejects.toBe(inheritedReason)
    const explicit = new AbortController()
    const explicitReason = new Error('explicit cancellation')
    explicit.abort(explicitReason)
    await expect(
      send(new Request('https://generativelanguage.googleapis.com/example'), {
        signal: explicit.signal,
      }),
    ).rejects.toBe(explicitReason)
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('createAntigravityPlugin (plugin entry surface)', () => {
  let tempProjectDir: string
  let fetchSpy: ReturnType<typeof spyOn>
  let plugin:
    | Awaited<ReturnType<ReturnType<typeof createAntigravityPlugin>>>
    | undefined

  beforeEach(() => {
    plugin = undefined
    tempProjectDir = mkdtempSync(join(tmpdir(), 'plugin-entry-test-'))

    // initAntigravityVersion performs a non-blocking fetch on first install.
    // Returning a non-OK response forces it to fall back to the hardcoded
    // version without hitting the network — keeping the test hermetic.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response('not-found', {
          status: 404,
          statusText: 'Not Found',
        })) as unknown as typeof fetch,
    )
  })

  afterEach(async () => {
    // Stop producers and drain sidebar writes before the next test changes
    // environment-based paths, or an old publication can write the next fixture.
    await plugin?.dispose?.()
    fetchSpy.mockRestore()
    mock.restore()
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  it('exposes the host-visible hook contract (config, command.execute.before, event, tool.google_search, auth)', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)

    plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    expect(typeof plugin.dispose).toBe('function')
    expect(typeof plugin.config).toBe('function')
    expect(typeof plugin['command.execute.before']).toBe('function')
    expect(typeof plugin.event).toBe('function')
    expect(plugin.tool).toBeDefined()
    expect(plugin.tool?.google_search).toBeDefined()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe(ANTIGRAVITY_PROVIDER_ID)
    expect(typeof plugin.auth.loader).toBe('function')

    // Two auth methods: OAuth with Antigravity + Manual API key entry.
    const labels = plugin.auth.methods.map((m) => m.label)
    expect(labels).toContain('OAuth with Google (Antigravity)')
    expect(labels).toContain('Manually enter API Key')
    expect(plugin.auth.methods).toHaveLength(2)
    const oauthMethod = plugin.auth.methods.find(
      (method) => method.label === 'OAuth with Google (Antigravity)',
    )
    expect(oauthMethod?.type).toBe('oauth')
    expect(typeof oauthMethod?.authorize).toBe('function')

    // No network call should leak from initialization — the version check
    // falls back to the hardcoded version on non-OK.
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('config hook registers the antigravity model catalog, whitelist, and the /antigravity command without deleting existing entries', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)
    plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    // Pre-populate the opencode config with a stub provider + command so
    // the plugin must merge rather than overwrite.
    const opencodeConfig = {
      provider: {
        'other-provider': { models: { foo: { name: 'foo' } } },
      },
      command: {
        existing: { template: 'existing', description: 'pre-existing' },
      },
    } as unknown as Parameters<typeof plugin.config>[0]

    await plugin.config?.(opencodeConfig)

    // Provider catalog: the antigravity provider now carries every model
    // listed in the core model registry, and a whitelist matching those ids.
    const expectedModelIds = getAntigravityOpencodeModelIds()
    const provider = (
      opencodeConfig as unknown as {
        provider?: Record<
          string,
          { models: Record<string, unknown>; whitelist: string[] }
        >
      }
    ).provider?.[ANTIGRAVITY_PROVIDER_ID]
    expect(provider).toBeDefined()
    expect(Object.keys(provider!.models).sort()).toEqual(
      [...expectedModelIds].sort(),
    )
    expect(provider?.whitelist).toEqual([...expectedModelIds])
    const serializedProvider = JSON.parse(JSON.stringify(provider))
    expect(Object.keys(serializedProvider.models).sort()).toEqual(
      RELEASE_MODEL_IDS,
    )
    expect([...serializedProvider.whitelist].sort()).toEqual(RELEASE_MODEL_IDS)

    // Each model definition matches the core registry values.
    for (const id of expectedModelIds) {
      expect(provider?.models[id]).toBe(OPENCODE_MODEL_DEFINITIONS[id])
    }

    // Existing providers and commands are preserved alongside the additions.
    const finalConfig = opencodeConfig as unknown as {
      provider?: Record<string, { models: Record<string, unknown> }>
      command?: Record<string, unknown>
    }
    expect(finalConfig.provider?.['other-provider']?.models).toEqual({
      foo: { name: 'foo' },
    })
    expect(finalConfig.command?.existing).toEqual({
      template: 'existing',
      description: 'pre-existing',
    })

    // Exactly one command is added beside the host's: /antigravity, which
    // opens the shared menu. The retired /gemini-dump alias is not
    // registered; the request dump switch lives in the menu's Diagnostics.
    expect(Object.keys(finalConfig.command ?? {}).sort()).toEqual(
      [ANTIGRAVITY_MENU_COMMAND, 'existing'].sort(),
    )
    const menuCommand = finalConfig.command?.[ANTIGRAVITY_MENU_COMMAND] as
      | { template: string; description: string }
      | undefined
    expect(menuCommand?.template).toBe(ANTIGRAVITY_MENU_COMMAND)
  })

  it('command.execute.before leaves other commands, the retired gemini-dump included, to the host', async () => {
    const client = createMinimalClient()
    const ctx = createPluginInput(client, tempProjectDir)
    plugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(ctx)

    // Non-matching command is a no-op — must return without throwing.
    await expect(
      plugin['command.execute.before']?.(
        { command: 'unrelated-command', arguments: '', sessionID: 'ses_test' },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()

    // The retired /gemini-dump name is no longer handled here either.
    await expect(
      plugin['command.execute.before']?.(
        {
          command: GEMINI_DUMP_COMMAND_NAME,
          arguments: 'status',
          sessionID: 'ses_test',
        },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()
  })
})

describe('package root exports', () => {
  it('exports only the two plugin factory aliases', () => {
    expect(Object.keys(packageRoot).sort()).toEqual([
      'AntigravityCLIOAuthPlugin',
      'GoogleOAuthPlugin',
    ])
    expect('authorizeAntigravity' in packageRoot).toBe(false)
    expect('exchangeAntigravity' in packageRoot).toBe(false)
  })
})

it('a real default background quota tick leaves an unmigrated pool and account-state sidecars untouched', async () => {
  const owned = realpathSync(mkdtempSync('/tmp/agy-unmigrated-tick-'))
  const overrides = {
    OPENCODE_CONFIG_DIR: join(owned, 'config'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(owned, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(owned, 'sidebar-state.json'),
  }
  const prior = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, overrides)
  mkdirSync(overrides.OPENCODE_CONFIG_DIR)
  const pool = getStoragePath()
  const bytes = JSON.stringify({
    version: 4,
    accounts: [{ refreshToken: 'synthetic-refresh', addedAt: 1, lastUsed: 1 }],
    activeIndex: 0,
  })
  writeFileSync(pool, bytes, { mode: 0o600 })
  const sidebarBytes =
    '{"version":1,"checkedAt":0,"accounts":[],"routingAuthoritative":false,"activeRouting":{}}'
  const upstream = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('not-found', { status: 404 }),
  )
  const transport = mock(
    async () => new Response('unexpected physical send', { status: 500 }),
  )
  const { watcher, changes, ready, sidebarSeedObserved, finish } =
    watchSidebarFixture(owned)
  const originalTimer = globalThis.setTimeout
  let timerSpy: ReturnType<typeof spyOn> | undefined
  let poller: BackgroundQuotaRefresh | undefined
  let tickDone: () => void = () => {}
  const tick = new Promise<void>((done) => {
    tickDone = done
  })
  let plugin:
    | Awaited<ReturnType<ReturnType<typeof createAntigravityPlugin>>>
    | undefined
  try {
    await ready
    // Observe the single seed and finish its event batch before plugin creation.
    writeFileSync(overrides.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE, sidebarBytes, {
      mode: 0o600,
    })
    await sidebarSeedObserved
    await new Promise<void>((done) => setImmediate(done))
    expect(changes).toContain('sidebar-state.json')
    changes.length = 0
    plugin = await createAntigravityPlugin('google', {
      dependencies: {
        agyTransport: transport,
        clock: { now: () => Date.now(), random: () => 0 },
      },
      _onPollerCreated(value) {
        poller = value
        // Wait for the background quota poller's next scheduled tick so its
        // current tick finishes asynchronous admission and account-state lock
        // work before disposal.
        timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
          handler: (...args: unknown[]) => void,
          delay: number,
          ...args: unknown[]
        ) => {
          if (delay === 300000) {
            timerSpy?.mockRestore()
            tickDone()
          }
          return originalTimer(() => {
            handler(...args)
          }, delay)
        }) as typeof setTimeout)
      },
    })(createPluginInput(createMinimalClient(), owned))
    expect(poller).toBeDefined()
    await tick
    await new Promise<void>((done) => setImmediate(done))
    await poller!.dispose()
    await plugin.dispose?.()
    await finish()
    expect(changes).toEqual([])
    expect(readFileSync(pool, 'utf8')).toBe(bytes)
    expect(
      readFileSync(overrides.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE, 'utf8'),
    ).toBe(sidebarBytes)
    expect(
      readdirSync(owned).filter((name) => name.startsWith('sidebar-state')),
    ).toEqual(['sidebar-state.json'])
    expect(
      readdirSync(overrides.OPENCODE_CONFIG_DIR).filter((name) =>
        name.startsWith('antigravity-accounts'),
      ),
    ).toEqual(['antigravity-accounts.json'])
    expect(transport).not.toHaveBeenCalled()
    expect(
      upstream.mock.calls.filter(([input]) =>
        /oauth2|cloudcode|generativelanguage/.test(String(input)),
      ),
    ).toEqual([])
  } finally {
    timerSpy?.mockRestore()
    await plugin?.dispose?.()
    upstream.mockRestore()
    watcher.close()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(owned, { recursive: true, force: true })
  }
})

it('the production V1 entry opens the vault menu without opening or changing dormant local accounts', async () => {
  const owned = realpathSync(
    mkdtempSync(
      join(
        process.platform === 'win32' ? tmpdir() : '/tmp',
        'agy-v1-vault-entry-',
      ),
    ),
  )
  const overrides = {
    OPENCODE_CONFIG_DIR: join(owned, 'config'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(owned, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(owned, 'sidebar.json'),
  }
  const prior = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, overrides)
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('not-found', { status: 404 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
  )
  const accountFile = getStoragePath()
  mkdirSync(join(owned, 'config'), { recursive: true })
  const localBytes = JSON.stringify({
    version: 4,
    accounts: [
      {
        refreshToken: 'synthetic-dormant-refresh',
        projectId: 'synthetic-local-project',
        addedAt: 1,
        lastUsed: 1,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  })
  writeFileSync(accountFile, localBytes, { mode: 0o600 })
  // Seeded where a version before the move kept it, beside the account
  // file; the plugin moves it to the state home when it starts.
  const legacyVault = getVaultDir(accountFile)
  const seeding = createOpenCodeVaultCustody({
    vaultDir: legacyVault,
    accountFile,
    reporterSource: 'direct',
    readHostSlot: async () => {
      throw new Error('enrollment must not read the native login')
    },
    connectEnrollment: async () => ({
      enrollPropose: async () => ({ requestId: 'synthetic-request' }),
      enrollPoll: async () => ({
        status: 'approved' as const,
        name: OPENCODE_VAULT_ENROLLMENT_NAME,
        token: 'ab'.repeat(32),
        tokenGeneration: 1,
      }),
      close() {},
    }),
  })
  let dispose: (() => Promise<void> | void) | undefined
  try {
    expect((await seeding.requestAccess()).state).toBe('approved')
    const claustrum = await loadCommonAuthClaustrum()
    const paths = claustrum.hostEnrollmentPaths({
      stateDir: legacyVault,
      host: 'opencode',
    })
    unlinkSync(paths.tokenPath)
    const client = createMinimalClient()
    const plugin = await packageRoot.GoogleOAuthPlugin(
      createPluginInput(client, owned),
    )
    dispose = plugin.dispose
    expect(plugin.auth?.methods.map((method) => method.label)).toEqual([
      V1_VAULT_ACTIVATION_LABEL,
    ])
    const vaultLogin = plugin.auth?.methods[0]
    if (vaultLogin?.type !== 'oauth')
      throw new Error('the vault activation method is absent')
    const activation = await vaultLogin.authorize()
    expect(activation.url).toBe('')
    expect(activation.method).toBe('auto')
    await expect(
      plugin['command.execute.before']?.(
        {
          command: ANTIGRAVITY_MENU_COMMAND,
          arguments: '',
          sessionID: 'vault-entry-session',
        },
        { parts: [] },
      ),
    ).rejects.toThrow()
    const notifications = await drainNotifications(0, 'vault-entry-session')
    const serialized = JSON.stringify(notifications)
    expect(serialized).toContain('Vault')
    expect(serialized).toContain('Accounts')
    expect(serialized).not.toContain('synthetic-dormant-refresh')
    expect(serialized).not.toContain('synthetic-local-project')
    expect(serialized).not.toContain('migrate --offline')
    expect(readFileSync(accountFile, 'utf8')).toBe(localBytes)
    expect(client.auth.set).not.toHaveBeenCalled()
    expect(
      JSON.stringify(
        await claustrum.readClaustrumEnrollmentStatus(
          paths,
          OPENCODE_VAULT_ENROLLMENT_NAME,
        ),
      ),
    ).toContain('missing_token')
    await dispose?.()
    dispose = undefined
    expect(
      readFileSync(overrides.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE, 'utf8'),
    ).toContain(VAULT_ACCOUNT_REMEDY)
  } finally {
    await dispose?.()
    await seeding.dispose()
    fetchSpy.mockRestore()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(owned, { recursive: true, force: true })
  }
})

for (const direction of ['local to vault', 'vault to local'] as const) {
  it(`the production V1 RPC apply refreshes sections when switching ${direction}`, async () => {
    const owned = realpathSync(
      mkdtempSync(
        join(
          process.platform === 'win32' ? tmpdir() : '/tmp',
          'agy-v1-menu-switch-',
        ),
      ),
    )
    const daemon = await startMenuVaultFixture(owned)
    const overrides = {
      OPENCODE_CONFIG_DIR: join(owned, 'config'),
      // The plugin moves the vault files into the state home at start. Keep
      // it below this owner-only root: the vault library refuses to save a
      // token below a folder others can change, as a runner's TMPDIR may be.
      XDG_STATE_HOME: join(owned, 'state'),
      ANTIGRAVITY_AUTH_RPC_DIR: join(owned, 'rpc'),
      ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(owned, 'sidebar.json'),
      SUBC_CONNECTION_FILE: daemon.connectionFile,
    }
    const prior = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    )
    Object.assign(process.env, overrides)
    const realFetch = globalThis.fetch
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        (async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          )
          return url.hostname === '127.0.0.1'
            ? realFetch(input, init)
            : new Response('not-found', { status: 404 })
        }) as typeof fetch,
        { preconnect: realFetch.preconnect },
      ),
    )
    let dispose: (() => Promise<void> | void) | undefined
    // Seeded where a version before the move kept it, beside the account
    // file; the plugin moves it to the state home when it starts.
    const seeding = createOpenCodeVaultCustody({
      vaultDir: getVaultDir(getStoragePath()),
      accountFile: getStoragePath(),
      reporterSource: 'direct',
      readHostSlot: async () => undefined,
    })
    // Reads the vault folder the plugin settled, once it has started.
    let settled: ReturnType<typeof createOpenCodeVaultCustody> | undefined
    try {
      const accountFile = getStoragePath()
      const modules = await loadCommonAuthStoreModules()
      await initializeFreshAccountStore(modules, {
        legacyPath: accountFile,
        now: Date.now,
      })
      const admission = await readAccountStoreAdmission(
        accountFile,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const repository = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async () => {
          throw new Error(
            'Opening the menu must not exchange local credentials',
          )
        },
      })
      try {
        for (let index = 1; index <= 2; index++)
          await repository.login({
            id: crypto.randomUUID(),
            refreshToken: `synthetic-menu-local-${index}`,
            metadata: { addedAt: index, lastUsed: index },
          })
      } finally {
        await repository.dispose()
      }
      expect((await seeding.requestAccess()).state).toBe('pending')
      if (direction === 'vault to local') {
        daemon.approve()
        expect((await seeding.requestAccess()).state).toBe('approved')
      }
      expect(await seeding.readMode()).toMatchObject({
        ok: true,
        record: { mode: direction === 'local to vault' ? 'local' : 'custody' },
      })
      const client = createMinimalClient()
      const plugin = await packageRoot.GoogleOAuthPlugin(
        createPluginInput(client, owned),
      )
      dispose = plugin.dispose
      settled = createOpenCodeVaultCustody({
        vaultDir: getVaultDir(accountFile),
        accountFile,
        reporterSource: 'direct',
        readHostSlot: async () => undefined,
      })
      const sessionId = 'menu-switch-session'
      await expect(
        plugin['command.execute.before']?.(
          {
            command: ANTIGRAVITY_MENU_COMMAND,
            arguments: '',
            sessionID: sessionId,
          },
          { parts: [] },
        ),
      ).rejects.toThrow()
      const rpc = createRpcClient(
        overrides.ANTIGRAVITY_AUTH_RPC_DIR,
        process.pid,
      )
      const initial = JSON.stringify(
        await rpc.pendingNotifications(0, sessionId),
      )
      expect(initial).toContain(
        direction === 'local to vault'
          ? '2 accounts'
          : '1 account served from the vault',
      )
      daemon.approve()
      if (direction === 'vault to local') {
        await daemon.waitForUsage(true)
        expect(daemon.activeUsageConnections).toBeGreaterThan(0)
        daemon.expectUsageCancellation()
      }
      const result = await rpc.apply({
        command: ANTIGRAVITY_MENU_COMMAND,
        sectionId: 'vault',
        actionId:
          direction === 'local to vault' ? 'request-access' : 'use-local',
        sessionId,
      })
      const serialized = JSON.stringify(result)
      expect(result).toMatchObject({
        command: ANTIGRAVITY_MENU_COMMAND,
        ok: true,
        text:
          direction === 'local to vault'
            ? `Vault access: approved as ${OPENCODE_VAULT_ENROLLMENT_NAME}`
            : 'Done. Start a new request to use the change.',
      })
      expect(await settled.readMode()).toMatchObject({
        ok: true,
        record: { mode: direction === 'local to vault' ? 'custody' : 'local' },
      })
      expect(result).toMatchObject({
        menu: {
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: 'accounts',
              lines: expect.arrayContaining([
                expect.stringContaining(
                  direction === 'local to vault'
                    ? '1 account served from the vault'
                    : '2 accounts',
                ),
              ]),
            }),
          ]),
        },
      })
      if (direction === 'local to vault')
        expect(serialized).not.toContain('"title":"Sign in"')
      else expect(serialized).toContain('"title":"Sign in"')
      expect(daemon.calls).toContain('auth.enroll_poll')
      expect(daemon.calls).toContain('credential.list_scoped')
      if (direction === 'vault to local') {
        await daemon.waitForUsage(false)
        expect(daemon.activeUsageConnections).toBe(0)
        expect(daemon.usage.watches).toBeGreaterThan(0)
        expect(daemon.usage.closedWatches).toBe(daemon.usage.watches)
      }
      expect(daemon.errors).toEqual([])
      expect(await rpc.pendingNotifications(0, 'other-menu-session')).toEqual(
        [],
      )
      expect(client.auth.set).not.toHaveBeenCalled()
    } finally {
      await dispose?.()
      await settled?.dispose()
      await seeding.dispose()
      await daemon.close()
      fetchSpy.mockRestore()
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(owned, { recursive: true, force: true })
    }
  })
}
