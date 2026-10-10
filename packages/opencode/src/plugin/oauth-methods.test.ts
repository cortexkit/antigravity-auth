import { beforeEach, describe, expect, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type AccountRepository,
  type CommonAuthStoreModules,
  createAccountRepositoryFactory,
  loadCommonAuthStoreModules,
} from '@cortexkit/antigravity-auth-core'
import type { AuthOAuthResult } from '@opencode-ai/plugin'
import { lifetimeHooks } from '../../../../test/fixtures/lifetime-hooks.ts'
import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import { managedStoreModules } from './__fixtures__/managed-store.test.ts'
import {
  type AccountAccessService,
  AccountChangedDuringReauthorizationError,
  createAccountAccessService,
} from './account-access'
import { DEFAULT_CONFIG } from './config'
import type { PluginLifecycle } from './lifecycle'
import { createOAuthMethods, parseOAuthCallbackInput } from './oauth-methods'
import { commitLogins } from './persist-account-pool'
import type { OAuthListener } from './server'
import type { AccountStorageV4 } from './storage'
import {
  AccountStorageUnreadableError,
  initializeFreshAccountStoreFor,
  openAccountStore,
} from './storage'

const EXPECTED_STATE = 'expected-state'
const AUTHORIZATION_URL = `https://accounts.google.com/o/oauth2/v2/auth?state=${EXPECTED_STATE}`

function success(
  refreshToken: string,
  email: string,
): Extract<AntigravityTokenExchangeResult, { type: 'success' }> {
  return {
    type: 'success',
    refresh: `${refreshToken}|project`,
    access: `access-${refreshToken}`,
    expires: 123,
    email,
    projectId: 'project',
  }
}

function createLifecycle(): PluginLifecycle {
  return {
    getAccountManager: () => null,
    replaceAccountRuntime: mock(async () => {}),
    register: mock(() => {}),
    dispose: mock(async () => {}),
  }
}

function createAccountAccess(initial: AccountStorageV4 | null = null): {
  service: AccountAccessService
  persistCalls: Array<{
    replaceAll: boolean
    emails: Array<string | undefined>
  }>
} {
  let storage = initial ? structuredClone(initial) : null
  const persistCalls: Array<{
    replaceAll: boolean
    emails: Array<string | undefined>
  }> = []

  const service = {
    loadAccounts: mock(async () => (storage ? structuredClone(storage) : null)),
    clearAccounts: mock(async () => {
      storage = { version: 4, accounts: [], activeIndex: 0 }
    }),
    mutateAccounts: mock(async (mutate) => {
      const current = storage ?? { version: 4, accounts: [], activeIndex: 0 }
      storage = (await mutate(structuredClone(current))) ?? current
      return structuredClone(storage)
    }),
    persistAccountPool: mock(
      async (
        results: Array<
          Extract<AntigravityTokenExchangeResult, { type: 'success' }>
        >,
        replaceAll: boolean,
      ) => {
        persistCalls.push({
          replaceAll,
          emails: results.map((result) => result.email),
        })
        const existing = replaceAll ? [] : (storage?.accounts ?? [])
        storage = {
          version: 4,
          activeIndex: 0,
          accounts: [
            ...existing,
            ...results.map((result, index) => ({
              email: result.email,
              refreshToken: result.refresh.split('|')[0]!,
              projectId: result.projectId,
              addedAt: index + 1,
              lastUsed: index + 1,
            })),
          ],
        }
      },
    ),
    applyVerificationResult: mock(async () => undefined),
    clearAccessBlocks: mock(async () => ({
      changed: false,
      wasAccessBlocked: false,
    })),
    verifyAccount: mock(async () => ({
      status: 'ok' as const,
      message: 'ok',
    })),
    selectAccount: mock(async () => undefined),
    openVerificationUrl: mock(async () => false),
    source: mock(async () => 'pool-file' as const),
  } as unknown as AccountAccessService

  return { service, persistCalls }
}

const hooks = lifetimeHooks()
const { it, afterEach } = hooks

describe('parseOAuthCallbackInput', () => {
  it('rejects a callback URL whose state does not match the authorization', () => {
    expect(
      parseOAuthCallbackInput(
        'http://localhost:51121/oauth-callback?code=code&state=wrong-state',
        EXPECTED_STATE,
      ),
    ).toEqual({ error: 'OAuth state mismatch' })
  })
})

