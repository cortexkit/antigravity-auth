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
 * Fail-closed semantics: when the accounts file exists but cannot be
 * read as a valid v4 (parse error, schema mismatch, unknown future
 * version, I/O error), `mutateAccountStorage` and `loadAccountStorage`
 * throw a typed `AccountStorageUnreadableError` instead of treating
 * the bad state as "empty pool" and overwriting the file on the next
 * write. A best-effort `.corrupt-<ISO-timestamp>` backup is created
 * before throwing so a future bug can never permanently destroy user
 * data. The backup itself never throws.
 *
 * This module is harness-agnostic: it does not own a path (the harness
 * adapter passes one in via `loadAccountStorage(path)`). The harness is
 * responsible for picking the right on-disk path and ensuring the parent
 * directory exists.
 */

import { chmod, copyFile, mkdir, readFile, unlink } from 'node:fs/promises'
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

/**
 * Reason the on-disk accounts file could not be parsed as a usable v4.
 * Harnesses distinguish between `malformed-json` (the file is broken
 * JSON — possibly truncated), `invalid-shape` (JSON parsed but the
 * shape does not match the storage schema), `unsupported-version` (a
 * version newer than v4 that this build cannot migrate), and `io-error`
 * (a real I/O failure other than ENOENT — typically EACCES).
 */
export type AccountStorageUnreadableReason =
  | 'malformed-json'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'io-error'

/**
 * Thrown when the on-disk accounts file exists but cannot be read as
 * a valid v4. Distinguishes ENOENT (first-run UX: missing file is
 * fine) from "the file is there but we can't trust it" (fail closed).
 *
 * `backupPath` is set when a `.corrupt-<ISO-timestamp>` sidecar was
 * successfully written; consumers should mention it in any user-facing
 * recovery message so the user knows their data is preserved.
 */
export class AccountStorageUnreadableError extends Error {
  readonly details: {
    path: string
    reason: AccountStorageUnreadableReason
    detail: string
    backupPath: string | null
  }

  constructor(
    message: string,
    details: AccountStorageUnreadableError['details'],
  ) {
    super(message)
    this.name = 'AccountStorageUnreadableError'
    this.details = details
  }
}

/**
 * Discriminated result of an internal read attempt. Used by the
 * mutation path so it can distinguish first-run (missing file is fine)
 * from "file is corrupt, refuse to write" without overloading the
 * public `null` contract that legitimate callers still expect.
 */
type StorageReadOutcome =
  | { state: 'missing' }
  | { state: 'ok'; storage: AccountStorageV4 }
  | {
      state: 'unreadable'
      reason: AccountStorageUnreadableReason
      detail: string
    }

export interface AccountStorageOptions {
  /**
   * Sleep override for deterministic retry timing in tests. Defaults to
   * a real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * Backup override for deterministic backup paths in tests. Defaults
   * to `path + '.corrupt-<ISO-timestamp>'` with the time captured at
   * call time. Returning `null` skips the backup.
   */
  buildBackupPath?: (path: string, now: Date) => string | null
  /**
   * Clock override for deterministic timestamps in tests. Defaults to
   * `() => new Date()`.
   */
  now?: () => Date
}

/**
 * Configuration for the lock-acquisition retry schedule. Mirrors the
 * legacy wait-and-retry schedule (5 retries, 100ms min, 1000ms max,
 * factor 2) so an immediate contention throw is a regression.
 */
const RETRY_DELAYS_MS = [100, 200, 400, 800, 1000] as const

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_BUILD_BACKUP_PATH = (path: string, now: Date): string =>
  `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`

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
 * Copy a corrupt file to a `.corrupt-<ISO-timestamp>` sidecar. The
 * backup itself never throws — if it fails (e.g. disk full, permission
 * denied on the sidecar path), the original unreadable error is what
 * the caller sees. Returns the backup path on success, `null` on
 * failure.
 */
