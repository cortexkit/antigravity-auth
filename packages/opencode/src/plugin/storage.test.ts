import { beforeEach, describe, expect, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountRepository,
  type AccountTokenExchange,
  type CommonAuthStoreModules,
  createAccountMigrationFactory,
  createAccountRepositoryFactory,
} from '@cortexkit/antigravity-auth-core'
import { lifetimeHooks } from '../../../../test/fixtures/lifetime-hooks.ts'
import { AnchorLockTrace } from './__fixtures__/anchor-lock-trace.test'
import { managedStoreModules } from './__fixtures__/managed-store.test.ts'
import { loadVerifiedStoreModules } from './__fixtures__/verified-store'
import { createRepositoryAccountAccessService } from './account-access'
import {
  createLocalAccountCredentials,
  loadAccountManagerFromRepository,
} from './accounts'
import { commitLogins, persistAccountPool } from './persist-account-pool'
import {
  type AccountMetadataV2 as AccountMetadata,
  type AccountStorageV2 as AccountStorage,
  type AccountStorageV4,
  accountFileForVault,
  assertLegacyPoolInUse,
  clearAccounts,
  deduplicateAccountsByEmail,
  ensureGitignore,
  ensureGitignoreSync,
  getStoragePath,
  initializeFreshAccountStoreFor,
  LegacyAccountPoolRetiredError,
  loadAccounts,
  mergeAccountStorage,
  migrateV2ToV3,
  mutateAccountByRefreshToken,
  mutateAccountStorage,
  type OpenAccountStoreOptions,
  openAccountStore,
  openAccountStoreForRecovery,
  saveAccounts,
  saveAccountsReplace,
} from './storage'

const hooks = lifetimeHooks()
const { it, afterEach } = hooks

describe('deduplicateAccountsByEmail', () => {
  it('returns empty array for empty input', () => {
    const result = deduplicateAccountsByEmail([])
    expect(result).toEqual([])
  })

  it('returns single account unchanged', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'test@example.com',
        refreshToken: 'r1',
        addedAt: 1000,
        lastUsed: 2000,
      },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toEqual(accounts)
  })

  it('keeps accounts without email (cannot deduplicate)', () => {
    const accounts: AccountMetadata[] = [
      { refreshToken: 'r1', addedAt: 1000, lastUsed: 2000 },
      { refreshToken: 'r2', addedAt: 1100, lastUsed: 2100 },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(2)
    expect(result[0]?.refreshToken).toBe('r1')
    expect(result[1]?.refreshToken).toBe('r2')
  })

  it('deduplicates accounts with same email, keeping newest by lastUsed', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'test@example.com',
        refreshToken: 'old-token',
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: 'test@example.com',
        refreshToken: 'new-token',
        addedAt: 2000,
        lastUsed: 3000,
      },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(1)
    expect(result[0]?.refreshToken).toBe('new-token')
    expect(result[0]?.email).toBe('test@example.com')
  })

  it('deduplicates accounts with same email, keeping newest by addedAt when lastUsed is equal', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'test@example.com',
        refreshToken: 'old-token',
        addedAt: 1000,
        lastUsed: 0,
      },
      {
        email: 'test@example.com',
        refreshToken: 'new-token',
        addedAt: 2000,
        lastUsed: 0,
      },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(1)
    expect(result[0]?.refreshToken).toBe('new-token')
  })

  it('handles multiple duplicate emails correctly', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'alice@example.com',
        refreshToken: 'alice-old',
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: 'bob@example.com',
        refreshToken: 'bob-old',
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: 'alice@example.com',
        refreshToken: 'alice-new',
        addedAt: 2000,
        lastUsed: 3000,
      },
      {
        email: 'bob@example.com',
        refreshToken: 'bob-new',
        addedAt: 2000,
        lastUsed: 3000,
      },
      {
        email: 'alice@example.com',
        refreshToken: 'alice-mid',
        addedAt: 1500,
        lastUsed: 2000,
      },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(2)

    const alice = result.find((a) => a.email === 'alice@example.com')
    const bob = result.find((a) => a.email === 'bob@example.com')

    expect(alice?.refreshToken).toBe('alice-new')
    expect(bob?.refreshToken).toBe('bob-new')
  })

  it('preserves order of kept accounts based on newest entry index', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'first@example.com',
        refreshToken: 'first-old',
        addedAt: 1000,
        lastUsed: 1000,
      },
      {
        email: 'second@example.com',
        refreshToken: 'second-new',
        addedAt: 3000,
        lastUsed: 3000,
      },
      {
        email: 'first@example.com',
        refreshToken: 'first-new',
        addedAt: 2000,
        lastUsed: 2000,
      },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(2)
    expect(result[0]?.email).toBe('second@example.com')
    expect(result[1]?.email).toBe('first@example.com')
  })

  it('mixes accounts with and without email correctly', () => {
    const accounts: AccountMetadata[] = [
      {
        email: 'test@example.com',
        refreshToken: 'r1',
        addedAt: 1000,
        lastUsed: 1000,
      },
      { refreshToken: 'no-email-1', addedAt: 1500, lastUsed: 1500 },
      {
        email: 'test@example.com',
        refreshToken: 'r2',
        addedAt: 2000,
        lastUsed: 2000,
      },
      { refreshToken: 'no-email-2', addedAt: 2500, lastUsed: 2500 },
    ]
    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(3)

    expect(result[0]?.refreshToken).toBe('no-email-1')
    expect(result[1]?.refreshToken).toBe('r2')
    expect(result[2]?.refreshToken).toBe('no-email-2')
  })

  it('handles exact scenario from issue #24 (11 duplicate accounts)', () => {
    const accounts: AccountMetadata[] = []
    for (let i = 0; i < 11; i++) {
      accounts.push({
        email: 'user@example.com',
        refreshToken: `token-${i}`,
        addedAt: 1000 + i * 100,
        lastUsed: 1000 + i * 100,
      })
    }

    const result = deduplicateAccountsByEmail(accounts)
    expect(result).toHaveLength(1)
    expect(result[0]?.refreshToken).toBe('token-10')
    expect(result[0]?.email).toBe('user@example.com')
  })
})