describe('createOAuthMethods', () => {
  it('persists each CLI account and replaces storage only for the first fresh account', async () => {
    const { service, persistCalls } = createAccountAccess()
    const callbackInputs = ['code-a', 'code-b']
    const addAnother = [true, false]
    const methods = createOAuthMethods({
      client: {
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async (code: string) =>
          code === 'code-a'
            ? success('refresh-a', 'a@example.com')
            : success('refresh-b', 'b@example.com'),
        ),
        promptProjectId: mock(async () => ''),
        promptCallback: mock(async () => callbackInputs.shift() ?? ''),
        promptAddAnotherAccount: mock(async () => addAnother.shift() ?? false),
        openBrowser: mock(async () => false),
        shouldSkipLocalServer: () => true,
        isHeadless: () => false,
      },
    })

    const result = await methods[0]?.authorize?.({ noBrowser: 'true' })
    const oauthResult = result as
      | Extract<AuthOAuthResult, { method: 'code' }>
      | undefined

    expect(await oauthResult?.callback('')).toMatchObject({
      type: 'success',
      email: 'a@example.com',
    })
    expect(persistCalls).toEqual([
      { replaceAll: true, emails: ['a@example.com'] },
      { replaceAll: false, emails: ['b@example.com'] },
    ])
  })

  it('adds a TUI-authenticated account without replacing existing storage', async () => {
    const { service, persistCalls } = createAccountAccess({
      version: 4,
      activeIndex: 0,
      accounts: [
        {
          email: 'existing@example.com',
          refreshToken: 'existing-refresh',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
    })
    const methods = createOAuthMethods({
      client: { tui: { showToast: mock(async () => {}) } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    expect(result).toMatchObject({ type: 'success' })
    expect(persistCalls).toEqual([
      { replaceAll: false, emails: ['new@example.com'] },
    ])
  })

  it('closes the local listener after callback success and state failure', async () => {
    for (const state of [EXPECTED_STATE, 'wrong-state']) {
      const close = mock(async () => {})
      const listener: OAuthListener = {
        waitForCallback: mock(
          async () =>
            new URL(
              `http://localhost:51121/oauth-callback?code=code&state=${state}`,
            ),
        ),
        close,
      }
      const { service } = createAccountAccess()
      const methods = createOAuthMethods({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: DEFAULT_CONFIG,
        lifecycle: createLifecycle(),
        accountAccess: service,
        dependencies: {
          authorize: mock(async () => ({
            url: AUTHORIZATION_URL,
            verifier: 'verifier',
            projectId: '',
          })),
          exchange: mock(async () => success('new-refresh', 'new@example.com')),
          startListener: mock(async () => listener),
          openBrowser: mock(async () => true),
          isHeadless: () => false,
          shouldSkipLocalServer: () => false,
        },
      })

      const authorization = await methods[0]?.authorize?.()
      const result = await (
        authorization as
          | Extract<AuthOAuthResult, { method: 'auto' }>
          | undefined
      )?.callback()

      expect(close).toHaveBeenCalledTimes(1)
      expect(result?.type).toBe(state === EXPECTED_STATE ? 'success' : 'failed')
    }
  })
})

describe('createOAuthMethods persistence failure handling', () => {
  function buildUnreadableError(): AccountStorageUnreadableError {
    return new AccountStorageUnreadableError(
      'Account storage at /tmp/x.json is unreadable (invalid-shape: accounts[1].refreshToken is missing or not a non-empty string). A backup was written to /tmp/x.json.corrupt-2026-07-23T12-00-00-000Z and the on-disk file has been left untouched.',
      {
        path: '/tmp/x.json',
        reason: 'invalid-shape',
        detail: 'accounts[1].refreshToken is missing or not a non-empty string',
        backupPath: '/tmp/x.json.corrupt-2026-07-23T12-00-00-000Z',
      },
    )
  }

  function findToastBody(
    showToast: ReturnType<typeof mock>,
    variant: 'success' | 'error',
  ): { message: string; variant: string } | undefined {
    for (const call of showToast.mock.calls) {
      const body = (
        call[0] as { body?: { message?: string; variant?: string } } | undefined
      )?.body
      if (body?.variant === variant) {
        return body as { message: string; variant: string }
      }
    }
    return undefined
  }

  it('returns a failed result (not a success toast) when TUI-code callback persistence throws AccountStorageUnreadableError', async () => {
    const unreadable = buildUnreadableError()
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      unreadable,
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    // A failed persistence MUST surface as a `failed` result — never a
    // `success` toast with nothing saved to disk. The original maintainer
    // bug had the callback swallow the throw and return `type: 'success'`.
    expect(result?.type).toBe('failed')
    expect(findToastBody(showToast, 'success')).toBeUndefined()
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('unreadable')
    expect(errorToast?.message).toContain('/tmp/x.json')
    expect(errorToast?.message).toContain(
      '/tmp/x.json.corrupt-2026-07-23T12-00-00-000Z',
    )
  })

  it('returns a failed result when TUI-listener callback persistence throws AccountStorageUnreadableError', async () => {
    const unreadable = buildUnreadableError()
    const close = mock(async () => {})
    const listener: OAuthListener = {
      waitForCallback: mock(
        async () =>
          new URL(
            `http://localhost:51121/oauth-callback?code=code&state=${EXPECTED_STATE}`,
          ),
      ),
      close,
    }
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      unreadable,
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        startListener: mock(async () => listener),
        openBrowser: mock(async () => true),
        isHeadless: () => false,
        shouldSkipLocalServer: () => false,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'auto' }> | undefined
    )?.callback()

    expect(result?.type).toBe('failed')
    expect(findToastBody(showToast, 'success')).toBeUndefined()
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast?.message).toContain('unreadable')
    expect(errorToast?.message).toContain('/tmp/x.json')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns a failed result when persistence throws a generic lock-contention error', async () => {
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      new Error('lock contention: another writer holds the file lock'),
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    expect(result?.type).toBe('failed')
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast?.message).toContain('lock contention')
  })
})

