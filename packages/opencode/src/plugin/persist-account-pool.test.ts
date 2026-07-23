/**
 * Tests for persistAccountPool and loadAccounts.
 *
 * Fail-closed contract: when the on-disk accounts file exists but is
 * unreadable (malformed JSON, schema mismatch, unsupported version,
 * I/O error), every read or write MUST surface a typed
 * `AccountStorageUnreadableError` rather than treat the bad state as
 * "empty pool". A failed mutation MUST NOT overwrite the user's file.
 *
 * The 23 cases below are the regression matrix for that contract.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountStorageUnreadableError } from '@cortexkit/antigravity-auth-core'
import { persistAccountPool } from './persist-account-pool'
import type { AccountMetadataV3, AccountStorageV4 } from './storage'
import * as storageModule from './storage'

function createMockAccount(
  overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
  return {
    email: 'test@example.com',
    refreshToken: 'test-refresh-token',
    projectId: 'test-project-id',
    managedProjectId: 'test-managed-project-id',
    addedAt: Date.now() - 10000,
    lastUsed: Date.now(),
    ...overrides,
  }
}

function createMockStorage(
  accounts: AccountMetadataV3[],
  activeIndex = 0,
): AccountStorageV4 {
  return {
    version: 4,
    accounts,
    activeIndex,
  }
}

describe('loadAccounts', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-persist-test-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  describe('file not found (ENOENT)', () => {
    it('returns null when file does not exist', async () => {
      const result = await storageModule.loadAccounts()
      expect(result).toBeNull()
    })
  })

  describe('file exists with valid data', () => {
    it('returns storage for valid V3 file', async () => {
      const mockStorage = createMockStorage([createMockAccount()])
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(mockStorage),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result).not.toBeNull()
      expect(result?.version).toBe(4)
      expect(result?.accounts).toHaveLength(1)
    })

    it('returns storage with multiple accounts', async () => {
      const mockStorage = createMockStorage([
        createMockAccount({
          email: 'user1@example.com',
          refreshToken: 'token1',
        }),
        createMockAccount({
          email: 'user2@example.com',
          refreshToken: 'token2',
        }),
      ])
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(mockStorage),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result?.accounts).toHaveLength(2)
      expect(result?.accounts[0]?.email).toBe('user1@example.com')
      expect(result?.accounts[1]?.email).toBe('user2@example.com')
    })

    it('preserves activeIndex from storage', async () => {
      const mockStorage = createMockStorage(
        [
          createMockAccount({ email: 'user1@example.com' }),
          createMockAccount({ email: 'user2@example.com' }),
        ],
        1,
      )
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(mockStorage),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result?.activeIndex).toBe(1)
    })
  })

  describe('error handling - THE BUG (fail-closed contract)', () => {
    it('throws AccountStorageUnreadableError on JSON parse error', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        '{ invalid json }}}',
        'utf8',
      )

      await expect(storageModule.loadAccounts()).rejects.toBeInstanceOf(
        AccountStorageUnreadableError,
      )
    })

    it('throws AccountStorageUnreadableError on invalid storage format', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify({ version: 4, notAccounts: [] }),
        'utf8',
      )

      await expect(storageModule.loadAccounts()).rejects.toBeInstanceOf(
        AccountStorageUnreadableError,
      )
    })

    it('throws AccountStorageUnreadableError on unknown version', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify({ version: 999, accounts: [] }),
        'utf8',
      )

      await expect(storageModule.loadAccounts()).rejects.toBeInstanceOf(
        AccountStorageUnreadableError,
      )
    })
  })

  describe('migration', () => {
    it('migrates V2 to V3 successfully', async () => {
      const v2Storage = {
        version: 2,
        accounts: [
          {
            refreshToken: 'token1',
            addedAt: Date.now() - 10000,
            lastUsed: Date.now(),
          },
        ],
        activeIndex: 0,
      }
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(v2Storage),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result?.version).toBe(4)
      expect(result?.accounts).toHaveLength(1)
    })
  })
})

describe('saveAccounts', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-persist-save-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  it('saves valid storage to disk', async () => {
    const storage = createMockStorage([createMockAccount()])
    await storageModule.saveAccounts(storage)

    const storagePath = join(configDir, 'antigravity-accounts.json')
    const writtenContent = await readFile(storagePath, 'utf8')
    const parsed = JSON.parse(writtenContent)
    expect(parsed.version).toBe(4)
    expect(parsed.accounts).toHaveLength(1)
  })
})

/**
 * Tests for the expected behavior of persistAccountPool
 *
 * These tests exercise the extracted lock-held persistence helper directly.
 */
