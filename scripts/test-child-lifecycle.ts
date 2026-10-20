import type { ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

const labels = [
  'native-run',
  'native-git',
  'lifetime',
  'packed-core-tsc',
  'packed-server-tsc',
  'build-tui',
  'build-setup',
] as const
type Label = (typeof labels)[number]
type ChildResult = {
  pid?: number
  status?: number | null
  exitCode?: number | null
  signal?: string | null
  signalCode?: string
  error?: unknown
}

export function traceBuildTestChild<T extends ChildResult>(
  command: string,
  argc: number,
  run: () => Promise<T>,
): Promise<T> {
  return traceTestCommand('build-tui', command, argc, run)
}

/** Sync APIs expose wait return, not kernel exit or individual pipe-close events. */
export function traceSyncTestChild<T extends ChildResult>(
  label: Label,
  command: string,
  argc: number,
  run: () => T,
  nonzeroExpected = false,
): T {
  const trace = openChildRecord(
    label,
    command,
    argc,
    'synchronous-wait-return',
    nonzeroExpected,
  )
  try {
    return trace.settled(run())
  } catch (error) {
    trace.threw()
    throw error
  } finally {
    trace.close()
  }
}

/**
 * Same journal as traceSyncTestChild for a command run asynchronously. The
 * command resolves only after the child exited and both output pipes were read
 * to the end, so one parent observation time covers exit and pipe closure.
 */
export async function traceTestCommand<T extends ChildResult>(
  label: Label,
  command: string,
  argc: number,
  run: () => Promise<T>,
  nonzeroExpected = false,
): Promise<T> {
  const trace = openChildRecord(
    label,
    command,
    argc,
    'asynchronous-exit-and-output-end',
    nonzeroExpected,
  )
  try {
    return trace.settled(await run())
  } catch (error) {
    trace.threw()
    throw error
  } finally {
    trace.close()
  }
}

function openChildRecord(
  label: Label,
  command: string,
  argc: number,
  observation: string,
  nonzeroExpected: boolean,
) {
  const now = () => ({
    wall: new Date().toISOString(),
    elapsedMs: Math.round(performance.now()),
  })
  const record = {
    label,
    runnerPid: process.pid,
    command: basename(command)
      .replace(/[^\w.+-]/g, '_')
      .slice(0, 64),
    argc,
    spawnRequested: now(),
    waitReturned: null as ReturnType<typeof now> | null,
    pid: null as number | null,
    status: null as number | null,
    signal: null as string | null,
    exitObserved: null as ReturnType<typeof now> | null,
    pipesClosedObserved: null as ReturnType<typeof now> | null,
    observation,
    failed: false,
    errorObserved: false,
  }
  const root = process.env.AGY_COMMON_AUTH_STORE_CONSUMER
  const save = () => {
    if (!root) return
    try {
      const directory = join(root, 'test-child-lifecycles')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(directory, `${process.pid}-${label}.json`),
        JSON.stringify(record),
      )
    } catch {
      /* Diagnostic I/O cannot fail a test. */
    }
  }
  save()
  return {
    settled<T extends ChildResult>(result: T): T {
      record.waitReturned = now()
      record.pid = result.pid ?? null
      record.status = result.status ?? result.exitCode ?? null
      record.signal = result.signal ?? result.signalCode ?? null
      record.failed =
        !!result.error || record.status !== 0 || record.signal !== null
      record.errorObserved = !!result.error
      // These are parent observation times, not claims about when the kernel exited.
      if (record.status !== null || record.signal !== null)
        record.exitObserved = record.waitReturned
      if (!result.error) record.pipesClosedObserved = record.waitReturned
      return result
    },
    threw() {
      record.waitReturned = now()
      record.failed = true
      record.errorObserved = true
    },
    close() {
      save()
      if (
        record.failed &&
        (!nonzeroExpected ||
          record.errorObserved ||
          record.signal ||
          record.status === null)
      )
        console.error(`[test-child-lifecycle] ${JSON.stringify(record)}`)
    },
  }
}

export function pendingTestChildLifecycles(
  root: string,
  runnerPid: number,
): unknown[] {
  const records: unknown[] = []
  for (const label of labels) {
    try {
      const fd = openSync(
        join(root, 'test-child-lifecycles', `${runnerPid}-${label}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      let text: string
      try {
        const buffer = Buffer.alloc(2048)
        const bytes = readSync(fd, buffer, 0, buffer.length, 0)
        if (bytes === buffer.length) continue
        text = buffer.subarray(0, bytes).toString()
      } finally {
        closeSync(fd)
      }
      const record = JSON.parse(text)
      // Copy only fixed-schema scalar fields; never relay arbitrary file content.
      if (record.runnerPid !== runnerPid || record.label !== label) continue
      const time = (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        'wall' in value &&
        typeof value.wall === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.wall)
          ? value.wall
          : null
      records.push({
        label,
        runnerPid,
        phase: record.waitReturned === null ? 'sync-wait' : 'wait-returned',
        spawnRequested: time(record.spawnRequested),
        waitReturned: time(record.waitReturned),
        status: Number.isInteger(record.status) ? record.status : null,
        signal: /^SIG[A-Z]{1,12}$/.test(record.signal) ? record.signal : null,
      })
    } catch {
      /* A racing or absent journal is not a command failure. */
    }
  }
  return records
}

/** Event timestamps for the asynchronous builder distinguish exit from pipe closure. */
export function traceAsyncTestChild(
  child: ChildProcess,
  command: string,
  argc: number,
) {
  const now = () => ({
    wall: new Date().toISOString(),
    elapsedMs: Math.round(performance.now()),
  })
  const record = {
    label: 'build-setup',
    runnerPid: process.pid,
    pid: child.pid,
    command: basename(command),
    argc,
    spawn: null as ReturnType<typeof now> | null,
    exit: null as ReturnType<typeof now> | null,
    pipeClose: null as ReturnType<typeof now> | null,
    status: null as number | null,
    signal: null as string | null,
    error: false,
  }
  child.once('spawn', () => {
    record.spawn = now()
  })
  child.once('error', () => {
    record.error = true
  })
  child.once('exit', (code, signal) => {
    record.exit = now()
    record.status = code
    record.signal = signal
  })
  child.once('close', () => {
    record.pipeClose = now()
    if (record.error || record.status !== 0 || record.signal)
      console.error(`[test-child-lifecycle] ${JSON.stringify(record)}`)
  })
}
