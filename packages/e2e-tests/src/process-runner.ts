/**
 * Hygienic process runner for the E2E harness.
 *
 * `runProcess()` exists to give the lifecycle/signal tests a real
 * subprocess they can spawn, signal, and reap — without spinning up a
 * full Bun instance. The OAuth / readline code paths still run
 * in-process; those tests live in `cli-flow.e2e.ts`.
 *
 * Design:
 *   - Spawns the child with `detached: true` so we control its process
 *     group; on POSIX we kill the entire group with `-pid`, on Windows
 *     we fall back to a `taskkill /T` (out of scope for the linux CI).
 *   - Captures up to 64 KiB of stdout and stderr each; anything beyond
 *     the cap is dropped (we surface a flag so tests can assert on the
 *     truncation).
 *   - Resolves on exit; rejects with `ProcessTimeoutError` if the
 *     timeout elapses before exit. The timeout path sends SIGTERM to
 *     the process group, waits up to 1s for exit, then escalates to
 *     SIGKILL.
 *   - Always releases the temp directory the harness owned for the
 *     process (e.g. a per-process state root) — the runner takes
 *     ownership of any `tempRoot` paths the caller passes in.
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUTPUT_CAP_BYTES = 64 * 1024
const SIGTERM_GRACE_MS = 1000

export class ProcessTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`Process "${command}" did not exit within ${timeoutMs}ms`)
    this.name = 'ProcessTimeoutError'
  }
}

export interface ProcessExit {
  /** Exit code, or null if the process was terminated by a signal. */
  exitCode: number | null
  /** Signal name that terminated the process, if any. */
  signal: NodeJS.Signals | null
  /** Captured stdout (truncated to 64 KiB). */
  stdout: string
  /** Captured stderr (truncated to 64 KiB). */
  stderr: string
  /** True when stdout/stderr hit the 64 KiB cap. */
  truncated: boolean
  /** Path the runner allocated for this process (if `tempRoot: true`). */
  tempRoot?: string
}

export interface RunProcessOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Allocate a private temp dir for the child and clean it up on exit. */
  tempRoot?: boolean
  /** Extra signal sent immediately after spawn (for tests that need it). */
  signal?: NodeJS.Signals
}

export interface RunningProcess extends Promise<ProcessExit> {
  /** Resolves once the child has exited. */
  readonly exited: Promise<ProcessExit>
  /** Send a signal to the process group (POSIX) or process (Windows). */
  kill(signal?: NodeJS.Signals): boolean
  /** PID of the spawned child. */
  readonly pid: number
}

/**
 * Spawn a child process and resolve on exit. The returned object is
 * a Promise that doubles as the running process — `await runProcess`
 * yields the exit record, and `.kill()` / `.pid` work while the child
 * is still alive.
 */
export function runProcess(options: RunProcessOptions): RunningProcess {
  const command = options.command
  const args = options.args ?? []
  const timeoutMs = options.timeoutMs ?? 30_000
  const cwd = options.cwd ?? process.cwd()
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  }
  const tempRoot = options.tempRoot
    ? mkdtempSync(join(tmpdir(), 'agy-e2e-proc-'))
    : undefined

  const spawnOptions: SpawnOptions = {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  const child: ChildProcess = spawn(command, args, spawnOptions)
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let exited = false
  let resolveExit!: (value: ProcessExit) => void
  let rejectExit!: (reason: unknown) => void
  let timeoutHandle: NodeJS.Timeout | undefined
  let sigtermHandle: NodeJS.Timeout | undefined

  const exitedPromise = new Promise<ProcessExit>((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })

  function finishWith(result: ProcessExit) {
    if (exited) return
    exited = true
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (sigtermHandle) clearTimeout(sigtermHandle)
    if (tempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    resolveExit(result)
  }

  function capPush(
    target: Buffer[],
    chunk: Buffer,
    counter: { n: number },
  ): number {
    const remaining = OUTPUT_CAP_BYTES - counter.n
    if (remaining <= 0) {
      truncated = true
      return counter.n
    }
    if (chunk.length <= remaining) {
      target.push(chunk)
      counter.n += chunk.length
      return counter.n
    }
    target.push(chunk.subarray(0, remaining))
    counter.n = OUTPUT_CAP_BYTES
    truncated = true
    return counter.n
  }

  const stdoutCounter = { n: 0 }
  const stderrCounter = { n: 0 }
  child.stdout?.on('data', (chunk: Buffer) => {
    capPush(stdoutChunks, chunk, stdoutCounter)
    stdoutBytes = stdoutCounter.n
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    capPush(stderrChunks, chunk, stderrCounter)
    stderrBytes = stderrCounter.n
  })

  child.once('error', (error) => {
    finishWith({
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8') || String(error),
      truncated,
      ...(tempRoot ? { tempRoot } : {}),
    })
  })

  child.once('exit', (code, signal) => {
    finishWith({
      exitCode: code,
      signal: signal as NodeJS.Signals | null,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      truncated,
      ...(tempRoot ? { tempRoot } : {}),
    })
  })

  timeoutHandle = setTimeout(() => {
    if (exited) return
    rejectExit(new ProcessTimeoutError(command, timeoutMs))
    // SIGTERM the process group first, then SIGKILL after grace.
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGTERM')
      } else if (child.pid) {
        child.kill('SIGTERM')
      }
    } catch {
      /* group may already be dead */
    }
    sigtermHandle = setTimeout(() => {
      if (exited) return
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        } else if (child.pid) {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }, SIGTERM_GRACE_MS)
    sigtermHandle.unref?.()
  }, timeoutMs)
  timeoutHandle.unref?.()

  if (options.signal && child.pid) {
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, options.signal)
      } else {
        child.kill(options.signal)
      }
    } catch {
      /* ignore — process may already be dead */
    }
  }

  const running = exitedPromise as RunningProcess
  Object.defineProperty(running, 'pid', { value: child.pid ?? -1 })
  Object.defineProperty(running, 'exited', { value: exitedPromise })
  running.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!child.pid) return false
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
      return true
    } catch {
      return false
    }
  }

  // Suppress unused-var warnings on captured lengths.
  void stdoutBytes
  void stderrBytes
  void rejectExit
  return running
}
