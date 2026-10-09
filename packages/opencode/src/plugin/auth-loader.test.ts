import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountTokenExchange,
  AccountManager as CoreAccountManager,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
} from '@cortexkit/antigravity-auth-core'

import type { AccountManager } from './accounts'
import { createAuthLoader } from './auth-loader'
import { DEFAULT_CONFIG } from './config'
import { createPluginLifecycle, type PluginLifecycle } from './lifecycle'
import {
  createLocationProactiveRefreshQueue,
  type ProactiveRefreshDependencies,
  type ProactiveRefreshQueue,
} from './refresh-queue'
import { type AccountStorageV4, openAccountStore } from './storage'
import type { GetAuth, Provider } from './types'

function storedAccounts(): AccountStorageV4 {
  return {
    version: 4,
    activeIndex: 0,
    accounts: [
      {
        email: 'stored@example.com',
        refreshToken: 'stored-refresh',
        projectId: 'stored-project',
        managedProjectId: 'managed-project',
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
      },
    ],
  }
}

function createLifecycle() {
  const replacements: Array<{ manager: unknown; queue: unknown }> = []
  const disposables: Array<{ dispose(): Promise<void> | void }> = []
  const lifecycle: PluginLifecycle = {
    getAccountManager: () => null,
    replaceAccountRuntime: mock(async (manager, queue) => {
      replacements.push({ manager, queue })
    }),
    register: mock((disposable) => {
      disposables.push(disposable)
    }),
    dispose: mock(async () => {
      for (const disposable of disposables) await disposable.dispose()
    }),
  }
  return { lifecycle, replacements }
}

/** A location with neither a pool file nor an account store yet. */
const poolFileOnly = async () =>
  ({ status: 'initialization-required' }) as const

