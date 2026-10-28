import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type AccountMigrationOutcome,
  type AccountQuotaResult,
  type AccountStorageV4,
  createAccountRepositoryFactory,
  loadCommonAuthClaustrum,
  loadCommonAuthStoreModules,
  readAccountStoreAdmission,
} from '@cortexkit/antigravity-auth-core'

import type { CliAccountsRead, CliDependencies } from './cli'
import type { OAuthLoginRequest } from './plugin/oauth-methods'

const oauthResult = {
  type: 'success' as const,
  refresh: 'synthetic-new-refresh|synthetic-project',
  access: 'synthetic-access',
  expires: 123,
  email: 'new@example.test',
  projectId: 'synthetic-project',
}
const authorize = mock(async () => ({
  url: 'https://accounts.example.test/auth?state=synthetic-state',
  verifier: 'synthetic-verifier',
  projectId: 'synthetic-project',
}))
const exchange = mock(async () => oauthResult)
const startListener = mock(async () => ({
  waitForCallback: async () =>
    new URL(
      'http://localhost/oauth-callback?code=synthetic-code&state=synthetic-state',
    ),
  close: async () => {},
}))
// Only the OAuth wire boundary is synthetic; orchestration and disk stores are real.
mock.module('./antigravity/oauth', () => ({
  authorizeAntigravity: authorize,
  exchangeAntigravity: exchange,
}))
mock.module('./plugin/server', () => ({ startOAuthListener: startListener }))
const {
  createDefaultAccountStoreOperations,
  createDefaultCliDependencies,
  performOAuthLogin,
  runCli,
} = await import('./cli')

function accountStorage(): AccountStorageV4 {
  return {
    version: 4,
    activeIndex: 0,
    accounts: [
      {
        email: 'alpha@example.com',
        refreshToken: 'refresh-secret',
        projectId: 'project-secret',
        managedProjectId: 'managed-secret',
        fingerprint: {
          userAgent: 'fingerprint-secret',
          deviceId: 'device-secret',
          sessionToken: 'session-secret',
          apiClient: 'api-secret',
          clientMetadata: {
            ideType: 'cli',
            platform: 'linux',
            pluginType: 'standalone',
          },
          createdAt: 1,
        },
        enabled: true,
        addedAt: 1,
        lastUsed: 2,
      },
      {
        email: 'disabled@example.com',
        refreshToken: 'disabled-refresh',
        enabled: false,
        addedAt: 3,
        lastUsed: 4,
      },
    ],
  }
}

function createHarness(overrides: Partial<CliDependencies> = {}) {
  let stdout = ''
  let stderr = ''
  let touched = 0
  const loginRequests: OAuthLoginRequest[] = []

  const deps: CliDependencies = {
    stdout: {
      write: (value) => {
        stdout += value
      },
    },
    stderr: {
      write: (value) => {
        stderr += value
      },
    },
    prompt: async () => {
      touched += 1
      return ''
    },
    openBrowser: async () => {
      touched += 1
    },
    performLogin: async (request, openBrowser) => {
      touched += 1
      loginRequests.push(request)
      if (!request.noBrowser) await openBrowser('https://accounts.example/auth')
      return {
        type: 'success',
        refresh: 'new-refresh|new-project',
        access: 'new-access',
        expires: 123,
        email: 'new@example.com',
        projectId: 'new-project',
      }
    },
    loadAccounts: async () => {
      touched += 1
      return accountStorage()
    },
    getQuota: async () => {
      touched += 1
      return []
    },
    accountStore: {
      legacyPath: () => '/isolated/antigravity-accounts.json',
      migrate: async () => {
        touched += 1
        throw new Error('migrate was not expected')
      },
      rollback: async () => {
        touched += 1
        throw new Error('rollback was not expected')
      },
      initialize: async () => {
        touched += 1
        throw new Error('initialize was not expected')
      },
      read: async () => ({ kind: 'legacy' }),
    },
    ...overrides,
  }

  return {
    deps,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    get touched() {
      return touched
    },
    loginRequests,
  }
}