describe('mergeAccountStorage eligibility state', () => {
  const storage = (
    account: AccountStorageV4['accounts'][number],
  ): AccountStorageV4 => ({
    version: 4,
    accounts: [account],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  })

  it('preserves a newer ineligible decision against a stale concurrent writer', () => {
    const existing = storage({
      refreshToken: 'r1',
      addedAt: 1,
      lastUsed: 1,
      enabled: false,
      accountIneligible: true,
      accountIneligibleAt: 200,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
      eligibilityStateUpdatedAt: 200,
    })
    const staleIncoming = storage({
      refreshToken: 'r1',
      addedAt: 1,
      lastUsed: 2,
      enabled: true,
      accountIneligible: false,
      eligibilityStateUpdatedAt: 100,
    })

    expect(
      mergeAccountStorage(existing, staleIncoming).accounts[0],
    ).toMatchObject({
      enabled: false,
      accountIneligible: true,
      accountIneligibleAt: 200,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
      eligibilityStateUpdatedAt: 200,
    })
  })

  it('accepts a newer successful eligibility recheck', () => {
    const existing = storage({
      refreshToken: 'r1',
      addedAt: 1,
      lastUsed: 1,
      enabled: false,
      accountIneligible: true,
      accountIneligibleAt: 200,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
      eligibilityStateUpdatedAt: 200,
    })
    const rechecked = storage({
      refreshToken: 'r1',
      addedAt: 1,
      lastUsed: 2,
      enabled: true,
      accountIneligible: false,
      eligibilityStateUpdatedAt: 300,
    })

    expect(mergeAccountStorage(existing, rechecked).accounts[0]).toMatchObject({
      enabled: true,
      accountIneligible: false,
      eligibilityStateUpdatedAt: 300,
    })
  })
})

