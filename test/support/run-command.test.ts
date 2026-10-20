import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runCommand, runCommandBytes } from './run-command.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'run-command-'))
  roots.push(root)
  return root
}

test('runCommand returns the exit code and complete text output', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      "process.stdout.write('out'.repeat(100000)); process.stderr.write('err'); process.exitCode = 3",
    ],
    { deadlineMs: 10_000 },
  )
  expect(result.exitCode).toBe(3)
  expect(result.signal).toBeNull()
  expect(result.stdout).toBe('out'.repeat(100000))
  expect(result.stderr).toBe('err')
  expect(result.pid).toBeGreaterThan(0)
}, 15_000)

test('runCommand passes stdin, cwd and a replaced environment', async () => {
  const root = scratch()
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      'const input = await Bun.stdin.text(); console.log(JSON.stringify({ input, cwd: process.cwd(), marker: process.env.RUN_COMMAND_MARKER ?? null, home: process.env.HOME ?? null }))',
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        RUN_COMMAND_MARKER: 'set',
        HOME: undefined,
      },
      stdin: 'piped input',
      deadlineMs: 10_000,
    },
  )
  expect(result.exitCode).toBe(0)
  const seen = JSON.parse(result.stdout)
  expect(seen.input).toBe('piped input')
  expect(seen.marker).toBe('set')
  expect(seen.home).toBeNull()
  expect(seen.cwd.endsWith(basename(root))).toBe(true)
}, 15_000)

test('runCommandBytes returns raw output bytes', async () => {
  const result = await runCommandBytes(
    [
      process.execPath,
      '-e',
      'process.stdout.write(new Uint8Array([0, 255, 10]))',
    ],
    { deadlineMs: 10_000 },
  )
  expect(result.exitCode).toBe(0)
  expect([...result.stdout]).toEqual([0, 255, 10])
}, 15_000)

test('runCommand reports a child ended by a signal', async () => {
  const result = await runCommand(
    [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"],
    { deadlineMs: 10_000 },
  )
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBe('SIGKILL')
}, 15_000)

test('runCommand kills a command at its deadline and names it', async () => {
  const root = scratch()
  const pidFile = join(root, 'pid')
  const started = performance.now()
  const failure = await runCommand(
    [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000)`,
    ],
    { deadlineMs: 2_000 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain(
    `command ${basename(process.execPath)} (argc=3) exceeded its 2000 ms deadline and was killed`,
  )
  expect(String(failure)).not.toContain('not reaped')
  // The deadline, not the 60 s child, ended the call; the child is gone.
  expect(performance.now() - started).toBeLessThan(8_000)
  expect(existsSync(pidFile)).toBe(true)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
}, 10_000)

test('runCommand refuses a missing or non-positive deadline', async () => {
  await expect(
    runCommand([process.execPath, '--version'], { deadlineMs: 0 }),
  ).rejects.toThrow('runCommand needs a positive deadline')
  await expect(
    runCommand([process.execPath, '--version'], {
      deadlineMs: Number.NaN,
    }),
  ).rejects.toThrow('runCommand needs a positive deadline')
})