describe('runCli parser', () => {
  it('prints help without touching operational dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['--help'], harness.deps)).toBe(0)
    expect(harness.stdout).toContain('Usage: antigravity-auth')
    expect(harness.stdout).toContain('login [--project <id>] [--no-browser]')
    expect(harness.stdout).toContain('list [--json]')
    expect(harness.stdout).toContain('quota [--json] [--refresh]')
    expect(harness.stderr).toBe('')
    expect(harness.touched).toBe(0)
  })

  it('rejects unknown commands before touching dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['wat'], harness.deps)).toBe(2)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toContain('Unknown command: wat')
    expect(harness.touched).toBe(0)
  })

  it('rejects a missing project argument before touching dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['login', '--project'], harness.deps)).toBe(2)
    expect(harness.stderr).toContain('Missing value for --project')
    expect(harness.touched).toBe(0)
  })

  it('rejects unsupported command options', async () => {
    const harness = createHarness()

    expect(await runCli(['list', '--refresh'], harness.deps)).toBe(2)
    expect(harness.stderr).toContain('Unknown option for list: --refresh')
    expect(harness.touched).toBe(0)
  })
})

describe('runCli commands', () => {
  it('passes login flags through the injected boundary', async () => {
    const harness = createHarness()

    expect(
      await runCli(
        ['login', '--project', 'my-project', '--no-browser'],
        harness.deps,
      ),
    ).toBe(0)
    expect(harness.loginRequests).toEqual([
      {
        projectId: 'my-project',
        noBrowser: true,
        isHeadless: false,
        refreshAccountIndex: undefined,
        accounts: [],
        startFresh: true,
      },
    ])
    expect(harness.touched).toBe(1)
    expect(harness.stdout).toContain('Authenticated new@example.com')
    expect(harness.stderr).toBe('')
  })

  it('opens the authorization URL during browser login', async () => {
    let opened = ''
    const harness = createHarness({
      openBrowser: async (url) => {
        opened = url
      },
    })

    expect(await runCli(['login'], harness.deps)).toBe(0)
    expect(opened).toBe('https://accounts.example/auth')
  })

  it('returns one and writes operational failures to stderr', async () => {
    const harness = createHarness({
      performLogin: async () => {
        throw new Error('callback failed')
      },
    })

    expect(await runCli(['login'], harness.deps)).toBe(1)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toBe('callback failed\n')
  })

  it('prints stage and code with a store relocate failure', async () => {
    const harness = createHarness()
    harness.deps.accountStore.relocate = async () => {
      throw Object.assign(new Error('owner write failed'), {
        stage: 'owner-write',
        code: 'ENOENT',
      })
    }

    expect(
      await runCli(['store', 'relocate', '--offline', '--yes'], harness.deps),
    ).toBe(1)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toBe(
      'owner write failed (stage: owner-write, code: ENOENT)\n',
    )
  })

  it('keeps a stageless store relocate failure to its message', async () => {
    const harness = createHarness()
    harness.deps.accountStore.relocate = async () => {
      throw new Error('relocation unavailable')
    }

    expect(
      await runCli(['store', 'relocate', '--offline', '--yes'], harness.deps),
    ).toBe(1)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toBe('relocation unavailable\n')
  })

  it('prints redacted parseable account JSON without prose', async () => {
    const harness = createHarness()

    expect(await runCli(['list', '--json'], harness.deps)).toBe(0)
    const value = JSON.parse(harness.stdout) as unknown
    expect(value).toEqual({
      accounts: [
        { index: 1, email: 'alpha@example.com', status: 'active' },
        { index: 2, email: 'disabled@example.com', status: 'disabled' },
      ],
    })
    expect(harness.stdout).not.toContain('refresh-secret')
    expect(harness.stdout).not.toContain('access-secret')
    expect(harness.stdout).not.toContain('project-secret')
    expect(harness.stdout).not.toContain('fingerprint-secret')
    expect(harness.stderr).toBe('')
  })

  it('prints a stable human account table', async () => {
    const harness = createHarness()

    expect(await runCli(['list'], harness.deps)).toBe(0)
    expect(harness.stdout).toBe(
      'INDEX  EMAIL                 STATUS\n' +
        '1      alpha@example.com     active\n' +
        '2      disabled@example.com  disabled\n',
    )
  })

  it('prints quota JSON with groups and partial failures', async () => {
    const results: AccountQuotaResult[] = [
      {
        index: 0,
        email: 'alpha@example.com',
        status: 'ok',
        quota: {
          groups: {
            'non-gemini': {
              remainingFraction: 0.25,
              resetTime: '2026-07-22T12:00:00.000Z',
              modelCount: 2,
            },
          },
          modelCount: 2,
        },
      },
      {
        index: 1,
        email: 'disabled@example.com',
        status: 'error',
        error: 'quota unavailable',
      },
    ]
    let refresh = false
    const harness = createHarness({
      getQuota: async (_accounts, options) => {
        refresh = options.refresh
        return results
      },
    })

    expect(await runCli(['quota', '--json', '--refresh'], harness.deps)).toBe(0)
    expect(refresh).toBe(true)
    expect(JSON.parse(harness.stdout)).toEqual({
      accounts: [
        {
          index: 1,
          email: 'alpha@example.com',
          status: 'ok',
          groups: [
            {
              name: 'non-gemini',
              remainingPercent: 25,
              resetTime: '2026-07-22T12:00:00.000Z',
            },
          ],
        },
        {
          index: 2,
          email: 'disabled@example.com',
          status: 'error',
          error: 'quota unavailable',
          groups: [],
        },
      ],
    })
  })

  it('prints a stable human quota table', async () => {
    const harness = createHarness({
      getQuota: async () => [
        {
          index: 0,
          email: 'alpha@example.com',
          status: 'ok',
          quota: {
            groups: {
              'non-gemini': { remainingFraction: 0.25, modelCount: 1 },
            },
            modelCount: 1,
          },
        },
        {
          index: 1,
          email: 'disabled@example.com',
          status: 'error',
          error: 'quota unavailable',
        },
      ],
    })

    expect(await runCli(['quota'], harness.deps)).toBe(0)
    expect(harness.stdout).toBe(
      'ACCOUNT               STATUS  GROUP       REMAINING  RESET\n' +
        'alpha@example.com     ok      non-gemini  25%        -\n' +
        'disabled@example.com  error   -           -          quota unavailable\n',
    )
  })
})