async function backupCorruptFile(
  sourcePath: string,
  buildBackupPath: (path: string, now: Date) => string | null,
  now: Date,
): Promise<string | null> {
  const backupPath = buildBackupPath(sourcePath, now)
  if (!backupPath) return null
  try {
    await copyFile(sourcePath, backupPath)
    await ensureSecurePermissions(backupPath)
    return backupPath
  } catch (backupError) {
    log.warn('Failed to back up corrupt account storage file', {
      sourcePath,
      backupPath,
      error: String(backupError),
    })
    return null
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

/**
 * Read the on-disk file and reduce it to a `StorageReadOutcome`. Used
 * by `mutateAccountStorage` (which needs to distinguish "missing →
 * first-run empty pool" from "exists but unreadable → refuse to write")
 * and by `loadAccountStorage` (which maps unreadable to a thrown error).
 */
async function readAndNormalizeV4(path: string): Promise<StorageReadOutcome> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { state: 'missing' }
    }
    return {
      state: 'unreadable',
      reason: 'io-error',
      detail: `${code ?? 'UNKNOWN'}: ${(error as Error).message ?? String(error)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (parseError) {
    return {
      state: 'unreadable',
      reason: 'malformed-json',
      detail: (parseError as Error).message ?? String(parseError),
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'unreadable',
      reason: 'invalid-shape',
      detail: 'top-level value is not an object',
    }
  }

  const candidate = parsed as { accounts?: unknown; version?: unknown }
  if (!Array.isArray(candidate.accounts)) {
    return {
      state: 'unreadable',
      reason: 'invalid-shape',
      detail: '`accounts` is missing or not an array',
    }
  }

  const parsedVersion = candidate.version
  if (
    parsedVersion !== 1 &&
    parsedVersion !== 2 &&
    parsedVersion !== 3 &&
    parsedVersion !== 4
  ) {
    return {
      state: 'unreadable',
      reason: 'unsupported-version',
      detail: `unsupported version: ${String(parsedVersion)}`,
    }
  }

  let storage: AccountStorageV4 | null = null
  switch (parsedVersion) {
    case 1:
      storage = migrateV3ToV4(
        migrateV2ToV3(
          migrateV1ToV2(parsed as Extract<AnyAccountStorage, { version: 1 }>),
        ),
      )
      break
    case 2:
      storage = migrateV3ToV4(
        migrateV2ToV3(parsed as Extract<AnyAccountStorage, { version: 2 }>),
      )
      break
    case 3:
      storage = migrateV3ToV4(parsed as AccountStorageV3)
      break
    case 4:
      storage = parsed as AccountStorageV4
      break
  }

  if (!storage) {
    return {
      state: 'unreadable',
      reason: 'unsupported-version',
      detail: `unhandled version after switch: ${String(parsedVersion)}`,
    }
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
    state: 'ok',
    storage: {
      version: 4,
      accounts: deduplicatedAccounts,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily,
    },
  }
}

/**
 * Load the account pool from `path`, migrating older versions in-place
 * to v4 and persisting the migrated copy.
 *
 * Returns `null` when the file does not exist (first-run UX).
 *
 * Throws `AccountStorageUnreadableError` when the file exists but
 * cannot be read as a valid v4 — callers must NOT treat this as an
 * empty pool, or they will silently destroy the user's data on the
 * next write.
 */
export async function loadAccountStorage(
  path: string,
): Promise<AccountStorageV4 | null> {
  const buildBackupPath = DEFAULT_BUILD_BACKUP_PATH
  const now = () => new Date()
  await ensureSecurePermissions(path)

  const outcome = await readAndNormalizeV4(path)
  if (outcome.state === 'missing') {
    return null
  }
  if (outcome.state === 'unreadable') {
    const backupPath = await backupCorruptFile(path, buildBackupPath, now())
    throw new AccountStorageUnreadableError(
      `Account storage at ${path} is unreadable (${outcome.reason}: ${outcome.detail}).` +
        (backupPath
          ? ` A backup was written to ${backupPath}. The plugin will refuse to write until the file is removed or repaired.`
          : ' A backup could not be written; the file has been left in place. The plugin will refuse to write until the file is removed or repaired.'),
      {
        path,
        reason: outcome.reason,
        detail: outcome.detail,
        backupPath,
      },
    )
  }

  // Persist the migrated copy for v1/v2/v3 so subsequent loads are
  // a single pass. Migration never changes semantics; a write failure
  // is logged but not fatal — the in-memory result is still correct.
  if (outcome.storage.version === 4) {
    const onDiskVersion = await readVersionOnly(path)
    if (onDiskVersion !== null && onDiskVersion !== 4) {
      try {
        await saveAccountStorage(path, outcome.storage)
        log.info('Migration to v4 complete')
      } catch (saveError) {
        log.warn('Failed to persist migrated storage', {
          error: String(saveError),
        })
      }
    }
  }

  return outcome.storage
}

async function readVersionOnly(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'number' ? parsed.version : null
  } catch {
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
 *
 * Throws `AccountStorageUnreadableError` when the file exists but
 * cannot be read as a valid v4. In that case the file is first copied
 * to a `.corrupt-<ISO-timestamp>` sidecar (best-effort) and the write
 * is aborted — a user with a corrupt-but-recoverable accounts file (or
 * one written by a newer plugin version) who adds one account MUST NOT
 * have their entire pool silently destroyed.
 */
export async function mutateAccountStorage(
  path: string,
  mutate: (
    current: AccountStorageV4,
  ) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>,
  options: AccountStorageOptions = {},
): Promise<AccountStorageV4> {
  const sleep = options.sleep ?? DEFAULT_SLEEP
  const buildBackupPath = options.buildBackupPath ?? DEFAULT_BUILD_BACKUP_PATH
  const now = options.now ?? (() => new Date())
  const lock = await acquireWithRetry(path, sleep)

  try {
    const outcome = await readAndNormalizeV4(path)

    if (outcome.state === 'unreadable') {
      const backupPath = await backupCorruptFile(path, buildBackupPath, now())
      throw new AccountStorageUnreadableError(
        `Refusing to write: account storage at ${path} is unreadable (${outcome.reason}: ${outcome.detail}).` +
          (backupPath
            ? ` A backup of the existing file was written to ${backupPath} and the on-disk file has been left untouched. Repair or remove the existing file before retrying.`
            : ' A backup could not be written; the on-disk file has been left untouched. Repair or remove the existing file before retrying.'),
        {
          path,
          reason: outcome.reason,
          detail: outcome.detail,
          backupPath,
        },
      )
    }

    const existing: AccountStorageV4 =
      outcome.state === 'ok'
        ? outcome.storage
        : { version: 4, accounts: [], activeIndex: 0 }

    // The mutator may be sync or async; awaiting its result lets long
    // mutators hold the lock for the duration of their work (the OS-level
    // create-lock + renewal keeps us exclusive that whole time).
    const next = await mutate(existing)
    const finalStorage: AccountStorageV4 = next ?? existing

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
