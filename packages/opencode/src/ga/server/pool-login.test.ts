import { describe, expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/antigravity-auth-core'
import {
  type AccountRepository,
  type AccountRow,
  createAccountMigrationFactory,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
} from '@opencode/plugin/promise/integration'

import {
  createVaultHostRelay,
  emptyVaultHostClient,
  withVaultHost,
} from '../../../../../test/support/vault-host.ts'
import { isPlaceholderCredential } from '../../common-auth-embedded/opencode2/index.js'
import {
  createGaLocationServicesFactory,
  createGaReauthorize,
  createGaRuntimeCollaborators,
} from '../../plugin/ga-location-services.ts'
import { createLocationLogger } from '../../plugin/logger.ts'
import { createOperatorSettingsRegistry } from '../../plugin/operator-settings.ts'
import * as persistence from '../../plugin/persist-account-pool.ts'
import {
  createLocationRuntime,
  type LocationRuntime,
} from '../../plugin/shared/runtime.ts'
import * as storage from '../../plugin/storage.ts'
import { registerGaAuthMethods } from './auth.ts'
import type { GaLocationServices, GaPluginOverrides } from './index.ts'
import { gaPreHeaderFailureResponse } from './index.ts'
import * as poolLogin from './pool-login.ts'
import {
  createGaPoolLogin,
  GA_POOL_METHOD_ID,
  GA_POOL_RECONNECT_METHOD_ID,
} from './pool-login.ts'

const GA_POOL_PASTE_METHOD_ID = poolLogin.GA_POOL_PASTE_METHOD_ID

function tree(root: string) {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((path) => {
      const full = join(root, path)
      return [
        path,
        statSync(full).isDirectory()
          ? 'directory'
          : readFileSync(full).toString('base64'),
      ]
    })
}

async function fixture(oauth?: GaPluginOverrides['oauth']) {
  const root = mkdtempSync(join(tmpdir(), 'ga-pool-login-'))
  const previous = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.OPENCODE_CONFIG_DIR = join(root, 'global-config')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  const legacyPath = join(root, 'resolved', 'accounts.json')
  const modules = await loadCommonAuthStoreModules()
  let mode: 'local' | 'custody' | 'unreadable' = 'local'
  let getRepository: (() => Promise<AccountRepository>) | undefined
  let services: GaLocationServices | undefined
  let runtime: LocationRuntime | undefined
  let registration:
    | Awaited<ReturnType<typeof registerGaAuthMethods>>
    | undefined
  let result = {
    type: 'success' as const,
    refresh: 'pool-refresh|pool-project',
    access: 'pool-access',
    expires: Date.now() + 3_600_000,
    email: 'pool@example.test',
    projectId: 'pool-project',
  }
  let refreshes = 0
  let beforeAdmissionRead: (() => Promise<void>) | undefined
  const repositoryStores = new WeakSet<object>()
  const observedModules = {
    ...modules,
    store: {
      ...modules.store,
      openPoolStore: ((options) => {
        const store = modules.store.openPoolStore(options)
        return new Proxy(store, {
          get(target, key) {
            const value = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (key === 'add')
              return (...args: unknown[]) => {
                repositoryStores.add(target)
                return Reflect.apply(value, target, args)
              }
            if (key === 'read')
              return async () => {
                if (!repositoryStores.has(target)) await beforeAdmissionRead?.()
                return Reflect.apply(value, target, [])
              }
            return value.bind(target)
          },
        })
      }) satisfies typeof modules.store.openPoolStore,
    },
  }
  const selected: string[][] = []
  const factory = createGaLocationServicesFactory({
    resolveAccountFile: () => legacyPath,
    loadStoreModules: async () => observedModules,
    now: Date.now,
    runtime: (input) => {
      getRepository = input.getRepository
      return createGaRuntimeCollaborators({
        ...input,
        accounts: { current: null, quotaLogger: null },
        now: Date.now,
      })
    },
    createPipeline: async ({ repository }) => ({
      execute: async () => {
        const read = await repository.read()
        if (read.status !== 'ready') throw new Error(read.status)
        selected.push(
          read.rows.map((row) => row.credential?.refreshToken ?? ''),
        )
        return new Response('next request uses committed account')
      },
      refreshAccounts: async () => {
        refreshes++
      },
      dispose: async () => {},
    }),
    custody: () => ({
      readMode: async () =>
        mode === 'unreadable'
          ? { ok: false, reason: 'unreadable' }
          : { ok: true, record: { version: 1, mode } },
      custodySource: async () => {
        throw new Error('Vault acquisition is not part of local login')
      },
      readState: async () => ({ schemaVersion: 1, accounts: {} }),
      menuSection: () => ({
        id: 'vault',
        title: 'Vault',
        build: () => ({ lines: [], actions: [] }),
      }),
      dispose: async () => {},
    }),
  })
  const methods: IntegrationMethodRegistration[] = []
  const editor: IntegrationEditor = {
    list: () => [{ id: 'google', name: 'Google' }],
    get: () => ({ id: 'google', name: 'Google' }),
    update: () => {
      throw new Error('Native metadata must stay unchanged')
    },
    remove: () => {
      throw new Error('Native integrations must stay unchanged')
    },
    method: {
      list: () => [],
      update: (method) => {
        methods.push(method)
      },
      remove: () => {
        throw new Error('Native methods must stay unchanged')
      },
    },
  }
  const cleanup = async () => {
    try {
      await registration?.dispose()
      await services?.dispose()
      await runtime?.dispose()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  try {
    services = await factory({ directory: root, overrides: {} })
    registration = await registerGaAuthMethods(
      {
        integration: {
          transform: async (transform) => {
            transform(editor)
            return { dispose: async () => {} }
          },
        },
      },
      undefined,
      {
        local: services.localLogin,
        oauth: {
          waitForCode: async () => 'code',
          exchange: async () => result,
          ...oauth,
        },
      },
    )
    return {
      root,
      legacyPath,
      modules,
      services,
      authorize: async (id: string) => {
        const method = methods.find(({ method }) => method.id === id)
        if (!method || !('authorize' in method))
          throw new Error('Pool method missing')
        return method.authorize({})
      },
      registration,
      selected,
      refreshes: () => refreshes,
      gateAdmission: (hook: () => Promise<void>) => {
        beforeAdmissionRead = hook
      },
      mode: (value: typeof mode) => {
        mode = value
      },
      result: (value: Partial<typeof result>) => {
        result = { ...result, ...value }
      },
      repository: async () => {
        if (!getRepository) throw new Error('Repository accessor missing')
        return getRepository()
      },
      login: async () => {
        const method = methods.find(
          ({ method }) =>
            method.type === 'oauth' && method.id === GA_POOL_METHOD_ID,
        )
        if (!method || !('authorize' in method))
          throw new Error('Pool method missing')
        const authorization = await method.authorize({})
        if (authorization.mode !== 'auto')
          throw new Error('Expected auto pool login')
        return authorization.callback
      },
      reconnect: async () => {
        const method = methods.find(
          ({ method }) =>
            method.type === 'oauth' &&
            method.id === GA_POOL_RECONNECT_METHOD_ID,
        )
        if (!method || !('authorize' in method))
          throw new Error('Reconnect method missing')
        const authorization = await method.authorize({})
        expect(authorization.url).toBe('')
        if (authorization.mode !== 'auto')
          throw new Error('Expected automatic reconnect')
        return authorization.callback
      },
      start: async () => {
        if (!services) throw new Error('Location missing')
        mkdirSync(join(root, '.opencode'), { recursive: true })
        writeFileSync(
          join(root, '.opencode', 'antigravity.json'),
          JSON.stringify({
            background_quota_refresh: false,
            proactive_token_refresh: false,
          }),
        )
        runtime = await createLocationRuntime({
          ...services.runtime,
          directory: root,
          operatorSettingsRegistry: createOperatorSettingsRegistry(),
        })
        return services.start({
          runtime,
          generation: 'pool-login',
          send: async () => {
            throw new Error('No live network')
          },
          notify: () => null,
          isConnected: () => false,
        })
      },
      rebind: async () => {
        await registration?.dispose()
        await services?.dispose()
        methods.length = 0
        services = await factory({ directory: root, overrides: {} })
        registration = await registerGaAuthMethods(
          {
            integration: {
              transform: async (transform) => {
                transform(editor)
                return { dispose: async () => {} }
              },
            },
          },
          undefined,
          {
            local: services.localLogin,
            oauth: {
              waitForCode: async () => 'code',
              exchange: async () => result,
            },
          },
        )
      },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  const read = await (await f.repository()).read()
  if (read.status !== 'ready') throw new Error(read.status)
  return read.rows
}

const FAILED = 'The Antigravity pool login could not be completed.'

describe('GA redirect URL pool login', () => {
  function oauthState(url: string) {
    const state = new URL(url).searchParams.get('state')
    if (!state) throw new Error('Authorization state missing')
    return state
  }

  async function flow() {
    const exchanged: { code: string; state: string }[] = []
    const f = await fixture()
    const pool = createGaPoolLogin({
      local: f.services.localLogin,
      oauth: {
        exchange: async (code, state) => {
          exchanged.push({ code, state })
          return {
            type: 'success',
            refresh: 'redirect-refresh',
            access: 'redirect-access',
            expires: Date.now() + 3_600_000,
            email: 'redirect@example.test',
          }
        },
      },
    })
    try {
      const attempt = await pool.start()
      const state = oauthState(attempt.url)
      const url = new URL(core.ANTIGRAVITY_REDIRECT_URI)
      url.searchParams.set('state', state)
      url.searchParams.set('code', 'redirect-secret-code')
      return {
        f,
        pool,
        attempt,
        state,
        url: url.href,
        exchanged,
        cleanup: async () => {
          await pool.dispose()
          await f.cleanup()
        },
      }
    } catch (error) {
      await pool.dispose()
      await f.cleanup()
      throw error
    }
  }

  it('auto-return alone exchanges the same PKCE state and persists through the shared pool flow', async () => {
    const f = await flow()
    try {
      const response = await fetch(f.url)
      expect(response.ok).toBe(true)
      const result = await f.attempt.completion
      await f.pool.onLogin(result)
      expect(f.exchanged).toEqual([
        { code: 'redirect-secret-code', state: f.state },
      ])
      expect((await rows(f.f))[0]?.credential?.refreshToken).toBe(
        'redirect-refresh',
      )
    } finally {
      await f.cleanup()
    }
  })

  it('paste-only host method never binds the callback port and persists before returning its placeholder', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(51121, resolve)
    })
    const f = await fixture({ waitForCode: undefined })
    try {
      const auth = await f.authorize(GA_POOL_PASTE_METHOD_ID)
      expect(auth.mode).toBe('code')
      expect(auth.instructions).toBe(
        "Paste the redirect URL from your browser's address bar",
      )
      if (auth.mode !== 'code') throw new Error('Expected paste method')
      const url = new URL(core.ANTIGRAVITY_REDIRECT_URI)
      url.searchParams.set('state', oauthState(auth.url))
      url.searchParams.set('code', 'paste-only-secret')
      const credential = await auth.callback(url.href)
      expect(isPlaceholderCredential(credential, 'google')).toBe(true)
      expect(await rows(f)).toHaveLength(1)
      await expect(auth.callback(url.href)).rejects.toThrow(FAILED)
    } finally {
      await f.cleanup()
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })

  it('listener first refuses a later paste and closes the listener after one exchange', async () => {
    const f = await flow()
    try {
      await fetch(f.url)
      await f.attempt.completion
      await expect(f.attempt.paste(f.url)).rejects.toThrow(FAILED)
      expect(f.exchanged).toHaveLength(1)
      await expect(fetch(f.url)).rejects.toThrow()
    } finally {
      await f.cleanup()
    }
  })

  it('paste first refuses a later listener callback after one exchange', async () => {
    const f = await flow()
    try {
      await f.attempt.paste(f.url)
      await expect(fetch(f.url)).rejects.toThrow()
      expect(f.exchanged).toEqual([
        { code: 'redirect-secret-code', state: f.state },
      ])
    } finally {
      await f.cleanup()
    }
  })

  it('an empty paste waits for the listener instead of failing', async () => {
    const f = await flow()
    try {
      let settled = false
      const result = f.attempt.paste('').then((value) => {
        settled = true
        return value
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      await fetch(f.url)
      expect(await result).toEqual(await f.attempt.completion)
      expect(f.exchanged).toHaveLength(1)
    } finally {
      await f.cleanup()
    }
  })

  for (const invalid of ['origin', 'path', 'state', 'code'] as const) {
    it(`refuses a pasted redirect with wrong or missing ${invalid} without echoing it`, async () => {
      const f = await flow()
      try {
        const url = new URL(f.url)
        if (invalid === 'origin') url.hostname = 'example.test'
        if (invalid === 'path') url.pathname = '/elsewhere'
        if (invalid === 'state')
          url.searchParams.set('state', 'wrong-secret-state')
        if (invalid === 'code') url.searchParams.delete('code')
        const error = await f.attempt
          .paste(url.href)
          .catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toBe(`Error: ${FAILED}`)
        expect(f.exchanged).toHaveLength(0)
      } finally {
        await f.cleanup()
      }
    })
  }

  it('keeps a pasted URL and upstream errors out of captured logs and host errors', async () => {
    const secret =
      'http://localhost:51121/oauth-callback?state=private-state&code=private-code'
    const output: unknown[][] = []
    const spies = (['warn', 'error', 'log', 'info', 'debug'] as const).map(
      (key) =>
        spyOn(console, key).mockImplementation((...args: unknown[]) => {
          output.push(args)
        }),
    )
    const f = await fixture({
      exchange: async () => {
        throw new Error(secret)
      },
    })
    try {
      const records: unknown[] = []
      createLocationLogger({
        sinkEnabled: () => true,
        sink: (record) => {
          records.push(record)
        },
      })
        .createLogger('oauth')
        .warn(`Failed callback ${secret}`, {
          callback: secret,
          error: new Error(secret),
        })
      expect(records).toHaveLength(1)
      expect(JSON.stringify(records)).not.toContain(secret)
      expect(JSON.stringify(records)).not.toContain('private-code')
      const auth = await f.authorize(GA_POOL_PASTE_METHOD_ID)
      if (auth.mode !== 'code') throw new Error('Expected paste method')
      const url = new URL(secret)
      url.searchParams.set('state', oauthState(auth.url))
      const error = await auth
        .callback(url.href)
        .catch((error: unknown) => error)
      expect(String(error)).toBe(`Error: ${FAILED}`)
      expect(JSON.stringify({ output, error: String(error) })).not.toContain(
        secret,
      )
      expect(JSON.stringify(output)).not.toContain(url.href)
      expect(JSON.stringify(output)).not.toContain('private-code')
    } finally {
      await f.cleanup()
      for (const spy of spies) spy.mockRestore()
    }
  })

  for (const authority of ['custody', 'unreadable', 'host'] as const) {
    it(`refuses paste login under ${authority} before OAuth or any store write`, async () => {
      let calls = 0
      const f = await fixture({
        authorize: async () => {
          calls++
          throw new Error('OAuth must not start')
        },
        exchange: async () => {
          calls++
          throw new Error('Exchange must not start')
        },
      })
      try {
        // Seed actual local store files before changing authority.
        const seed = createGaPoolLogin({
          local: f.services.localLogin,
          oauth: {
            waitForCode: async () => 'seed',
            exchange: async () => ({
              type: 'success',
              refresh: 'seed-refresh',
              access: 'seed-access',
              expires: Date.now() + 3_600_000,
            }),
          },
        })
        try {
          const auth = await seed.method.authorize({})
          if (auth.mode !== 'auto') throw new Error('Expected auto')
          await seed.onLogin(await auth.callback)
        } finally {
          await seed.dispose()
        }
        const before = tree(f.root)
        const refuse = async () => {
          await expect(f.authorize(GA_POOL_PASTE_METHOD_ID)).rejects.toThrow(
            FAILED,
          )
        }
        if (authority === 'host') {
          const relay = createVaultHostRelay(emptyVaultHostClient)
          await withVaultHost('thalamus', relay.accessor, refuse)
        } else {
          f.mode(authority)
          await refuse()
        }
        expect(calls).toBe(0)
        expect(tree(f.root)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }
})

describe('GA existing local pool reconnect', () => {
  it('reconnects after browser success when quota lands between admission config and row reads', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let reconnect: ReturnType<typeof f.reconnect> | undefined
    let observedRefusal: unknown
    const original = f.services.localLogin!.assertExistingPool!.bind(
      f.services.localLogin,
    )
    const observe = spyOn(
      f.services.localLogin!,
      'assertExistingPool',
    ).mockImplementation(async (admit) => {
      try {
        await original(admit)
      } catch (error) {
        observedRefusal = error
        throw error
      }
    })
    try {
      await f.login()
      const [row] = await rows(f)
      if (!row) throw new Error('Missing committed login')
      expect(isPlaceholderCredential(await f.reconnect(), 'google')).toBe(true)
      let gated = false
      f.gateAdmission(async () => {
        if (gated) return
        gated = true
        entered.resolve()
        await release.promise
      })
      reconnect = f.reconnect()
      await entered.promise
      await (await f.repository()).recordQuota(row.ref, {
        schemaVersion: 1,
        cachedQuotaUpdatedAt: 123,
      })
      release.resolve()
      const result = await reconnect.then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      expect(observedRefusal).toBeUndefined()
      if ('error' in result) throw result.error
      expect(isPlaceholderCredential(result.value, 'google')).toBe(true)
      expect((await rows(f))[0]?.quota).toEqual({
        status: 'present',
        quota: { schemaVersion: 1, cachedQuotaUpdatedAt: 123 },
      })
    } finally {
      release.resolve()
      await reconnect?.catch(() => {})
      observe.mockRestore()
      await f.cleanup()
    }
  })

  it('surfaces exhausted snapshots as fixed digit-free busy text for reconnect and local serving', async () => {
    const f = await fixture()
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    const busy = 'The Antigravity account store is busy. Try again in a moment.'
    try {
      await f.login()
      const [row] = await rows(f)
      if (!row) throw new Error('Missing committed login')
      const repository = await f.repository()
      let writes = 0
      f.gateAdmission(async () => {
        await repository.recordQuota(row.ref, {
          schemaVersion: 1,
          cachedQuotaUpdatedAt: ++writes,
        })
      })
      await expect(f.reconnect()).rejects.toThrow(busy)
      expect(writes).toBe(3)
      expect(warning.mock.calls).toEqual([
        [
          '[antigravity.pool-login] stage=existing-pool-admission reason=store-busy',
        ],
      ])
      expect(busy).not.toMatch(/\d|429|500|502|503|504|524/)
      await expect(f.login()).rejects.toThrow(busy)
      const started = await f.start()
      const job = {
        sessionID: 'busy-next',
        parentSessionID: null,
        kind: 'generate' as const,
        modelID: 'antigravity-gemini-3.8-flash',
        variant: null,
        url: 'https://example.test',
        body: '{}',
      }
      const context = {
        signal: new AbortController().signal,
        send: async () => new Response('unused'),
      }
      let refusal: unknown
      try {
        await started.execute(job, context)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(core.AccountStoreBusyError)
      expect((refusal as Error).message).toBe(busy)
      const response = gaPreHeaderFailureResponse(refusal)
      expect(response.status).toBe(502)
      expect(response.headers.has('retry-after')).toBe(false)
      expect(await response.json()).toEqual({
        error: { code: 502, status: 'UNAVAILABLE', message: busy },
      })
      // A busy refusal must not prevent a later request from serving.
      f.gateAdmission(async () => {})
      const recovered = await started.execute(job, context)
      expect(await recovered.text()).toBe('next request uses committed account')
    } finally {
      warning.mockRestore()
      await f.cleanup()
    }
  })

  it('logs only fixed stage and reason codes before sanitizing a damaged-store refusal', async () => {
    const f = await fixture()
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    const check = spyOn(
      f.services.localLogin!,
      'assertExistingPool',
    ).mockRejectedValue(
      new Error('secret-token /private/path row@example.test'),
    )
    try {
      await expect(f.reconnect()).rejects.toThrow(FAILED)
      expect(warning.mock.calls).toEqual([
        [
          '[antigravity.pool-login] stage=existing-pool-admission reason=store-refusal',
        ],
      ])
    } finally {
      check.mockRestore()
      warning.mockRestore()
      await f.cleanup()
    }
  })

  it('returns only the public marker without changing seeded pool bytes or refreshing accounts', async () => {
    const f = await fixture()
    try {
      await f.login()
      const before = tree(f.root)
      const credential = await f.reconnect()
      expect(isPlaceholderCredential(credential, 'google')).toBe(true)
      expect(String(credential.methodID)).toBe(GA_POOL_RECONNECT_METHOD_ID)
      expect(JSON.stringify(credential)).not.toContain('pool-refresh')
      expect(JSON.stringify(credential)).not.toContain('pool-access')
      expect(JSON.stringify(credential)).not.toContain('pool@example.test')
      expect(f.refreshes()).toBe(0)
      expect(tree(f.root)).toEqual(before)
    } finally {
      await f.cleanup()
    }
  })

  it('refuses a fresh store without initialization or writes', async () => {
    const f = await fixture()
    const initializer = spyOn(storage, 'initializeFreshAccountStoreFor')
    try {
      const before = tree(f.root)
      await expect(f.reconnect()).rejects.toThrow(FAILED)
      expect(initializer).not.toHaveBeenCalled()
      expect(tree(f.root)).toEqual(before)
    } finally {
      initializer.mockRestore()
      await f.cleanup()
    }
  })

  it('allows concurrent login on a fresh store while reconnect refuses without poisoning initialization', async () => {
    const f = await fixture()
    try {
      const reconnecting = f.reconnect()
      const loggingIn = f.login()
      const [reconnectResult, loginResult] = await Promise.allSettled([
        reconnecting,
        loggingIn,
      ])
      expect(reconnectResult.status).toBe('rejected')
      if (reconnectResult.status === 'rejected') {
        expect(reconnectResult.reason.message).toContain(FAILED)
      }
      expect(loginResult.status).toBe('fulfilled')
      if (loginResult.status === 'fulfilled') {
        expect(isPlaceholderCredential(loginResult.value, 'google')).toBe(true)
      }
      const accountRows = await rows(f)
      expect(accountRows).toHaveLength(1)
      expect(accountRows[0]?.credential?.refreshToken).toBe('pool-refresh')
    } finally {
      await f.cleanup()
    }
  })

  it('returns the public marker and directly serves a request from the existing pool without account refresh', async () => {
    const f = await fixture()
    try {
      await f.login()
      expect(f.refreshes()).toBe(0)
      const serving = await f.start()
      const credential = await f.reconnect()
      expect(isPlaceholderCredential(credential, 'google')).toBe(true)
      expect(String(credential.methodID)).toBe(GA_POOL_RECONNECT_METHOD_ID)
      expect(f.refreshes()).toBe(0)

      await serving.execute(
        {
          sessionID: 'reconnect-next',
          parentSessionID: null,
          kind: 'generate',
          modelID: 'antigravity-gemini-3.8-flash',
          variant: null,
          url: 'https://example.test',
          body: '{}',
        },
        {
          signal: new AbortController().signal,
          send: async () => new Response('unused'),
        },
      )
      expect(f.selected).toContainEqual(['pool-refresh'])
      expect(f.refreshes()).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  for (const mode of ['custody', 'unreadable'] as const) {
    it(`refuses ${mode} with a populated store without opening or reading the repository`, async () => {
      const f = await fixture()
      try {
        await f.login()
        const seededRepository = await f.repository()
        f.mode(mode)
        let bindingsRead = 0
        let opened = 0
        let reads = 0
        const readBinding = core.readAccountStoreBinding
        const bindingSpy = spyOn(
          core,
          'readAccountStoreBinding',
        ).mockImplementation(async (...args) => {
          bindingsRead++
          return readBinding(...args)
        })
        const factory = core.createAccountRepositoryFactory
        const factorySpy = spyOn(
          core,
          'createAccountRepositoryFactory',
        ).mockImplementation((...args) => {
          opened++
          const create = factory(...args)
          return (options) => {
            const repo = create(options)
            const origRead = repo.read.bind(repo)
            repo.read = async () => {
              reads++
              return origRead()
            }
            return repo
          }
        })
        const readSpy = spyOn(seededRepository, 'read').mockImplementation(
          async () => {
            reads++
            throw new Error('repository read must not be reached')
          },
        )
        try {
          // 1. Pre-bound location services instance (seededRepository is live)
          await expect(f.reconnect()).rejects.toThrow(FAILED)
          expect(bindingsRead).toBe(0)
          expect(opened).toBe(0)
          expect(reads).toBe(0)

          // 2. Freshly rebound location services instance (repositoryPromise is uncached)
          await f.rebind()
          await expect(f.reconnect()).rejects.toThrow(FAILED)
          expect(bindingsRead).toBe(0)
          expect(opened).toBe(0)
          expect(reads).toBe(0)
        } finally {
          bindingSpy.mockRestore()
          factorySpy.mockRestore()
          readSpy.mockRestore()
        }
      } finally {
        await f.cleanup()
      }
    })
  }

  for (const mode of ['custody', 'unreadable'] as const) {
    it(`refuses ${mode} after seeding without writes`, async () => {
      const f = await fixture()
      try {
        await f.login()
        f.mode(mode)
        const before = tree(f.root)
        await expect(f.reconnect()).rejects.toThrow(FAILED)
        expect(tree(f.root)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }

  for (const state of [
    'empty',
    'all-disabled',
    'ineligible',
    'verification',
  ] as const) {
    it(`refuses an actual ${state} store without subsequent writes`, async () => {
      const f = await fixture()
      try {
        await f.login()
        const repository = await f.repository()
        const row = (await rows(f))[0]!
        if (state === 'empty') await repository.remove(row.ref)
        else if (state === 'all-disabled') {
          await repository.setEnabled(row.ref, {
            enabled: false,
            actor: 'user',
          })
        } else {
          await repository.updateMetadata(row.ref, (current) => ({
            kind: 'set',
            metadata: {
              ...current!,
              ...(state === 'ineligible'
                ? { accountIneligible: true }
                : { verificationRequired: true }),
            },
          }))
        }
        const before = tree(f.root)
        await expect(f.reconnect()).rejects.toThrow(FAILED)
        expect(tree(f.root)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }

  const refused: Record<string, (row: AccountRow) => AccountRow[]> = {
    empty: () => [],
    disabled: (row) => [{ ...row, enabled: false }],
    unusable: (row) => [{ ...row, usable: false }],
    torn: (row) => [{ ...row, torn: true }],
    unbound: (row) => [{ ...row, unbound: true }],
    invalid: (row) => [{ ...row, invalid: 'entry' }],
    'missing credential': (row) => [{ ...row, credential: undefined }],
    'absent metadata': (row) => [{ ...row, metadata: { status: 'absent' } }],
    'dropped metadata': (row) => [
      { ...row, metadata: { status: 'dropped', reason: 'uncovered' } },
    ],
    ineligible: (row) => [
      {
        ...row,
        metadata: {
          status: 'present',
          metadata: { addedAt: 1, lastUsed: 2, accountIneligible: true },
        },
      },
    ],
    verification: (row) => [
      {
        ...row,
        metadata: {
          status: 'present',
          metadata: { addedAt: 1, lastUsed: 2, verificationRequired: true },
        },
      },
    ],
  }
  for (const [name, project] of Object.entries(refused)) {
    it(`refuses ${name} rows without writing the actual seeded store`, async () => {
      let refuse = false
      const factory = core.createAccountRepositoryFactory
      const factorySpy = spyOn(
        core,
        'createAccountRepositoryFactory',
      ).mockImplementation((modules) => {
        const create = factory(modules)
        return (options) => {
          const repository = create(options)
          const read = repository.read.bind(repository)
          repository.read = async () => {
            const result = await read()
            return refuse && result.status === 'ready'
              ? { ...result, rows: project(result.rows[0]!) }
              : result
          }
          return repository
        }
      })
      const f = await fixture()
      try {
        await f.login()
        refuse = true
        const before = tree(f.root)
        await expect(f.reconnect()).rejects.toThrow(FAILED)
        expect(tree(f.root)).toEqual(before)
      } finally {
        factorySpy.mockRestore()
        await f.cleanup()
      }
    })
  }
})

describe('GA location pool login', () => {
  it('initializes only the injected resolved path and the next request sees the committed account without restart', async () => {
    const f = await fixture()
    try {
      const globalPath = storage.getStoragePath()
      expect(globalPath).not.toBe(f.legacyPath)
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('initialization-required')
      const serving = await f.start()
      await expect(
        serving.execute(
          {
            sessionID: 'empty',
            parentSessionID: null,
            kind: 'generate',
            modelID: 'antigravity-gemini-3.8-flash',
            variant: null,
            url: 'https://example.test',
            body: '{}',
          },
          {
            signal: new AbortController().signal,
            send: async () => new Response('unused'),
          },
        ),
      ).rejects.toThrow('not initialized')
      const credential = await f.login()
      expect(String(credential.methodID)).toBe(GA_POOL_METHOD_ID)
      expect(credential.access).not.toBe('pool-access')
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('bound')
      expect(existsSync(globalPath)).toBe(false)
      expect(
        (await readAccountStoreBinding(globalPath, f.modules, Date.now)).status,
      ).toBe('initialization-required')
      expect(
        (await rows(f)).map((row) => row.credential?.refreshToken),
      ).toEqual(['pool-refresh'])
      await serving.execute(
        {
          sessionID: 'next',
          parentSessionID: null,
          kind: 'generate',
          modelID: 'antigravity-gemini-3.8-flash',
          variant: null,
          url: 'https://example.test',
          body: '{}',
        },
        {
          signal: new AbortController().signal,
          send: async () => new Response('unused'),
        },
      )
      expect(f.selected).toEqual([['pool-refresh']])
    } finally {
      await f.cleanup()
    }
  })

  it('refuses a pending migration without initialization or any file writes', async () => {
    const f = await fixture()
    try {
      mkdirSync(join(f.root, 'resolved'), { recursive: true, mode: 0o700 })
      writeFileSync(
        f.legacyPath,
        JSON.stringify({
          version: 4,
          accounts: [
            {
              refreshToken: 'pending-refresh',
              addedAt: 1,
              lastUsed: 2,
            },
          ],
          activeIndex: 0,
        }),
        { mode: 0o600 },
      )
      await expect(
        createAccountMigrationFactory(f.modules)({
          legacyPath: f.legacyPath,
          offline: { processesStopped: true },
          now: Date.now,
          onBoundary: async (name) => {
            if (name === 'after-capture')
              throw new Error('synthetic interruption')
          },
        }),
      ).rejects.toThrow('synthetic interruption')
      expect(
        await readAccountStoreBinding(f.legacyPath, f.modules, Date.now),
      ).toMatchObject({ status: 'pending', phase: 'capture' })
      const before = tree(join(f.root, 'resolved'))
      const initializer = spyOn(storage, 'initializeFreshAccountStoreFor')
      try {
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(initializer).not.toHaveBeenCalled()
        await expect(f.reconnect()).rejects.toThrow(FAILED)
        expect(tree(join(f.root, 'resolved'))).toEqual(before)
      } finally {
        initializer.mockRestore()
      }
    } finally {
      await f.cleanup()
    }
  })
})

describe('GA pool login durability', () => {
  for (const mode of ['custody', 'unreadable'] as const) {
    it(`refuses actual ${mode} location authority without creating files`, async () => {
      const f = await fixture()
      try {
        f.mode(mode)
        const before = tree(f.root)
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(tree(f.root)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }

  it('keeps an initialized bound empty store when authority is revoked before account commit', async () => {
    const f = await fixture()
    const initialize = storage.initializeFreshAccountStoreFor
    const initializer = spyOn(
      storage,
      'initializeFreshAccountStoreFor',
    ).mockImplementation(async (...args) => {
      const outcome = await initialize(...args)
      f.mode('custody')
      return outcome
    })
    try {
      await expect(f.login()).rejects.toThrow(FAILED)
      expect(initializer).toHaveBeenCalledTimes(1)
      expect(initializer.mock.calls[0]?.[1]?.legacyPath).toBe(f.legacyPath)
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('bound')
      f.mode('local')
      expect(await rows(f)).toEqual([])
      await f.login()
      expect(initializer).toHaveBeenCalledTimes(1)
      expect(await rows(f)).toHaveLength(1)
    } finally {
      initializer.mockRestore()
      await f.cleanup()
    }
  })

  for (const action of ['revoke', 'dispose'] as const) {
    it(`retains the committed row without a placeholder when ${action} happens after commit`, async () => {
      const f = await fixture()
      const committed = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const commit = persistence.commitLogins
      const writer = spyOn(persistence, 'commitLogins').mockImplementation(
        async (...args) => {
          const result = await commit(...args)
          expect(result.map((entry) => entry.status)).toEqual(['committed'])
          committed.resolve()
          await release.promise
          return result
        },
      )
      try {
        const pending = f.login().then(
          () => 'unexpected placeholder',
          (error: Error) => error.message,
        )
        await committed.promise
        expect(await rows(f)).toHaveLength(1)
        let disposal: Promise<void> | undefined
        if (action === 'revoke') f.mode('custody')
        else disposal = f.registration.dispose()
        release.resolve()
        expect(await pending).toBe(FAILED)
        await disposal
        f.mode('local')
        expect(
          (await rows(f)).map((row) => row.credential?.refreshToken),
        ).toEqual(['pool-refresh'])
      } finally {
        release.resolve()
        writer.mockRestore()
        await f.cleanup()
      }
    })
  }

  it('rejects a duplicate identity through the registered method and preserves its existing row', async () => {
    const f = await fixture()
    try {
      await f.login()
      const before = await rows(f)
      const bytes = tree(join(f.root, 'resolved'))
      f.result({
        refresh: 'different-secret|pool-project',
        access: 'different-access',
      })
      await expect(f.login()).rejects.toThrow(FAILED)
      expect(await rows(f)).toEqual(before)
      expect(tree(join(f.root, 'resolved'))).toEqual(bytes)
    } finally {
      await f.cleanup()
    }
  })

  it('keeps expected-ref reauthorization distinct from pool add and replaces only the captured row', async () => {
    const f = await fixture()
    let reauthorize: ReturnType<typeof createGaReauthorize> | undefined
    try {
      await f.login()
      f.result({
        refresh: 'second-refresh|pool-project',
        email: 'second@example.test',
      })
      await f.login()
      const before = await rows(f)
      const first = before[0]!
      const changed = Promise.withResolvers<void>()
      const notified = Promise.withResolvers<string>()
      reauthorize = createGaReauthorize({
        repository: await f.repository(),
        assertAdmission: f.services.localLogin!.assertAdmission,
        overrides: {
          oauth: {
            waitForCode: async () => 'code',
            exchange: async () => ({
              type: 'success',
              refresh: 'replacement-refresh|pool-project',
              access: 'replacement-access',
              email: 'pool@example.test',
              expires: Date.now() + 3_600_000,
              projectId: 'pool-project',
            }),
          },
        },
        afterChange: async () => {
          changed.resolve()
        },
      })
      await reauthorize.run(first.ref, {
        notify: (text) => {
          notified.resolve(text)
        },
      })
      expect(await notified.promise).toBe('Account reauthorized.')
      await changed.promise
      await reauthorize.dispose()
      const after = await rows(f)
      expect(after).toHaveLength(2)
      expect(after[0]?.ref.id).toBe(first.ref.id)
      expect(after[0]?.credential?.refreshToken).toBe('replacement-refresh')
      expect(after[1]).toEqual(before[1])
    } finally {
      await reauthorize?.dispose()
      await f.cleanup()
    }
  })

  for (const outcome of ['skipped', 'refused', 'empty', 'multiple'] as const) {
    it(`does not issue a placeholder for a ${outcome} commit result`, async () => {
      const f = await fixture()
      const commit = persistence.commitLogins
      const writer = spyOn(persistence, 'commitLogins').mockImplementation(
        async (...args) => {
          if (outcome === 'empty') return []
          if (outcome === 'skipped')
            return [{ status: 'skipped', reason: 'no-refresh-token' }]
          if (outcome === 'refused')
            return [
              {
                status: 'refused',
                kind: 'duplicate-identity',
                message: 'credential-safe detail',
              },
            ]
          const result = await commit(...args)
          return [...result, ...result]
        },
      )
      try {
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(await rows(f)).toHaveLength(outcome === 'multiple' ? 1 : 0)
      } finally {
        writer.mockRestore()
        await f.cleanup()
      }
    })
  }
})