describe('runCli account store commands', () => {
  const completed = (
    status: 'active' | 'inactive',
  ): AccountMigrationOutcome => ({
    status: 'completed',
    receipt: {
      id: 'generation-1',
      status,
      legacyPath: '/isolated/antigravity-accounts.json',
      storeDir: '/isolated/antigravity-accounts.json.store',
      sourceKind: 'file',
      durability: 'posix-directory-synced',
      restartRequired: true,
    },
  })

  function storeHarness(prompted: string) {
    const calls: string[] = []
    const harness = createHarness({
      prompt: async () => prompted,
      accountStore: {
        legacyPath: () => '/isolated/antigravity-accounts.json',
        migrate: async (path) => {
          calls.push(`migrate:${path}`)
          return completed('active')
        },
        rollback: async (path) => {
          calls.push(`rollback:${path}`)
          return completed('inactive')
        },
        initialize: async (path) => {
          calls.push(`initialize:${path}`)
          return completed('active')
        },
        read: async () => ({ kind: 'legacy' }),
      },
    })
    return { harness, calls }
  }

  it('refuses migrate and rollback without --offline before any effect', async () => {
    for (const command of ['migrate', 'rollback']) {
      const { harness, calls } = storeHarness('yes')
      expect(await runCli([command], harness.deps)).toBe(2)
      expect(harness.stderr).toContain('--offline')
      expect(calls).toEqual([])
    }
  })

  it('migrates only after the operator types yes', async () => {
    const declined = storeHarness('no')
    expect(await runCli(['migrate', '--offline'], declined.harness.deps)).toBe(
      1,
    )
    expect(declined.calls).toEqual([])

    const accepted = storeHarness('yes')
    expect(await runCli(['migrate', '--offline'], accepted.harness.deps)).toBe(
      0,
    )
    expect(accepted.calls).toEqual([
      'migrate:/isolated/antigravity-accounts.json',
    ])
    expect(accepted.harness.stdout).toContain('generation-1 is active')
    expect(accepted.harness.stdout).toContain('Restart OpenCode')
  })

  it('rolls back with --yes and reports a pending lock without success', async () => {
    const { harness, calls } = storeHarness('')
    expect(await runCli(['rollback', '--offline', '--yes'], harness.deps)).toBe(
      0,
    )
    expect(calls).toEqual(['rollback:/isolated/antigravity-accounts.json'])

    const pending = createHarness({
      accountStore: {
        legacyPath: () => '/isolated/antigravity-accounts.json',
        migrate: async () => ({
          status: 'pending',
          reason: 'lock-contention',
        }),
        rollback: async () => completed('inactive'),
        initialize: async () => completed('active'),
        read: async () => ({ kind: 'legacy' }),
      },
    })
    expect(await runCli(['migrate', '--offline', '--yes'], pending.deps)).toBe(
      1,
    )
    expect(pending.stderr).toContain('lock-contention')
    expect(pending.stdout).toBe('')
  })

  it('initializes a fresh store only through the explicit init command', async () => {
    const { harness, calls } = storeHarness('')
    expect(await runCli(['init'], harness.deps)).toBe(0)
    expect(calls).toEqual(['initialize:/isolated/antigravity-accounts.json'])
    expect(await runCli(['init', '--force'], harness.deps)).toBe(2)
  })
})

