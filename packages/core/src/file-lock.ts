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
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
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
  /**
   * Resolves when the renewal loop detects the lock has been taken over
   * by another owner (or otherwise lost before `release()`). Resolves
   * immediately if the lock is already lost.
   */
  whenLost(): Promise<void>
  hasLost(): boolean
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
  /** Owning process ID — used to detect a dead/in-progress evicter. */
  pid: number
  /** Wall-clock time (ms) the marker was created. Used for the TTL floor. */
  createdAt: number
}

const MARKER_TTL_MS = 30_000

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

async function readMarkerPayload(path: string): Promise<MarkerPayload | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).ownerId === 'string' &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      typeof (parsed as Record<string, unknown>).createdAt === 'number'
    ) {
      return parsed as MarkerPayload
    }
    return null
  } catch {
    return null
  }
}

/**
 * Best-effort liveness check for a PID. Returns `true` when the process
 * is alive or when the platform lacks a reliable probe (Windows), so
 * the marker is only reclaimed when we have positive evidence of death.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM (process exists but we cannot signal it) still counts as alive.
    return true
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
    // contender cannot trap us in an infinite loop). Before each retry,
    // inspect the existing marker: if its PID is dead or the marker is
    // older than MARKER_TTL_MS, it is abandoned and we reclaim it.
    let markerClaimed = false
    for (let attempt = 0; attempt < MARKER_CLAIM_MAX_ATTEMPTS; attempt++) {
      try {
        await mkdir(evictingDir, { recursive: true, mode: 0o700 })
        await writeFile(
          evictingPath,
          JSON.stringify({
            ownerId,
            pid: process.pid,
            createdAt: now(),
          }),
          {
            flag: 'wx',
            encoding: 'utf8',
            mode: 0o600,
          },
        )
        markerClaimed = true
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        // Existing marker — check whether it is reclaimed-able.
        const existing = await readMarkerPayload(evictingPath)
        if (existing) {
          const ageMs = now() - existing.createdAt
          const deadPid = !isProcessAlive(existing.pid)
          if (deadPid || ageMs > MARKER_TTL_MS) {
            // Stale marker — recycle the directory and retry the claim.
            await rmEvictingDir(evictingPath)
            continue
          }
        }
        await sleep(MARKER_CLAIM_BACKOFF_MS)
      }
    }
    if (!markerClaimed) {
      return null
    }

    await options.onStep?.('stale-marker-claimed')

    // First re-check boundary: confirm the marker is still ours AND
    // the lock still looks stale (its real owner may have refreshed).
    let markerPayload = await readMarkerPayload(evictingPath)
    if (markerPayload?.ownerId !== ownerId) continue

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
    markerPayload = await readMarkerPayload(evictingPath)
    if (markerPayload?.ownerId !== ownerId) continue

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
  let lost = false
  let lostResolve: (() => void) | null = null
  let lostPromise: Promise<void> | null = new Promise<void>((resolve) => {
    lostResolve = resolve
  })

  const markLost = (): void => {
    if (lost) return
    lost = true
    if (renewTimer !== null) {
      clearInterval(renewTimer)
      renewTimer = null
    }
    const resolve = lostResolve
    lostResolve = null
    resolve?.()
  }

  const setupRenew = (): void => {
    if (options.renew === false) return
    const interval =
      options.renewIntervalMs ??
      Math.max(RENEW_MIN_INTERVAL_MS, Math.floor(options.ttlMs / 3))

    const renew = async (): Promise<void> => {
      if (released || lost) return
      try {
        const observed = await readLockPayload(lockPath)
        if (released || lost) return
        // If the lock file is gone or carries a different ownerId, the
        // lock has been taken over. Mark it lost so the next iteration
        // stops renewing — this is the case the dispatch's TOCTOU test
        // exercises (owner B evicts and replaces the lock while owner
        // A's renewal is paused).
        if (observed === null) {
          markLost()
          return
        }
        if (observed.ownerId !== ownerId) {
          markLost()
          return
        }
        if (observed.expiresAt > now()) {
          if (released || lost) return
          // TOCTOU protection: the lock file may have been swapped out
          // from under us between the read above and the write below.
          // Compare-and-swap via a sibling temp file + atomic rename so
          // we never overwrite a fresh owner's lock content directly.
          // The remaining race window — between the re-read and the
          // rename — collapses to a single inode replace that POSIX
          // rename(2) makes atomic at the filesystem level.
          const tempPath = `${lockPath}.${ownerId}.tmp`
          let shouldCommit = false
          try {
            await writeFile(
              tempPath,
              JSON.stringify({
                ownerId,
                expiresAt: now() + options.ttlMs,
              }),
              { encoding: 'utf8', mode: 0o600 },
            )
            if (released || lost) {
              await unlink(tempPath).catch(() => {})
              return
            }
            const currentObserved = await readLockPayload(lockPath)
            if (released || lost) {
              await unlink(tempPath).catch(() => {})
              return
            }
            if (!currentObserved || currentObserved.ownerId !== ownerId) {
              // Another owner slipped in — leave their content intact,
              // mark lost, drop our temp draft.
              markLost()
              await unlink(tempPath).catch(() => {})
              return
            }
            shouldCommit = true
            await rename(tempPath, lockPath)
          } catch {
            // Lost the race against a rename/evict — mark lost so the
            // next iteration stops renewing, and clean up any temp draft.
            markLost()
            if (!shouldCommit) {
              await unlink(tempPath).catch(() => {})
            }
          }
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
    if (released) return
    released = true
    if (renewTimer !== null) {
      clearInterval(renewTimer)
      renewTimer = null
    }
    const pendingRenew = inFlightRenew
    inFlightRenew = null
    if (pendingRenew) {
      try {
        await pendingRenew
      } catch {
        // renewal swallows its own errors; awaiting is just a fence
      }
    }

    try {
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
    } finally {
      markLost()
      renewTimer = null
      inFlightRenew = null
      lostResolve = null
      lostPromise = null
    }
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
  return {
    ownerId,
    assertOwned,
    release,
    whenLost: () => lostPromise ?? Promise.resolve(),
    hasLost: () => lost,
  }
}