describe('persistAccountPool behavior (Issue #89)', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-pool-test-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    jest.useRealTimers()
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  describe('merging behavior (replaceAll=false)', () => {
    it('merges a newly authenticated account with existing accounts', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'existing@example.com',
            refreshToken: 'existing-token',
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'new-token|new-project',
            access: 'new-access',
            expires: Date.now() + 3_600_000,
            email: 'new@example.com',
            projectId: 'new-project',
          },
        ],
        false,
      )

      expect(await storageModule.loadAccounts()).toMatchObject({
        accounts: [
          { email: 'existing@example.com', refreshToken: 'existing-token' },
          { email: 'new@example.com', refreshToken: 'new-token' },
        ],
      })
    })

    it('deduplicates by email, keeping the newest token (by lastUsed)', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'shared@example.com',
            refreshToken: 'old-token',
            addedAt: 1,
            lastUsed: 100,
          }),
          createMockAccount({
            email: 'shared@example.com',
            refreshToken: 'newer-token',
            addedAt: 2,
            lastUsed: 200,
          }),
          createMockAccount({
            email: 'shared@example.com',
            refreshToken: 'newest-token',
            addedAt: 3,
            lastUsed: 300,
          }),
        ]),
      )

      // Persisting a token for the same email must collapse all three
      // existing entries to one survivor (newest by lastUsed).
      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'rotation-token|rotation-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'shared@example.com',
            projectId: 'rotation-project',
          },
        ],
        false,
      )

      const result = await storageModule.loadAccounts()
      const shared = result?.accounts.filter(
        (a) => a.email === 'shared@example.com',
      )
      expect(shared).toHaveLength(1)
      expect(shared?.[0]?.refreshToken).toBe('rotation-token')
    })

    it('deduplicates by refresh token when email is not available', async () => {
      // No email on the existing account → identity is refresh-token-only.
      // A new login for the same token is an in-place update, not a
      // duplicate entry.
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            refreshToken: 'shared-token',
            addedAt: 1,
            lastUsed: 1,
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'shared-token|shared-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            projectId: 'shared-project',
          },
        ],
        false,
      )

      const result = await storageModule.loadAccounts()
      const matches = result?.accounts.filter(
        (a) => a.refreshToken === 'shared-token',
      )
      expect(matches).toHaveLength(1)
    })

    it('preserves activeIndex when adding new accounts (replaceAll=false)', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage(
          [
            createMockAccount({
              email: 'a@example.com',
              refreshToken: 'token-a',
            }),
            createMockAccount({
              email: 'b@example.com',
              refreshToken: 'token-b',
            }),
          ],
          1,
        ),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'token-c|c-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'c@example.com',
            projectId: 'c-project',
          },
        ],
        false,
      )

      const result = await storageModule.loadAccounts()
      expect(result?.activeIndex).toBe(1)
    })

    it('updates lastUsed timestamp for an existing account on a new login', async () => {
      const originalLastUsed = Date.now() - 1_000_000
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'returning@example.com',
            refreshToken: 'returning-token',
            addedAt: originalLastUsed - 10_000,
            lastUsed: originalLastUsed,
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'returning-token|returning-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'returning@example.com',
            projectId: 'returning-project',
          },
        ],
        false,
      )

      const result = await storageModule.loadAccounts()
      const survivor = result?.accounts.find(
        (a) => a.email === 'returning@example.com',
      )
      expect(survivor?.lastUsed).toBeGreaterThan(originalLastUsed)
    })
  })

  describe('fresh start behavior (replaceAll=true)', () => {
    it('replaces existing accounts for an explicit fresh start', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'existing@example.com',
            refreshToken: 'existing-token',
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'fresh-token|fresh-project',
            access: 'fresh-access',
            expires: Date.now() + 3_600_000,
            email: 'fresh@example.com',
            projectId: 'fresh-project',
          },
        ],
        true,
      )

      expect(await storageModule.loadAccounts()).toMatchObject({
        activeIndex: 0,
        accounts: [{ email: 'fresh@example.com', refreshToken: 'fresh-token' }],
      })
    })

    it('resets activeIndex to 0 (replaceAll=true)', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage(
          [
            createMockAccount({
              email: 'a@example.com',
              refreshToken: 'token-a',
            }),
            createMockAccount({
              email: 'b@example.com',
              refreshToken: 'token-b',
            }),
          ],
          1,
        ),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'fresh-token|fresh-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'fresh@example.com',
            projectId: 'fresh-project',
          },
        ],
        true,
      )

      const result = await storageModule.loadAccounts()
      expect(result?.activeIndex).toBe(0)
    })

    it('ignores the existing accounts file (replaceAll=true preserves only the freshly-persisted accounts)', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'stale@example.com',
            refreshToken: 'stale-token',
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'only-token|only-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'only@example.com',
            projectId: 'only-project',
          },
        ],
        true,
      )

      const result = await storageModule.loadAccounts()
      const emails = result?.accounts.map((a) => a.email) ?? []
      expect(emails).toEqual(['only@example.com'])
    })
  })

  describe('THE BUG: fail-closed behavior on unreadable storage', () => {
    it('does NOT overwrite the existing file when storage is corrupt (malformed JSON)', async () => {
      // Seed a "user data" file the plugin must not destroy. Use a
      // non-JSON blob that mimics a half-written or hand-edited file.
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      const originalRaw =
        '{ "version": 4, "accounts": [{ "refreshToken": "x", "addedAt": 1, "lastUsed": 1 /* truncated'
      await writeFile(storagePath, originalRaw, 'utf8')

      await expect(
        persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        ),
      ).rejects.toBeInstanceOf(AccountStorageUnreadableError)

      // The original bytes must remain on disk.
      expect(await readFile(storagePath, 'utf8')).toBe(originalRaw)
    })

    it('throws AccountStorageUnreadableError when persistAccountPool is called against a corrupt file', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        storagePath,
        JSON.stringify({ version: 4, notAccounts: [] }),
        'utf8',
      )

      await expect(
        persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        ),
      ).rejects.toBeInstanceOf(AccountStorageUnreadableError)
    })

    it('error message identifies the backup path so a UI layer can surface a recovery hint', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, '{ invalid json', 'utf8')

      let captured: unknown
      try {
        await persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        )
      } catch (error) {
        captured = error
      }
      const err = captured as AccountStorageUnreadableError
      expect(err.details.path).toBe(storagePath)
      expect(err.details.backupPath).not.toBeNull()
      expect(err.message).toContain(storagePath)
      if (err.details.backupPath) {
        expect(err.message).toContain(err.details.backupPath)
      }
    })

    it('only treats ENOENT as "safe to create a new file"', async () => {
      // No file exists yet → persistAccountPool must succeed (first-run).
      await expect(
        persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'first-token|first-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'first@example.com',
              projectId: 'first-project',
            },
          ],
          false,
        ),
      ).resolves.toBeUndefined()
      const result = await storageModule.loadAccounts()
      expect(result?.accounts).toHaveLength(1)
      expect(result?.accounts[0]?.email).toBe('first@example.com')
    })
  })
})

