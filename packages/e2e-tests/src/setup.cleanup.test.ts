/**
 * Test for the orphan-root sweep in `setup.ts`.
 *
 * The e2e preload creates a fresh `agy-e2e-*` temp root per test and
 * tears it down in `afterEach`. The `afterAll` orphan sweep is opt-in
 * behind `AGY_E2E_SWEEP_ORPHANS=1` and only reaps entries whose mtime
 * is older than 24h. These tests pin the contract:
 *
 *   1. A fresh root is never deleted by the orphan sweep.
 *   2. A root older than the cutoff is reaped when the sweep runs.
 *   3. Non-`agy-e2e-*` entries are left alone.
 *   4. When the env var is unset, the sweep is a no-op (no-op guard).
 *
 * Without these guards, a process-wide afterAll would happily delete
 * roots owned by a sibling test file (or a parallel CI job) the moment
 * its own afterEach finished — racing ENOENT on atomic rename, missing
 * RPC port files, and FileLockOwnershipError are the symptoms the
 * upstream maintainer hit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sweepOrphanE2eRoots } from './setup'

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
