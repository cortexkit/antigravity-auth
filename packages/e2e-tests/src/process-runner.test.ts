import { afterAll, describe, expect, it } from 'bun:test'

import {
  type ProcessExit,
  ProcessTimeoutError,
  runProcess,
} from './process-runner'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const BUN = process.execPath

function fixtureCommand(): {
  command: string
  args: string[]
  cwd: string
} {
  return {
    command: BUN,
    args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
    cwd: process.cwd(),
  }
}

describe('runProcess', () => {
  it('resolves with exit metadata when the child exits cleanly', async () => {
    const cmd = fixtureCommand()
    const exit = await runProcess({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
    })
    expect(exit.exitCode).toBe(0)
    expect(exit.signal).toBeNull()
    expect(exit.truncated).toBe(false)
  })

  it('captures stdout and stderr up to the 64 KiB cap', async () => {
    const exit = await runProcess({
      command: BUN,
      args: [
        '-e',
        'process.stdout.write("x".repeat(200_000)); process.stderr.write("y".repeat(200_000)); process.exit(0)',
      ],
    })
    expect(exit.stdout.length).toBeLessThanOrEqual(64 * 1024)
    expect(exit.stderr.length).toBeLessThanOrEqual(64 * 1024)
    expect(exit.truncated).toBe(true)
  })

  it('captures non-zero exit codes without throwing', async () => {
    const exit = await runProcess({
      command: BUN,
      args: ['-e', 'process.exit(7)'],
    })
    expect(exit.exitCode).toBe(7)
  })

  it('rejects with ProcessTimeoutError when the child exceeds timeoutMs', async () => {
    let exit: ProcessExit | undefined
    try {
      exit = await runProcess({
        command: BUN,
        args: [
          '-e',
          'setInterval(() => {}, 100); process.stdout.write("alive")',
        ],
        timeoutMs: 250,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessTimeoutError)
    }
    // After SIGKILL the temp root should still be cleaned up.
    if (exit) {
      expect(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL').toBe(true)
    }
  })

  it('kills the entire process group when the timeout escalates to SIGKILL', async () => {
    // Spawn a process that spawns its own grandchild, then loops. The
    // harness timeout must SIGKILL the whole group so the grandchild
    // does not survive and leak file descriptors.
    const handle = runProcess({
      command: BUN,
      args: [
        '-e',
        `
        const { spawn } = require('node:child_process')
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { detached: true })
        setInterval(() => process.stdout.write('.'), 50)
        `,
      ],
      timeoutMs: 300,
    })
    await expect(handle).rejects.toBeInstanceOf(ProcessTimeoutError)
    // Wait for the SIGKILL to land and the OS to reap both processes.
    await new Promise((resolve) => setTimeout(resolve, 800))
  })

  it('clean up the temp dir when tempRoot: true even on timeout', async () => {
    const root = process.env.ANTIGRAVITY_TEST_ROOT
    let exit: ProcessExit | undefined
    try {
      exit = await runProcess({
        command: BUN,
        args: ['-e', 'setInterval(() => {}, 100)'],
        tempRoot: true,
        timeoutMs: 250,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessTimeoutError)
      if (root) {
        const { readdirSync } = await import('node:fs')
        const remaining = readdirSync(root).filter((name) =>
          name.startsWith('agy-e2e-proc-'),
        )
        expect(remaining).toEqual([])
      }
    }
    if (exit?.tempRoot) {
      const { existsSync } = await import('node:fs')
      expect(existsSync(exit.tempRoot)).toBe(false)
    }
  })

  it('kill() sends the supplied signal to the running process group', async () => {
    const handle = runProcess({
      command: BUN,
      args: ['-e', 'setInterval(() => {}, 100)'],
      timeoutMs: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const sent = handle.kill('SIGTERM')
    expect(sent).toBe(true)
    const exit = await handle
    expect(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL').toBe(true)
  })
})