describe('runCli reads the active account store', () => {
  const operations = (read: CliAccountsRead) => ({
    legacyPath: () => '/isolated/antigravity-accounts.json',
    migrate: async () => {
      throw new Error('not expected')
    },
    rollback: async () => {
      throw new Error('not expected')
    },
    initialize: async () => {
      throw new Error('not expected')
    },
    read: async () => read,
  })

  it('lists store accounts without reading the retired account file', async () => {
    let legacyReads = 0
    const harness = createHarness({
      loadAccounts: async () => {
        legacyReads += 1
        return accountStorage()
      },
      accountStore: operations({
        kind: 'store',
        accounts: [
          {
            email: 'store@example.com',
            refreshToken: 'store-refresh-secret',
            addedAt: 1,
            lastUsed: 1,
            enabled: false,
          },
        ],
      }),
    })
    expect(await runCli(['list', '--json'], harness.deps)).toBe(0)
    expect(JSON.parse(harness.stdout)).toEqual({
      accounts: [{ index: 1, email: 'store@example.com', status: 'disabled' }],
    })
    expect(legacyReads).toBe(0)
    expect(harness.stdout).not.toContain('secret')
  })

  it('refuses list and quota while a migration is unfinished', async () => {
    const harness = createHarness({
      accountStore: operations({
        kind: 'unavailable',
        reason: 'an account-store migrate is unfinished',
      }),
    })
    expect(await runCli(['quota'], harness.deps)).toBe(1)
    expect(harness.stderr).toContain('unfinished')
    expect(harness.stdout).toBe('')
  })

  it('reads a genuine fresh store through the default operations', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-cli-')))
    try {
      const legacyPath = join(root, 'antigravity-accounts.json')
      const store = createDefaultAccountStoreOperations()
      expect(await store.read(legacyPath)).toEqual({ kind: 'uninitialized' })
      const initialized = await store.initialize(legacyPath)
      expect(initialized.status).toBe('completed')

      const modules = await loadCommonAuthStoreModules()
      const admission = await readAccountStoreAdmission(
        legacyPath,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const repository = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async () => {
          throw new Error('token exchange is not part of this test')
        },
      })
      await repository.login({
        id: crypto.randomUUID(),
        refreshToken: 'store-refresh',
        identity: 'store@example.com',
        metadata: { email: 'store@example.com', addedAt: 5, lastUsed: 6 },
      })
      await repository.dispose()

      const read = await store.read(legacyPath)
      expect(read).toEqual({
        kind: 'store',
        accounts: [
          {
            email: 'store@example.com',
            refreshToken: 'store-refresh',
            addedAt: 5,
            lastUsed: 6,
            enabled: true,
          },
        ],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('default CLI real-store login', () => {
  const roots: string[] = []
  const originalEnv = { ...process.env }
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
    authorize.mockClear()
    exchange.mockClear()
    startListener.mockClear()
  })

  function profile() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-store-login-')))
    roots.push(root)
    const home = join(root, 'home')
    const config = join(root, 'config', 'opencode')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(config, { recursive: true, mode: 0o700 })
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DB: join(root, 'isolated.db'),
      PI_AGENT_DIR: join(root, 'pi-decoy'),
      PI_CODING_AGENT_DIR: join(root, 'pi-native'),
      PI_ANTIGRAVITY_AUTH_FILE: join(root, 'pi-decoy', 'accounts.json'),
      SUBC_CONNECTION_FILE: join(root, 'absent-connection.json'),
      CLAUSTRUM_SUBC_CONNECTION: join(root, 'absent-connection.json'),
      PATH: '/usr/bin:/bin',
    }
    Object.assign(process.env, env)
    const deps = createDefaultCliDependencies()
    let errors = ''
    deps.stdout = { write() {} }
    deps.stderr = { write: (value) => (errors += value) }
    deps.openBrowser = mock(async () => {})
    deps.isHeadless = () => false
    deps.setupIO = { env, home }
    return {
      root,
      config,
      deps,
      legacyPath: deps.accountStore.legacyPath(),
      nativePath: join(env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      errors: () => errors,
    }
  }

  async function seed(p: ReturnType<typeof profile>, populated = false) {
    expect((await p.deps.accountStore.initialize(p.legacyPath)).status).toBe(
      'completed',
    )
    if (!populated) return
    const modules = await loadCommonAuthStoreModules()
    const admission = await readAccountStoreAdmission(
      p.legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const repository = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('refresh must not run during login')
      },
    })
    try {
      await repository.login({
        id: crypto.randomUUID(),
        refreshToken: 'synthetic-original-refresh',
        identity: 'original@example.test',
        metadata: { email: 'original@example.test', addedAt: 1, lastUsed: 2 },
      })
    } finally {
      await repository.dispose()
    }
  }

  async function accounts(p: ReturnType<typeof profile>) {
    const read = await p.deps.accountStore.read(p.legacyPath)
    if (read.kind !== 'store')
      throw new Error(`expected store, got ${read.kind}`)
    return read.accounts
  }

  function snapshot(root: string, prefix = ''): unknown[] {
    return readdirSync(join(root, prefix))
      .sort()
      .flatMap((name): unknown[] => {
        const path = join(prefix, name)
        const stat = statSync(join(root, path))
        const row = [
          path,
          stat.mode,
          stat.mtimeMs,
          stat.ctimeMs,
          stat.isDirectory()
            ? 'directory'
            : readFileSync(join(root, path)).toString('base64'),
        ]
        return stat.isDirectory() ? [row, ...snapshot(root, path)] : [row]
      })
  }

  it('fresh login initializes the current store without creating a legacy pool', async () => {
    const p = profile()
    expect(await runCli(['login'], p.deps)).toBe(0)
    expect(p.errors()).toBe('')
    expect(await accounts(p)).toMatchObject([
      { email: oauthResult.email, refreshToken: 'synthetic-new-refresh' },
    ])
    expect(existsSync(p.legacyPath)).toBe(false)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(exchange).toHaveBeenCalledTimes(1)
  })

  it('native vault marker refuses fresh login before OAuth or initialization', async () => {
    const p = profile()
    const claustrum = await loadCommonAuthClaustrum()
    mkdirSync(dirname(p.nativePath), { recursive: true, mode: 0o700 })
    writeFileSync(
      p.nativePath,
      JSON.stringify({ google: claustrum.custodyPlaceholder('google') }),
      { mode: 0o600 },
    )
    const before = snapshot(p.root)
    expect(await runCli(['login'], p.deps)).toBe(1)
    expect(p.errors()).not.toBe('')
    expect(authorize).not.toHaveBeenCalled()
    expect(startListener).not.toHaveBeenCalled()
    expect(p.deps.openBrowser).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
    expect(await p.deps.accountStore.read(p.legacyPath)).toEqual({
      kind: 'uninitialized',
    })
  })

  it('native source changing during OAuth refuses persistence into the real store', async () => {
    const p = profile()
    await seed(p, true)
    const claustrum = await loadCommonAuthClaustrum()
    exchange.mockImplementationOnce(async () => {
      mkdirSync(dirname(p.nativePath), { recursive: true, mode: 0o700 })
      writeFileSync(
        p.nativePath,
        JSON.stringify({ google: claustrum.custodyPlaceholder('google') }),
        { mode: 0o600 },
      )
      return oauthResult
    })
    expect(await runCli(['login'], p.deps)).toBe(1)
    expect(p.errors()).not.toBe('')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(await accounts(p)).toMatchObject([
      {
        email: 'original@example.test',
        refreshToken: 'synthetic-original-refresh',
      },
    ])
    expect(JSON.parse(readFileSync(p.nativePath, 'utf8')).google).toEqual(
      claustrum.custodyPlaceholder('google'),
    )
    expect(existsSync(p.legacyPath)).toBe(false)
  })

  it('initialized empty login commits into the current store', async () => {
    const p = profile()
    await seed(p)
    expect(await runCli(['login'], p.deps)).toBe(0)
    expect(p.errors()).toBe('')
    expect(await accounts(p)).toMatchObject([{ email: oauthResult.email }])
    expect(existsSync(p.legacyPath)).toBe(false)
  })

  it.each([
    false,
    true,
  ])('add preserves the original account and commits the new login (startFresh=%s)', async (startFresh) => {
    const p = profile()
    await seed(p, true)
    await p.deps.performLogin(
      {
        noBrowser: false,
        isHeadless: false,
        accounts: startFresh
          ? [{ ...oauthResult, refresh: 'earlier-result' }]
          : [],
        startFresh,
      },
      p.deps.openBrowser,
    )
    expect(await accounts(p)).toMatchObject([
      {
        email: 'original@example.test',
        refreshToken: 'synthetic-original-refresh',
      },
      { email: oauthResult.email, refreshToken: 'synthetic-new-refresh' },
    ])
    expect(existsSync(p.legacyPath)).toBe(false)
  })

  it('replace uses the attributed repository replacement', async () => {
    const p = profile()
    await seed(p, true)
    expect(await runCli(['login'], p.deps)).toBe(0)
    expect(p.errors()).toBe('')
    expect(await accounts(p)).toMatchObject([{ email: oauthResult.email }])
    expect(existsSync(p.legacyPath)).toBe(false)
    const admission = await readAccountStoreAdmission(
      p.legacyPath,
      await loadCommonAuthStoreModules(),
      Date.now,
    )
    expect(admission.status).toBe('active')
  })

  it('pending legacy migration refuses before OAuth with unchanged bytes and metadata', async () => {
    const p = profile()
    // The pre-store account file where this process's store path names it:
    // the account store's anchor for a config folder in the state folder.
    writeFileSync(p.legacyPath, JSON.stringify(accountStorage()), {
      mode: 0o600,
    })
    const before = snapshot(p.root)
    expect(await runCli(['login'], p.deps)).toBe(1)
    expect(p.errors()).toContain('offline migration')
    expect(authorize).not.toHaveBeenCalled()
    expect(startListener).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
    expect(p.deps.openBrowser).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })

  it('setup --login refuses pending migration before OAuth or native activation', async () => {
    const p = profile()
    // The pre-store account file where this process's store path names it:
    // the account store's anchor for a config folder in the state folder.
    writeFileSync(p.legacyPath, JSON.stringify(accountStorage()), {
      mode: 0o600,
    })
    const before = snapshot(p.root)
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=1', '--login'],
        p.deps,
      ),
    ).toBe(1)
    expect(p.errors()).toContain('offline migration')
    expect(authorize).not.toHaveBeenCalled()
    expect(startListener).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
    expect(p.deps.openBrowser).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })

  it('fresh setup --login initializes the store and activates V1 without a legacy bootstrap', async () => {
    const p = profile()
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=1', '--login'],
        p.deps,
      ),
    ).toBe(0)
    expect(p.errors()).toBe('')
    expect(await accounts(p)).toMatchObject([{ email: oauthResult.email }])
    expect(existsSync(p.legacyPath)).toBe(false)
    expect(JSON.parse(readFileSync(p.nativePath, 'utf8')).google.refresh).toBe(
      oauthResult.refresh,
    )
  })

  it('setup --login persists before native V1 activation and retains unrelated accounts', async () => {
    const p = profile()
    await seed(p, true)
    exchange.mockImplementationOnce(async () => {
      expect(existsSync(p.nativePath)).toBe(false)
      return oauthResult
    })
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=1', '--login'],
        p.deps,
      ),
    ).toBe(0)
    expect(p.errors()).toBe('')
    expect(await accounts(p)).toMatchObject([
      { email: 'original@example.test' },
      { email: oauthResult.email },
    ])
    expect(JSON.parse(readFileSync(p.nativePath, 'utf8')).google).toEqual({
      type: 'oauth',
      refresh: oauthResult.refresh,
      access: oauthResult.access,
      expires: oauthResult.expires,
    })
    if (process.platform !== 'win32')
      expect(statSync(p.nativePath).mode & 0o777).toBe(0o600)
    expect(existsSync(p.legacyPath)).toBe(false)
  })

  it('setup --login never activates V1 when persistence refuses a successor credential', async () => {
    const p = profile()
    await seed(p, true)
    exchange.mockImplementationOnce(async () => ({
      ...oauthResult,
      email: 'original@example.test',
    }))
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=1', '--login'],
        p.deps,
      ),
    ).toBe(1)
    expect(p.errors()).toContain('re-authentication')
    expect(existsSync(p.nativePath)).toBe(false)
    expect(await accounts(p)).toMatchObject([
      {
        email: 'original@example.test',
        refreshToken: 'synthetic-original-refresh',
      },
    ])
  })

  it('pure OpenCode 2 setup defers OAuth and leaves the V1 slot untouched', async () => {
    const p = profile()
    expect(
      await runCli(
        ['setup', '--yes', '--no-claustrum', '--opencode=2', '--login'],
        p.deps,
      ),
    ).toBe(0)
    expect(p.errors()).toBe('')
    expect(authorize).not.toHaveBeenCalled()
    expect(startListener).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
    expect(existsSync(p.nativePath)).toBe(false)
    expect(existsSync(p.legacyPath)).toBe(false)
  })
})

