import { afterEach, expect, test } from 'bun:test'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AnchorLockTrace } from './__fixtures__/anchor-lock-trace'

let trace: AnchorLockTrace | undefined
let root: string | undefined
afterEach(async () => {
  trace?.stop()
  trace = undefined
  if (root) await promises.rm(root, { recursive: true, force: true })
  root = undefined
})

test('anchor trace attributes a multi-second real lock hold to slow fsync', async () => {
  root = await promises.mkdtemp(join(tmpdir(), 'anchor-fsync-'))
  trace = new AnchorLockTrace('injected slow fsync on real file', {
    beforeSync: () => Bun.sleep(2_100),
  })
  await trace.install()
  const { withLock } = await import(
    '@cortexkit/antigravity-auth-core/common-auth/fs'
  )
  const path = join(root, 'store.json')
  await trace.phase('seed:slow-fsync-control', () =>
    withLock(
      path,
      { name: 'save', ttlMs: 10_000, timeoutMs: 1_000 },
      async () => {
        const handle = await promises.open(path, 'wx', 0o600)
        try {
          await handle.writeFile('{}\n')
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
    ),
  )
  expect(trace.locks).toHaveLength(1)
  const lock = trace.locks[0]!
  expect(lock.path).toBe(`${path}.save.lock`)
  expect(lock.name).toBe('save')
  expect(lock.caller).toContain('anchor-lock-trace.test.ts')
  expect(lock.markerAttempts).toBe(1)
  expect(lock.overlaps).toEqual([])
  expect(lock.releasedMs).toBeDefined()
  expect(lock.releaseStartMs! - lock.acquiredMs!).toBeGreaterThanOrEqual(2_100)
  const syncs = trace.phases.filter((phase) => phase.phase === 'handle:sync')
  expect(syncs).toHaveLength(1)
  expect(syncs[0]?.path).toBe(path)
  expect(syncs[0]?.ms).toBeGreaterThanOrEqual(2_100)
})

test('anchor trace identifies a marker held by a same-process contender during release', async () => {
  root = await promises.mkdtemp(join(tmpdir(), 'anchor-contender-'))
  trace = new AnchorLockTrace('same-process marker control')
  await trace.install()
  const fsRoot = dirname(
    Bun.resolveSync(
      '@cortexkit/antigravity-auth-core/common-auth/fs',
      import.meta.dir,
    ),
  )
  const api = (await import(
    pathToFileURL(join(fsRoot, 'refresh-file-lock.js')).href
  )) as typeof import('../../../core/src/common-auth-embedded/fs/refresh-file-lock.js')
  const path = join(root, 'store.json')
  const holder = await api.acquireRefreshFileLock({
    path,
    name: 'save',
    ttlMs: 1,
  })
  expect(holder).not.toBeNull()
  // Expire a real lease deliberately so the second operation takes the marker.
  // The trace must identify the blocked release's contender as one of ours;
  // the short lease does not claim that normal store leases expire early.
  await Bun.sleep(10)
  let signalMarker = () => {}
  const markerSeen = new Promise<void>((resolve) => {
    signalMarker = resolve
  })
  let unpark = () => {}
  const parked = new Promise<void>((resolve) => {
    unpark = resolve
  })
  const contenderPending = api.acquireRefreshFileLock({
    path,
    name: 'save',
    ttlMs: 10_000,
    onStep: async (step) => {
      if (step === 'eviction-marker-acquired') {
        signalMarker()
        await parked
      }
    },
  })
  await markerSeen
  const release = holder!.release()
  await Bun.sleep(80)
  unpark()
  const contender = await contenderPending
  expect(contender).not.toBeNull()
  await release
  await contender!.release()
  expect(trace.locks).toHaveLength(2)
  expect(trace.locks[1]?.overlaps).toEqual([0])
  expect(trace.locks[1]?.previous).toBe(0)
  expect(trace.locks[0]?.markerAttempts).toBeGreaterThan(1)
  expect(trace.locks[0]?.markerBlockedMs).toBeGreaterThanOrEqual(50)
  expect(
    trace.markers.some(
      (marker) =>
        marker.lock === 0 &&
        marker.phase === 'release' &&
        marker.event === 'blocked' &&
        marker.sameProcess === true,
    ),
  ).toBe(true)
})
