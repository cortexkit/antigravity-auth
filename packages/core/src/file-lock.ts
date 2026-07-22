/**
 * Renewable fenced file lock.
 *
 * The lock file at `${path}.${name}.lock` holds the JSON
 * `{ ownerId, expiresAt }`. Acquiring it uses an exclusive `wx` write so
 * concurrent processes race deterministically — only one wins.
 *
 * A contended, live lock (ownerId present, expiresAt > now) returns
 * `null` immediately; no eviction is attempted and no destructive op
 * touches the file. A contended, stale lock (no owner, expired, or
 * malformed-but-old) opens an eviction protocol that uses an exclusive
 * "evicting" marker directory at `${lockPath}.evicting/owner.json` as a
 * fence: the file holds the in-progress evicter's ownerId. The marker
 * is verified before every destructive seam (re-read, unlink,
 * re-acquire) so a contender whose marker has been hijacked will see
 * ownership has changed and back off without touching the winner's lock.
 *
 * The renewal timer is `setInterval(...).unref()`-ed so it does not
 * keep the Node/Bun runtime alive. Default renewal interval is
 * `max(1000, floor(ttlMs / 3))`.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const RENEW_MIN_INTERVAL_MS = 1_000
const MARKER_CLAIM_MAX_ATTEMPTS = 8
const MARKER_CLAIM_BACKOFF_MS = 25

export type FileLockStep =
  | 'stale-marker-stat'
  | 'stale-marker-claimed'
  | 'stale-lock-confirmed'
  | 'eviction-marker-acquired'

export interface FencedFileLockOptions {
  path: string
  name: string
  ttlMs: number
  /**
   * Defaults to `true`. When false, no renewal timer is scheduled.
   */
  renew?: boolean
  /**
   * Override the renewal cadence in milliseconds.
   * Defaults to `max(RENEW_MIN_INTERVAL_MS, floor(ttlMs / 3))`.
   */
  renewIntervalMs?: number
  /**
   * Clock injection. Defaults to `Date.now`. Tests use this to
   * simulate elapsed time without waiting for real wall-clock ticks.
   */
  now?: () => number
  /**
   * Hook invoked at well-defined milestones inside the eviction
   * protocol. Used by tests to inject interleavings and simulate
   * racing contenders.
   */
  onStep?: (step: FileLockStep) => Promise<void> | void
}

export interface FencedFileLock {
  ownerId: string
  assertOwned(): Promise<void>
  release(): Promise<void>
}

/**
 * Thrown by `assertOwned` when the lock file no longer carries our
 * ownerId or has expired.
 */
export class FileLockOwnershipError extends Error {
  readonly details: {
    path: string
    expectedOwner: string
    observedOwner?: string
    observedExpiresAt?: number
  }

  constructor(message: string, details: FileLockOwnershipError['details']) {
    super(message)
    this.name = 'FileLockOwnershipError'
    this.details = details
  }
}

interface LockPayload {
  ownerId: string
  expiresAt: number
}

interface MarkerPayload {
  ownerId: string
}

async function readLockPayload(path: string): Promise<LockPayload | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).ownerId === 'string' &&
      typeof (parsed as Record<string, unknown>).expiresAt === 'number'
    ) {
      return parsed as LockPayload
    }
    return null
  } catch {
    return null
  }
}

async function readMarkerOwner(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).ownerId === 'string'
    ) {
      return (parsed as MarkerPayload).ownerId
    }
    return null
  } catch {
    return null
  }
}