describe('Storage Migration', () => {
  const now = Date.now()
  const future = now + 100000
  const past = now - 100000

  describe('migrateV2ToV3', () => {
    it('converts gemini rate limits to gemini-antigravity', () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      }

      const v3 = migrateV2ToV3(v2)

      expect(v3.version).toBe(3)
      const account = v3.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toEqual({
        'gemini-antigravity': future,
      })
      expect(account.rateLimitResetTimes?.['gemini-cli']).toBeUndefined()
    })

    it('preserves claude rate limits', () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: future,
            },
          },
        ],
        activeIndex: 0,
      }

      const v3 = migrateV2ToV3(v2)
      const account = v3.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toEqual({
        claude: future,
      })
    })

    it('handles mixed rate limits correctly', () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: future,
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      }

      const v3 = migrateV2ToV3(v2)
      const account = v3.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toEqual({
        claude: future,
        'gemini-antigravity': future,
      })
    })

    it('filters out expired rate limits', () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: past,
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      }

      const v3 = migrateV2ToV3(v2)
      const account = v3.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toEqual({
        'gemini-antigravity': future,
      })
      expect(account.rateLimitResetTimes?.claude).toBeUndefined()
    })

    it('removes rateLimitResetTimes object if all keys are expired', () => {
      const v2: AccountStorage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              claude: past,
              gemini: past,
            },
          },
        ],
        activeIndex: 0,
      }

      const v3 = migrateV2ToV3(v2)
      const account = v3.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toBeUndefined()
    })
  })

  describe('loadAccounts migration integration', () => {
    let configDir: string
    let previousConfigDir: string | undefined

    beforeEach(async () => {
      previousConfigDir = process.env.OPENCODE_CONFIG_DIR
      configDir = await mkdtemp(join(tmpdir(), 'antigravity-storage-test-'))
      process.env.OPENCODE_CONFIG_DIR = configDir
    })

    it('migrates V2 storage on load and persists V4', async () => {
      const v2Data = {
        version: 2,
        accounts: [
          {
            refreshToken: 'r1',
            addedAt: now,
            lastUsed: now,
            rateLimitResetTimes: {
              gemini: future,
            },
          },
        ],
        activeIndex: 0,
      }

      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(v2Data),
        'utf8',
      )

      const result = await loadAccounts()

      expect(result).not.toBeNull()
      expect(result?.version).toBe(4)

      const account = result?.accounts[0]
      if (!account) throw new Error('Account not found')

      expect(account.rateLimitResetTimes).toEqual({
        'gemini-antigravity': future,
      })

      // Read the actual saved file to verify V4 was persisted
      const storagePath = join(configDir, 'antigravity-accounts.json')
      const savedContent = JSON.parse(await readFile(storagePath, 'utf8'))
      expect(savedContent.version).toBe(4)
      expect(savedContent.accounts[0].rateLimitResetTimes).toEqual({
        'gemini-antigravity': future,
      })

      // ensureGitignore should have created a .gitignore too
      const gitignorePath = join(configDir, '.gitignore')
      const gitignore = await readFile(gitignorePath, 'utf8')
      expect(gitignore).toContain('antigravity-accounts.json')
    })

    afterEach(async () => {
      if (previousConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      }
      if (configDir) {
        await rm(configDir, { recursive: true, force: true })
      }
    })
  })

  describe('ensureGitignore', () => {
    let configDir: string

    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), 'antigravity-gitignore-'))
    })

    afterEach(async () => {
      if (configDir) {
        await rm(configDir, { recursive: true, force: true })
      }
    })

    it('creates .gitignore when file does not exist', async () => {
      await ensureGitignore(configDir)

      const gitignore = await readFile(join(configDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('antigravity-accounts.json')
      // The signature cache and the default debug logs live in the state
      // home now, so the account store's folder no longer lists them.
      expect(gitignore).not.toContain('antigravity-signature-cache.json')
      expect(gitignore).not.toContain('antigravity-logs/')
    })

    it('appends missing entries to existing .gitignore', async () => {
      await writeFile(join(configDir, '.gitignore'), 'existing-entry', 'utf8')

      await ensureGitignore(configDir)

      const gitignore = await readFile(join(configDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('existing-entry')
      expect(gitignore).toContain('antigravity-accounts.json')
      // ensureGitignore inserts a separator newline before the appended block
      // when the existing content does not already end with one.
      expect(gitignore).toContain('existing-entry\nantigravity-accounts.json')
    })

    it('does nothing when all entries already exist', async () => {
      const existing = [
        '.gitignore',
        'antigravity-accounts.json',
        'antigravity-accounts.json.*.tmp',
        'antigravity-accounts.json.store*',
        'antigravity-signature-cache.json',
        'antigravity-logs/',
      ].join('\n')
      const _before = await writeFile(
        join(configDir, '.gitignore'),
        existing,
        'utf8',
      )

      await ensureGitignore(configDir)

      const after = await readFile(join(configDir, '.gitignore'), 'utf8')
      expect(after).toBe(existing)
    })
  })

  describe('ensureGitignoreSync', () => {
    let configDir: string

    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), 'antigravity-gitignore-sync-'))
    })

    afterEach(async () => {
      if (configDir) {
        await rm(configDir, { recursive: true, force: true })
      }
    })

    it('creates .gitignore when file does not exist', () => {
      ensureGitignoreSync(configDir)

      const gitignore = require('node:fs').readFileSync(
        join(configDir, '.gitignore'),
        'utf8',
      )
      expect(gitignore).toContain('antigravity-accounts.json')
      expect(gitignore).not.toContain('antigravity-signature-cache.json')
      expect(gitignore).not.toContain('antigravity-logs/')
    })

    it('appends missing entries to existing .gitignore', async () => {
      await writeFile(join(configDir, '.gitignore'), 'existing-entry', 'utf8')

      ensureGitignoreSync(configDir)

      const gitignore = require('node:fs').readFileSync(
        join(configDir, '.gitignore'),
        'utf8',
      )
      expect(gitignore).toContain('existing-entry')
      expect(gitignore).toContain('antigravity-accounts.json')
    })

    it('does nothing when all entries already exist', async () => {
      const existing = [
        '.gitignore',
        'antigravity-accounts.json',
        'antigravity-accounts.json.*.tmp',
        'antigravity-accounts.json.store*',
        'antigravity-signature-cache.json',
        'antigravity-logs/',
      ].join('\n')
      await writeFile(join(configDir, '.gitignore'), existing, 'utf8')

      ensureGitignoreSync(configDir)

      const after = require('node:fs').readFileSync(
        join(configDir, '.gitignore'),
        'utf8',
      )
      expect(after).toBe(existing)
    })
  })
})

