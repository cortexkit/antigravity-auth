/**
 * Lock-held account storage engine.
 *
 * Owns the on-disk schema for the multi-account pool (v4) plus every
 * migration from older versions, the load/merge/save primitives, and a
 * `mutateAccountStorage` entry point that holds a fenced file lock for
 * the duration of read-modify-write. Concurrent writes retry up to a
 * bounded schedule (`100, 200, 400, 800, 1000ms` with factor 2 / max 1000)
 * before surfacing a typed `AccountStorageLockContentionError`.
 *
 * This module is harness-agnostic: it does not own a path (the harness
 * adapter passes one in via `loadAccountStorage(path)`). The harness is
 * responsible for picking the right on-disk path and ensuring the parent
 * directory exists.
 */

import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AccountMetadataV3,
  AccountStorageV3,
  AccountStorageV4,
  AnyAccountStorage,
  RateLimitStateV2,
  RateLimitStateV3,
} from './account-types.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { acquireFencedFileLock, type FencedFileLock } from './file-lock.ts'
import { createLogger } from './logger.ts'

const log = createLogger('account-storage')

/**
 * Thrown when `mutateAccountStorage` exhausts its initial attempt plus
 * five retries against a lock that is still held. Surfaces a typed
 * signal harnesses can distinguish from transient I/O errors.
 */
export class AccountStorageLockContentionError extends Error {
  readonly details: { path: string; attempts: number }

  constructor(
    message: string,
    details: AccountStorageLockContentionError['details'],
  ) {
    super(message)
    this.name = 'AccountStorageLockContentionError'
    this.details = details
  }
}

export interface AccountStorageOptions {
  /**
   * Sleep override for deterministic retry timing in tests. Defaults to
   * a real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Configuration for the lock-acquisition retry schedule. Mirrors the
 * legacy wait-and-retry schedule (5 retries, 100ms min, 1000ms max,
 * factor 2) so an immediate contention throw is a regression.
 */
const RETRY_DELAYS_MS = [100, 200, 400, 800, 1000] as const

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch {
    // best-effort; Windows + non-POSIX FS ignore this.
  }
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await readFile(path)
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeJsonAtomic(path, { version: 4, accounts: [], activeIndex: 0 })
  }
}

/**
 * Deduplicate accounts that share an email, keeping the entry with the
 * newest `lastUsed` then `addedAt`. Order of the kept entries in the
 * output array is determined by the position of the *newest* matching
 * account in the input array (not necessarily the original positions).
 */
export function deduplicateAccountsByEmail<
  T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
  const emailToNewestIndex = new Map<string, number>()
  const indicesToKeep = new Set<number>()

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]
    if (!acc) continue

    if (!acc.email) {
      indicesToKeep.add(i)
      continue
    }

    const existingIndex = emailToNewestIndex.get(acc.email)
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i)
      continue
    }

    const existing = accounts[existingIndex]
    if (!existing) {
      emailToNewestIndex.set(acc.email, i)
      continue
    }

    const currLastUsed = acc.lastUsed || 0
    const existLastUsed = existing.lastUsed || 0
    const currAddedAt = acc.addedAt || 0
    const existAddedAt = existing.addedAt || 0

    const isNewer =
      currLastUsed > existLastUsed ||
      (currLastUsed === existLastUsed && currAddedAt > existAddedAt)

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i)
    }
  }

  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx)
  }

  const result: T[] = []
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i]
      if (acc) {
        result.push(acc)
      }
    }
  }

  return result
}

function migrateV1ToV2(
  v1: Extract<AnyAccountStorage, { version: 1 }>,
): Extract<AnyAccountStorage, { version: 2 }> {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV2 = {}
      if (
        acc.isRateLimited &&
        acc.rateLimitResetTime &&
        acc.rateLimitResetTime > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime
        rateLimitResetTimes.gemini = acc.rateLimitResetTime
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      }
    }),
    activeIndex: v1.activeIndex,
  }
}

