import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireFencedFileLock,
  FileLockOwnershipError,
  type FileLockStep,
} from './file-lock.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'file-lock-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readLock(lockPath: string): Promise<{
  ownerId: string
  expiresAt: number
} | null> {
  try {
    const text = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.ownerId === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeLock(
  lockPath: string,
  ownerId: string,
  expiresAt: number,
): Promise<void> {
  await mkdir(lockPath.replace(/[^/]+$/, ''), { recursive: true }).catch(
    () => {},
  )
  await writeFile(lockPath, JSON.stringify({ ownerId, expiresAt }), 'utf8')
}

async function corruptLock(lockPath: string): Promise<void> {
  await writeFile(lockPath, 'this is not json at all', 'utf8')
}

async function setMtime(
  path: string,
  ageMs: number,
  now: number,
): Promise<void> {
  const target = new Date(now - ageMs)
  await utimes(path, target, target)
}

describe('acquireFencedFileLock — exclusive acquisition', () => {
  it('grants a lock to the first acquirer and returns null to the second while the first is live', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    const first = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(first).not.toBeNull()
    expect(first!.ownerId).toBeTruthy()

    const contents = await readLock(lockPath)
    expect(contents?.ownerId).toBe(first!.ownerId)
    expect(contents?.expiresAt).toBeGreaterThan(Date.now() + 50_000)

    const second = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(second).toBeNull()

    await first!.release()
  })

  it('uses the per-name lock path shape under the target directory', async () => {
    const target = join(root, 'state.json')
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })

    const entries = await (await import('node:fs/promises')).readdir(root, {
      recursive: true,
    })
    expect(entries.some((e) => e.endsWith('state.json.accounts.lock'))).toBe(
      true,
    )
    await lock!.release()
  })

  it('allows a fresh acquirer after release', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    const first = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(first).not.toBeNull()
    await first!.release()

    // Lock file should be gone after release
    expect(await readLock(lockPath)).toBeNull()

    const second = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(second).not.toBeNull()
    expect(second!.ownerId).not.toBe(first!.ownerId)
    await second!.release()
  })

  it('isolates different lock names against each other', async () => {
    const target = join(root, 'state.json')
    const a = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    const b = await acquireFencedFileLock({
      path: target,
      name: 'audit',
      ttlMs: 60_000,
    })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.ownerId).not.toBe(b!.ownerId)
    await a!.release()
    await b!.release()
  })
})

describe('acquireFencedFileLock — live-lock contention returns null', () => {
  it('does not evict a lock whose expiresAt is still in the future', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'live-owner', Date.now() + 60_000)

    const observedSteps: FileLockStep[] = []
    const second = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: (step) => {
        observedSteps.push(step)
      },
    })
    expect(second).toBeNull()
    // No eviction steps should fire when the lock is live.
    expect(observedSteps).toEqual([])

    const after = await readLock(lockPath)
    expect(after?.ownerId).toBe('live-owner')
  })
})

describe('acquireFencedFileLock — renewal extends expiry', () => {
  it('re-writes the lock with a fresh expiresAt on each tick', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    let currentTime = 100_000
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 200,
      renewIntervalMs: 25,
      now: () => currentTime,
    })
    expect(lock).not.toBeNull()

    const firstContents = await readLock(lockPath)
    expect(firstContents?.ownerId).toBe(lock!.ownerId)
    expect(firstContents?.expiresAt).toBe(currentTime + 200)

    // Advance "real" world so the interval can fire; the implementation's
    // renewal callback reads `now()` so `currentTime` stays in sync.
    await new Promise((r) => setTimeout(r, 80))
    currentTime += 80

    const secondContents = await readLock(lockPath)
    expect(secondContents?.ownerId).toBe(lock!.ownerId)
    // The renewed expiresAt should be past the initial one (≥ firstContents.expiresAt).
    expect(secondContents!.expiresAt).toBeGreaterThanOrEqual(
      firstContents!.expiresAt,
    )

    // Stop renewal cleanly before tearDown removes the dir.
    await lock!.release()
  })

  it('does not renew when the lock has been taken over by another owner', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    let currentTime = 200_000
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 200,
      renewIntervalMs: 25,
      now: () => currentTime,
    })
    expect(lock).not.toBeNull()

    // Another contender replaces the lock file out from under us.
    await writeLock(lockPath, 'other-process', currentTime + 60_000)

    await new Promise((r) => setTimeout(r, 80))
    currentTime += 80

    const observed = await readLock(lockPath)
    expect(observed?.ownerId).toBe('other-process')

    await lock!.release()
  })

  it("renewal timer is unref'd so it does not keep the process alive", async () => {
    // We cannot directly observe `unref()` from the test, but we can check
    // that releasing the lock stops renewal (no further rewrites occur).
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    let currentTime = 300_000
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 200,
      renewIntervalMs: 25,
      now: () => currentTime,
    })

    await new Promise((r) => setTimeout(r, 70))
    currentTime += 70
    const before = await readLock(lockPath)
    expect(before?.ownerId).toBe(lock!.ownerId)

    await lock!.release()
    expect(await readLock(lockPath)).toBeNull()

    // Wait past another renew tick; nothing should happen.
    await new Promise((r) => setTimeout(r, 70))
    currentTime += 70
    expect(await readLock(lockPath)).toBeNull()
  })
})

