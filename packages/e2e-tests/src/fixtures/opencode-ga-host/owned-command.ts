import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface OwnedCommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputCapExceeded: boolean
  cleanupFailures: string[]
  spawnError?: string
}

export function procIdentity(stat: string): {
  parent: number
  group: number
  start: string
} {
  // The command name can contain spaces and parentheses; fields start after its last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const parent = Number(fields[1])
  const group = Number(fields[2])
  const start = fields[19]
  if (
    !Number.isSafeInteger(parent) ||
    !Number.isSafeInteger(group) ||
    !/^\d+$/.test(start ?? '')
  )
    throw new Error('Malformed process ownership record')
  return { parent, group, start: start! }
}

export function ownsProcess(
  before: ReturnType<typeof procIdentity>,
  current: ReturnType<typeof procIdentity>,
  parent: number,
  pid: number,
): boolean {
  return (
    before.start === current.start &&
    current.parent === parent &&
    current.group === pid
  )
}

/** A detached, bounded child whose process group is signalled only while its leader is still ours. */
export function startOwnedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    deadlineMs: number
    outputCapBytes?: number
  },
) {
  if (
    !command.startsWith('/') ||
    !Number.isInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > 120_000
  )
    throw new Error(
      'Owned command requires an absolute executable and a finite deadline',
    )
  const cap = options.outputCapBytes ?? 8 * 1024 * 1024
  if (!Number.isInteger(cap) || cap < 1 || cap > 8 * 1024 * 1024)
    throw new Error('Invalid owned command output cap')
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    detached: true,
  })
  const cleanupFailures: string[] = []
  let identity: ReturnType<typeof procIdentity> | undefined
  if (child.pid) {
    try {
      identity = procIdentity(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
    } catch (error) {
      // A short-lived child may exit before its stat is read; no signal is needed on a normal close.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        cleanupFailures.push(`capture ownership: ${String(error)}`)
    }
  }
  let stdout = ''
  let stderr = ''
  let bytes = 0
  let timedOut = false
  let outputCapExceeded = false
  let spawnError: string | undefined
  let closed = false
  const signal = (value: NodeJS.Signals) => {
    if (closed || child.exitCode !== null || child.signalCode !== null) return
    try {
      if (
        !child.pid ||
        !identity ||
        !ownsProcess(
          identity,
          procIdentity(readFileSync(`/proc/${child.pid}/stat`, 'utf8')),
          process.pid,
          child.pid,
        )
      )
        throw new Error('Process ownership changed; refusing signal')
      process.kill(-child.pid, value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        cleanupFailures.push(`signal ${value}: ${String(error)}`)
    }
  }
  const retain = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const remaining = Math.max(0, cap - bytes)
    const text = chunk.subarray(0, remaining).toString()
    if (stream === 'stdout') stdout += text
    else stderr += text
    bytes += chunk.length
    if (bytes > cap && !outputCapExceeded) {
      outputCapExceeded = true
      signal('SIGKILL')
    }
  }
  child.stdout.on('data', (chunk: Buffer) => retain(chunk, 'stdout'))
  child.stderr.on('data', (chunk: Buffer) => retain(chunk, 'stderr'))
  const result = new Promise<OwnedCommandResult>((resolve) => {
    let settled = false
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(reap)
      resolve({
        code,
        signal: exitSignal,
        stdout,
        stderr,
        timedOut,
        outputCapExceeded,
        cleanupFailures,
        ...(spawnError ? { spawnError } : {}),
      })
    }
    const deadline = setTimeout(() => {
      timedOut = true
      signal('SIGKILL')
    }, options.deadlineMs)
    // A descendant retaining a pipe must not leave the caller waiting indefinitely after a kill.
    const reap = setTimeout(() => {
      cleanupFailures.push(
        'Child did not close within the bounded reap interval',
      )
      signal('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
      child.unref()
      finish(child.exitCode, child.signalCode)
    }, options.deadlineMs + 5_000)
    child.once('error', (error) => {
      spawnError = String(error)
    })
    child.once('close', (code, exitSignal) => {
      closed = true
      finish(code, exitSignal)
    })
  })
  return { process: child, result, signal, output: () => ({ stdout, stderr }) }
}

export function assertOwnedCommandSucceeded(result: OwnedCommandResult): void {
  if (
    result.code !== 0 ||
    result.signal ||
    result.timedOut ||
    result.outputCapExceeded ||
    result.spawnError ||
    result.cleanupFailures.length
  )
    throw new Error(`Owned command failed: ${JSON.stringify(result)}`)
}
