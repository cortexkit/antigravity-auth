import { describe, expect, it, mock } from 'bun:test'

import type { AccountManager } from './accounts'
import { createAuthLoader } from './auth-loader'
import { DEFAULT_CONFIG } from './config'
import { createPluginLifecycle, type PluginLifecycle } from './lifecycle'
import type { AccountStorageV4 } from './storage'
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
    })

    await lifecycle.dispose()
    expect(secondManager.dispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
  })
})