export function migrateV2ToV3(
  v2: Extract<AnyAccountStorage, { version: 2 }>,
): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV3 = {}
      if (
        acc.rateLimitResetTimes?.claude &&
        acc.rateLimitResetTimes.claude > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude
      }
      if (
        acc.rateLimitResetTimes?.gemini &&
        acc.rateLimitResetTimes.gemini > Date.now()
      ) {
        rateLimitResetTimes['gemini-antigravity'] =
          acc.rateLimitResetTimes.gemini
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      }
    }),
    activeIndex: v2.activeIndex,
  }
}

function migrateV3ToV4(v3: AccountStorageV3): AccountStorageV4 {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      ...acc,
      fingerprint: undefined,
      fingerprintHistory: undefined,
    })),
    activeIndex: v3.activeIndex,
    activeIndexByFamily: v3.activeIndexByFamily,
  }
}

/**
 * Merge two v4 account pools keyed by `refreshToken`. Preserves
 * `projectId`/`managedProjectId` from either side when the incoming
 * payload omits them. Eligibility state survives via a per-field
 * `eligibilityStateUpdatedAt` comparison so a stale concurrent writer
 * cannot regress an explicit ineligible decision.
 */
export function mergeAccountStorage(
  existing: AccountStorageV4,
  incoming: AccountStorageV4,
): AccountStorageV4 {
  const accountMap = new Map<string, AccountMetadataV3>()

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc)
    }
  }

  for (const acc of incoming.accounts) {
    if (!acc.refreshToken) continue
    const existingAcc = accountMap.get(acc.refreshToken)
    if (existingAcc) {
      const eligibilitySource =
        (acc.eligibilityStateUpdatedAt ?? 0) >=
        (existingAcc.eligibilityStateUpdatedAt ?? 0)
          ? acc
          : existingAcc
      const merged: AccountMetadataV3 = {
        ...existingAcc,
        ...acc,
        projectId: acc.projectId ?? existingAcc.projectId,
        managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
        rateLimitResetTimes: {
          ...existingAcc.rateLimitResetTimes,
          ...acc.rateLimitResetTimes,
        },
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        accountIneligible: eligibilitySource.accountIneligible,
        accountIneligibleAt: eligibilitySource.accountIneligibleAt,
        accountIneligibleReason: eligibilitySource.accountIneligibleReason,
        eligibilityStateUpdatedAt: eligibilitySource.eligibilityStateUpdatedAt,
      }
      if (merged.accountIneligible) {
        merged.enabled = false
      }
      accountMap.set(acc.refreshToken, merged)
    } else {
      accountMap.set(acc.refreshToken, acc)
    }
  }

  return {
    version: 4,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily,
  }
}

async function readAndNormalizeV4(
  path: string,
): Promise<AccountStorageV4 | null> {
  let parsed: AnyAccountStorage | null = null
  try {
    const content = await readFile(path, 'utf-8')
    parsed = JSON.parse(content) as AnyAccountStorage
  } catch {
    return null
  }

  if (!parsed || !Array.isArray(parsed.accounts)) {
    return null
  }

  let storage: AccountStorageV4 | null = null
  switch (parsed.version) {
    case 1:
      storage = migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(parsed)))
      break
    case 2:
      storage = migrateV3ToV4(migrateV2ToV3(parsed))
      break
    case 3:
      storage = migrateV3ToV4(parsed)
      break
    case 4:
      storage = parsed
      break
    default:
      return null
  }

  const validAccounts = storage.accounts.filter(
    (a): a is AccountMetadataV3 =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as AccountMetadataV3).refreshToken === 'string',
  )

  const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts)

  let activeIndex =
    typeof storage.activeIndex === 'number' &&
    Number.isFinite(storage.activeIndex)
      ? storage.activeIndex
      : 0
  if (deduplicatedAccounts.length > 0) {
    activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1)
    activeIndex = Math.max(activeIndex, 0)
  } else {
    activeIndex = 0
  }

  return {
    version: 4,
    accounts: deduplicatedAccounts,
    activeIndex,
    activeIndexByFamily: storage.activeIndexByFamily,
  }
}

