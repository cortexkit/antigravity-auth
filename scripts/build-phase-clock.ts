import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { traceBuildTestChild } from './test-child-lifecycle.ts'

const directory = 'build-test-phase-clocks'
const storage = new AsyncLocalStorage<PhaseClock>()
const now = () => performance.timeOrigin + performance.now()

type Phase = { name: string; startedAt: number }
type Event = { name: string; at: number; elapsedMs?: number; detail?: string }
type Journal = {
  schema: 1
  id: string
  test: string
  startedAt: number
  timeoutMs: number
  status: 'running' | 'passed' | 'failed'
  active: Phase[]
  recent: Event[]
  failure?: string
  failedPhase?: string
}

type ClockOptions = {
  root?: string
  now?: () => number
  report?: (line: string) => void
}

class PhaseClock {
  readonly journal: Journal
  readonly time: () => number
  private readonly file: string | undefined
  private readonly report: (line: string) => void
  private persisted = false

  constructor(test: string, timeoutMs: number, options: ClockOptions) {
    this.time = options.now ?? now
    this.report =
      options.report ?? ((line) => process.stderr.write(`${line}\n`))
    this.journal = {
      schema: 1,
      id: `${process.pid}-${randomUUID()}`,
      test,
      startedAt: this.time(),
      timeoutMs,
      status: 'running',
      active: [],
      recent: [],
    }
    const root = options.root ?? process.env.AGY_COMMON_AUTH_STORE_CONSUMER
    if (root) this.file = join(root, directory, `${this.journal.id}.json`)
    this.save()
  }

  save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(this.journal))
      renameSync(temporary, this.file)
      this.persisted = true
    } catch {
      // Diagnostics must not turn a successful build into a failed build.
      this.persisted = false
    }
  }

  event(name: string, detail?: string, elapsedMs?: number) {
    this.journal.recent.push({ name, at: this.time(), elapsedMs, detail })
    if (this.journal.recent.length > 16) this.journal.recent.shift()
    this.save()
  }

  enter(name: string) {
    const phase = { name, startedAt: this.time() }
    this.journal.active.push(phase)
    this.event(`enter ${name}`)
    return phase
  }

  leave(phase: Phase, error?: unknown) {
    if (error !== undefined) {
      this.journal.failedPhase ??= phase.name
      this.journal.failure = String(error).slice(0, 1000)
    }
    this.journal.active.splice(this.journal.active.indexOf(phase), 1)
    this.event(
      `${error === undefined ? 'exit' : 'reject'} ${phase.name}`,
      error === undefined ? undefined : String(error).slice(0, 1000),
      this.time() - phase.startedAt,
    )
  }

  finish(error?: unknown) {
    this.journal.status = error === undefined ? 'passed' : 'failed'
    if (error !== undefined) this.journal.failure = String(error).slice(0, 1000)
    this.event(this.journal.status)
    if (error !== undefined && !this.persisted)
      this.report(format(this.journal, this.time(), 'test failed'))
  }
}

export async function withBuildPhaseClock<T>(
  test: string,
  timeoutMs: number,
  action: () => Promise<T>,
  options: ClockOptions = {},
): Promise<T> {
  const clock = new PhaseClock(test, timeoutMs, options)
  return storage.run(clock, async () => {
    try {
      const value = await action()
      clock.finish()
      return value
    } catch (error) {
      clock.finish(error)
      throw error
    }
  })
}

export async function buildPhase<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const clock = storage.getStore()
  if (!clock) return action()
  const phase = clock.enter(name)
  try {
    const value = await action()
    clock.leave(phase)
    return value
  } catch (error) {
    clock.leave(phase, error)
    throw error
  }
}

export function buildSyncPhase<T>(name: string, action: () => T): T {
  const clock = storage.getStore()
  if (!clock) return action()
  const phase = clock.enter(name)
  try {
    const value = action()
    clock.leave(phase)
    return value
  } catch (error) {
    clock.leave(phase, error)
    throw error
  }
}

export function buildPhaseNote(name: string, detail: string) {
  storage.getStore()?.event(name, detail.slice(0, 1000))
}

function format(journal: Journal, at: number, reason: string) {
  return `[build-test-phase-clock] ${JSON.stringify({
    reason,
    test: journal.test,
    pid: journal.id.split('-')[0],
    elapsedMs: Math.round(at - journal.startedAt),
    timeoutMs: journal.timeoutMs,
    active: journal.active.map((phase) => ({
      name: phase.name,
      elapsedMs: Math.round(at - phase.startedAt),
    })),
    failedPhase: journal.failedPhase,
    failure: journal.failure,
    recent: journal.recent.map((event) => ({
      ...event,
      at: Math.round(event.at - journal.startedAt),
      elapsedMs:
        event.elapsedMs === undefined ? undefined : Math.round(event.elapsedMs),
    })),
  })}`
}

/**
 * Runs in the wrapper, not the test process: a blocked synchronous child wait
 * cannot prevent the wrapper from reporting the last entered build phase.
 */
export function createBuildPhaseReporter(
  root: string,
  options: Omit<ClockOptions, 'root'> = {},
) {
  const reported = new Set<string>()
  const time = options.now ?? now
  const report = options.report ?? ((line) => process.stderr.write(`${line}\n`))
  return (commandFailure?: string) => {
    let files: string[]
    try {
      files = readdirSync(join(root, directory))
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      let journal: Journal
      try {
        journal = JSON.parse(readFileSync(join(root, directory, file), 'utf8'))
      } catch {
        continue
      }
      if (journal.schema !== 1 || reported.has(journal.id)) continue
      const at = time()
      const reason =
        journal.status === 'failed'
          ? 'test failed'
          : journal.status === 'running'
            ? (commandFailure ??
              (at - journal.startedAt >= journal.timeoutMs
                ? 'test deadline reached'
                : undefined))
            : undefined
      if (!reason) continue
      reported.add(journal.id)
      report(format(journal, at, reason))
    }
  }
}

// Expose optional clock hooks under a shared symbol for copied build scripts.
Object.defineProperty(globalThis, Symbol.for('cortexkit.build-phase-clock'), {
  configurable: true,
  value: {
    phase: buildPhase,
    sync: buildSyncPhase,
    note: buildPhaseNote,
    child: traceBuildTestChild,
  },
})