describe('acquireFencedFileLock — release deletes only its own lock', () => {
  it('refuses to delete a lock that has been reassigned to another owner', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })

    // Another process takes over the lock.
    await writeLock(lockPath, 'other-process', Date.now() + 60_000)

    await lock!.release()

    const after = await readLock(lockPath)
    expect(after?.ownerId).toBe('other-process')

    // Cleanup the simulated "other process" lock so rm is happy.
    await rm(lockPath, { force: true })
  })

  it('is a no-op when the lock file is already gone', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    await rm(lockPath, { force: true })

    await expect(lock!.release()).resolves.toBeUndefined()
  })

  it('release() awaits any in-flight renewal and prevents it from resurrecting the lock', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    // Capture the REAL writeFile before spying so the spy can delegate to
    // it without re-entering itself.
    const realWriteFile = fsp.writeFile
    const writeSpy = spyOn(fsp, 'writeFile').mockImplementation(
      async (filePath, content, opts) => {
        // Slow lock-file writes so an in-flight renewal's writeFile takes
        // longer than release()'s read+unlink — this guarantees the race
        // becomes observable without the released-flag / in-flight-fence.
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          await new Promise((resolve) => setTimeout(resolve, 80))
        }
        return realWriteFile.call(
          fsp,
          filePath as never,
          content as never,
          opts as never,
        )
      },
    )

    try {
      const lock = await acquireFencedFileLock({
        path: target,
        name: 'accounts',
        ttlMs: 60_000,
        renewIntervalMs: 5,
      })

      // Wait long enough for at least one renewal to be in-flight (and
      // stuck mid-writeFile) when we trigger release().
      await new Promise((resolve) => setTimeout(resolve, 30))

      await lock.release()

      // With the fix: release awaits the in-flight renewal, then unlinks.
      // Without the fix: release unlinks first, the still-pending renewal
      // writeFile completes and resurrects the lock — this is the assertion
      // that would fail. Read the lock contents back to check.
      await stat(lockPath).then(
        () => {
          throw new Error(
            `lock file ${lockPath} should be gone after release, but stat() succeeded`,
          )
        },
        (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        },
      )

      // Wait past the slow-writeFile window so any post-release queue
      // entry has fully drained.
      await new Promise((resolve) => setTimeout(resolve, 120))
      await stat(lockPath).then(
        () => {
          throw new Error(
            `lock file ${lockPath} resurrected after release window`,
          )
        },
        (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        },
      )
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe('acquireFencedFileLock — assertOwned', () => {
  it('throws FileLockOwnershipError when the lock file is reassigned to another owner', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })

    await writeLock(lockPath, 'other-process', Date.now() + 60_000)

    await expect(lock!.assertOwned()).rejects.toBeInstanceOf(
      FileLockOwnershipError,
    )

    await rm(lockPath, { force: true })
  })

  it('throws FileLockOwnershipError when the lock has expired', async () => {
    let currentTime = 400_000
    const target = join(root, 'state.json')

    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 1000,
      renew: false,
      now: () => currentTime,
    })

    currentTime += 2000
    await expect(lock!.assertOwned()).rejects.toBeInstanceOf(
      FileLockOwnershipError,
    )

    await lock!.release()
  })

  it('resolves cleanly when ownership and expiry still match', async () => {
    const target = join(root, 'state.json')
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    await expect(lock!.assertOwned()).resolves.toBeUndefined()
    await lock!.release()
  })
})

describe('acquireFencedFileLock — expired lock recovery', () => {
  it('evicts and takes over a lock whose expiresAt is in the past', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'zombie-owner', Date.now() - 60_000)

    const observed: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: (step) => {
        observed.push(step)
      },
    })
    expect(lock).not.toBeNull()
    expect(lock!.ownerId).not.toBe('zombie-owner')

    // The full eviction chain should have run.
    expect(observed).toContain('stale-marker-stat')
    expect(observed).toContain('stale-marker-claimed')
    expect(observed).toContain('stale-lock-confirmed')
    expect(observed).toContain('eviction-marker-acquired')

    const contents = await readLock(lockPath)
    expect(contents?.ownerId).toBe(lock!.ownerId)

    await lock!.release()
  })
})