/**
 * Load the account pool from `path`, migrating older versions in-place
 * to v4 and persisting the migrated copy. Returns `null` when the file
 * does not exist, is unreadable, or fails schema validation.
 */
export async function loadAccountStorage(
  path: string,
): Promise<AccountStorageV4 | null> {
  try {
    await ensureSecurePermissions(path)

    const content = await readFile(path, 'utf-8')
    const data = JSON.parse(content) as AnyAccountStorage

    if (!Array.isArray(data.accounts)) {
      log.warn('Invalid storage format, ignoring')
      return null
    }

    let storage: AccountStorageV4
    if (data.version === 1) {
      log.info('Migrating account storage from v1 to v4')
      const v2 = migrateV1ToV2(data)
      const v3 = migrateV2ToV3(v2)
      storage = migrateV3ToV4(v3)
      try {
        await saveAccountStorage(path, storage)
        log.info('Migration to v4 complete')
      } catch (saveError) {
        log.warn('Failed to persist migrated storage', {
          error: String(saveError),
        })
      }
    } else if (data.version === 2) {
      log.info('Migrating account storage from v2 to v4')
      const v3 = migrateV2ToV3(data)
      storage = migrateV3ToV4(v3)
      try {
        await saveAccountStorage(path, storage)
        log.info('Migration to v4 complete')
      } catch (saveError) {
        log.warn('Failed to persist migrated storage', {
          error: String(saveError),
        })
      }
    } else if (data.version === 3) {
      log.info('Migrating account storage from v3 to v4')
      storage = migrateV3ToV4(data)
      try {
        await saveAccountStorage(path, storage)
        log.info('Migration to v4 complete')
      } catch (saveError) {
        log.warn('Failed to persist migrated storage', {
          error: String(saveError),
        })
      }
    } else if (data.version === 4) {
      storage = data
    } else {
      log.warn('Unknown storage version, ignoring', {
        version: (data as { version?: unknown }).version,
      })
      return null
    }

    const validAccounts = storage.accounts.filter(
      (a): a is AccountMetadataV3 => {
        return (
          !!a &&
          typeof a === 'object' &&
          typeof (a as AccountMetadataV3).refreshToken === 'string'
        )
      },
    )

    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts)

    let activeIndex =
      typeof storage.activeIndex === 'number' &&
      Number.isFinite(storage.activeIndex)
        ? storage.activeIndex
        : 0
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1)
      activeIndex = Math.max(activeIndex, 0)
    } else {
      activeIndex = 0
    }

    return {
      version: 4,
      accounts: deduplicatedAccounts,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return null
    }
    log.error('Failed to load account storage', { error: String(error) })
    return null
  }
}

/**
 * Acquire the lock for `path`, retrying on contention up to the legacy
 * wait-and-retry schedule (`100, 200, 400, 800, 1000ms`) so an
 * immediate contention throw is a regression. Throws a typed
 * `AccountStorageLockContentionError` after the initial attempt plus
 * five retries — but only when the failure mode is "another writer
 * holds the lock" (`null` from `acquireFencedFileLock`). Real I/O
 * errors (permission denied, missing path, disk failure) are rethrown
 * immediately so callers can distinguish them from contention.
 */
async function acquireWithRetry(
  path: string,
  sleep: (ms: number) => Promise<void>,
): Promise<FencedFileLock> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // acquireFencedFileLock throws on real I/O failure (permission,
    // missing dir, disk error); it only returns `null` for a live,
    // contended lock. Rethrow immediately so callers don't mistake a
    // missing config dir for "someone else is writing".
    const lock = await acquireFencedFileLock({
      path,
      name: 'accounts',
      ttlMs: 10_000,
      renew: true,
    })
    if (lock) {
      return lock
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay !== undefined) {
        await sleep(delay)
      }
    }
  }

  throw new AccountStorageLockContentionError(
    `account storage lock contention at ${path} after ${RETRY_DELAYS_MS.length + 1} attempts`,
    {
      path,
      attempts: RETRY_DELAYS_MS.length + 1,
    },
  )
}

