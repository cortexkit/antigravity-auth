import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runBuildTestChild } from '../scripts/build-test-child.ts'

test('build setup timeout stays failed and teardown drains the held audit before removing its fixture', async () => {
  const result = await new Promise<{ error: unknown; output: string }>(
    (done) => {
      execFile(
        process.execPath,
        [
          'test',
          '--isolate',
          './packages/opencode/scripts/build-tui.test.ts',
          '-t',
          '^build.setup_probe$',
        ],
        {
          cwd: resolve(import.meta.dir, '..'),
          env: { ...process.env, AGY_BUILD_SETUP_PROBE: '1' },
          timeout: 4_000,
          maxBuffer: 128 * 1024,
        },
        (error, stdout, stderr) => done({ error, output: stdout + stderr }),
      )
    },
  )
  expect(result.error).toMatchObject({ code: 1, killed: false, signal: null })
  expect(result.output).toContain('hook timed out')
  expect(result.output).toContain('1 fail')
  const record = result.output.match(/BUILD_SETUP_TEARDOWN (.+)/)?.[1]
  expect(record).toBeDefined()
  expect(JSON.parse(record ?? '{}')).toEqual({
    events: ['release-present', 'audit-drained'],
    live: false,
  })
  expect(result.output).not.toContain('ENOENT')
  expect(result.output).not.toContain('Unhandled error')
})

test('build child deadline confirms termination and pipe reaping before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-child-deadline-'))
  const receipt = join(root, 'pid')
  try {
    await expect(
      runBuildTestChild(
        [
          '-e',
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); setInterval(() => {}, 100);`,
        ],
        performance.now() + 6_000,
      ),
    ).rejects.toThrow('build setup child deadline exceeded')
    const pid = Number(await readFile(receipt, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