// ---------------------------------------------------------------------------
// Account-store mode over the genuine published store
//
// The login menu's verification and re-authentication run against the
// released common-auth store and fs entries embedded in the core package
// through `loadCommonAuthStoreModules`. Check source-output.json and every
// payload against the released 0.12.0 archive first. Each private config
// directory has a genuinely initialized store, so login checks the completed
// initialization record rather than substituting an admission result.
// ---------------------------------------------------------------------------

const RELEASED_COMMON_AUTH = {
  package: '@cortexkit/common-auth',
  version: '0.12.0',
  tarballSha256:
    '35ce4c601c94e8aba94762fade7895047b3038b70c0d93753aa4d955bb04e951',
} as const

async function embeddedFilesBelow(
  root: string,
  dir: string,
): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await embeddedFilesBelow(root, path)))
    else out.push(path)
  }
  return out
}

let genuine: Promise<CommonAuthStoreModules> | undefined

/** The released store and fs entries, after their embedding receipt checks out. */
function genuineModules(): Promise<CommonAuthStoreModules> {
  genuine ??= (async () => {
    const root = dirname(
      dirname(
        Bun.resolveSync(
          '@cortexkit/antigravity-auth-core/common-auth/store',
          import.meta.dir,
        ),
      ),
    )
    const receipt = JSON.parse(
      await readFile(join(root, 'source-output.json'), 'utf8'),
    ) as {
      package?: unknown
      version?: unknown
      artifactStatus?: unknown
      tarballSha256?: unknown
      files?: Array<{ output: string; bytes: number; outputSha256: string }>
    }
    if (
      receipt.package !== RELEASED_COMMON_AUTH.package ||
      receipt.version !== RELEASED_COMMON_AUTH.version ||
      receipt.artifactStatus !== 'released' ||
      receipt.tarballSha256 !== RELEASED_COMMON_AUTH.tarballSha256 ||
      !Array.isArray(receipt.files)
    ) {
      throw new Error(
        `the embedded common-auth receipt is not the released ${RELEASED_COMMON_AUTH.version}`,
      )
    }
    const recorded = receipt.files.filter((file) =>
      /^(store|fs)\//.test(file.output),
    )
    const present = [
      ...(await embeddedFilesBelow(root, 'store')),
      ...(await embeddedFilesBelow(root, 'fs')),
    ].sort()
    if (
      JSON.stringify(present) !==
      JSON.stringify(recorded.map((file) => file.output).sort())
    ) {
      throw new Error('embedded store/fs files differ from the receipt')
    }
    for (const file of recorded) {
      const bytes = await readFile(join(root, file.output))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== file.bytes || sha256 !== file.outputSha256) {
        throw new Error(`embedded ${file.output} differs from the receipt`)
      }
    }
    return loadCommonAuthStoreModules()
  })()
  const owner = hooks.lifetime
  return owner
    .operation(genuine)
    .then((modules) => managedStoreModules(owner, modules))
}