/**
 * Run `mutate` against the freshest persisted pool while holding the
 * file lock. The mutator may return a partial v4 (or `undefined` to
 * keep the input unchanged) and is guaranteed to see the post-migration
 * v4 shape.
 *
 * Throws `AccountStorageLockContentionError` after exhausting the
 * retry schedule against a lock that is still held by another writer.
 */
export async function mutateAccountStorage(
  path: string,
  mutate: (
    current: AccountStorageV4,
  ) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>,
  options: AccountStorageOptions = {},
): Promise<AccountStorageV4> {
  const sleep = options.sleep ?? DEFAULT_SLEEP
  const lock = await acquireWithRetry(path, sleep)

  try {
    const existing = await readAndNormalizeV4(path)
    // The mutator may be sync or async; awaiting its result lets long
    // mutators hold the lock for the duration of their work (the OS-level
    // create-lock + renewal keeps us exclusive that whole time).
    const next = await mutate(
      existing ?? { version: 4, accounts: [], activeIndex: 0 },
    )
    const finalStorage: AccountStorageV4 = next ??
      existing ?? {
        version: 4,
        accounts: [],
        activeIndex: 0,
      }

    await lock.assertOwned()
    await writeJsonAtomic(path, finalStorage)

    return finalStorage
  } finally {
    try {
      await lock.release()
    } catch (releaseError) {
      log.warn('Failed to release account storage lock', {
        error: String(releaseError),
      })
    }
  }
}

/**
 * Merge `incoming` into the persisted pool under the lock. Returns the
 * merged v4 result that was written to disk.
 */
export async function saveAccountStorage(
  path: string,
  incoming: AccountStorageV4,
): Promise<AccountStorageV4> {
  return mutateAccountStorage(path, (current) =>
    mergeAccountStorage(current, incoming),
  )
}

/**
 * Write `incoming` to disk unconditionally (no merge). Required for
 * destructive operations like delete where the next-state must replace
 * — never be merged with — what is on disk.
 */
export async function saveAccountStorageReplace(
  path: string,
  incoming: AccountStorageV4,
): Promise<AccountStorageV4> {
  return mutateAccountStorage(path, () => incoming)
}

/**
 * Unlink the persisted pool while holding the lock so a concurrent
 * debounced save cannot resurrect the pool mid-clear. Missing files are
 * treated as a successful no-op (matches the legacy semantics).
 */
export async function clearAccountStorage(path: string): Promise<void> {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))
  const lock = await acquireWithRetry(path, sleep)

  try {
    await unlink(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.error('Failed to clear account storage', { error: String(error) })
      throw error
    }
  } finally {
    try {
      await lock.release()
    } catch (releaseError) {
      log.warn('Failed to release account storage lock', {
        error: String(releaseError),
      })
    }
  }
}

/**
 * Bundle the harness-facing storage primitives. Used by `AccountManager`
 * so tests can inject a fake store without going through the filesystem.
 */
export interface AccountStorageStore {
  load: (path: string) => Promise<AccountStorageV4 | null>
  saveMerged: (
    path: string,
    next: AccountStorageV4,
  ) => Promise<AccountStorageV4>
  mutate: (
    path: string,
    fn: (
      current: AccountStorageV4,
    ) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>,
    options?: AccountStorageOptions,
  ) => Promise<AccountStorageV4>
  clear: (path: string) => Promise<void>
}

export const defaultAccountStorageStore: AccountStorageStore = {
  load: loadAccountStorage,
  saveMerged: saveAccountStorage,
  mutate: mutateAccountStorage,
  clear: clearAccountStorage,
}
