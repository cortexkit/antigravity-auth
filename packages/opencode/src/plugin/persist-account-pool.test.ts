/**
 * Tests for persistAccountPool function
 *
 * Issue #89: Multi-account login overwrites existing accounts
 * Root cause: loadAccounts() returning null is treated as "no accounts"
 * even when the file exists but couldn't be read (permissions, corruption, etc.)
 *
 * @see https://github.com/cortexkit/antigravity-auth/issues/89
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  describe('error handling - THE BUG (Issue #89)', () => {
    it('returns null on JSON parse error', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        '{ invalid json }}}',
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result).toBeNull()
    })

    it('returns null on invalid storage format', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify({ version: 4, notAccounts: [] }),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result).toBeNull()
    })

    it('returns null on unknown version', async () => {
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'antigravity-accounts.json'),
        JSON.stringify({ version: 999, accounts: [] }),
        'utf8',
      )

      const result = await storageModule.loadAccounts()

      expect(result).toBeNull()
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
 * NOTE: persistAccountPool is currently a private function in plugin.ts.
 * These tests document the EXPECTED behavior after the fix.
 * To run these tests, persistAccountPool should be exported.
 */
describe('persistAccountPool behavior (Issue #89)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('merging behavior (replaceAll=false)', () => {
    it.todo('merges new account with existing accounts', () => {})

    it.todo('deduplicates by email, keeping the newest token', () => {})

    it.todo('deduplicates by refresh token when email not available', () => {})

    it.todo('preserves activeIndex when adding new accounts', () => {})

    it.todo('updates lastUsed timestamp for existing accounts', () => {})
  })

  describe('fresh start behavior (replaceAll=true)', () => {
    it.todo('replaces all existing accounts with new ones', () => {})

    it.todo('resets activeIndex to 0', () => {})

    it.todo('ignores existing accounts file', () => {})
  })

  describe('THE BUG: error handling when loadAccounts fails (Issue #89)', () => {
    it.todo('should NOT overwrite accounts when loadAccounts returns null due to permission error', () => {})

    it.todo('should throw error when file exists but cannot be read', () => {})

    it.todo('should prompt user when existing accounts may be lost', () => {})

    it.todo("should only treat ENOENT as 'safe to create new file'", () => {})
  })
})

/**
 * Tests for TUI flow integration (Issue #89)
 */
describe('TUI flow integration (Issue #89)', () => {
  describe('account persistence after OAuth', () => {
    it.todo('should merge new account with existing accounts in TUI flow', () => {})

    it.todo('should show warning when existing accounts cannot be loaded', () => {})

    it.todo('should ask user for confirmation before potentially overwriting accounts', () => {})
  })

  describe('authorize function behavior', () => {
    it.todo('TUI flow (inputs falsy) should check for existing accounts', () => {})

    it.todo('should handle loadAccounts returning null gracefully', () => {})
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
 * Proposed fix validation tests
 */
describe('proposed fix validation', () => {
  describe('loadAccounts should distinguish error types', () => {
    it.todo("should return { error: 'ENOENT' } when file doesn't exist", () => {})
    it.todo("should return { error: 'PERMISSION_DENIED' } on EACCES", () => {})
    it.todo("should return { error: 'PARSE_ERROR' } on invalid JSON", () => {})
    it.todo("should return { error: 'INVALID_FORMAT' } on schema mismatch", () => {})
  })

  describe('persistAccountPool should handle errors safely', () => {
    it.todo("should throw AccountFileUnreadableError when file exists but can't be read", () => {})
    it.todo('should include recovery instructions in error message', () => {})
  })

  describe('user prompts for data safety', () => {
    it.todo('should prompt user when accounts file exists but is unreadable', () => {})
    it.todo('should offer options: (r)etry, (b)ackup and continue, (a)bort', () => {})
  })
})