describe('createAuthLoader', () => {
  it('restores auth drift from storage before creating the account runtime', async () => {
    const authSet = mock(async () => {})
    const clearAccounts = mock(async () => {})
    const manager = {
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'stored@example.com',
          enabled: true,
          parts: { refreshToken: 'stored-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const { lifecycle, replacements } = createLifecycle()
    const createFetch = mock(() => ({
      fetch: mock(async () => new Response('ok')),
      dispose: mock(async () => {}),
    }))
    const loader = createAuthLoader({
      client: {
        auth: { set: authSet },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => storedAccounts()),
        clearAccounts,
        loadAccountManager: mock(async () => manager as never),
      },
    })
    const getAuth = mock(async () => undefined) as unknown as GetAuth

    const result = await loader(getAuth, {
      id: 'g',
      name: 'G',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    } as never)

    expect(result).toMatchObject({ apiKey: '' })
    expect(authSet).toHaveBeenCalledWith({
      path: { id: 'google' },
      body: {
        type: 'oauth',
        refresh: 'stored-refresh|stored-project|managed-project',
        access: '',
        expires: 0,
      },
    })
    expect(clearAccounts).not.toHaveBeenCalled()
    expect(replacements).toEqual([{ manager, queue: null }])
  })

  it('clears stale storage only when auth cannot be restored', async () => {
    const clearAccounts = mock(async () => {})
    const { lifecycle } = createLifecycle()
    const createFetch = mock(() => ({
      fetch: mock(async () => new Response('ok')),
      dispose: mock(async () => {}),
    }))
    const loader = createAuthLoader({
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => null),
        clearAccounts,
      },
    })

    const result = await loader(
      mock(async () => ({ type: 'api', key: 'not-oauth' })) as never,
      {
        id: 'g',
        name: 'G',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      } as never,
    )

    expect(result).toEqual({})
    expect(clearAccounts).toHaveBeenCalledTimes(1)
    expect(createFetch).not.toHaveBeenCalled()
  })

  it('zeros provider costs and replaces fetch and account runtimes on reload', async () => {
    const firstManager = {
      name: 'first',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'first@example.test',
          enabled: true,
          parts: { refreshToken: 'first-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const secondManager = {
      name: 'second',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'second@example.test',
          enabled: true,
          parts: { refreshToken: 'second-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const managers = [firstManager, secondManager]
    const firstDispose = mock(async () => {})
    const secondDispose = mock(async () => {})
    const fetchRuntimes = [
      {
        fetch: mock(async () => new Response('first')),
        dispose: firstDispose,
      },
      {
        fetch: mock(async () => new Response('second')),
        dispose: secondDispose,
      },
    ]
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: mock(() => {}) },
      shutdownDiskSignatureCache: mock(async () => {}),
      clearFetchState: mock(() => {}),
    })
    const createFetch = mock(() => fetchRuntimes.shift()!)
    const loader = createAuthLoader({
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => storedAccounts()),
        clearAccounts: mock(async () => {}),
        loadAccountManager: mock(async () => managers.shift() as never),
      },
    })
    const provider = {
      models: {
        alpha: { cost: { input: 9, output: 7 } },
        beta: { cost: { input: 3, output: 2 } },
      },
    } as unknown as Provider
    const getAuth = mock(async () => ({
      type: 'oauth' as const,
      refresh: 'stored-refresh|stored-project|managed-project',
      access: 'access',
      expires: 100,
    }))

    await loader(getAuth, provider)
    await loader(getAuth, provider)

    expect(provider.models?.alpha?.cost).toMatchObject({ input: 0, output: 0 })
    expect(provider.models?.beta?.cost).toMatchObject({ input: 0, output: 0 })
    expect(lifecycle.getAccountManager()).toBe(
      secondManager as unknown as AccountManager,
    )
    expect(firstManager.dispose).toHaveBeenCalledTimes(1)
    expect(secondManager.dispose).not.toHaveBeenCalled()
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(createFetch).toHaveBeenCalledWith({
      accountManager: secondManager,
      getAuth,
      source: { kind: 'pool-file' },
    })

    await lifecycle.dispose()
    expect(secondManager.dispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
  })

  it('returned fetch delegates to the live runtime after reload()', async () => {
    const firstFetch = mock(async () => new Response('first'))
    const secondFetch = mock(async () => new Response('second'))
    const firstDispose = mock(async () => {})
    const secondDispose = mock(async () => {})
    const managerA = {
      name: 'a',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'a@example.test',
          enabled: true,
          parts: { refreshToken: 'a-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const managerB = {
      name: 'b',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'b@example.test',
          enabled: true,
          parts: { refreshToken: 'b-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const managers = [managerA, managerB]
    const createFetch = mock(() => {
      const isFirst = createFetch.mock.calls.length === 1
      return {
        fetch: isFirst ? firstFetch : secondFetch,
        dispose: isFirst ? firstDispose : secondDispose,
      }
    })
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: mock(() => {}) },
      shutdownDiskSignatureCache: mock(async () => {}),
      clearFetchState: mock(() => {}),
    })
    const loader = createAuthLoader({
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => storedAccounts()),
        clearAccounts: mock(async () => {}),
        loadAccountManager: mock(async () => managers.shift() as never),
      },
    })
    const getAuth = mock(async () => ({
      type: 'oauth' as const,
      refresh: 'stored-refresh|stored-project|managed-project',
      access: 'access',
      expires: 100,
    })) as unknown as GetAuth

    const firstResult = (await loader(getAuth, {
      id: 'g',
      name: 'G',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    } as never)) as {
      fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
    }
    const liveFetch = firstResult.fetch

    await loader.reload(getAuth)

    const midResponse = await liveFetch('https://example.test/mid')
    expect(midResponse).toBeInstanceOf(Response)
    expect(firstFetch).not.toHaveBeenCalled()
    expect(secondFetch).toHaveBeenCalledTimes(1)
  })

  it('exposes load on the handle so contract consumers can read it', () => {
    const createFetch = mock(() => ({
      fetch: mock(async () => new Response('ok')),
      dispose: mock(async () => {}),
    }))
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: mock(() => {}) },
      shutdownDiskSignatureCache: mock(async () => {}),
      clearFetchState: mock(() => {}),
    })
    const loader = createAuthLoader({
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => null),
        clearAccounts: mock(async () => {}),
      },
    })
    expect(typeof loader.load).toBe('function')
    expect(loader.load).toBe(loader)
  })

  it('awaits prior runtime dispose before returning from reload()', async () => {
    let disposeFinished = false
    const firstDispose = mock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      disposeFinished = true
    })
    const firstManager = {
      name: 'first',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'first@example.test',
          enabled: true,
          parts: { refreshToken: 'first-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const secondManager = {
      name: 'second',
      getAccountCount: () => 1,
      getAccounts: () => [
        {
          index: 0,
          email: 'second@example.test',
          enabled: true,
          parts: { refreshToken: 'second-refresh' },
          cachedQuota: undefined,
        },
      ],
      requestSaveToDisk: mock(() => {}),
      getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
      dispose: mock(async () => {}),
    }
    const managers = [firstManager, secondManager]
    const secondDispose = mock(async () => {})
    const fetchRuntimes = [
      {
        fetch: mock(async () => new Response('first')),
        dispose: firstDispose,
      },
      {
        fetch: mock(async () => new Response('second')),
        dispose: secondDispose,
      },
    ]
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: mock(() => {}) },
      shutdownDiskSignatureCache: mock(async () => {}),
      clearFetchState: mock(() => {}),
    })
    const createFetch = mock(() => fetchRuntimes.shift()!)
    const loader = createAuthLoader({
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      createFetch,
      dependencies: {
        openAccountStore: poolFileOnly,
        loadAccounts: mock(async () => storedAccounts()),
        clearAccounts: mock(async () => {}),
        loadAccountManager: mock(async () => managers.shift() as never),
      },
    })
    const getAuth = mock(async () => ({
      type: 'oauth' as const,
      refresh: 'stored-refresh|stored-project|managed-project',
      access: 'access',
      expires: 100,
    })) as unknown as GetAuth

    await loader(getAuth, {
      id: 'g',
      name: 'G',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    } as never)

    const before = disposeFinished
    const reloadPromise = loader.reload(getAuth)
    // Without awaiting dispose, the reload promise returns before
    // the previous runtime's dispose has settled.
    expect(disposeFinished).toBe(before)
    await reloadPromise
    expect(disposeFinished).toBe(true)
  })
})

