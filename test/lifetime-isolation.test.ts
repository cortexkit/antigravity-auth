import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TestLifetime } from './fixtures/test-lifetime.ts'

async function timeoutChild(oldOrder: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifetime-proof-'))
  try {
    const hooks = pathToFileURL(
      join(import.meta.dir, 'fixtures/lifetime-hooks.ts'),
    ).href
    const lifetime = pathToFileURL(
      join(import.meta.dir, 'fixtures/test-lifetime.ts'),
    ).href
    await writeFile(
      join(root, 'package.json'),
      '{"name":"owned-lifetime-proof","private":true,"type":"module"}\n',
    )
    await writeFile(
      join(root, 'lifetime.test.ts'),
      `
import { beforeEach, expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lifetimeHooks } from ${JSON.stringify(hooks)}
import { TestLifetime } from ${JSON.stringify(lifetime)}
if (${oldOrder}) Object.defineProperty(TestLifetime.prototype, 'drain', {
  value: async function(cleanup: () => unknown) { await cleanup() }
})
const hooks = lifetimeHooks()
const { it, afterEach } = hooks
const completed = join(import.meta.dir, 'completed')
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(import.meta.dir, 'state-'))
  await writeFile(join(directory, 'value'), 'original')
})
afterEach(() => rm(directory, { recursive: true, force: true }))
it('original timeout remains a failure', async () => {
  const owned = directory
  await new Promise(resolve => setTimeout(resolve, 200))
  const lastRead = await readFile(join(owned, 'value'), 'utf8')
  expect(lastRead).toBe('original')
  await writeFile(completed, lastRead)
  console.log('ORIGINAL_FINAL_READ_COMPLETED')
}, 100)
it('successor waits for the original final read', async () => {
  expect(await readFile(completed, 'utf8')).toBe('original')
  await writeFile(join(directory, 'value'), 'successor')
  expect(await readFile(join(directory, 'value'), 'utf8')).toBe('successor')
})
`,
    )
    const child = spawnSync(
      process.execPath,
      ['test', '--isolate', './lifetime.test.ts'],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          XDG_STATE_HOME: root,
          XDG_CACHE_HOME: root,
        },
        encoding: 'utf8',
        timeout: 4_000,
        maxBuffer: 128 * 1024,
      },
    )
    const completed = await readFile(join(root, 'completed'), 'utf8').catch(
      (error) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined
        throw error
      },
    )
    return { child, output: child.stdout + child.stderr, completed }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('keeps the original timeout failed and joins its final disk read before teardown and successor setup', async () => {
  const result = await timeoutChild(false)
  expect(result.child.error).toBeUndefined()
  expect(result.child.signal).toBeNull()
  expect(result.child.status).toBe(1)
  expect(result.output).toContain('timed out after 100ms')
  expect(result.child.stdout).toContain('ORIGINAL_FINAL_READ_COMPLETED')
  expect(result.output).toContain(
    '(pass) successor waits for the original final read',
  )
  expect(result.output).toContain('1 pass')
  expect(result.output).toContain('1 fail')
  expect(result.output).not.toContain('Unhandled error')
  expect(result.completed).toBe('original')
})

it('detects the old cleanup ordering that deletes state before the timed-out body finishes', async () => {
  const result = await timeoutChild(true)
  expect(result.child.error).toBeUndefined()
  expect(result.child.signal).toBeNull()
  expect(result.child.status).toBe(1)
  expect(result.output).toContain('timed out after 100ms')
  expect(result.child.stdout).not.toContain('ORIGINAL_FINAL_READ_COMPLETED')
  expect(result.output).not.toContain(
    '(pass) successor waits for the original final read',
  )
  expect(result.completed).toBeUndefined()
})

it('preserves ordinary assertion and operation failures while releasing late barriers', async () => {
  const lifetime = new TestLifetime()
  const failure = new Error('original assertion')
  await expect(
    lifetime.runnerBody(() => {
      throw failure
    }, 'owner'),
  ).rejects.toBe(failure)
  await expect(lifetime.operation(Promise.reject(failure))).rejects.toBe(
    failure,
  )
  await lifetime.drain(() => {})
  let released = false
  lifetime.unpark(() => {
    released = true
  })
  expect(released).toBe(true)
  await lifetime.untilCancelled()
  expect(lifetime.signal.aborted).toBe(true)
})
