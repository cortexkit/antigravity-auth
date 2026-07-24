/**
 * Test for the temp-root lifecycle in `setup.ts`.
 *
 * The e2e preload creates a fresh `agy-e2e-*` temp root per test and
 * tears the whole set down in `afterAll` — AFTER every test file's own
 * `afterEach` has disposed its harness (mock server, plugin handles,
 * port files, fence locks). An `afterEach`-time `rmSync(root)` would
 * race the harness and silently fail (`force: true` swallows the
 * error), leaving `antigravity-accounts.json` shards in the system
 * tmpdir. The reviewer measured 18 such leaks from 3 runs.
 *
 * Two contract surfaces are pinned here:
 *
 *   A. The orphan sweep (`sweepOrphanE2eRoots`) is opt-in behind
 *      `AGY_E2E_SWEEP_ORPHANS=1`, only reaps entries older than 24h,
 *      and never touches non-`agy-e2e-*` paths. (Maintenance contract
 *      for `bun run --cwd packages/e2e-tests test` developers.)
 *
 *   B. `cleanupTestRootsForThisFile(roots)` deletes every root it is
 *      handed — and ONLY those roots (preserving the cross-file race
 *      fix from the prior round). After `force: true` rm, an
 *      `existsSync` re-check makes a regression loud. (Production
 *      contract for `bun run test:e2e`.)
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cleanupE2eRootsForCurrentFile,
  cleanupTestRootsForThisFile,
  sweepOrphanE2eRoots,
} from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const PREV_ENV = process.env.AGY_E2E_SWEEP_ORPHANS
const PREV_TMPDIR = process.env.TMPDIR

let scratchRoot: string

beforeEach(() => {
  // Use an isolated TMPDIR for each test so we never touch the host's
  // real tmpdir — the sweep walks `process.env.TMPDIR ?? os.tmpdir()`.
  scratchRoot = join(
    process.env.TMPDIR ?? tmpdir(),
    `agy-e2e-sweep-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(scratchRoot, { recursive: true })
  process.env.TMPDIR = scratchRoot
  // Default: opt-in sweep disabled. Individual tests flip it on.
  delete process.env.AGY_E2E_SWEEP_ORPHANS
})

afterEach(() => {
  try {
    rmSync(scratchRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  if (PREV_TMPDIR === undefined) {
    delete process.env.TMPDIR
  } else {
    process.env.TMPDIR = PREV_TMPDIR
  }
  if (PREV_ENV === undefined) {
    delete process.env.AGY_E2E_SWEEP_ORPHANS
  } else {
    process.env.AGY_E2E_SWEEP_ORPHANS = PREV_ENV
  }
})

function backdateMtime(path: string, ageMs: number): void {
  // `utimesSync` takes seconds-since-epoch; floor to the integer second
  // and accept the sub-second drift that may push the cutoff check by
  // ~1s. The 24h floor is six orders of magnitude looser than that, so
  // the test stays deterministic.
  const target = Math.floor((Date.now() - ageMs) / 1000)
  utimesSync(path, target, target)
}

describe('sweepOrphanE2eRoots', () => {
  it('is a no-op when AGY_E2E_SWEEP_ORPHANS is unset', () => {
    const stale = join(scratchRoot, 'agy-e2e-stale-noenv')
    mkdirSync(stale, { recursive: true })
    backdateMtime(stale, 25 * 60 * 60 * 1000)

    sweepOrphanE2eRoots()

    expect(existsSync(stale)).toBe(true)
  })

  it('leaves fresh agy-e2e-* roots untouched', () => {
    process.env.AGY_E2E_SWEEP_ORPHANS = '1'
    const fresh = join(scratchRoot, 'agy-e2e-fresh')
    mkdirSync(fresh, { recursive: true })

    sweepOrphanE2eRoots()

    expect(existsSync(fresh)).toBe(true)
  })

  it('reaps agy-e2e-* roots older than the 24h cutoff', () => {
    process.env.AGY_E2E_SWEEP_ORPHANS = '1'
    const stale = join(scratchRoot, 'agy-e2e-stale-old')
    mkdirSync(stale, { recursive: true })
    backdateMtime(stale, 25 * 60 * 60 * 1000)

    sweepOrphanE2eRoots()

    expect(existsSync(stale)).toBe(false)
  })

  it('preserves agy-e2e-* roots that just crossed the cutoff', () => {
    // A root whose mtime is minutes old (well inside the 24h window)
    // must survive the sweep — only orphans hours older qualify.
    process.env.AGY_E2E_SWEEP_ORPHANS = '1'
    const fresh = join(scratchRoot, 'agy-e2e-just-now')
    mkdirSync(fresh, { recursive: true })

    sweepOrphanE2eRoots()

    expect(existsSync(fresh)).toBe(true)
    expect(statSync(fresh).isDirectory()).toBe(true)
  })

  it('does not touch entries that do not match the agy-e2e- prefix', () => {
    process.env.AGY_E2E_SWEEP_ORPHANS = '1'
    const unrelated = join(scratchRoot, 'something-else-old')
    mkdirSync(unrelated, { recursive: true })
    backdateMtime(unrelated, 25 * 60 * 60 * 1000)

    sweepOrphanE2eRoots()

    expect(existsSync(unrelated)).toBe(true)
  })
})

describe('cleanupTestRootsForThisFile', () => {
  it('removes a root only after its live harness is disposed', async () => {
    const root = join(scratchRoot, 'agy-e2e-live-harness')
    const accounts = join(root, 'pi-agent', 'antigravity-accounts.json')
    mkdirSync(join(root, 'pi-agent'), { recursive: true })
    writeFileSync(accounts, '{"version":4,"accounts":[]}')

    let disposed = false
    const disposeHarnesses = async (ownedRoot: string): Promise<void> => {
      expect(ownedRoot).toBe(root)
      expect(existsSync(accounts)).toBe(true)
      disposed = true
    }

    await cleanupTestRootsForThisFile([root], disposeHarnesses)

    expect(disposed).toBe(true)
    expect(
      readdirSync(scratchRoot).filter((entry) => entry.startsWith('agy-e2e-')),
    ).toHaveLength(0)
  })

  it('removes every root it is handed', async () => {
    const a = join(scratchRoot, 'agy-e2e-cleanup-a')
    const b = join(scratchRoot, 'agy-e2e-cleanup-b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    await cleanupTestRootsForThisFile([a, b])

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
  })

  it('is a no-op when the list is empty', async () => {
    await cleanupTestRootsForThisFile([])
  })

  it('only touches roots it is handed (cross-file race fix)', async () => {
    // `agy-e2e-other-file` simulates a root owned by a SIBLING test
    // file that is still running concurrently. The cleanup must
    // never touch it — that's the maintainer's race fix.
    const own = join(scratchRoot, 'agy-e2e-own-file')
    const sibling = join(scratchRoot, 'agy-e2e-other-file')
    mkdirSync(own, { recursive: true })
    mkdirSync(sibling, { recursive: true })

    await cleanupTestRootsForThisFile([own])

    expect(existsSync(own)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })

  it('throws (loud) when a root survives deletion — the regression catch', async () => {
    // The harness-leak scenario from the cross-family review: an
    // rmSync fails (force:true swallows it) but the path is still
    // there. We synthesize that on a read-only sysfs path — EACCES
    // is the cleanest cross-platform reproducer for "rmSync can't
    // make this go away" without spinning up a second process or
    // toggling chattr +i.
    const own = join(scratchRoot, 'agy-e2e-clean-beside')
    mkdirSync(own, { recursive: true })
    try {
      await cleanupTestRootsForThisFile([own, '/sys/kernel'])
      throw new Error('expected cleanup to report the surviving root')
    } catch (error) {
      expect(String(error)).toMatch(/1 leaked temp root\(s\)/)
    }
    // Tidy up the real entry; /sys/kernel is untouched.
    rmSync(own, { recursive: true, force: true })
  })
})