describe('pool file retired by the account store', () => {
  let configDir = ''
  let previousConfigDir: string | undefined
  const pool: AccountStorageV4 = {
    version: 4,
    activeIndex: 0,
    accounts: [
      { email: 'a@example.test', refreshToken: 'r-a', addedAt: 1, lastUsed: 2 },
    ],
  }

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'agy-retired-pool-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  it('still reads and writes the pool file while no store exists', async () => {
    await saveAccountsReplace(pool)
    await expect(loadAccounts()).resolves.toMatchObject({
      accounts: [expect.objectContaining({ refreshToken: 'r-a' })],
    })
  })

  it('refuses every pool-file reader and writer once the store directory exists, leaving a recreated file untouched', async () => {
    const legacyPath = getStoragePath()
    await saveAccountsReplace(pool)
    const before = await readFile(legacyPath, 'utf8')
    // A store directory that no pointer publishes is not proof that the
    // store is absent; the migration's check refuses it.
    await mkdir(`${legacyPath}.store`)

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['loadAccounts', () => loadAccounts()],
      ['saveAccounts', () => saveAccounts(pool)],
      ['saveAccountsReplace', () => saveAccountsReplace(pool)],
      ['clearAccounts', () => clearAccounts()],
      [
        'mutateAccountByRefreshToken',
        () =>
          mutateAccountByRefreshToken('r-a', (account) => {
            account.label = 'changed'
            return true
          }),
      ],
      [
        'mutateAccountStorage',
        () =>
          mutateAccountStorage(legacyPath, () => ({ ...pool, accounts: [] })),
      ],
    ]
    for (const [name, attempt] of attempts) {
      const failure = await attempt().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect([name, failure]).toEqual([
        name,
        expect.any(LegacyAccountPoolRetiredError),
      ])
    }
    expect(await readFile(legacyPath, 'utf8')).toBe(before)
  })

  it('does not create the pool file when the store exists and it is gone', async () => {
    await mkdir(`${getStoragePath()}.store`)
    await expect(saveAccountsReplace(pool)).rejects.toBeInstanceOf(
      LegacyAccountPoolRetiredError,
    )
    await expect(stat(getStoragePath())).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses on a store pointer it cannot read rather than treat it as absent', async () => {
    const legacyPath = getStoragePath()
    await saveAccountsReplace(pool)
    const before = await readFile(legacyPath, 'utf8')
    await writeFile(`${legacyPath}.store.pointer.json`, '{"schemaVersion":', {
      mode: 0o600,
    })
    const failure = await assertLegacyPoolInUse(legacyPath).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LegacyAccountPoolRetiredError)
    expect((failure as Error).cause).toMatchObject({
      name: 'AccountMigrationError',
    })
    await expect(saveAccounts(pool)).rejects.toBeInstanceOf(
      LegacyAccountPoolRetiredError,
    )
    expect(await readFile(legacyPath, 'utf8')).toBe(before)
  })
})

describe('openAccountStore', () => {
  let configDir = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'agy-open-store-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  // None of these cases may open a store or build a repository: only an
  // active, verified generation does.
  function options() {
    const built: unknown[] = []
    return {
      built,
      options: {
        modules: {
          store: {
            openPoolStore: () => {
              throw new Error(
                'admission opened a store for a non-active result',
              )
            },
          },
        },
        createRepository: (input: unknown) => {
          built.push(input)
          throw new Error('a repository was built for a non-active store')
        },
        exchange: async () => {
          throw new Error('no exchange')
        },
        now: () => 1,
      } satisfies OpenAccountStoreOptions,
    }
  }

  it('answers initialization-required for a fresh installation and creates nothing', async () => {
    const { built, options: open } = options()
    await expect(openAccountStore(open)).resolves.toEqual({
      status: 'initialization-required',
    })
    expect(built).toEqual([])
    expect(await readdir(configDir)).toEqual([])
  })

  it('answers migration-required for an existing pool file without a store, naming the offline command', async () => {
    await saveAccountsReplace({ version: 4, accounts: [], activeIndex: 0 })
    const before = await readdir(configDir)
    const { built, options: open } = options()
    const opening = await openAccountStore(open)
    expect(opening.status).toBe('migration-required')
    expect(opening.status === 'migration-required' ? opening.message : '').toBe(
      'Antigravity accounts require offline migration. Stop OpenCode, then run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`.',
    )
    expect(built).toEqual([])
    expect(await readdir(configDir)).toEqual(before)
  })

  it('refuses unowned store files instead of initializing or resetting them', async () => {
    await mkdir(join(configDir, 'antigravity-accounts.json.store'))
    const { built, options: open } = options()
    await expect(openAccountStore(open)).resolves.toMatchObject({
      status: 'refused',
      admission: { status: 'error' },
    })
    expect(built).toEqual([])
  })
})