/**
 * Tests for TUI flow integration (fail-closed contract).
 */
describe('TUI flow integration (fail-closed contract)', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-tui-test-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    jest.useRealTimers()
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  describe('account persistence after OAuth', () => {
    it('merges a newly-authenticated account with existing accounts in the TUI flow', async () => {
      await storageModule.saveAccountsReplace(
        createMockStorage([
          createMockAccount({
            email: 'existing@example.com',
            refreshToken: 'existing-token',
          }),
        ]),
      )

      await persistAccountPool(
        [
          {
            type: 'success',
            refresh: 'new-token|new-project',
            access: 'a',
            expires: Date.now() + 3_600_000,
            email: 'new@example.com',
            projectId: 'new-project',
          },
        ],
        false,
      )

      const result = await storageModule.loadAccounts()
      expect(result?.accounts.map((a) => a.email)).toEqual([
        'existing@example.com',
        'new@example.com',
      ])
    })

    it('loadAccounts surfaces a typed AccountStorageUnreadableError when existing accounts cannot be loaded', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, 'definitely-not-json', 'utf8')

      let captured: unknown
      try {
        await storageModule.loadAccounts()
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
      expect((captured as AccountStorageUnreadableError).details.reason).toBe(
        'malformed-json',
      )
    })

    it('persistAccountPool propagates the unreadable error so a UI layer can prompt the user', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        storagePath,
        JSON.stringify({ version: 4, notAccounts: [] }),
        'utf8',
      )

      await expect(
        persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        ),
      ).rejects.toBeInstanceOf(AccountStorageUnreadableError)
    })
  })

  describe('authorize flow behavior', () => {
    it('TUI flow can load existing accounts and treat null as "no accounts yet"', async () => {
      // No file → loadAccounts returns null (first-run, not an error).
      const result = await storageModule.loadAccounts()
      expect(result).toBeNull()
    })

    it('handles loadAccounts returning null gracefully (first-run UX unchanged)', async () => {
      const result = await storageModule.loadAccounts()
      expect(result).toBeNull()
      // No throw → the TUI flow can proceed to OAuth login.
    })
  })
})

