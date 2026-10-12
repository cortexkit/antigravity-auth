import { describe, expect, it, mock, spyOn } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountTokenExchange,
  AccountManager as CoreAccountManager,
  createAccountRepositoryFactory,
  type EnrollmentAuthority,
  enrollmentAuthority,
  initializeFreshAccountStore,
  loadCommonAuthClaustrum,
  loadCommonAuthStoreModules,
} from '@cortexkit/antigravity-auth-core'
import { createOpencodeClient } from '@opencode-ai/sdk'

import { AccountManager } from './accounts'
import { createAuthLoader } from './auth-loader'
import { DEFAULT_CONFIG } from './config'
import { createPluginLifecycle, type PluginLifecycle } from './lifecycle'
import {
  createLocationProactiveRefreshQueue,
  type ProactiveRefreshDependencies,
  ProactiveRefreshQueue,
} from './refresh-queue'
import { type AccountStorageV4, openAccountStore } from './storage'
import type { GetAuth, Provider } from './types'
import { createV1VaultActivationMethod } from './vault-activation'

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
  let closing = false
  const lifecycle: PluginLifecycle = {
    getAccountManager: () => null,
    isClosing: () => closing,
    replaceAccountRuntime: mock(async (manager, queue) => {
      replacements.push({ manager, queue })
      return true
    }),
    register: mock((disposable) => {
      disposables.push(disposable)
    }),
    dispose: mock(async () => {
      closing = true
      for (const disposable of disposables) await disposable.dispose()
    }),
  }
  return { lifecycle, replacements }
}

function createOwnedLifecycle() {
  const replacements: Array<{ manager: unknown; queue: unknown }> = []
  const lifecycle = createPluginLifecycle({
    sessionRegistry: { clear() {} },
    shutdownDiskSignatureCache: async () => {},
    clearFetchState() {},
  })
  const replace = lifecycle.replaceAccountRuntime.bind(lifecycle)
  lifecycle.replaceAccountRuntime = async (manager, queue, requests) => {
    replacements.push({ manager, queue })
    return replace(manager, queue, requests)
  }
  return { lifecycle, replacements }
}

/** A promise with its resolver, for holding and observing one step. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A location with neither a pool file nor an account store yet. */
const poolFileOnly = async () =>
  ({ status: 'initialization-required' }) as const