describe('performOAuthLogin', () => {
  const request: OAuthLoginRequest = {
    projectId: 'project-id',
    noBrowser: false,
    isHeadless: false,
    refreshAccountIndex: undefined,
    accounts: [],
    startFresh: true,
  }

  it('opens, waits, exchanges once, persists once, and closes the listener', async () => {
    let opened = ''
    let exchanges = 0
    let upserts = 0
    let closes = 0

    const result = await performOAuthLogin(request, {
      authorize: async () => ({
        url: 'https://accounts.example/auth?state=expected',
        verifier: 'verifier',
        projectId: 'project-id',
      }),
      exchange: async (code, state) => {
        exchanges += 1
        expect(code).toBe('oauth-code')
        expect(state).toBe('expected')
        return {
          type: 'success',
          refresh: 'refresh|project-id',
          access: 'access',
          expires: 123,
          email: 'alpha@example.com',
          projectId: 'project-id',
        }
      },
      startListener: async () => ({
        waitForCallback: async () =>
          new URL(
            'http://localhost:51121/oauth-callback?code=oauth-code&state=expected',
          ),
        close: async () => {
          closes += 1
        },
      }),
      openBrowser: async (url) => {
        opened = url
      },
      upsert: async () => {
        upserts += 1
      },
    })

    expect(result.email).toBe('alpha@example.com')
    expect(opened).toBe('https://accounts.example/auth?state=expected')
    expect(exchanges).toBe(1)
    expect(upserts).toBe(1)
    expect(closes).toBe(1)
  })

  it('does not open a browser with --no-browser', async () => {
    let opens = 0
    const result = await performOAuthLogin(
      { ...request, noBrowser: true },
      {
        authorize: async () => ({
          url: 'https://accounts.example/auth?state=expected',
          verifier: 'verifier',
          projectId: 'project-id',
        }),
        exchange: async () => ({
          type: 'success',
          refresh: 'refresh|project-id',
          access: 'access',
          expires: 123,
          projectId: 'project-id',
        }),
        startListener: async () => ({
          waitForCallback: async () =>
            new URL(
              'http://localhost:51121/oauth-callback?code=code&state=expected',
            ),
          close: async () => {},
        }),
        openBrowser: async () => {
          opens += 1
        },
        upsert: async () => {},
      },
    )

    expect(result.type).toBe('success')
    expect(opens).toBe(0)
  })

  it('closes the listener and leaves storage unchanged when callback validation fails', async () => {
    let exchanges = 0
    let upserts = 0
    let closes = 0

    await expect(
      performOAuthLogin(request, {
        authorize: async () => ({
          url: 'https://accounts.example/auth?state=expected',
          verifier: 'verifier',
          projectId: 'project-id',
        }),
        exchange: async () => {
          exchanges += 1
          return {
            type: 'failed',
            error: 'not reached',
          }
        },
        startListener: async () => ({
          waitForCallback: async () =>
            new URL(
              'http://localhost:51121/oauth-callback?code=code&state=wrong',
            ),
          close: async () => {
            closes += 1
          },
        }),
        openBrowser: async () => {},
        upsert: async () => {
          upserts += 1
        },
      }),
    ).rejects.toThrow('OAuth state mismatch')

    expect(exchanges).toBe(0)
    expect(upserts).toBe(0)
    expect(closes).toBe(1)
  })
})