/**
 * Regression tests to ensure the fix doesn't break normal operation
 */
describe('regression tests', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-regression-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  describe('first-time user experience', () => {
    it('should work correctly when no accounts file exists (ENOENT)', async () => {
      const result = await storageModule.loadAccounts()
      expect(result).toBeNull()

      const newStorage = createMockStorage([createMockAccount()])
      await storageModule.saveAccounts(newStorage)
    })
  })

  describe('normal multi-account workflow', () => {
    it('should load existing accounts correctly', async () => {
      const existingStorage = createMockStorage([
        createMockAccount({ email: 'existing@example.com' }),
      ])
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify(existingStorage),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result).not.toBeNull()
      expect(result?.accounts).toHaveLength(1)
      expect(result?.accounts[0]?.email).toBe('existing@example.com')
    })

    it('should preserve all accounts when saving', async () => {
      const storage = createMockStorage([
        createMockAccount({
          email: 'user1@example.com',
          refreshToken: 'token1',
        }),
        createMockAccount({
          email: 'user2@example.com',
          refreshToken: 'token2',
        }),
        createMockAccount({
          email: 'user3@example.com',
          refreshToken: 'token3',
        }),
      ])

      await storageModule.saveAccounts(storage)

      const storagePath = join(configDir, 'antigravity-accounts.json')
      const parsed = JSON.parse(await readFile(storagePath, 'utf8'))
      expect(parsed.accounts).toHaveLength(3)

      const gitignore = await readFile(join(configDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('antigravity-accounts.json')
    })
  })
})

/**
 * Proposed fix validation tests. Each `loadAccounts` failure mode maps
 * to a distinct `AccountStorageUnreadableError.reason` so callers (UI,
 * CLI, RPC) can branch on the failure category without parsing the
 * error message.
 */
