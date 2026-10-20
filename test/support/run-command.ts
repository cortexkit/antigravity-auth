import { basename } from 'node:path'

/**
 * Tests run child commands through this helper instead of a synchronous spawn.
 *
 * Bun's synchronous spawn can lose a child's exit on Linux (oven-sh/bun#34069):
 * the child stays a zombie and the waiting test runner spins at 100% CPU, so
 * neither the per-test timeout nor anything else in that process can run.
 * An asynchronous spawn keeps the event loop alive, so a stuck command is
 * stopped here at its own deadline and reported by name. Nothing is retried.
 */
export interface RunCommandOptions {
  /** Required: how long the command may run before it is killed and the call throws. */
  deadlineMs: number
  cwd?: string
  /** Replaces the child's whole environment when given; undefined values are dropped. */
  env?: Record<string, string | undefined>
  stdin?: string | Uint8Array
}

export interface RunCommandResult<Output extends string | Buffer = string> {
  pid: number
  /** null when the child ended through a signal. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: Output
  stderr: Output
}

/** After SIGTERM, the child gets this long before SIGKILL. */
const TERM_GRACE_MS = 250
/** After SIGKILL, wait this long for the child to exit before reporting it unreaped. */
const REAP_BOUND_MS = 2_000

function describe(argv: readonly string[]) {
  return `${basename(argv[0] ?? '')} (argc=${argv.length})`
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const bytes = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      chunks.push(value)
    }
  })()
  return {
    bytes,
    cancel: () => {
      reader.cancel().catch(() => {})
    },
  }
}

async function spawnCollect(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult<Buffer>> {
  const { deadlineMs } = options
  if (!argv.length) throw new Error('runCommand needs a command')
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error(
      `runCommand needs a positive deadline for ${describe(argv)}`,
    )
  const env = options.env
    ? Object.fromEntries(
        Object.entries(options.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env,
    stdin:
      options.stdin === undefined
        ? 'ignore'
        : typeof options.stdin === 'string'
          ? new TextEncoder().encode(options.stdin)
          : options.stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  const finished = Promise.all([child.exited, stdout.bytes, stderr.bytes])
  // Keep a late rejection from surfacing as unhandled after the deadline path throws.
  finished.catch(() => {})
  const completed = await within(finished, deadlineMs)
  if (completed) {
    const [, out, err] = completed
    return {
      pid: child.pid,
      exitCode: child.exitCode,
      signal: (child.signalCode as NodeJS.Signals | null) ?? null,
      stdout: out,
      stderr: err,
    }
  }
  // On deadline, stop the child, wait up to the reap bound, then fail by name.
  child.kill('SIGTERM')
  let reaped = await within(child.exited, TERM_GRACE_MS)
  if (reaped === undefined) {
    child.kill('SIGKILL')
    reaped = await within(child.exited, REAP_BOUND_MS)
  }
  // A grandchild may still hold the pipes open; stop reading instead of waiting on it.
  stdout.cancel()
  stderr.cancel()
  throw new Error(
    `command ${describe(argv)} exceeded its ${deadlineMs} ms deadline and was killed${
      reaped === undefined
        ? `; it was not reaped within ${REAP_BOUND_MS} ms`
        : ''
    }`,
  )
}

/** Run a command and return its output as UTF-8 text. */
export async function runCommand(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult<string>> {
  const result = await spawnCollect(argv, options)
  return {
    ...result,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  }
}

/** Run a command and return its output as raw bytes. */
export function runCommandBytes(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult<Buffer>> {
  return spawnCollect(argv, options)
}