describe('createAuthLoader on the account store', () => {
  const provider = {
    id: 'g',
    name: 'G',
    source: 'custom',
    env: [],
    options: {},
    models: {},
  } as never

  async function activeStore(
    exchange: AccountTokenExchange = async () => {
      throw new Error('token exchange is not part of these tests')
    },
  ) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'auth-loader-store-')))
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
    const open = () =>
      openAccountStore({
        modules,
        createRepository: createAccountRepositoryFactory(modules),
        exchange,
        legacyPath,
      })
    const seeding = await open()
    if (seeding.status !== 'ready') throw new Error(seeding.status)
    await seeding.repository.login({
      id: crypto.randomUUID(),
      refreshToken: 'store-refresh',
      metadata: { email: 'store@example.com', addedAt: 1, lastUsed: 1 },
    })
    await seeding.repository.dispose()
    return { root, open }
  }

  it('routes with the core manager over the store and never reads the pool file', async () => {
    const { root, open } = await activeStore()
    try {
      const loadAccounts = mock(async () => {
        throw new Error('the retired pool file must not be read')
      })
      const clearAccounts = mock(async () => {})
      const { lifecycle, replacements } = createLifecycle()
      const managers: unknown[] = []
      const storeQueues: ProactiveRefreshQueue[] = []
      const loader = createAuthLoader({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: { ...DEFAULT_CONFIG, proactive_token_refresh: true },
        lifecycle,
        createFetch: ({ accountManager }) => {
          managers.push(accountManager)
          return { fetch: mock(async () => new Response('ok')), dispose() {} }
        },
        dependencies: {
          openAccountStore: open,
          loadAccounts,
          clearAccounts,
          createRefreshQueue: () => {
            throw new Error('the host-client queue must not run over the store')
          },
          createStoreRefreshQueue: (queueDependencies, queueConfig) => {
            const queue = createLocationProactiveRefreshQueue(
              queueDependencies,
              queueConfig,
            )
            storeQueues.push(queue)
            return queue
          },
        },
      })
      const result = await loader(
        mock(async () => ({
          type: 'oauth',
          refresh: 'host-refresh',
          access: '',
          expires: 0,
        })) as never,
        provider,
      )
      expect(result).toMatchObject({ apiKey: '' })
      expect(loadAccounts).not.toHaveBeenCalled()
      expect(clearAccounts).not.toHaveBeenCalled()
      const [manager] = managers
      expect(manager).toBeInstanceOf(CoreAccountManager)
      if (!(manager instanceof CoreAccountManager)) throw new Error('manager')
      expect(manager.getAccounts().map((account) => account.email)).toEqual([
        'store@example.com',
      ])
      // The pool-file (host-client) refresh queue never runs over a
      // store-backed manager; its proactive refresh is the store queue.
      expect(storeQueues).toHaveLength(1)
      expect(replacements).toEqual([{ manager, queue: storeQueues[0] }])
      await lifecycle.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refreshes proactively through the repository on the due account's own ref, never the host client", async () => {
    const exchanged: string[] = []
    const { root, open } = await activeStore(async ({ refreshToken }) => {
      exchanged.push(refreshToken)
      return {
        accessToken: `access-for-${refreshToken}`,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
      }
    })
    try {
      const authSet = mock(async () => {})
      const { lifecycle } = createLifecycle()
      const managers: CoreAccountManager[] = []
      const refreshers: ProactiveRefreshDependencies['refreshToken'][] = []
      const loader = createAuthLoader({
        client: {
          tui: { showToast: mock(async () => {}) },
          auth: { set: authSet },
        } as never,
        providerId: 'google',
        config: { ...DEFAULT_CONFIG, proactive_token_refresh: true },
        lifecycle,
        createFetch: ({ accountManager }) => {
          if (accountManager instanceof CoreAccountManager) {
            managers.push(accountManager)
          }
          return { fetch: mock(async () => new Response('ok')), dispose() {} }
        },
        dependencies: {
          openAccountStore: open,
          createStoreRefreshQueue: (queueDependencies, queueConfig) => {
            refreshers.push(queueDependencies.refreshToken)
            return createLocationProactiveRefreshQueue(queueDependencies, {
              ...queueConfig,
              enabled: false,
            })
          },
        },
      })
      await loader(
        mock(async () => ({
          type: 'oauth',
          refresh: 'host-refresh',
          access: '',
          expires: 0,
        })) as never,
        provider,
      )
      const [manager] = managers
      const [refresh] = refreshers
      const account = manager?.getAccounts()[0]
      if (!manager || !refresh || !account) throw new Error('not loaded')

      const refreshed = await refresh(manager.toAuthDetails(account), account)
      expect(refreshed?.access).toBe('access-for-store-refresh')
      expect(exchanged).toEqual(['store-refresh'])
      expect(account.access).toBe('access-for-store-refresh')
      expect(authSet).not.toHaveBeenCalled()
      await lifecycle.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the store only for a genuinely fresh location, and never over a pool file', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'auth-loader-fresh-')))
    try {
      const legacyPath = join(root, 'antigravity-accounts.json')
      const modules = await loadCommonAuthStoreModules()
      const open = () =>
        openAccountStore({
          modules,
          createRepository: createAccountRepositoryFactory(modules),
          exchange: async () => {
            throw new Error('no exchange')
          },
          legacyPath,
        })
      const initializations: string[] = []
      const { lifecycle } = createLifecycle()
      const loader = createAuthLoader({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: DEFAULT_CONFIG,
        lifecycle,
        createFetch: () => ({
          fetch: mock(async () => new Response()),
          dispose() {},
        }),
        dependencies: {
          openAccountStore: open,
          initializeFreshStore: async () => {
            initializations.push(legacyPath)
            return initializeFreshAccountStore(modules, {
              legacyPath,
              now: Date.now,
            })
          },
        },
      })
      expect((await loader.accountStore()).status).toBe(
        'initialization-required',
      )
      const opened = await loader.initializeFreshStore()
      expect(opened.status).toBe('ready')
      // Already initialized: the ready opening is returned, nothing redone.
      expect((await loader.initializeFreshStore()).status).toBe('ready')
      expect(initializations).toHaveLength(1)
      await lifecycle.dispose()

      // A location with a pool file is migrated offline, never initialized.
      const other = realpathSync(
        mkdtempSync(join(tmpdir(), 'auth-loader-pool-')),
      )
      try {
        const otherLegacy = join(other, 'antigravity-accounts.json')
        writeFileSync(
          otherLegacy,
          '{"version":4,"accounts":[],"activeIndex":0}',
          {
            mode: 0o600,
          },
        )
        const initialize = mock(async () => ({ status: 'completed' }))
        const poolLoader = createAuthLoader({
          client: { tui: { showToast: mock(async () => {}) } } as never,
          providerId: 'google',
          config: DEFAULT_CONFIG,
          lifecycle: createLifecycle().lifecycle,
          createFetch: () => ({
            fetch: mock(async () => new Response()),
            dispose() {},
          }),
          dependencies: {
            openAccountStore: () =>
              openAccountStore({
                modules,
                createRepository: createAccountRepositoryFactory(modules),
                exchange: async () => {
                  throw new Error('no exchange')
                },
                legacyPath: otherLegacy,
              }),
            initializeFreshStore: initialize,
          },
        })
        expect((await poolLoader.initializeFreshStore()).status).toBe(
          'migration-required',
        )
        expect(initialize).not.toHaveBeenCalled()
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the store untouched when the host holds no sign-in', async () => {
    const { root, open } = await activeStore()
    try {
      const clearAccounts = mock(async () => {})
      const { lifecycle, replacements } = createLifecycle()
      const loader = createAuthLoader({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: DEFAULT_CONFIG,
        lifecycle,
        createFetch: () => ({
          fetch: mock(async () => new Response()),
          dispose() {},
        }),
        dependencies: { openAccountStore: open, clearAccounts },
      })
      expect(
        await loader(mock(async () => undefined) as never, provider),
      ).toEqual({})
      expect(clearAccounts).not.toHaveBeenCalled()
      expect(replacements).toEqual([])
      await lifecycle.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to serve a bound generation with interrupted repository work, without the pool file', async () => {
    const loadAccounts = mock(async () => null)
    const clearAccounts = mock(async () => {})
    const { lifecycle, replacements } = createLifecycle()
    const loader = createAuthLoader({
      client: { tui: { showToast: mock(async () => {}) } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      createFetch: () => ({
        fetch: mock(async () => new Response()),
        dispose() {},
      }),
      dependencies: {
        openAccountStore: async () =>
          ({
            status: 'recovery-required',
            binding: { status: 'bound' },
            message: 'finish the interrupted operation',
          }) as never,
        loadAccounts,
        clearAccounts,
      },
    })
    await expect(
      loader(
        mock(async () => ({
          type: 'oauth',
          refresh: 'host-refresh',
          access: '',
          expires: 0,
        })) as never,
        provider,
      ),
    ).rejects.toThrow('finish the interrupted operation')
    expect(loadAccounts).not.toHaveBeenCalled()
    expect(clearAccounts).not.toHaveBeenCalled()
    expect(replacements).toEqual([])
    expect(
      loader.usesPoolFile({ status: 'migration-required', message: '' }),
    ).toBe(true)
  })

  it('refuses to start while a migration is pending, without falling back to the pool file', async () => {
    const loadAccounts = mock(async () => null)
    const showToast = mock(async () => {})
    const { lifecycle, replacements } = createLifecycle()
    const loader = createAuthLoader({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      createFetch: () => ({
        fetch: mock(async () => new Response()),
        dispose() {},
      }),
      dependencies: {
        openAccountStore: async () => ({
          status: 'refused',
          admission: {
            status: 'pending',
            phase: 'build',
            operation: 'migrate',
          },
          message: 'finish the migration offline',
        }),
        loadAccounts,
      },
    })
    await expect(
      loader(
        mock(async () => ({
          type: 'oauth',
          refresh: 'host-refresh',
          access: '',
          expires: 0,
        })) as never,
        provider,
      ),
    ).rejects.toThrow('finish the migration offline')
    expect(loadAccounts).not.toHaveBeenCalled()
    expect(replacements).toEqual([])
    expect(showToast).toHaveBeenCalled()
  })
})