describe('createAuthLoader', () => {
  it('keeps an unmigrated local target unavailable with default producers, preserves passthrough and cancellation, and delegates fresh vault authority', async () => {
    const { lifecycle, replacements } = createOwnedLifecycle()
    const loadAccounts = mock(async () => storedAccounts())
    const clearAccounts = mock(async () => {})
    const loadAccountManager = mock(async () => {
      throw new Error('unmigrated manager constructed')
    })
    const createRefreshQueue = mock(() => {
      throw new Error('unmigrated queue constructed')
    })
    const createFetch = mock(() => {
      throw new Error('unmigrated interceptor constructed')
    })
    const openAccountStore = mock(
      async () =>
        ({
          status: 'migration-required',
          message: 'not a trusted request message',
        }) as const,
    )
    const vaultFetch = mock(async () => new Response('approved-vault'))
    const passthrough = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unrelated-response'),
    )
    let authority: EnrollmentAuthority = 'local'
    const getAuth = mock(async () => ({
      type: 'oauth' as const,
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3600000,
    }))
    const loader = createAuthLoader({
      client: { tui: { showToast: mock(async () => {}) } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle,
      readAuthority: async () => authority,
      createFetch,
      createVaultFetch: async () => ({ fetch: vaultFetch, dispose() {} }),
      dependencies: {
        openAccountStore,
        loadAccounts,
        clearAccounts,
        loadAccountManager,
        createRefreshQueue,
        isDebugEnabled: () => false,
      },
    })
    try {
      const loaded = await loader(getAuth, { models: {} } as never)
      if (typeof loaded.fetch !== 'function')
        throw new Error('no delegating fetch')
      for (const input of [
        'https://generativelanguage.googleapis.com/v1/models/test:streamGenerateContent',
        new URL(
          'https://generativelanguage.googleapis.com/v1/models/test:streamGenerateContent',
        ),
        new Request(
          'https://generativelanguage.googleapis.com/v1/models/test:streamGenerateContent',
        ),
      ]) {
        const response = await loaded.fetch(input)
        expect(response.status).toBe(412)
        expect(await response.json()).toEqual({
          error: {
            code: 412,
            status: 'FAILED_PRECONDITION',
            message:
              'Antigravity accounts require offline migration. Stop OpenCode, then run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`.',
          },
        })
      }
      expect(passthrough).not.toHaveBeenCalled()
      const init = { headers: { 'x-test': 'unchanged' } }
      expect(
        await (
          await loaded.fetch('https://example.invalid/non-generative', init)
        ).text(),
      ).toBe('unrelated-response')
      expect(passthrough).toHaveBeenCalledWith(
        'https://example.invalid/non-generative',
        init,
      )
      const abort = new AbortController()
      const cancellation = new Error('caller-cancelled')
      abort.abort(cancellation)
      await expect(
        loaded.fetch('https://generativelanguage.googleapis.com/example', {
          signal: abort.signal,
        }),
      ).rejects.toBe(cancellation)
      await expect(
        loaded.fetch(
          new Request('https://generativelanguage.googleapis.com/example', {
            signal: abort.signal,
          }),
        ),
      ).rejects.toBe(cancellation)
      await loader.reload(getAuth)
      authority = 'vault'
      expect(
        await (
          await loaded.fetch(
            'https://generativelanguage.googleapis.com/example',
          )
        ).text(),
      ).toBe('approved-vault')
      expect(vaultFetch).toHaveBeenCalledTimes(1)
      authority = 'local'
      expect(
        (
          await loaded.fetch(
            'https://generativelanguage.googleapis.com/example',
          )
        ).status,
      ).toBe(412)
      expect(openAccountStore).toHaveBeenCalledTimes(1)
      expect(loadAccounts).not.toHaveBeenCalled()
      expect(clearAccounts).not.toHaveBeenCalled()
      expect(loadAccountManager).not.toHaveBeenCalled()
      expect(createRefreshQueue).not.toHaveBeenCalled()
      expect(createFetch).not.toHaveBeenCalled()
      expect(replacements).toEqual([])
      await lifecycle.dispose()
      await expect(
        loaded.fetch('https://generativelanguage.googleapis.com/example'),
      ).rejects.toThrow('The account loader is disposed')
    } finally {
      passthrough.mockRestore()
      await lifecycle.dispose()
    }
  })
  for (const heldDrain of ['request', 'queue'] as const) {
    it(`refuses new vault admission while final shutdown holds the ${heldDrain} drain`, async () => {
      const requestHeld = deferred()
      const queueHeld = deferred()
      const events: string[] = []
      const { lifecycle } = createOwnedLifecycle()
      const manager = new AccountManager()
      manager.dispose = mock(async () => {
        events.push('manager:dispose')
      })
      const client = createOpencodeClient({
        fetch: async () => {
          events.push('host:mutation')
          throw new Error('No host I/O is allowed')
        },
      })
      const queue = new ProactiveRefreshQueue(client, 'google')
      queue.dispose = mock(async () => {
        events.push('queue:stop')
        await queueHeld.promise
        events.push('queue:drained')
      })
      const requestDispose = mock(async () => {
        events.push('request:abort')
        await requestHeld.promise
        events.push('request:drained')
      })
      await lifecycle.replaceAccountRuntime(manager, queue, {
        retire: async () => {},
        dispose: requestDispose,
      })
      const getAuth: GetAuth = mock(async () => {
        throw new Error('Native auth must stay unread')
      })
      const readAuthority = mock(async () => 'vault' as const)
      const localConstruction = mock(() => {
        throw new Error('Local source must stay unconstructed')
      })
      const vaultSend = mock(async () => {
        events.push('vault:mutation')
        return new Response('late-vault-send')
      })
      const vaultConstruction = mock(async () => ({
        fetch: vaultSend,
        dispose: mock(async () => {}),
      }))
      const openStore = mock(poolFileOnly)
      const loadAccounts = mock(async () => storedAccounts())
      const clearAccounts = mock(async () => {})
      const publishSidebar = mock(async () => {})
      const loader = createAuthLoader({
        client,
        providerId: 'google',
        config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
        lifecycle,
        readAuthority,
        createFetch: localConstruction,
        createVaultFetch: vaultConstruction,
        publishSidebar,
        dependencies: {
          openAccountStore: openStore,
          loadAccounts,
          clearAccounts,
          isDebugEnabled: () => false,
        },
      })
      const provider: Provider = {
        id: 'google',
        name: 'Google',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      }
      const result = await loader(getAuth, provider)
      if (!('fetch' in result) || typeof result.fetch !== 'function')
        throw new Error('No delegating fetch returned')
      readAuthority.mockClear()
      let finished = false
      const disposal = Promise.resolve(lifecycle.dispose()).then(() => {
        finished = true
      })
      try {
        expect(events).toEqual(['request:abort', 'queue:stop'])
        expect(requestDispose).toHaveBeenCalledTimes(1)
        expect(queue.dispose).toHaveBeenCalledTimes(1)
        // Release the other drain so each case proves that its named drain
        // alone keeps the producer's close hook from running.
        if (heldDrain === 'request') queueHeld.resolve()
        else requestHeld.resolve()
        await Promise.resolve()
        expect(finished).toBe(false)
        expect(manager.dispose).not.toHaveBeenCalled()
        await expect(result.fetch('https://example.test/new')).rejects.toThrow(
          'The account loader is disposed',
        )
        await expect(loader.load(getAuth, provider)).rejects.toThrow(
          'The account loader is disposed',
        )
        await expect(loader.reload(getAuth)).rejects.toThrow(
          'The account loader is disposed',
        )
        expect(readAuthority).not.toHaveBeenCalled()
        expect(getAuth).not.toHaveBeenCalled()
        expect(openStore).not.toHaveBeenCalled()
        expect(loadAccounts).not.toHaveBeenCalled()
        expect(clearAccounts).not.toHaveBeenCalled()
        expect(localConstruction).not.toHaveBeenCalled()
        expect(vaultConstruction).not.toHaveBeenCalled()
        expect(vaultSend).not.toHaveBeenCalled()
        expect(publishSidebar).not.toHaveBeenCalled()
      } finally {
        requestHeld.resolve()
        queueHeld.resolve()
        await disposal
      }
      expect(finished).toBe(true)
      expect(events).not.toContain('vault:mutation')
      expect(events).not.toContain('host:mutation')
      expect(events.at(-1)).toBe('manager:dispose')
    })
  }

  for (const seam of [
    'fetch authority',
    'load authority',
    'reload authority',
    'vault construction',
  ] as const) {
    it(`refuses admission after awaiting ${seam} while final shutdown still drains`, async () => {
      const drain = deferred()
      const entered = deferred()
      const awaited = deferred<EnrollmentAuthority>()
      const { lifecycle } = createOwnedLifecycle()
      const manager = new AccountManager()
      const managerDispose = mock(async () => {})
      manager.dispose = managerDispose
      await lifecycle.replaceAccountRuntime(manager, null, {
        retire: async () => {},
        dispose: () => drain.promise,
      })
      let holdAuthority = false
      const readAuthority = mock(async () => {
        if (holdAuthority) {
          entered.resolve()
          return awaited.promise
        }
        return 'vault' as const
      })
      const getAuth: GetAuth = mock(async () => {
        throw new Error('Native auth must stay unread')
      })
      const vaultSend = mock(async () => new Response('late-send'))
      const vaultDispose = mock(async () => {})
      const vaultConstruction = mock(async () => {
        if (seam === 'vault construction') {
          entered.resolve()
          await awaited.promise
        }
        return { fetch: vaultSend, dispose: vaultDispose }
      })
      const localConstruction = mock(() => {
        throw new Error('Local source must stay unconstructed')
      })
      const loader = createAuthLoader({
        client: createOpencodeClient(),
        providerId: 'google',
        config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
        lifecycle,
        readAuthority,
        createFetch: localConstruction,
        createVaultFetch: vaultConstruction,
        dependencies: { isDebugEnabled: () => false },
      })
      const provider: Provider = {
        id: 'google',
        name: 'Google',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      }
      const loaded = await loader(getAuth, provider)
      if (typeof loaded.fetch !== 'function') throw new Error('No fetch')
      holdAuthority = seam !== 'vault construction'
      const pending =
        seam === 'load authority'
          ? loader.load(getAuth, provider)
          : seam === 'reload authority'
            ? loader.reload(getAuth)
            : loaded.fetch('https://example.test/pending')
      // Handle a rejection while the admission is held; assert it only after
      // releasing the gate because Bun's matcher can wait synchronously.
      void pending.catch(() => {})
      await entered.promise
      let finished = false
      const disposal = Promise.resolve(lifecycle.dispose()).then(() => {
        finished = true
      })
      try {
        expect(finished).toBe(false)
        expect(managerDispose).not.toHaveBeenCalled()
        awaited.resolve(
          seam === 'load authority' || seam === 'reload authority'
            ? 'local'
            : 'vault',
        )
        await expect(pending).rejects.toThrow('The account loader is disposed')
        expect(finished).toBe(false)
        expect(getAuth).not.toHaveBeenCalled()
        expect(localConstruction).not.toHaveBeenCalled()
        expect(vaultConstruction).toHaveBeenCalledTimes(
          seam === 'vault construction' ? 1 : 0,
        )
        expect(vaultSend).not.toHaveBeenCalled()
        expect(vaultDispose).not.toHaveBeenCalled()
      } finally {
        awaited.resolve('vault')
        drain.resolve()
        await disposal
      }
      expect(managerDispose).toHaveBeenCalledTimes(1)
      expect(vaultDispose).toHaveBeenCalledTimes(
        seam === 'vault construction' ? 1 : 0,
      )
    })
  }

  it('serves a fresh vault activation without reading native auth, then refuses its marker after disconnect without touching local files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v1-vault-roundtrip-'))
    const nativeFile = join(root, 'auth.json')
    const localFile = join(root, 'accounts.json')
    const localBytes = JSON.stringify(storedAccounts())
    writeFileSync(localFile, localBytes)
    let authority: EnrollmentAuthority = 'vault'
    let nativeReads = 0
    const { lifecycle } = createLifecycle()
    const openStore = mock(async () => {
      throw new Error('Local store must stay unopened')
    })
    const loadAccounts = mock(async () => {
      throw new Error('Legacy pool must stay unread')
    })
    const clearAccounts = mock(async () => {})
    const authSet = mock(async () => {})
    const vaultSend = mock(async () => new Response('synthetic-vault-response'))
    const loader = createAuthLoader({
      client: {
        auth: { set: authSet },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      readAuthority: async () => authority,
      createFetch: () => {
        throw new Error('No local executor should be constructed')
      },
      createVaultFetch: async () => ({
        fetch: vaultSend,
        dispose: async () => {},
      }),
      dependencies: {
        openAccountStore: openStore,
        loadAccounts,
        clearAccounts,
      },
    })
    try {
      const method = createV1VaultActivationMethod({
        providerId: 'google',
        readAuthority: async () => authority,
        authFile: () => nativeFile,
      })
      if (method.type !== 'oauth') throw new Error('Expected OAuth envelope')
      const activation = await method.authorize()
      if (activation.method !== 'auto')
        throw new Error('Expected automatic activation')
      const answer = await activation.callback()
      expect(answer.type).toBe('success')
      const claustrum = await loadCommonAuthClaustrum()
      expect(answer).toEqual({
        ...claustrum.custodyPlaceholder('google'),
        type: 'success',
      })
      // Model the host's persistence of the callback result in an owned file;
      // this test does not claim to execute OpenCode's native auth UI.
      writeFileSync(
        nativeFile,
        JSON.stringify({ google: claustrum.custodyPlaceholder('google') }),
      )
      const nativeBytes = readFileSync(nativeFile, 'utf8')
      const getAuth: GetAuth = async () => {
        nativeReads++
        return claustrum.custodyPlaceholder('google')
      }
      const result = await loader(getAuth, {
        id: 'google',
        name: 'Google',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      } as never)
      if (!('fetch' in result) || typeof result.fetch !== 'function')
        throw new Error('No vault fetch returned')
      expect(
        await (
          await result.fetch(
            'https://generativelanguage.googleapis.com/synthetic',
          )
        ).text(),
      ).toBe('synthetic-vault-response')
      expect(nativeReads).toBe(0)
      expect(vaultSend).toHaveBeenCalledTimes(1)
      authority = 'local'
      await expect(
        result.fetch('https://generativelanguage.googleapis.com/synthetic'),
      ).rejects.toThrow('sign in')
      expect(vaultSend).toHaveBeenCalledTimes(1)
      expect(openStore).not.toHaveBeenCalled()
      expect(loadAccounts).not.toHaveBeenCalled()
      expect(clearAccounts).not.toHaveBeenCalled()
      expect(authSet).not.toHaveBeenCalled()
      expect(readFileSync(nativeFile, 'utf8')).toBe(nativeBytes)
      expect(readFileSync(localFile, 'utf8')).toBe(localBytes)
    } finally {
      await lifecycle.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
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
      retire: mock(async () => {}),
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
      retire: mock(async () => {}),
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
    const firstManagerDisposed = deferred()
    firstManager.dispose = mock(async () => {
      firstManagerDisposed.resolve()
    })
    const firstRetired = deferred()
    const firstRetire = mock(() => firstRetired.promise)
    const firstDispose = mock(async () => {})
    const secondRetire = mock(async () => {})
    const secondDispose = mock(async () => {})
    const fetchRuntimes = [
      {
        fetch: mock(async () => new Response('first')),
        retire: firstRetire,
        dispose: firstDispose,
      },
      {
        fetch: mock(async () => new Response('second')),
        retire: secondRetire,
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

    try {
      await loader(getAuth, provider)
      await loader(getAuth, provider)

      expect(provider.models?.alpha?.cost).toMatchObject({
        input: 0,
        output: 0,
      })
      expect(provider.models?.beta?.cost).toMatchObject({
        input: 0,
        output: 0,
      })
      expect(lifecycle.getAccountManager()).toBe(
        secondManager as unknown as AccountManager,
      )
      expect(createFetch).toHaveBeenCalledWith({
        accountManager: secondManager,
        getAuth,
        source: { kind: 'pool-file' },
      })
      // The replaced runtime is retired, not aborted, and its manager stays
      // open until that retirement finishes.
      expect(firstRetire).toHaveBeenCalledTimes(1)
      expect(firstDispose).not.toHaveBeenCalled()
      expect(firstManager.dispose).not.toHaveBeenCalled()
      firstRetired.resolve()
      await firstManagerDisposed.promise
      expect(firstManager.dispose).toHaveBeenCalledTimes(1)
      expect(secondManager.dispose).not.toHaveBeenCalled()

      await lifecycle.dispose()
      expect(secondManager.dispose).toHaveBeenCalledTimes(1)
      expect(secondDispose).toHaveBeenCalledTimes(1)
      expect(secondRetire).not.toHaveBeenCalled()
    } finally {
      firstRetired.resolve()
      await lifecycle.dispose()
    }
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
        retire: mock(async () => {}),
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
      retire: mock(async () => {}),
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

  it('returns from reload() without waiting for the replaced runtime to finish its admitted requests', async () => {
    // The replaced runtime is retired: its admitted requests may run for
    // minutes, so reload() must not wait for them, and must not abort them.
    const firstRetired = deferred()
    const firstRetire = mock(() => firstRetired.promise)
    const firstDispose = mock(async () => {})
    const firstManagerDisposed = deferred()
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
      dispose: mock(async () => {
        firstManagerDisposed.resolve()
      }),
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
        retire: firstRetire,
        dispose: firstDispose,
      },
      {
        fetch: mock(async () => new Response('second')),
        retire: mock(async () => {}),
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

    try {
      await loader(getAuth, {
        id: 'g',
        name: 'G',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      } as never)

      await loader.reload(getAuth)
      expect(firstRetire).toHaveBeenCalledTimes(1)
      expect(firstDispose).not.toHaveBeenCalled()
      expect(firstManager.dispose).not.toHaveBeenCalled()

      firstRetired.resolve()
      await firstManagerDisposed.promise
      expect(firstManager.dispose).toHaveBeenCalledTimes(1)
      expect(firstDispose).not.toHaveBeenCalled()
      expect(secondManager.dispose).not.toHaveBeenCalled()
    } finally {
      firstRetired.resolve()
      await lifecycle.dispose()
    }
    expect(secondDispose).toHaveBeenCalledTimes(1)
    expect(secondManager.dispose).toHaveBeenCalledTimes(1)
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
    const { lifecycle, replacements } = createOwnedLifecycle()
    try {
      const loadAccounts = mock(async () => {
        throw new Error('the retired pool file must not be read')
      })
      const clearAccounts = mock(async () => {})
      const managers: unknown[] = []
      const storeQueues: ProactiveRefreshQueue[] = []
      const loader = createAuthLoader({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: { ...DEFAULT_CONFIG, proactive_token_refresh: true },
        lifecycle,
        createFetch: ({ accountManager }) => {
          managers.push(accountManager)
          return {
            fetch: mock(async () => new Response('ok')),
            async retire() {},
            dispose() {},
          }
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
      expect(storeQueues[0]?.getStats().isRunning).toBe(false)
    } finally {
      await lifecycle.dispose()
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
    const { lifecycle } = createOwnedLifecycle()
    try {
      const authSet = mock(async () => {})
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
          return {
            fetch: mock(async () => new Response('ok')),
            async retire() {},
            dispose() {},
          }
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
      await lifecycle.dispose()
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
          async retire() {},
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
            async retire() {},
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
          async retire() {},
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
        async retire() {},
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
    ).toBe(false)
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
        async retire() {},
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

describe('enrollment authority at loader and request start', () => {
  it('serves public vault enrollment with a genuinely corrupt unused local store', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'corrupt-unused-store-')),
    )
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      clearFetchState() {},
      shutdownDiskSignatureCache: async () => {},
    })
    try {
      const modules = await loadCommonAuthStoreModules()
      const legacyPath = join(root, 'antigravity-accounts.json')
      await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
      const open = () =>
        openAccountStore({
          modules,
          createRepository: createAccountRepositoryFactory(modules),
          legacyPath,
          exchange: async () => {
            throw new Error('unused exchange')
          },
        })
      const seeded = await open()
      if (seeded.status !== 'ready') throw new Error(seeded.status)
      const corruptPath = seeded.admission.paths.configPath
      await seeded.repository.dispose()
      const corrupt = '{genuinely invalid local store config'
      writeFileSync(corruptPath, corrupt)
      expect((await open()).status).not.toBe('ready')
      const claustrum = await loadCommonAuthClaustrum()
      const paths = claustrum.hostEnrollmentPaths({
        stateDir: root,
        host: 'opencode',
      })
      const name = 'antigravity-auth-opencode'
      const manager = new claustrum.ClaustrumEnrollmentManager({
        paths,
        proposedName: name,
        client: {
          enrollPropose: async () => ({ requestId: 'synthetic-request' }),
          enrollPoll: async () => ({
            status: 'approved',
            name,
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }),
        },
      })
      expect((await manager.reconcile()).state).toBe('approved')
      const localOpen = mock(open)
      const loader = createAuthLoader({
        client: {} as never,
        providerId: 'google',
        config: DEFAULT_CONFIG,
        lifecycle,
        readAuthority: () => enrollmentAuthority(paths, name, claustrum),
        createFetch: () => {
          throw new Error('local runtime constructed')
        },
        createVaultFetch: async () => ({
          fetch: async () => new Response('vault-served'),
          dispose() {},
        }),
        dependencies: { openAccountStore: localOpen },
      })
      const loaded = await loader(
        async () => {
          throw new Error('unused native login')
        },
        { models: {} } as never,
      )
      if (typeof loaded.fetch !== 'function') throw new Error('no vault fetch')
      expect(
        await (
          await loaded.fetch(
            'https://generativelanguage.googleapis.com/example',
          )
        ).text(),
      ).toBe('vault-served')
      expect(localOpen).not.toHaveBeenCalled()
      expect(readFileSync(corruptPath, 'utf8')).toBe(corrupt)
    } finally {
      await lifecycle.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not open local accounts or read the native login while vault authority is active', async () => {
    const { createAuthLoader } = await import('./auth-loader')
    const { createPluginLifecycle } = await import('./lifecycle')
    const localOpen = mock(async () => {
      throw new Error('local store was touched')
    })
    const localAuth = mock(async () => {
      throw new Error('native login was touched')
    })
    const vaultFetch = mock(async () => new Response('vault-only'))
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      clearFetchState() {},
      shutdownDiskSignatureCache: async () => {},
    })
    const loader = createAuthLoader({
      client: {} as never,
      providerId: 'google',
      config: {} as never,
      lifecycle,
      readAuthority: async () => 'vault',
      createFetch: () => {
        throw new Error('local interceptor was constructed')
      },
      createVaultFetch: async () => ({ fetch: vaultFetch, dispose() {} }),
      dependencies: { openAccountStore: localOpen },
    })
    try {
      const loaded = await loader(localAuth, { models: {} } as never)
      if (typeof loaded.fetch !== 'function')
        throw new Error('no fetch runtime')
      const response = await loaded.fetch(
        'https://generativelanguage.googleapis.com/example',
      )
      expect(await response.text()).toBe('vault-only')
      expect(vaultFetch).toHaveBeenCalledTimes(1)
      expect(localAuth).not.toHaveBeenCalled()
      expect(localOpen).not.toHaveBeenCalled()
    } finally {
      await lifecycle.dispose()
    }
  })

  it('builds and sends no vault runtime when the loader is disposed during the request authority read', async () => {
    const events: string[] = []
    let heldAuthority: Promise<EnrollmentAuthority> | null = null
    let releaseAuthority: (authority: EnrollmentAuthority) => void = () => {}
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      clearFetchState() {},
      shutdownDiskSignatureCache: async () => {},
    })
    const loader = createAuthLoader({
      client: {} as never,
      providerId: 'google',
      config: {} as never,
      lifecycle,
      readAuthority: () => heldAuthority ?? Promise.resolve('vault'),
      createFetch: () => {
        throw new Error('local interceptor was constructed')
      },
      createVaultFetch: async () => {
        events.push('vault runtime built')
        return {
          fetch: async () => {
            events.push('vault send')
            return new Response('vault-after-dispose')
          },
          dispose() {
            events.push('vault runtime disposed')
          },
        }
      },
      dependencies: {
        openAccountStore: async () => {
          throw new Error('local store was touched')
        },
      },
    })
    try {
      const loaded = await loader(
        mock(async () => {
          throw new Error('native login was touched')
        }),
        { models: {} } as never,
      )
      if (typeof loaded.fetch !== 'function')
        throw new Error('no fetch runtime')
      heldAuthority = new Promise<EnrollmentAuthority>((resolve) => {
        releaseAuthority = resolve
      })
      const outcome = loaded
        .fetch('https://generativelanguage.googleapis.com/example')
        .then(
          async (response: Response) => ({
            kind: 'response' as const,
            text: await response.text(),
          }),
          (error: unknown) => ({
            kind: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      await lifecycle.dispose()
      events.push('lifecycle disposed')
      releaseAuthority('vault')
      expect({ outcome: await outcome, events }).toEqual({
        outcome: { kind: 'error', message: 'The account loader is disposed' },
        events: ['lifecycle disposed'],
      })
    } finally {
      releaseAuthority('vault')
      await lifecycle.dispose()
    }
  })

  it('sends nothing on a vault runtime whose construction finishes after loader disposal began, and disposes it', async () => {
    const events: string[] = []
    const construction = deferred()
    let markConstructing: () => void = () => {}
    const constructing = new Promise<void>((resolve) => {
      markConstructing = resolve
    })
    let markProducersStarting: () => void = () => {}
    const producersStarting = new Promise<void>((resolve) => {
      markProducersStarting = resolve
    })
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      // The lifecycle clears fetch state immediately before it disposes its
      // producers, the loader first among them.
      clearFetchState() {
        markProducersStarting()
      },
      shutdownDiskSignatureCache: async () => {},
    })
    const loader = createAuthLoader({
      client: {} as never,
      providerId: 'google',
      config: {} as never,
      lifecycle,
      readAuthority: async () => 'vault',
      createFetch: () => {
        throw new Error('local interceptor was constructed')
      },
      createVaultFetch: async () => {
        events.push('vault runtime construction started')
        markConstructing()
        await construction.promise
        events.push('vault runtime built')
        return {
          fetch: async () => {
            events.push('vault send')
            return new Response('vault-after-dispose')
          },
          dispose() {
            events.push('vault runtime disposed')
          },
        }
      },
      dependencies: {
        openAccountStore: async () => {
          throw new Error('local store was touched')
        },
      },
    })
    try {
      const loaded = await loader(
        mock(async () => {
          throw new Error('native login was touched')
        }),
        { models: {} } as never,
      )
      if (typeof loaded.fetch !== 'function')
        throw new Error('no fetch runtime')
      const outcome = loaded
        .fetch('https://generativelanguage.googleapis.com/example')
        .then(
          async (response: Response) => ({
            kind: 'response' as const,
            text: await response.text(),
          }),
          (error: unknown) => ({
            kind: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      await constructing
      // The loader's disposal waits for the runtime under construction so it
      // can close it; construction finishes once that disposal has begun.
      const disposal = lifecycle.dispose()
      await producersStarting
      construction.resolve()
      await disposal
      events.push('lifecycle disposed')
      expect({ outcome: await outcome, events }).toEqual({
        outcome: { kind: 'error', message: 'The account loader is disposed' },
        events: [
          'vault runtime construction started',
          'vault runtime built',
          'vault runtime disposed',
          'lifecycle disposed',
        ],
      })
    } finally {
      construction.resolve()
      await lifecycle.dispose()
    }
  })
})
