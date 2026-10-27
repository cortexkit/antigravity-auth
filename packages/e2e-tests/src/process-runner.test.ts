import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProcessTimeoutError, runProcess } from './process-runner'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const BUN = process.execPath

async function until(observed: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!observed()) {
    if (Date.now() >= deadline)
      throw new Error('process observation did not arrive')
    await Bun.sleep(10)
  }
}

// Hold only the runner's timeout; readiness, SIGTERM and the real escalation
// timer remain observable independently of child startup speed.
function heldTimeout() {
  const original = globalThis.setTimeout
  let expire: (() => void) | undefined
  const schedule = Object.assign(
    (callback: unknown, delay?: number, ...args: unknown[]) => {
      if (delay === 250 && typeof callback === 'function') {
        expire = () => callback(...args)
        return original(() => {}, 0)
      }
      return original(callback as (...args: unknown[]) => void, delay, ...args)
    },
    { __promisify__: original.__promisify__ },
  )
  // Bun returns Node timer objects; the shared DOM type overload also permits
  // numeric handles, which this process-runner adapter never receives.
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(
    schedule as unknown as typeof setTimeout,
  )
  return {
    expire() {
      expect(expire).toBeDefined()
      expire?.()
    },
    restore: () => timer.mockRestore(),
  }
}

function linuxIdentity(pid: number): string | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')[1]
      ?.split(' ')
    // A zombie cannot execute or retain sockets; its parent may reap it later.
    return fields?.[0] === 'Z' ? undefined : fields?.[19]
  } catch {
    return undefined
  }
}

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
    const output = await runProcess({
      command: BUN,
      args: [
        '-e',
        'process.stdout.write("small-out"); process.stderr.write("small-err")',
      ],
    })
    expect(output.stdout).toBe('small-out')
    expect(output.stderr).toBe('small-err')
    expect(output.truncated).toBe(false)
  })

  it('captures stdout and stderr up to the 64 KiB cap', async () => {
    const exit = await runProcess({
      command: BUN,
      args: [
        '-e',
        'await Promise.all([new Promise(r => process.stdout.write("out:".repeat(50_000), r)), new Promise(r => process.stderr.write("err:".repeat(50_000), r))])',
      ],
    })
    expect(exit.stdout).toBe('out:'.repeat(16 * 1024))
    expect(exit.stderr).toBe('err:'.repeat(16 * 1024))
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
    await expect(
      runProcess({
        command: BUN,
        args: [
          '-e',
          'setInterval(() => {}, 100); process.stdout.write("alive")',
        ],
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError)
  })

  it.skipIf(process.platform !== 'linux')(
    'kills the entire process group when the timeout escalates to SIGKILL',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agy-e2e-group-'))
      const timer = heldTimeout()
      let childPid: number | undefined
      const handle = runProcess({
        command: BUN,
        args: [
          '-e',
          `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        process.on('SIGTERM', () => writeFileSync(${JSON.stringify(join(root, 'parent-term'))}, 'term'));
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
          const { writeFileSync } = require('node:fs');
          process.on('SIGTERM', () => writeFileSync(${JSON.stringify(join(root, 'child-term'))}, 'term'));
          writeFileSync(${JSON.stringify(join(root, 'ready'))}, String(process.pid));
          setInterval(() => {}, 100);
        `)}], { stdio: 'ignore' });
        setInterval(() => {}, 100);
        `,
        ],
        timeoutMs: 250,
      })
      void handle.catch(() => {})
      try {
        await until(() => existsSync(join(root, 'ready')))
        childPid = Number(readFileSync(join(root, 'ready'), 'utf8'))
        const parentBirth = linuxIdentity(handle.pid)
        const childBirth = linuxIdentity(childPid)
        expect(parentBirth).toBeDefined()
        expect(childBirth).toBeDefined()
        timer.expire()
        await expect(handle).rejects.toBeInstanceOf(ProcessTimeoutError)
        await until(
          () =>
            existsSync(join(root, 'parent-term')) &&
            existsSync(join(root, 'child-term')),
        )
        expect(linuxIdentity(handle.pid)).toBe(parentBirth)
        expect(linuxIdentity(childPid)).toBe(childBirth)
        await until(
          () =>
            linuxIdentity(handle.pid) !== parentBirth &&
            linuxIdentity(childPid as number) !== childBirth,
        )
      } finally {
        timer.restore()
        handle.kill('SIGKILL')
        if (childPid && linuxIdentity(childPid))
          process.kill(childPid, 'SIGKILL')
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('clean up the temp dir when tempRoot: true even on timeout', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agy-e2e-proc-parent-'))
    const previous = process.env.TMPDIR
    process.env.TMPDIR = parent
    const timer = heldTimeout()
    const handle = runProcess({
      command: BUN,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(join(parent, 'ready'))}, 'ready'); setInterval(() => {}, 100)`,
      ],
      tempRoot: true,
      timeoutMs: 250,
    })
    void handle.catch(() => {})
    try {
      await until(() => existsSync(join(parent, 'ready')))
      const allocated = readdirSync(parent).filter((name) =>
        name.startsWith('agy-e2e-proc-'),
      )
      expect(allocated).toHaveLength(1)
      const actualRoot = join(parent, allocated[0] as string)
      expect(existsSync(actualRoot)).toBe(true)
      timer.expire()
      await expect(handle).rejects.toBeInstanceOf(ProcessTimeoutError)
      await until(() => !existsSync(actualRoot))
      expect(existsSync(actualRoot)).toBe(false)
    } finally {
      timer.restore()
      handle.kill('SIGKILL')
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      rmSync(parent, { recursive: true, force: true })
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