describe('createOAuthMethods in account-store mode', () => {
  let configDir = ''
  let previousConfigDir: string | undefined
  const repositories: AccountRepository[] = []

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await realpath(
      await mkdtemp(join(tmpdir(), 'agy-oauth-store-')),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    for (const repository of repositories.splice(0)) await repository.dispose()
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  /** A served store holding rows A and B, and the menu's collaborators. */
  async function storeWithTwoAccounts(probe?: {
    onProbe?: (bearer: string) => Promise<void> | void
    status: number
    body: string
  }) {
    const modules = await genuineModules()
    expect((await initializeFreshAccountStoreFor(modules)).status).toBe(
      'completed',
    )
    const opening = await openAccountStore({
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange: async ({ refreshToken }) => ({
        accessToken: `access-for-${refreshToken}`,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
      }),
    })
    if (opening.status !== 'ready') throw new Error('store is not ready')
    const repository = opening.repository
    repositories.push(repository)
    await commitLogins(repository, [
      success('token-a', 'a@example.test'),
      success('token-b', 'b@example.test'),
    ])
    const bearers: string[] = []
    const transport = mock(async (_url: string, init?: RequestInit) => {
      const bearer =
        ((init?.headers ?? {}) as Record<string, string>).Authorization ?? ''
      bearers.push(bearer)
      await probe?.onProbe?.(bearer)
      return new Response(probe?.body ?? '', { status: probe?.status ?? 200 })
    })
    const refusePoolFile = async (): Promise<never> => {
      throw new Error('the pool file is not used in store mode')
    }
    const accountAccess = createAccountAccessService({
      client: {} as never,
      providerId: 'google',
      store: {
        load: refusePoolFile,
        mutate: refusePoolFile,
        clear: refusePoolFile,
        persistAccountPool: refusePoolFile,
        source: async () => repository,
      },
      openBrowser: async () => false,
      prompt: {
        selectAccount: async () => undefined,
        confirmOpenVerificationUrl: async () => false,
      },
      dependencies: { transport: transport as never },
    })
    const rows = async () => {
      const read = await repository.read()
      if (read.status !== 'ready') throw new Error('store is not ready')
      return read.rows
    }
    return { repository, accountAccess, bearers, rows }
  }

  function menuMethods(
    accountAccess: AccountAccessService,
    menu: Array<Record<string, unknown>>,
    exchange?: () => Promise<
      Extract<AntigravityTokenExchangeResult, { type: 'success' }>
    >,
  ) {
    return createOAuthMethods({
      client: { tui: { showToast: mock(async () => {}) } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess,
      dependencies: {
        promptLoginMode: mock(async () => menu.shift() ?? { mode: 'cancel' }),
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(
          exchange ?? (async () => success('unused', 'unused@example.test')),
        ),
        promptProjectId: mock(async () => ''),
        promptCallback: mock(async () => 'code'),
        promptAddAnotherAccount: mock(async () => false),
        openBrowser: mock(async () => false),
        shouldSkipLocalServer: () => true,
        isHeadless: () => false,
      } as never,
    })
  }

  it('verifies the listed row through its own attributed refresh and records the verdict on that row only', async () => {
    const store = await storeWithTwoAccounts({
      status: 403,
      body: JSON.stringify({ error: { message: 'validation_required' } }),
    })
    const methods = menuMethods(store.accountAccess, [
      { mode: 'verify', verifyAccountIndex: 1 },
      { mode: 'cancel' },
    ])
    await methods[0]?.authorize?.({ noBrowser: 'true' })

    expect(store.bearers).toEqual(['Bearer access-for-token-b'])
    const [rowA, rowB] = await store.rows()
    expect(rowB?.enabled).toBe(false)
    expect(
      rowB?.metadata.status === 'present'
        ? rowB.metadata.metadata.verificationRequired
        : undefined,
    ).toBe(true)
    expect(rowA?.enabled).toBe(true)
    expect(
      rowA?.metadata.status === 'present'
        ? rowA.metadata.metadata.verificationRequired
        : undefined,
    ).not.toBe(true)
  })

  it('drops a verdict whose row was re-authenticated while the probe ran', async () => {
    let replaced = false
    const holder: { repository?: AccountRepository } = {}
    const store = await storeWithTwoAccounts({
      status: 403,
      body: JSON.stringify({ error: { message: 'ACCOUNT_INELIGIBLE' } }),
      onProbe: async () => {
        if (replaced || holder.repository === undefined) return
        replaced = true
        const read = await holder.repository.read()
        const rowB = read.status === 'ready' ? read.rows[1] : undefined
        if (rowB === undefined) throw new Error('row B is missing')
        await holder.repository.replaceCredential(rowB.ref, {
          refreshToken: 'token-b2',
          disabled: 'keep',
        })
      },
    })
    holder.repository = store.repository
    const listed = (await store.rows())[1]?.ref
    const methods = menuMethods(store.accountAccess, [
      { mode: 'verify', verifyAccountIndex: 1 },
      { mode: 'cancel' },
    ])
    await methods[0]?.authorize?.({ noBrowser: 'true' })

    const rowB = (await store.rows())[1]
    expect(rowB?.ref.id).toBe(listed?.id)
    expect(rowB?.ref.credentialEpoch).toBe((listed?.credentialEpoch ?? 0) + 1)
    expect(rowB?.credential?.refreshToken).toBe('token-b2')
    expect(rowB?.enabled).toBe(true)
    expect(
      rowB?.metadata.status === 'present'
        ? rowB.metadata.metadata.accountIneligible
        : undefined,
    ).not.toBe(true)
  })

  it('re-authenticates exactly the listed row with a new credential epoch', async () => {
    const store = await storeWithTwoAccounts()
    const [listedA, listedB] = await store.rows()
    const methods = menuMethods(
      store.accountAccess,
      [{ mode: 'add', refreshAccountIndex: 0 }],
      async () => success('token-a2', 'a@example.test'),
    )
    await methods[0]?.authorize?.({ noBrowser: 'true' })

    const [rowA, rowB] = await store.rows()
    expect(rowA?.ref).toEqual({
      id: listedA!.ref.id,
      credentialEpoch: listedA!.ref.credentialEpoch + 1,
    })
    expect(rowA?.credential?.refreshToken).toBe('token-a2')
    expect(rowB?.ref).toEqual(listedB!.ref)
    expect(rowB?.credential?.refreshToken).toBe('token-b')
  })

  it('refuses a sign-in to another account, or to a row changed since the listing, with nothing written', async () => {
    const store = await storeWithTwoAccounts()
    const before = await store.rows()

    const wrongAccount = await menuMethods(
      store.accountAccess,
      [{ mode: 'add', refreshAccountIndex: 0 }],
      async () => success('token-x', 'x@example.test'),
    )[0]
      ?.authorize?.({ noBrowser: 'true' })
      .catch((error: unknown) => error)
    expect(wrongAccount).toBeInstanceOf(
      AccountChangedDuringReauthorizationError,
    )
    expect((wrongAccount as Error).message).toBe(
      'Account changed during reauthorization. Reopen the account dialog.',
    )
    expect(await store.rows()).toEqual(before)

    // The row is re-authenticated elsewhere after the menu listed it.
    const stale = await menuMethods(
      store.accountAccess,
      [{ mode: 'add', refreshAccountIndex: 1 }],
      async () => {
        const rowB = (await store.rows())[1]
        if (rowB === undefined) throw new Error('row B is missing')
        await store.repository.replaceCredential(rowB.ref, {
          refreshToken: 'token-b-elsewhere',
          disabled: 'keep',
        })
        return success('token-b-late', 'b@example.test')
      },
    )[0]
      ?.authorize?.({ noBrowser: 'true' })
      .catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(AccountChangedDuringReauthorizationError)
    const rowB = (await store.rows())[1]
    expect(rowB?.credential?.refreshToken).toBe('token-b-elsewhere')
  })
})