describe('Windows migrated-store anchor', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    ?.value as string
  const noExchange: AccountTokenExchange = async () => {
    throw new Error('this test performs no token exchange')
  }
  const loginOf = (refresh: string, email: string) => ({
    type: 'success' as const,
    refresh,
    access: 'never-stored',
    expires: 1,
    email,
    projectId: '',
  })

  let configDir = ''
  let appDataRoot = ''
  let previousConfigDir: string | undefined
  let previousAppData: string | undefined
  const repositories: AccountRepository[] = []
  let anchorTrace: AnchorLockTrace | undefined

  async function traceAnchor(
    name: string,
    work: (trace: AnchorLockTrace) => Promise<void>,
  ) {
    const trace = new AnchorLockTrace(name)
    anchorTrace = trace
    await trace.run(async () => {
      await trace.install()
      await work(trace)
    })
  }

  const configPool = () => join(configDir, 'antigravity-accounts.json')
  const legacyPool = () =>
    join(appDataRoot, 'opencode', 'antigravity-accounts.json')

  it('finds the legacy Windows vault without inspecting any account-store path', async () => {
    await mkdir(join(appDataRoot, 'opencode', 'antigravity-auth-vault'), {
      recursive: true,
    })
    mockWindows()
    const exists = spyOn(fs, 'existsSync')
    const reads = spyOn(fs, 'readFileSync')
    try {
      expect(accountFileForVault()).toBe(legacyPool())
      expect(exists.mock.calls.map(([path]) => String(path))).toEqual([
        join(configDir, 'antigravity-auth-vault'),
        join(appDataRoot, 'opencode', 'antigravity-auth-vault'),
      ])
      expect(reads.mock.calls).toEqual([])
    } finally {
      exists.mockRestore()
      reads.mockRestore()
    }
  })

  function openAt(legacyPath: string, modules: CommonAuthStoreModules) {
    return openAccountStore({
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange: noExchange,
      legacyPath,
    })
  }

  function openResolved(modules: CommonAuthStoreModules) {
    return openAccountStore({
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange: noExchange,
    })
  }

  // The genuine store modules snapshot the platform when they first load,
  // so every test below loads and seeds them unmocked and only then swaps
  // the platform to Windows for the resolution under test.
  function mockWindows() {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })
  }

  // None of the pending-store cases below may open a store or build a
  // repository: only an active, verified generation does.
  function stubOptions(): OpenAccountStoreOptions {
    return {
      modules: {
        store: {
          openPoolStore: () => {
            throw new Error('admission opened a store for a non-active result')
          },
        },
      },
      createRepository: () => {
        throw new Error('a repository was built for a non-active store')
      },
      exchange: noExchange,
      now: () => 1,
    } satisfies OpenAccountStoreOptions
  }

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    previousAppData = process.env.APPDATA
    configDir = await realpath(await mkdtemp(join(tmpdir(), 'agy-win-config-')))
    appDataRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'agy-win-appdata-')),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.APPDATA = appDataRoot
  })

  afterEach(async () => {
    try {
      for (const repository of repositories.splice(0)) {
        await repository.dispose()
      }
      Object.defineProperty(process, 'platform', {
        value: realPlatform,
        configurable: true,
      })
      if (previousConfigDir === undefined)
        delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
      await rm(configDir, { recursive: true, force: true })
      await rm(appDataRoot, { recursive: true, force: true })
    } finally {
      anchorTrace?.stop()
      anchorTrace = undefined
    }
  })

  it('finds a store migrated at the %APPDATA% anchor after its pool file is retired', async () => {
    await traceAnchor(
      'finds a store migrated at the %APPDATA% anchor after its pool file is retired',
      async (trace) => {
        const modules = await trace.phase(
          'load:verified-modules',
          genuineModules,
        )
        await mkdir(join(appDataRoot, 'opencode'), { recursive: true })
        expect(
          (
            await trace.phase('seed:initialize:appdata', () =>
              initializeFreshAccountStoreFor(modules, {
                legacyPath: legacyPool(),
              }),
            )
          ).status,
        ).toBe('completed')
        const seeded = await trace.phase('seed:open:appdata', () =>
          openAt(legacyPool(), modules),
        )
        expect(seeded.status).toBe('ready')
        if (seeded.status !== 'ready') return
        repositories.push(seeded.repository)
        const [login] = await trace.phase('seed:commit-login', () =>
          commitLogins(seeded.repository, [
            loginOf('legacy-token|legacy-project', 'legacy@example.test'),
          ]),
        )
        expect(login).toMatchObject({ status: 'committed' })

        // The pool file is retired and OPENCODE_CONFIG_DIR has no store, yet
        // the migrated store must stay visible through the real resolution path.
        mockWindows()
        await expect(stat(legacyPool())).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(getStoragePath()).toBe(legacyPool())
        const resolved = await trace.phase('resolve:open', () =>
          openResolved(modules),
        )
        expect(resolved.status).toBe('ready')
        if (resolved.status !== 'ready') return
        repositories.push(resolved.repository)
        const read = await trace.phase('resolve:read', () =>
          resolved.repository.read(),
        )
        expect(read.status).toBe('ready')
        if (read.status !== 'ready') return
        expect(read.rows.map((row) => row.credential?.refreshToken)).toEqual([
          'legacy-token',
        ])
        expect(trace.locks.some((lock) => lock.name === 'save')).toBe(true)
      },
    )
  })

  it('refuses when pointers exist at both anchors, naming both', async () => {
    await traceAnchor(
      'refuses when pointers exist at both anchors, naming both',
      async (trace) => {
        const modules = await trace.phase(
          'load:verified-modules',
          genuineModules,
        )
        await mkdir(join(appDataRoot, 'opencode'), { recursive: true })
        expect(
          (
            await trace.phase('seed:initialize:appdata', () =>
              initializeFreshAccountStoreFor(modules, {
                legacyPath: legacyPool(),
              }),
            )
          ).status,
        ).toBe('completed')
        expect(
          (
            await trace.phase('seed:initialize:config', () =>
              initializeFreshAccountStoreFor(modules, {
                legacyPath: configPool(),
              }),
            )
          ).status,
        ).toBe('completed')
        mockWindows()
        let failure: unknown
        try {
          getStoragePath()
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(Error)
        expect(String((failure as Error)?.message)).toContain(legacyPool())
        expect(String((failure as Error)?.message)).toContain(configPool())
        expect(trace.locks.some((lock) => lock.name === 'save')).toBe(true)
      },
    )
  })

  it('keeps using the config anchor when only it publishes a store', async () => {
    const modules = await genuineModules()
    expect(
      (
        await initializeFreshAccountStoreFor(modules, {
          legacyPath: configPool(),
        })
      ).status,
    ).toBe('completed')
    mockWindows()
    expect(getStoragePath()).toBe(configPool())
    const resolved = await openResolved(modules)
    expect(resolved.status).toBe('ready')
    if (resolved.status !== 'ready') return
    repositories.push(resolved.repository)
  })

  it('falls back to the legacy pool file when the config folder cannot be created', async () => {
    mockWindows()
    const blocker = join(configDir, 'not-a-directory')
    await writeFile(blocker, 'blocking the config folder\n')
    process.env.OPENCODE_CONFIG_DIR = join(blocker, 'opencode')
    await mkdir(join(appDataRoot, 'opencode'), { recursive: true })
    await writeFile(
      legacyPool(),
      JSON.stringify({ version: 4, accounts: [], activeIndex: 0 }),
      { mode: 0o600 },
    )
    expect(getStoragePath()).toBe(legacyPool())
    const resolved = await openAccountStore(stubOptions())
    expect(resolved.status).toBe('migration-required')
  })

  it('still moves an unmigrated legacy pool file into the config folder', async () => {
    mockWindows()
    await mkdir(join(appDataRoot, 'opencode'), { recursive: true })
    await writeFile(
      legacyPool(),
      JSON.stringify({ version: 4, accounts: [], activeIndex: 0 }),
      { mode: 0o600 },
    )
    expect(getStoragePath()).toBe(configPool())
    await expect(stat(legacyPool())).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const resolved = await openAccountStore(stubOptions())
    expect(resolved.status).toBe('migration-required')
  })

  it('ignores the %APPDATA% anchor outside Windows', async () => {
    await mkdir(join(appDataRoot, 'opencode'), { recursive: true })
    // Pointers at both anchors: a non-Windows start still resolves the
    // config anchor without refusing.
    await writeFile(`${legacyPool()}.store.pointer.json`, '{}\n', {
      mode: 0o600,
    })
    await writeFile(`${configPool()}.store.pointer.json`, '{}\n', {
      mode: 0o600,
    })
    // Set explicitly, because this suite also runs on real Windows runners,
    // where the unmocked platform is win32 and both pointers rightly refuse.
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    })
    expect(getStoragePath()).toBe(configPool())
  })
})