describe('acquireFencedFileLock — malformed lock fails closed', () => {
  it('returns null on malformed JSON unless mtime proves the lock is stale', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await corruptLock(lockPath)

    const observed: FileLockStep[] = []
    const result = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: (step) => {
        observed.push(step)
      },
    })
    // Lock is malformed but file is brand new — fail closed.
    expect(result).toBeNull()
    expect(observed).toEqual([])

    // Now backdate mtime past the TTL window so it proves staleness, then retry.
    const lockStats = await stat(lockPath)
    const now = Date.now()
    await setMtime(lockPath, lockStats.mtimeMs - 0, now - 5 * 60_000)

    const evicted = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(evicted).not.toBeNull()
    await evicted!.release()
  })

  it('returns null on JSON that has the wrong shape (no ownerId/expiresAt) until mtime proves stale', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeFile(lockPath, JSON.stringify({ stranger: 'shape' }), 'utf8')

    const result = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(result).toBeNull()

    const now = Date.now()
    await setMtime(lockPath, 0, now - 5 * 60_000)

    const evicted = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
    })
    expect(evicted).not.toBeNull()
    await evicted!.release()
  })
})

describe('acquireFencedFileLock — stale eviction marker ownership', () => {
  it('refuses to delete the lock when the marker has been reassigned to another evicter', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'zombie', Date.now() - 60_000)

    const stepsObserved: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: async (step) => {
        stepsObserved.push(step)
        if (step === 'stale-marker-claimed') {
          // Hijack the marker synchronously inside the awaited hook so
          // the implementation's next read sees the new owner before it
          // can confirm "marker is still ours".
          const markerPath = join(`${lockPath}.evicting`, 'owner.json')
          await rm(markerPath, { force: true })
          await writeFile(markerPath, JSON.stringify({ ownerId: 'hijacker' }), {
            encoding: 'utf8',
          })
        }
      },
    })
    expect(lock).toBeNull()

    // The original zombie lock must still be intact — neither observer
    // deleted it; the second observer lost the marker before the
    // destructive seam, so it backed off.
    const after = await readLock(lockPath)
    expect(after?.ownerId).toBe('zombie')
  })

  it('refuses to delete when the lock is reassigned to a fresh owner after our marker claim', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'zombie', Date.now() - 60_000)

    const stepsObserved: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: async (step) => {
        stepsObserved.push(step)
        if (step === 'stale-marker-claimed') {
          // Between our marker claim and the "stale-lock-confirmed"
          // boundary, the real lock owner (zombie) refreshes the lock to
          // a fresh, live payload.
          await writeLock(lockPath, 'winner', Date.now() + 60_000)
        }
      },
    })
    expect(lock).toBeNull()

    const after = await readLock(lockPath)
    expect(after?.ownerId).toBe('winner')

    // Clean up the leftover winner lock + evicting dir from the test.
    await rm(lockPath, { force: true })
    await rm(`${lockPath}.evicting`, { recursive: true, force: true })
  })

  it("an observer that lost the eviction marker never deletes the winner's fresh lock", async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`
    const markerPath = join(`${lockPath}.evicting`, 'owner.json')

    // Force the lock to look stale: corrupt its contents and backdate
    // mtime so the malformed-with-stale-mtime branch is exercised.
    await corruptLock(lockPath)
    const now = Date.now()
    await setMtime(lockPath, 0, now - 10 * 60_000)

    // The "winner" is a different process that has, by this point,
    // claimed the marker before us. We will overwrite the marker AFTER
    // we observe our own stale-marker-claimed hook and ensure the
    // implementation refuses to touch the lock file.
    const stepsObserved: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: async (step) => {
        stepsObserved.push(step)
        if (step === 'stale-marker-claimed') {
          await rm(markerPath, { force: true })
          await writeFile(markerPath, JSON.stringify({ ownerId: 'winner' }), {
            encoding: 'utf8',
          })
        }
      },
    })

    expect(lock).toBeNull()

    // The lock file must still exist with its corrupted contents (no
    // destructive op ran).
    const stillCorrupted = await readLock(lockPath)
    expect(stillCorrupted).toBeNull() // malformed JSON returns null
    const lockStats = await stat(lockPath)
    expect(lockStats.isFile()).toBe(true)

    await rm(lockPath, { force: true })
    await rm(`${lockPath}.evicting`, { recursive: true, force: true })
  })
})

describe('acquireFencedFileLock — onStep interleavings', () => {
  it('fires the four steps in order during a clean eviction', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'zombie', Date.now() - 60_000)

    const observed: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: (step) => {
        observed.push(step)
      },
    })
    expect(lock).not.toBeNull()
    expect(observed).toEqual([
      'stale-marker-stat',
      'stale-marker-claimed',
      'stale-lock-confirmed',
      'eviction-marker-acquired',
    ])

    await lock!.release()
  })

  it('does not fire eviction steps when the contended lock is live', async () => {
    const target = join(root, 'state.json')
    const lockPath = `${target}.accounts.lock`

    await writeLock(lockPath, 'live', Date.now() + 60_000)

    const observed: FileLockStep[] = []
    const lock = await acquireFencedFileLock({
      path: target,
      name: 'accounts',
      ttlMs: 60_000,
      onStep: (step) => {
        observed.push(step)
      },
    })
    expect(lock).toBeNull()
    expect(observed).toEqual([])
  })
})
