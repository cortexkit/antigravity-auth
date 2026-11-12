/**
 * Older versions write antigravity.json under core's fenced lock; this one
 * writes it under common-auth's `withLock`, on the same lock file. Both
 * directions run in real processes: each side waits while the other holds
 * the lock, and neither treats the other's live record as stale.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand } from '../../../../../test/support/run-command'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const fileLock = resolve(import.meta.dir, '../../../../core/src/file-lock.ts')
const writer = resolve(import.meta.dir, './writer.ts')
const fsLock = resolve(
  import.meta.dir,
  '../../../../core/src/common-auth-embedded/fs/index.js',
)
const HOLD_MS = 1_500

/** Old holder: core's fenced lock with the old writer's lease, held, then checked. */
const oldHolder = (target: string, signal: string) => `
import { writeFile } from 'node:fs/promises'
import { acquireFencedFileLock } from ${JSON.stringify(fileLock)}
const lock = await acquireFencedFileLock({ path: ${JSON.stringify(target)}, name: 'antigravity-operator', ttlMs: 5000, renew: false })
if (!lock) throw new Error('old holder could not take a free lock')
await writeFile(${JSON.stringify(signal)}, 'held')
await new Promise((resolve) => setTimeout(resolve, ${HOLD_MS}))
await lock.assertOwned()
const releasedAt = Date.now()
await lock.release()
console.log(JSON.stringify({ releasedAt }))
`

/** New holder: withLock with the new writer's lease, held, then checked. */
const newHolder = (target: string, signal: string) => `
import { writeFile } from 'node:fs/promises'
import { withLock } from ${JSON.stringify(fsLock)}
const releasedAt = await withLock(${JSON.stringify(target)}, { name: 'antigravity-operator', ttlMs: 5000, timeoutMs: 5000, renew: true }, async (lock) => {
  await writeFile(${JSON.stringify(signal)}, 'held')
  await new Promise((resolve) => setTimeout(resolve, ${HOLD_MS}))
  await lock.assertOwned()
  return Date.now()
})
console.log(JSON.stringify({ releasedAt }))
`

const waitFor = (signal: string) => `
import { stat } from 'node:fs/promises'
for (;;) {
  try { await stat(${JSON.stringify(signal)}); break } catch {}
  await new Promise((resolve) => setTimeout(resolve, 10))
}
`

/** New contender: the operator writer itself. */
const newWriter = (target: string, signal: string) => `
${waitFor(signal)}
import { writeOperatorConfigAt } from ${JSON.stringify(writer)}
const startedAt = Date.now()
await writeOperatorConfigAt(${JSON.stringify(target)}, { killswitch: { enabled: true, minimum_remaining_percent: 7 }, log_level: 'warn' })
console.log(JSON.stringify({ startedAt, acquiredAt: Date.now() }))
`

/** Old contender: core's fenced lock retried, as an old writer's caller would. */
const oldContender = (target: string, signal: string) => `
${waitFor(signal)}
import { acquireFencedFileLock } from ${JSON.stringify(fileLock)}
const startedAt = Date.now()
let refused = 0
for (;;) {
  const lock = await acquireFencedFileLock({ path: ${JSON.stringify(target)}, name: 'antigravity-operator', ttlMs: 5000, renew: false })
  if (lock) {
    const acquiredAt = Date.now()
    await lock.release()
    console.log(JSON.stringify({ startedAt, acquiredAt, refused }))
    break
  }
  refused++
  await new Promise((resolve) => setTimeout(resolve, 25))
}
`

async function run(source: string) {
  const result = await runCommand([process.execPath, '-e', source], {
    deadlineMs: 20_000,
  })
  if (result.exitCode !== 0)
    throw new Error(`child failed (${result.exitCode}): ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'operator-lock-interop-'))
  roots.push(root)
  const target = join(root, 'antigravity.json')
  await writeFile(target, '{ "quiet_mode": true }\n')
  return { target, signal: join(root, 'held') }
}

describe('operator lock interop between versions', () => {
  it('the new writer waits for an old fenced holder and never evicts it', async () => {
    const { target, signal } = await fixture()
    const [holder, contender] = await Promise.all([
      run(oldHolder(target, signal)),
      run(newWriter(target, signal)),
    ])
    // The holder's ownership check passed after the hold, so its record was
    // never replaced; the writer acquired only after the holder released.
    expect(contender.acquiredAt).toBeGreaterThanOrEqual(holder.releasedAt)
    expect(contender.startedAt).toBeLessThan(holder.releasedAt)
    const written = JSON.parse(await readFile(target, 'utf8'))
    expect(written).toEqual({
      quiet_mode: true,
      operator: {
        killswitch: { enabled: true, minimum_remaining_percent: 7 },
        log_level: 'warn',
      },
    })
    await expect(stat(`${target}.antigravity-operator.lock`)).rejects.toThrow()
  })

  it('an old fenced writer waits for a new withLock holder and never evicts it', async () => {
    const { target, signal } = await fixture()
    const [holder, contender] = await Promise.all([
      run(newHolder(target, signal)),
      run(oldContender(target, signal)),
    ])
    expect(contender.refused).toBeGreaterThan(0)
    expect(contender.acquiredAt).toBeGreaterThanOrEqual(holder.releasedAt)
    await expect(stat(`${target}.antigravity-operator.lock`)).rejects.toThrow()
  })
})
