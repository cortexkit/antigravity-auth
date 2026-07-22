import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountMetadata,
  type AccountStorage,
  type AccountStorageV4,
  deduplicateAccountsByEmail,
  ensureGitignore,
  ensureGitignoreSync,
  loadAccounts,
  mergeAccountStorage,
  migrateV2ToV3,
} from './storage'

mock.module('proper-lockfile', () => ({
  lock: mock().mockResolvedValue(mock().mockResolvedValue(undefined)),
  default: {
    lock: mock().mockResolvedValue(mock().mockResolvedValue(undefined)),
  },
}))

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
      expect(gitignore).toContain('antigravity-signature-cache.json')
      expect(gitignore).toContain('antigravity-logs/')
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
        'antigravity-signature-cache.json',
        'antigravity-logs/',
      ].join('\n')
      const before = await writeFile(
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
      expect(gitignore).toContain('antigravity-signature-cache.json')
      expect(gitignore).toContain('antigravity-logs/')
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