async function rmEvictingDir(evictingPath: string): Promise<void> {
  await rm(evictingPath, { force: true }).catch(() => {})
  await rm(dirname(evictingPath), { recursive: true, force: true }).catch(
    () => {},
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function acquireFencedFileLock(
  options: FencedFileLockOptions,
): Promise<FencedFileLock | null> {
  const lockPath = `${options.path}.${options.name}.lock`
  const evictingDir = `${lockPath}.evicting`
  const evictingPath = join(evictingDir, 'owner.json')

  const ownerId = randomUUID()
  const now = options.now ?? Date.now

  const tryAcquire = async (
    expiresAt: number,
  ): Promise<FencedFileLock | null> => {
    const payload = JSON.stringify({ ownerId, expiresAt })
    try {
      await mkdir(dirname(lockPath), { recursive: true })
      await writeFile(lockPath, payload, {
        flag: 'wx',
        encoding: 'utf8',
        mode: 0o600,
      })
      return buildLock(lockPath, evictingPath, ownerId, options, now)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return null
      }
      throw err
    }
  }

  // Outer loop: each iteration represents one full attempt to acquire
  // (fresh OR after eviction). We may need to retry if the contender
  // creates a new lock between our unlink and our re-acquire.
  for (;;) {
    const firstTry = await tryAcquire(now() + options.ttlMs)
    if (firstTry) return firstTry

    const observed = await readLockPayload(lockPath)
    const lockStats = await stat(lockPath).catch(() => null)
    if (!lockStats) continue // lock vanished between attempts

    const currentTime = now()
    const looksLive =
      observed !== null &&
      typeof observed.ownerId === 'string' &&
      observed.expiresAt > currentTime
    if (looksLive) {
      return null
    }

    // malformed fail-closed: only proceed when mtime proves staleness.
    const looksValid = observed !== null
    if (!looksValid) {
      const ageMs = currentTime - lockStats.mtimeMs
      if (ageMs < options.ttlMs) return null
    }

    // Past this point we have decided the lock is stale and we will
    // attempt eviction.
    await options.onStep?.('stale-marker-stat')

    // Claim the exclusive evicting marker (bounded retries so a stuck
    // contender cannot trap us in an infinite loop).
    let markerClaimed = false
    for (let attempt = 0; attempt < MARKER_CLAIM_MAX_ATTEMPTS; attempt++) {
      try {
        await mkdir(evictingDir, { recursive: true, mode: 0o700 })
        await writeFile(evictingPath, JSON.stringify({ ownerId }), {
          flag: 'wx',
          encoding: 'utf8',
          mode: 0o600,
        })
        markerClaimed = true
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        await sleep(MARKER_CLAIM_BACKOFF_MS)
      }
    }
    if (!markerClaimed) {
      return null
    }

    await options.onStep?.('stale-marker-claimed')

    // First re-check boundary: confirm the marker is still ours AND
    // the lock still looks stale (its real owner may have refreshed).
    let markerOwner = await readMarkerOwner(evictingPath)
    if (markerOwner !== ownerId) continue

    const observedAgain = await readLockPayload(lockPath)
    const refreshed =
      observedAgain !== null &&
      observedAgain.ownerId !== ownerId &&
      observedAgain.expiresAt > now()
    if (refreshed) {
      await rmEvictingDir(evictingPath)
      return null
    }

    await options.onStep?.('stale-lock-confirmed')

    // Second re-check boundary: marker must still be ours before
    // unlinking. If we lost ownership between the previous check and
    // this one, the winner is now responsible for the lock file.
    markerOwner = await readMarkerOwner(evictingPath)
    if (markerOwner !== ownerId) continue

    try {
      await unlink(lockPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        await rmEvictingDir(evictingPath)
        continue
      }
    }

    await options.onStep?.('eviction-marker-acquired')

    // Re-acquire while still holding the marker as the new lock's
    // "we evicted this" witness. If another contender grabs between our
    // unlink and our re-acquire, drop the marker and loop back.
    const reentry = await tryAcquire(now() + options.ttlMs)
    if (reentry) {
      await rmEvictingDir(evictingPath)
      return reentry
    }
    await rmEvictingDir(evictingPath)
  }
}

function buildLock(
  lockPath: string,
  evictingPath: string,
  ownerId: string,
  options: FencedFileLockOptions,
  now: () => number,
): FencedFileLock {
  let renewTimer: ReturnType<typeof setInterval> | null = null
  let inFlightRenew: Promise<void> | null = null
  let released = false

  const setupRenew = (): void => {
    if (options.renew === false) return
    const interval =
      options.renewIntervalMs ??
      Math.max(RENEW_MIN_INTERVAL_MS, Math.floor(options.ttlMs / 3))

    const renew = async (): Promise<void> => {
      if (released) return
      try {
        const observed = await readLockPayload(lockPath)
        if (released) return
        if (
          observed &&
          observed.ownerId === ownerId &&
          observed.expiresAt > now()
        ) {
          if (released) return
          await writeFile(
            lockPath,
            JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs }),
            { encoding: 'utf8', mode: 0o600 },
          )
        }
      } catch {
        // best-effort renewal; nothing to do on failure
      }
    }

    // The timer callback is small: it only schedules a renew if one is not
    // already in flight and the lock has not been released. The renew
    // Promise itself runs to completion; its in-flight state is tracked
    // so release() can await it before unlinking.
    const tick = (): void => {
      if (released) return
      if (inFlightRenew) return
      inFlightRenew = renew().finally(() => {
        inFlightRenew = null
      })
    }

    renewTimer = setInterval(tick, interval)
    if (
      renewTimer &&
      typeof (renewTimer as { unref?: () => void }).unref === 'function'
    ) {
      ;(renewTimer as { unref: () => void }).unref()
    }
  }

  const release = async (): Promise<void> => {
    // Stop scheduling new renewals, then await any in-flight one so its
    // writeFile cannot resurrect the lock after we unlink it below.
    released = true
    if (renewTimer !== null) {
      clearInterval(renewTimer)
      renewTimer = null
    }
    if (inFlightRenew) {
      try {
        await inFlightRenew
      } catch {
        // renewal swallows its own errors; awaiting is just a fence
      }
    }

    const observed = await readLockPayload(lockPath)
    if (!observed || observed.ownerId !== ownerId) {
      // Not ours anymore — refuse to delete.
      await rmEvictingDir(evictingPath).catch(() => {})
      return
    }
    try {
      await unlink(lockPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await rmEvictingDir(evictingPath).catch(() => {})
  }

  const assertOwned = async (): Promise<void> => {
    const observed = await readLockPayload(lockPath)
    if (!observed || observed.ownerId !== ownerId) {
      throw new FileLockOwnershipError(
        `file lock ${lockPath} is not owned by ${ownerId}`,
        {
          path: lockPath,
          expectedOwner: ownerId,
          observedOwner: observed?.ownerId,
          observedExpiresAt: observed?.expiresAt,
        },
      )
    }
    if (observed.expiresAt <= now()) {
      throw new FileLockOwnershipError(`file lock ${lockPath} has expired`, {
        path: lockPath,
        expectedOwner: ownerId,
        observedOwner: observed.ownerId,
        observedExpiresAt: observed.expiresAt,
      })
    }
  }

  setupRenew()
  return { ownerId, assertOwned, release }
}
