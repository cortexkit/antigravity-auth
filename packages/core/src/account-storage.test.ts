/**
 * Account storage concurrency + migration tests.
 *
 * Locks onto the fenced-file-lock semantics: `mutateAccountStorage`
 * must wait-and-succeed when the lock is held briefly by another
 * writer (preserving the legacy `proper-lockfile` retry schedule), and
 * must surface a typed `AccountStorageLockContentionError` once the
 * schedule is exhausted against a still-held lock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountStorageLockContentionError,
  AccountStorageUnreadableError,
  clearAccountStorage,
  deduplicateAccountsByEmail,
  loadAccountStorage,
  mergeAccountStorage,
  mutateAccountStorage,
  saveAccountStorage,
  saveAccountStorageReplace,
} from './account-storage.ts'
import type { AccountMetadataV3, AccountStorageV4 } from './account-types.ts'
import { acquireFencedFileLock } from './file-lock.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'account-storage-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function storagePath(name = 'accounts.json'): string {
  return join(root, name)
}

function makeV4(
  accounts: AccountMetadataV3[],
  activeIndex = 0,
  activeIndexByFamily?: { claude?: number; gemini?: number },
): AccountStorageV4 {
  return {
    version: 4,
    accounts,
    activeIndex,
    activeIndexByFamily,
  }
}

function makeV3(
  accounts: AccountMetadataV3[],
  activeIndex = 0,
): {
  version: 3
  accounts: AccountMetadataV3[]
  activeIndex: number
  activeIndexByFamily?: { claude?: number; gemini?: number }
} {
  return {
    version: 3,
    accounts,
    activeIndex,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  }
}

function makeV2(
  accounts: Array<{
    email?: string
    refreshToken: string
    projectId?: string
    managedProjectId?: string
    addedAt: number
    lastUsed: number
    rateLimitResetTimes?: { claude?: number; gemini?: number }
  }>,
  activeIndex = 0,
): {
  version: 2
  accounts: typeof accounts
  activeIndex: number
} {
  return { version: 2, accounts, activeIndex }
}

function makeV1(
  accounts: Array<{
    email?: string
    refreshToken: string
    addedAt: number
    lastUsed: number
    isRateLimited?: boolean
    rateLimitResetTime?: number
  }>,
  activeIndex = 0,
): {
  version: 1
  accounts: typeof accounts
  activeIndex: number
} {
  return { version: 1, accounts, activeIndex }
}

describe('deduplicateAccountsByEmail', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateAccountsByEmail([])).toEqual([])
  })

  it('keeps accounts without email', () => {
    const accounts: AccountMetadataV3[] = [
      { refreshToken: 'r1', addedAt: 1, lastUsed: 2 },
      { refreshToken: 'r2', addedAt: 3, lastUsed: 4 },
    ]
    expect(deduplicateAccountsByEmail(accounts)).toEqual(accounts)
  })

  it('keeps the newest entry by lastUsed for duplicate emails', () => {
    const accounts: AccountMetadataV3[] = [
      { email: 'a@example.com', refreshToken: 'old', addedAt: 1, lastUsed: 1 },
      { email: 'a@example.com', refreshToken: 'new', addedAt: 2, lastUsed: 9 },
    ]
    expect(deduplicateAccountsByEmail(accounts)).toHaveLength(1)
    expect(deduplicateAccountsByEmail(accounts)[0]?.refreshToken).toBe('new')
  })
})

describe('mergeAccountStorage', () => {
  it('preserves a newer ineligible decision against a stale concurrent writer', () => {
    const existing = makeV4([
      {
        refreshToken: 'r1',
        addedAt: 1,
        lastUsed: 1,
        enabled: false,
        accountIneligible: true,
        accountIneligibleAt: 200,
        accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
        eligibilityStateUpdatedAt: 200,
      },
    ])
    const staleIncoming = makeV4([
      {
        refreshToken: 'r1',
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
        accountIneligible: false,
        eligibilityStateUpdatedAt: 100,
      },
    ])
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
    const existing = makeV4([
      {
        refreshToken: 'r1',
        addedAt: 1,
        lastUsed: 1,
        enabled: false,
        accountIneligible: true,
        accountIneligibleAt: 200,
        accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
        eligibilityStateUpdatedAt: 200,
      },
    ])
    const rechecked = makeV4([
      {
        refreshToken: 'r1',
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
        accountIneligible: false,
        eligibilityStateUpdatedAt: 300,
      },
    ])
    expect(mergeAccountStorage(existing, rechecked).accounts[0]).toMatchObject({
      enabled: true,
      accountIneligible: false,
      eligibilityStateUpdatedAt: 300,
    })
  })
})

describe('loadAccountStorage migrations', () => {
  const now = Date.now()
  const future = now + 100_000

  it('migrates v1 -> v4', async () => {
    const v1 = makeV1(
      [
        {
          email: 'a@example.com',
          refreshToken: 'r1',
          addedAt: now,
          lastUsed: now,
          isRateLimited: true,
          rateLimitResetTime: future,
        },
      ],
      0,
    )
    await writeFile(storagePath(), JSON.stringify(v1), 'utf8')

    const result = await loadAccountStorage(storagePath())
    expect(result?.version).toBe(4)
    expect(result?.accounts[0]).toMatchObject({
      refreshToken: 'r1',
      email: 'a@example.com',
    })
    expect(result?.accounts[0]?.rateLimitResetTimes).toEqual({
      claude: future,
      'gemini-antigravity': future,
    })
  })

  it('migrates v2 -> v4', async () => {
    const v2 = makeV2(
      [
        {
          refreshToken: 'r1',
          addedAt: now,
          lastUsed: now,
          rateLimitResetTimes: { gemini: future },
        },
      ],
      0,
    )
    await writeFile(storagePath(), JSON.stringify(v2), 'utf8')

    const result = await loadAccountStorage(storagePath())
    expect(result?.version).toBe(4)
    expect(result?.accounts[0]?.rateLimitResetTimes).toEqual({
      'gemini-antigravity': future,
    })
  })

  it('migrates v3 -> v4 and drops fingerprint fields', async () => {
    const v3 = makeV3([
      {
        refreshToken: 'r1',
        addedAt: now,
        lastUsed: now,
        fingerprint: {
          deviceId: 'd1',
          sessionToken: 't1',
          userAgent: 'ua',
          apiClient: 'ac',
          clientMetadata: { ideType: 'IDE', platform: 'P', pluginType: 'G' },
          createdAt: now,
        },
        fingerprintHistory: [
          {
            fingerprint: {
              deviceId: 'd0',
              sessionToken: 't0',
              userAgent: 'ua',
              apiClient: 'ac',
              clientMetadata: {
                ideType: 'IDE',
                platform: 'P',
                pluginType: 'G',
              },
              createdAt: now - 1,
            },
            timestamp: now - 1,
            reason: 'initial',
          },
        ],
      },
    ])
    await writeFile(storagePath(), JSON.stringify(v3), 'utf8')

    const result = await loadAccountStorage(storagePath())
    expect(result?.version).toBe(4)
    expect(result?.accounts[0]?.fingerprint).toBeUndefined()
    expect(result?.accounts[0]?.fingerprintHistory).toBeUndefined()
  })
})

describe('loadAccountStorage missing-vs-unreadable', () => {
  it('returns null when the file is missing (ENOENT is not an error)', async () => {
    expect(await loadAccountStorage(storagePath())).toBeNull()
  })

  it('throws AccountStorageUnreadableError on JSON parse error and creates a backup', async () => {
    const path = storagePath()
    await writeFile(path, '{ invalid json }', 'utf8')

    let captured: unknown
    try {
      await loadAccountStorage(path)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    const err = captured as AccountStorageUnreadableError
    expect(err.details.path).toBe(path)
    expect(err.details.reason).toBe('malformed-json')
    expect(err.details.backupPath).not.toBeNull()
    // The original file must remain on disk for the user to recover.
    const onDisk = await readFile(path, 'utf8')
    expect(onDisk).toBe('{ invalid json }')
    // The backup sidecar must hold a verbatim copy.
    if (err.details.backupPath) {
      const backup = await readFile(err.details.backupPath, 'utf8')
      expect(backup).toBe('{ invalid json }')
    }
  })

  it('throws AccountStorageUnreadableError when accounts is not an array', async () => {
    const path = storagePath()
    await writeFile(
      path,
      JSON.stringify({ version: 4, notAccounts: [] }),
      'utf8',
    )

    let captured: unknown
    try {
      await loadAccountStorage(path)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    const err = captured as AccountStorageUnreadableError
    expect(err.details.reason).toBe('invalid-shape')
    expect(err.details.backupPath).not.toBeNull()
  })

  it('throws AccountStorageUnreadableError on unknown version', async () => {
    const path = storagePath()
    await writeFile(
      path,
      JSON.stringify({ version: 999, accounts: [] }),
      'utf8',
    )

    let captured: unknown
    try {
      await loadAccountStorage(path)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    const err = captured as AccountStorageUnreadableError
    expect(err.details.reason).toBe('unsupported-version')
    expect(err.details.detail).toContain('999')
    expect(err.details.backupPath).not.toBeNull()
  })

  it('throws AccountStorageUnreadableError when the file is a JSON array (not an object)', async () => {
    const path = storagePath()
    await writeFile(path, '[]', 'utf8')

    await expect(loadAccountStorage(path)).rejects.toBeInstanceOf(
      AccountStorageUnreadableError,
    )
  })

  it('still surfaces ENOENT as null (NOT unreadable) when the parent directory does not exist', async () => {
    const path = join(root, 'nested-missing', 'accounts.json')
    expect(await loadAccountStorage(path)).toBeNull()
  })
})

describe('loadAccountStorage normalization', () => {
  it('deduplicates accounts sharing an email', async () => {
    await writeFile(
      storagePath(),
      JSON.stringify(
        makeV4([
          {
            email: 'a@example.com',
            refreshToken: 'old',
            addedAt: 1,
            lastUsed: 1,
          },
          {
            email: 'a@example.com',
            refreshToken: 'new',
            addedAt: 2,
            lastUsed: 9,
          },
        ]),
      ),
      'utf8',
    )
    const result = await loadAccountStorage(storagePath())
    expect(result?.accounts).toHaveLength(1)
    expect(result?.accounts[0]?.refreshToken).toBe('new')
  })

  it('clamps activeIndex to a valid range', async () => {
    await writeFile(
      storagePath(),
      JSON.stringify({
        version: 4,
        accounts: [{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }],
        activeIndex: 99,
      }),
      'utf8',
    )
    const result = await loadAccountStorage(storagePath())
    expect(result?.activeIndex).toBe(0)
  })
})

describe('saveAccountStorage', () => {
  it('persists the v4 file with secure permissions on POSIX', async () => {
    if (process.platform === 'win32') return
    const path = storagePath()
    const storage = makeV4([
      {
        refreshToken: 'r1',
        addedAt: 1,
        lastUsed: 1,
      },
    ])
    await saveAccountStorage(path, storage)
    const stats = await stat(path)
    expect((stats.mode & 0o777).toString(8)).toBe('600')
  })

  it('merges new accounts into an existing pool', async () => {
    const path = storagePath()
    await saveAccountStorage(
      path,
      makeV4([{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }]),
    )
    await saveAccountStorage(
      path,
      makeV4([{ refreshToken: 'r2', addedAt: 2, lastUsed: 2 }]),
    )
    const result = await loadAccountStorage(path)
    const tokens = result?.accounts.map((a) => a.refreshToken).sort()
    expect(tokens).toEqual(['r1', 'r2'])
  })
})

describe('saveAccountStorageReplace', () => {
  it('replaces the file (does not merge)', async () => {
    const path = storagePath()
    await saveAccountStorage(
      path,
      makeV4([{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }]),
    )
    await saveAccountStorageReplace(
      path,
      makeV4([{ refreshToken: 'r2', addedAt: 2, lastUsed: 2 }]),
    )
    const result = await loadAccountStorage(path)
    expect(result?.accounts).toHaveLength(1)
    expect(result?.accounts[0]?.refreshToken).toBe('r2')
  })
})

describe('clearAccountStorage', () => {
  it('removes an existing file', async () => {
    const path = storagePath()
    await saveAccountStorage(
      path,
      makeV4([{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }]),
    )
    await clearAccountStorage(path)
    expect(await loadAccountStorage(path)).toBeNull()
  })

  it('succeeds silently when the file is already absent', async () => {
    await expect(clearAccountStorage(storagePath())).resolves.toBeUndefined()
  })
})

describe('mutateAccountStorage concurrency', () => {
  it('serializes two add operations so both accounts remain', async () => {
    const path = storagePath()
    await saveAccountStorage(path, makeV4([], 0))

    const delays: number[] = []
    const start = Date.now()
    const a = mutateAccountStorage(path, async (current) => {
      // Pause to simulate the write window, giving B a chance to commit first.
      await new Promise((r) => setTimeout(r, 150))
      return {
        version: 4,
        accounts: [
          ...current.accounts,
          { refreshToken: 'a', addedAt: 1, lastUsed: 1 },
        ],
        activeIndex: 0,
      }
    })
    // Yield the event loop so A acquires the lock first.
    await new Promise((r) => setTimeout(r, 10))
    const b = mutateAccountStorage(path, (current) => ({
      version: 4,
      accounts: [
        ...current.accounts,
        { refreshToken: 'b', addedAt: 2, lastUsed: 2 },
      ],
      activeIndex: 0,
    }))

    await Promise.all([a, b])
    delays.push(Date.now() - start)

    const result = await loadAccountStorage(path)
    const tokens = result?.accounts.map((acc) => acc.refreshToken).sort()
    expect(tokens).toEqual(['a', 'b'])
  })

  it('lets a remove-then-add sequence against fresh state leave A absent and B present', async () => {
    const path = storagePath()
    await saveAccountStorage(
      path,
      makeV4([
        { refreshToken: 'a', addedAt: 1, lastUsed: 1 },
        { refreshToken: 'b', addedAt: 2, lastUsed: 2 },
      ]),
    )

    const remove = mutateAccountStorage(path, async (current) => {
      // Pause so B can commit while we still hold the lock-less snapshot.
      await new Promise((r) => setTimeout(r, 150))
      return {
        version: 4,
        accounts: current.accounts.filter((acc) => acc.refreshToken !== 'a'),
        activeIndex: 0,
      }
    })
    await new Promise((r) => setTimeout(r, 10))
    const add = mutateAccountStorage(path, (current) => ({
      version: 4,
      accounts: [
        ...current.accounts,
        { refreshToken: 'new-b', addedAt: 9, lastUsed: 9 },
      ],
      activeIndex: 0,
    }))

    await Promise.all([remove, add])

    const result = await loadAccountStorage(path)
    const tokens = result?.accounts.map((acc) => acc.refreshToken).sort()
    expect(tokens).toEqual(['b', 'new-b'])
  })

  it('waits and commits when a competing lock is released mid-mutation', async () => {
    const path = storagePath()
    const held = await acquireFencedFileLock({
      path,
      name: 'accounts',
      ttlMs: 10_000,
      renew: true,
    })
    expect(held).not.toBeNull()
    const heldLock = held!

    // Schedule the competing lock to release well within the
    // legacy wait-and-retry schedule (first retry sleeps 100ms,
    // second sleeps 200ms — by then the holder should have released).
    setTimeout(() => {
      heldLock.release().catch(() => {})
    }, 150)

    const startedAt = Date.now()
    const result = await mutateAccountStorage(path, (current) => ({
      version: 4,
      accounts: [
        ...current.accounts,
        { refreshToken: 'late', addedAt: 1, lastUsed: 1 },
      ],
      activeIndex: 0,
    }))
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(result.accounts.map((acc) => acc.refreshToken)).toContain('late')
  })

  it('throws AccountStorageLockContentionError when the lock is held past the retry schedule', async () => {
    const path = storagePath()
    const held = await acquireFencedFileLock({
      path,
      name: 'accounts',
      ttlMs: 10_000,
      renew: true,
    })
    expect(held).not.toBeNull()
    const heldLock = held!

    try {
      await expect(
        mutateAccountStorage(path, (current) => current, {
          sleep: async () => {
            // Zero-delay sleep so the test does not block for the full schedule.
          },
        }),
      ).rejects.toBeInstanceOf(AccountStorageLockContentionError)
    } finally {
      await heldLock.release()
    }
  })
})

describe('file mode after storage operations', () => {
  it('chmods an existing v4 file to 0600 on POSIX', async () => {
    if (process.platform === 'win32') return
    const path = storagePath()
    await writeFile(
      path,
      JSON.stringify(makeV4([{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }])),
      'utf8',
    )
    await chmod(path, 0o644)
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('644')

    await loadAccountStorage(path)

    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
  })

  it('creates parent directories on demand', async () => {
    const nested = join(root, 'nested', 'deep', 'accounts.json')
    await saveAccountStorage(
      nested,
      makeV4([{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }]),
    )
    const raw = JSON.parse(await readFile(nested, 'utf8'))
    expect(raw.version).toBe(4)
  })
})

describe('ensureFileExists on initial write', () => {
  it('seeds an empty v4 pool when mutate is called against a missing file', async () => {
    const path = storagePath('first-write.json')
    const result = await mutateAccountStorage(path, (current) => ({
      ...current,
      activeIndex: 0,
    }))
    expect(result.version).toBe(4)
    expect(result.accounts).toEqual([])

    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw).toMatchObject({ version: 4, accounts: [], activeIndex: 0 })
  })
})

describe('mutateAccountStorage fail-closed on unreadable file', () => {
  // Snapshot the raw bytes of a corrupt file to verify the on-disk
  // file is NEVER overwritten by a failed mutation.
  async function seedCorrupt(
    name: string,
    contents: string,
  ): Promise<{ path: string; raw: string }> {
    const path = storagePath(name)
    await writeFile(path, contents, 'utf8')
    return { path, raw: contents }
  }

  it('throws AccountStorageUnreadableError against malformed JSON and does NOT overwrite the file', async () => {
    const { path, raw } = await seedCorrupt(
      'corrupt-1.json',
      '{ invalid json }',
    )
    const attemptedAdd: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: 'new-token',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
    }

    let captured: unknown
    try {
      await mutateAccountStorage(path, () => attemptedAdd)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    const err = captured as AccountStorageUnreadableError
    expect(err.details.reason).toBe('malformed-json')
    expect(err.details.path).toBe(path)
    expect(err.details.backupPath).not.toBeNull()

    // The user's file must be byte-for-byte unchanged.
    const onDisk = await readFile(path, 'utf8')
    expect(onDisk).toBe(raw)
    // The backup must hold a verbatim copy.
    if (err.details.backupPath) {
      const backup = await readFile(err.details.backupPath, 'utf8')
      expect(backup).toBe(raw)
    }
  })

  it('throws AccountStorageUnreadableError on invalid shape (accounts not an array)', async () => {
    const { path, raw } = await seedCorrupt(
      'corrupt-2.json',
      JSON.stringify({ version: 4, notAccounts: [] }),
    )

    let captured: unknown
    try {
      await mutateAccountStorage(path, (current) => current)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    expect((captured as AccountStorageUnreadableError).details.reason).toBe(
      'invalid-shape',
    )
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('throws AccountStorageUnreadableError on unsupported-version (e.g. a newer plugin wrote version 5)', async () => {
    const { path, raw } = await seedCorrupt(
      'corrupt-3.json',
      JSON.stringify({
        version: 5,
        accounts: [{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }],
      }),
    )

    let captured: unknown
    try {
      await mutateAccountStorage(path, (current) => current)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    expect((captured as AccountStorageUnreadableError).details.reason).toBe(
      'unsupported-version',
    )
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('succeeds against a missing file (first-run UX unchanged)', async () => {
    const path = storagePath('first-run.json')
    const result = await mutateAccountStorage(path, (current) => ({
      ...current,
      accounts: [{ refreshToken: 'r1', addedAt: 1, lastUsed: 1 }],
      activeIndex: 0,
    }))
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.refreshToken).toBe('r1')
  })

  it('error message includes the path and the backup path so the user knows where their data went', async () => {
    const { path } = await seedCorrupt('corrupt-4.json', '{ broken')

    let captured: unknown
    try {
      await mutateAccountStorage(path, (current) => current)
    } catch (error) {
      captured = error
    }
    const err = captured as AccountStorageUnreadableError
    expect(err.message).toContain(path)
    if (err.details.backupPath) {
      expect(err.message).toContain(err.details.backupPath)
    }
  })

  it('still preserves the file when the backup itself fails', async () => {
    const { path, raw } = await seedCorrupt('corrupt-5.json', '{ broken')

    let captured: unknown
    try {
      await mutateAccountStorage(path, (current) => current, {
        buildBackupPath: () => '/proc/this-cannot-be-written/corrupt-5.json',
      })
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AccountStorageUnreadableError)
    const err = captured as AccountStorageUnreadableError
    expect(err.details.backupPath).toBeNull()
    // Original file MUST remain intact.
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('a legacy v1 file migrates in-place (no unreadable throw) and v4 ends up on disk', async () => {
    const path = storagePath('legacy-v1.json')
    const v1 = {
      version: 1,
      accounts: [
        {
          email: 'a@example.com',
          refreshToken: 'r1',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
    }
    await writeFile(path, JSON.stringify(v1), 'utf8')
    const result = await mutateAccountStorage(path, (current) => current)
    expect(result.version).toBe(4)
    expect(result.accounts[0]?.refreshToken).toBe('r1')
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    expect(onDisk.version).toBe(4)
    expect(onDisk.accounts[0]?.refreshToken).toBe('r1')
  })
})