// ---------------------------------------------------------------------------
// Genuine public store
//
// These tests exercise the store and filesystem modules copied verbatim from
// the pinned published common-auth archive into the core package. They run in
// disposable directories, migrate real account files, verify the completed
// migration owns those paths, and retire that migration during rollback.
// Before loading the modules, the receipt must name that exact archive and
// every embedded store/fs file must match its recorded size and SHA-256. This
// verifies the embedded copy against the pinned published archive and fails
// on missing, changed, or extra files.
// ---------------------------------------------------------------------------

let genuine: Promise<CommonAuthStoreModules> | undefined

/** Load the public store/fs files only after their recorded sizes and SHA-256 hashes match. */
function genuineModules(): Promise<CommonAuthStoreModules> {
  genuine ??= loadVerifiedStoreModules()
  const owner = hooks.lifetime
  return owner
    .operation(genuine)
    .then((modules) => managedStoreModules(owner, modules))
}

describe('account store over the genuine public store', () => {
  let configDir = ''
  let previousConfigDir: string | undefined
  const opened: AccountRepository[] = []

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await realpath(await mkdtemp(join(tmpdir(), 'agy-real-store-')))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    for (const repository of opened.splice(0)) await repository.dispose()
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  async function open(
    exchange: AccountTokenExchange = async () => {
      throw new Error('this test performs no token exchange')
    },
  ) {
    const modules = await genuineModules()
    const opening = await openAccountStore({
      modules: modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange,
    })
    if (opening.status === 'ready') opened.push(opening.repository)
    return opening
  }

  const success = (refresh: string, email: string) => ({
    type: 'success' as const,
    refresh,
    access: 'never-stored',
    expires: 1,
    email,
    projectId: '',
  })

  it('initializes a fresh store only when asked, then serves it and refuses the pool file', async () => {
    const modules = await genuineModules()
    await expect(open()).resolves.toEqual({
      status: 'initialization-required',
    })

    const initialized = await initializeFreshAccountStoreFor(modules)
    expect(initialized.status).toBe('completed')

    const opening = await open()
    expect(opening.status).toBe('ready')
    if (opening.status !== 'ready') return
    await expect(opening.repository.read()).resolves.toMatchObject({
      status: 'ready',
      rows: [],
    })

    const [login] = await commitLogins(opening.repository, [
      success('fresh-token|fresh-project', 'fresh@example.test'),
    ])
    expect(login).toMatchObject({ status: 'committed', outcome: 'added' })
    const read = await opening.repository.read()
    if (login?.status !== 'committed' || read.status !== 'ready') {
      throw new Error('the login was not committed to a ready store')
    }
    expect(read.rows.map((row) => row.ref)).toEqual([login.ref])

    // The store owns the accounts now: no pool-file reader or writer runs,
    // and the pool file is never created.
    for (const attempt of [
      () => loadAccounts(),
      () => saveAccountsReplace({ version: 4, accounts: [], activeIndex: 0 }),
      () => persistAccountPool([success('late-token', 'late@example.test')]),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(
        LegacyAccountPoolRetiredError,
      )
    }
    await expect(stat(getStoragePath())).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('binds a published generation for recovery without serving it, and binds nothing before one exists', async () => {
    const modules = await genuineModules()
    const options = {
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange: async (): Promise<never> => {
        throw new Error('this test performs no token exchange')
      },
    }
    await expect(openAccountStoreForRecovery(options)).resolves.toEqual({
      status: 'initialization-required',
    })
    expect((await initializeFreshAccountStoreFor(modules)).status).toBe(
      'completed',
    )
    const recovery = await openAccountStoreForRecovery(options)
    expect(recovery.status).toBe('bound')
    if (recovery.status !== 'bound') return
    opened.push(recovery.repository)
    const serving = await open()
    expect(serving.status).toBe('ready')
    if (serving.status !== 'ready') return
    expect(recovery.binding.paths).toEqual(serving.admission.paths)
  })

  it('serves a migrated pool, refuses its retired file, and refuses again when the file is recreated', async () => {
    const modules = await genuineModules()
    await saveAccountsReplace({
      version: 4,
      activeIndex: 1,
      accounts: [
        {
          email: 'one@example.test',
          refreshToken: 'token-one',
          projectId: 'project-one',
          addedAt: 10,
          lastUsed: 20,
        },
        {
          email: 'two@example.test',
          refreshToken: 'token-two',
          addedAt: 11,
          lastUsed: 21,
          enabled: false,
        },
      ],
    })
    await expect(open()).resolves.toMatchObject({
      status: 'migration-required',
    })

    const migrated = await createAccountMigrationFactory(modules)({
      legacyPath: getStoragePath(),
      offline: { processesStopped: true },
      now: () => Date.now(),
    })
    expect(migrated.status).toBe('completed')
    await expect(stat(getStoragePath())).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const opening = await open()
    expect(opening.status).toBe('ready')
    if (opening.status !== 'ready') return
    const read = await opening.repository.read()
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') return
    expect(
      read.rows.map((row) => ({
        token: row.credential?.refreshToken,
        enabled: row.enabled,
        email:
          row.metadata.status === 'present'
            ? row.metadata.metadata.email
            : undefined,
      })),
    ).toEqual([
      { token: 'token-one', enabled: true, email: 'one@example.test' },
      { token: 'token-two', enabled: false, email: 'two@example.test' },
    ])

    // Retired: every pool-file path refuses and nothing recreates the file.
    await expect(
      saveAccounts({ version: 4, accounts: [], activeIndex: 0 }),
    ).rejects.toBeInstanceOf(LegacyAccountPoolRetiredError)
    await expect(stat(getStoragePath())).rejects.toMatchObject({
      code: 'ENOENT',
    })

    // A pool file recreated after activation (an older build, a restore) is
    // neither served nor written.
    const recreated = '{"version":4,"accounts":[],"activeIndex":0}'
    await writeFile(getStoragePath(), recreated, { mode: 0o600 })
    await expect(
      mutateAccountStorage(getStoragePath(), (current) => current),
    ).rejects.toBeInstanceOf(LegacyAccountPoolRetiredError)
    await expect(loadAccounts()).rejects.toBeInstanceOf(
      LegacyAccountPoolRetiredError,
    )
    expect(await readFile(getStoragePath(), 'utf8')).toBe(recreated)
    await expect(open()).resolves.toMatchObject({
      status: 'refused',
      admission: { status: 'error' },
    })
  })

  it('refreshes accounts concurrently and drops a verdict for a credential replaced meanwhile', async () => {
    const modules = await genuineModules()
    expect((await initializeFreshAccountStoreFor(modules)).status).toBe(
      'completed',
    )
    // Each exchange finishes only once both have started: refreshes that
    // were serialized across accounts would never both get there.
    let started = 0
    let bothStarted: () => void = () => {}
    const bothHaveStarted = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const owner = hooks.lifetime
    owner.unpark(bothStarted)
    const exchanged: string[] = []
    const opening = await open(async ({ refreshToken }) => {
      exchanged.push(`start ${refreshToken}`)
      started += 1
      if (started === 2) bothStarted()
      await bothHaveStarted
      owner.signal.throwIfAborted()
      exchanged.push(`end ${refreshToken}`)
      return {
        accessToken: `access-for-${refreshToken}`,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
      }
    })
    if (opening.status !== 'ready') throw new Error('store is not ready')
    const repository = opening.repository
    await commitLogins(repository, [
      success('token-a', 'a@example.test'),
      success('token-b', 'b@example.test'),
    ])

    const manager = await loadAccountManagerFromRepository(repository, {
      onDiagnostic: () => {},
    })
    const credentials = createLocalAccountCredentials(manager, { repository })
    const [accountA, accountB] = manager.getAccounts()
    const [authA, authB] = await Promise.all([
      credentials.refresh(accountA!),
      credentials.refresh(accountB!),
    ])
    expect(authA?.access).toBe('access-for-token-a')
    expect(authB?.access).toBe('access-for-token-b')
    expect(exchanged.slice(0, 2).sort()).toEqual([
      'start token-a',
      'start token-b',
    ])

    // A verdict probed for row A's first credential arrives after row A was
    // re-authenticated: the store refuses it and nothing changes.
    const service = createRepositoryAccountAccessService({
      repository,
      openBrowser: async () => false,
      prompt: {
        selectAccount: async () => undefined,
        confirmOpenVerificationUrl: async () => false,
      },
    })
    const [listedA] = await service.listAccounts()
    await service.reauthorizeAccount(
      listedA!.ref,
      success('token-a2', 'a@example.test'),
    )
    await expect(
      service.applyVerificationResult({
        status: 'probed',
        ref: listedA!.ref,
        result: { status: 'ineligible', message: 'ACCOUNT_INELIGIBLE' },
        observedAt: Date.now(),
      }),
    ).resolves.toEqual({ status: 'stale', rowId: listedA!.ref.id })
    const after = await repository.read()
    const rowA = after.status === 'ready' ? after.rows[0] : undefined
    expect(rowA?.enabled).toBe(true)
    expect(rowA?.credential?.refreshToken).toBe('token-a2')
    expect(
      rowA?.metadata.status === 'present'
        ? rowA.metadata.metadata.accountIneligible
        : undefined,
    ).not.toBe(true)
  })
})