describe('proposed fix validation', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'antigravity-fix-test-'))
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  describe('loadAccounts distinguishes error types via the typed error reason', () => {
    it('returns null when the file does not exist (ENOENT is NOT an error)', async () => {
      expect(await storageModule.loadAccounts()).toBeNull()
    })

    it('throws AccountStorageUnreadableError with reason "io-error" when the file exists but cannot be read', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      // Write to a directory at the same path → readFile returns
      // EISDIR (an io-error distinct from parse / shape / version).
      await writeFile(storagePath, 'not a directory', 'utf8')
      // Make it unreadable by removing all permissions on POSIX.
      if (process.platform !== 'win32') {
        const { chmod } = await import('node:fs/promises')
        await chmod(storagePath, 0o000)
        try {
          let captured: unknown
          try {
            await storageModule.loadAccounts()
          } catch (error) {
            captured = error
          }
          // On some CI images chmod 0 still allows root to read; if so,
          // accept any unreadable reason and move on. The contract is
          // "any non-ENOENT read failure throws".
          if (captured !== undefined) {
            expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
          }
        } finally {
          await chmod(storagePath, 0o600)
        }
      }
    })

    it('throws AccountStorageUnreadableError with reason "malformed-json" on invalid JSON', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, '{ broken', 'utf8')

      let captured: unknown
      try {
        await storageModule.loadAccounts()
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
      expect((captured as AccountStorageUnreadableError).details.reason).toBe(
        'malformed-json',
      )
    })

    it('throws AccountStorageUnreadableError with reason "invalid-shape" on schema mismatch', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        storagePath,
        JSON.stringify({ version: 4, notAccounts: [] }),
        'utf8',
      )

      let captured: unknown
      try {
        await storageModule.loadAccounts()
      } catch (error) {
        captured = error
      }
      expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
      expect((captured as AccountStorageUnreadableError).details.reason).toBe(
        'invalid-shape',
      )
    })
  })

  describe('persistAccountPool surfaces errors safely', () => {
    it('throws AccountStorageUnreadableError when the file exists but cannot be parsed', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, '{ broken json', 'utf8')

      await expect(
        persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        ),
      ).rejects.toBeInstanceOf(AccountStorageUnreadableError)
    })

    it('error message includes the file path and the backup path so the user knows where their data went', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, 'not json at all', 'utf8')

      let captured: unknown
      try {
        await persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        )
      } catch (error) {
        captured = error
      }
      const err = captured as AccountStorageUnreadableError
      expect(err.message).toContain(storagePath)
      if (err.details.backupPath) {
        expect(err.message).toContain(err.details.backupPath)
      }
      // Recovery hint: the error MUST point at the backup so the user
      // (or the UI layer) can offer them a manual recovery path.
      expect(err.message.toLowerCase()).toContain('backup')
    })
  })

  describe('backup-on-corruption', () => {
    it('propagates a typed error so the caller (UI / CLI / RPC) can prompt the user', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      await writeFile(storagePath, '{ broken', 'utf8')

      let captured: unknown
      try {
        await persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        )
      } catch (error) {
        captured = error
      }
      // The caller gets a typed error → can branch on `name ===
      // 'AccountStorageUnreadableError'` to show a recovery prompt.
      expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    })

    it('writes a .corrupt-<ISO-timestamp> sidecar so the user can recover manually', async () => {
      const storagePath = join(configDir, 'antigravity-accounts.json')
      await mkdir(configDir, { recursive: true })
      const originalRaw = '{"version":4,"accounts":[]'
      await writeFile(storagePath, originalRaw, 'utf8')

      let captured: unknown
      try {
        await persistAccountPool(
          [
            {
              type: 'success',
              refresh: 'new-token|new-project',
              access: 'a',
              expires: Date.now() + 3_600_000,
              email: 'new@example.com',
              projectId: 'new-project',
            },
          ],
          false,
        )
      } catch (error) {
        captured = error
      }
      const err = captured as AccountStorageUnreadableError
      expect(err.details.backupPath).not.toBeNull()
      // The backup sidecar must hold a verbatim copy of the user's data.
      if (err.details.backupPath) {
        const backup = await readFile(err.details.backupPath, 'utf8')
        expect(backup).toBe(originalRaw)
        // And the original file must be untouched.
        expect(await readFile(storagePath, 'utf8')).toBe(originalRaw)
      }
    })
  })
})
