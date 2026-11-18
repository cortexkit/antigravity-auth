import { spyOn } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as promises from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as timers from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

type LockModule =
  typeof import('../../../../core/src/common-auth-embedded/fs/refresh-file-lock.js')
type Scope = {
  operation: string
  lock?: number
  lockName?: string
  stage?: string
  retry?: number
}
type Span = Scope & {
  phase: string
  path?: string
  startMs: number
  ms?: number
  requestedMs?: number
  cancelled?: boolean
  caller?: string
  error?: { code: string; win32Code?: number; reason?: string; stage?: string }
}

const round = (ms: number) => Math.round(ms * 10) / 10
const SLOW_MS = 3_000
const SNAPSHOT_LEAD_MS = 200
type TraceOutcome = 'passed' | 'failure' | 'timeout'
type TraceOptions = {
  now?: () => number
  emit?: (line: string) => void
  schedule?: (callback: () => void, delayMs: number) => () => void
}

function schedule(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

function atomicWritePhase(path: string) {
  const file = basename(path)
  if (file === 'layout-moving.json') return 'move:write-manifest'
  if (file === 'layout.json') return 'move:write-marker'
  if (basename(dirname(path)) === 'antigravity-auth-vault')
    return 'move:copy-write'
  return 'io:writeJsonAtomic'
}

/** Observe lock operations, filesystem I/O and real timer delays without changing their results or timing policy. */
export class RuntimeLayoutLockTrace {
  private readonly context = new AsyncLocalStorage<Scope>()
  private readonly spans: Span[] = []
  private readonly restores: Array<() => void> = []
  private readonly clock: () => number
  private readonly started: number
  private cancelSnapshot?: () => void
  private test = '(layout test setup)'
  private locks = 0
  private operations = 0
  private readonly retries = new Map<string, number>()

  constructor(private readonly options: TraceOptions = {}) {
    this.clock = options.now ?? (() => performance.now())
    this.started = this.clock()
  }

  arm(test: string, timeoutMs: number) {
    this.test = test
    this.cancelSnapshot = (this.options.schedule ?? schedule)(
      () => this.print('near timeout, may still pass'),
      Math.max(0, timeoutMs - SNAPSHOT_LEAD_MS),
    )
  }

  bodySettled() {
    this.cancelSnapshot?.()
    this.cancelSnapshot = undefined
  }

  private now() {
    return this.clock() - this.started
  }

  private start(phase: string, path?: string): Span {
    const span: Span = {
      operation: 'background',
      ...this.context.getStore(),
      phase,
      path,
      startMs: this.now(),
    }
    this.spans.push(span)
    return span
  }

  private failed(span: Span, error: unknown) {
    const detail = error as NodeJS.ErrnoException & {
      win32Code?: number
      reason?: string
      stage?: string
    }
    span.error = {
      code: detail?.code ?? detail?.name ?? 'error',
      win32Code: detail?.win32Code,
      reason: detail?.reason,
      stage: detail?.stage,
    }
  }

  private async measure<T>(
    phase: string,
    path: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const span = this.start(phase, path)
    try {
      return await work()
    } catch (error) {
      this.failed(span, error)
      throw error
    } finally {
      span.ms = this.now() - span.startMs
    }
  }

  phase<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
    const operation = `${phase} #${++this.operations}`
    return this.context.run({ operation }, () =>
      this.measure(phase, undefined, work),
    )
  }

  step<T>(phase: string, work: () => T | Promise<T>, path?: string) {
    return this.measure(phase, path, work)
  }

  syncPhase<T>(phase: string, work: () => T, path?: string): T {
    const span = this.start(phase, path)
    try {
      return work()
    } catch (error) {
      this.failed(span, error)
      throw error
    } finally {
      span.ms = this.now() - span.startMs
    }
  }

  async install() {
    const root = dirname(
      Bun.resolveSync(
        '@cortexkit/antigravity-auth-core/common-auth/fs',
        import.meta.dir,
      ),
    )
    const api = (await import(
      pathToFileURL(join(root, 'refresh-file-lock.js')).href
    )) as LockModule
    const acquire = api.acquireRefreshFileLock
    const acquisitionSpy = spyOn(api, 'acquireRefreshFileLock')
    this.restores.push(() => acquisitionSpy.mockRestore())
    acquisitionSpy.mockImplementation((options) => {
      const parent = this.context.getStore()
      if (!parent) return acquire(options)
      const path = `${options.path}.${options.name}.lock`
      const key = `${parent.operation}\0${path}`
      const retry = this.retries.get(key) ?? 0
      this.retries.set(key, retry + 1)
      const scope = {
        operation: parent.operation,
        lock: this.locks++,
        lockName: options.name,
        stage: 'acquire',
        retry,
      }
      return this.context.run(scope, async () => {
        const lock = await this.measure('lock:acquire', path, () =>
          acquire({
            ...options,
            onStep: (step) =>
              this.measure(`lock:step:${step}`, path, () =>
                options.onStep?.(step),
              ),
          }),
        )
        if (!lock) {
          this.syncPhase('lock:contended', () => {}, path)
          return lock
        }
        this.retries.delete(key)
        scope.stage = 'hold'
        const release = lock.release.bind(lock)
        lock.release = (signal) =>
          this.context.run({ ...scope, stage: 'release' }, () =>
            this.measure('lock:release', path, () => release(signal)),
          )
        return lock
      })
    })

    this.observe(promises, [
      'open',
      'mkdir',
      'link',
      'rmdir',
      'unlink',
      'rename',
      'rm',
      'readFile',
      'writeFile',
      'lstat',
      'stat',
      'readdir',
      'realpath',
      'chmod',
    ])
    const atomic = (await import(
      pathToFileURL(join(root, 'atomic-write.js')).href
    )) as object
    this.observe(atomic, ['writeJsonAtomic'])
    const backend = (await import(
      pathToFileURL(Bun.resolveSync('@cortexkit/private-files', root)).href
    )) as object
    this.observe(backend, [
      'createPrivateFile',
      'createOwnerOnly',
      'verifySafeParent',
      'verifyOwnerOnly',
      'verifyPrivatePath',
      'securePrivatePath',
      'readOwnerOnly',
    ])
    this.observeTimers()
    this.observePromiseTimers()
  }

  private observe(api: object, names: string[]) {
    // Forward opaque argument lists and receivers just as the real APIs received them.
    const methods = api as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    for (const name of names) {
      const original = methods[name]
      if (!original)
        throw new Error(`Missing filesystem observer target: ${name}`)
      const spy = spyOn(methods, name)
      this.restores.push(() => spy.mockRestore())
      spy.mockImplementation(async (...args: unknown[]) => {
        if (!this.context.getStore()) return Reflect.apply(original, api, args)
        const path = String(args[0])
        const phase =
          name === 'securePrivatePath'
            ? 'permissions:tighten (PrivateFileMigration)'
            : name === 'writeJsonAtomic'
              ? atomicWritePhase(path)
              : `io:${name}`
        const result = await this.measure(phase, path, () =>
          Reflect.apply(original, api, args),
        )
        if (name !== 'open' || !result || typeof result !== 'object')
          return result
        return new Proxy(result, {
          get: (target, key) => {
            const value: unknown = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (
              ![
                'sync',
                'datasync',
                'writeFile',
                'chmod',
                'close',
                'stat',
              ].includes(String(key))
            )
              return value.bind(target)
            return (...values: unknown[]) =>
              this.measure(`handle:${String(key)}`, path, () =>
                Reflect.apply(value, target, values),
              )
          },
        })
      })
    }
  }

  private observeTimers() {
    const set = globalThis.setTimeout
    const clear = globalThis.clearTimeout
    const timers = new Map<unknown, Span>()
    const setSpy = spyOn(globalThis, 'setTimeout')
    this.restores.push(() => setSpy.mockRestore())
    setSpy.mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (!this.context.getStore()) return set(callback, delay, ...args)
      const caller = new Error().stack?.split('\n').slice(2, 7).join('\n')
      const phase = caller?.includes('takeLock')
        ? 'lock:layout-backoff'
        : caller?.includes('unlinkIfIdentical')
          ? 'move:sharing-backoff'
          : 'timer:setTimeout'
      const span = this.start(phase)
      span.requestedMs = delay ?? 0
      span.caller = caller?.slice(0, 800)
      const trace = this
      const handle = set(
        function (this: unknown, ...values: unknown[]) {
          span.ms = trace.now() - span.startMs
          timers.delete(handle)
          Reflect.apply(callback, this, values)
        },
        delay,
        ...args,
      )
      timers.set(handle, span)
      return handle
    }) as typeof setTimeout)
    const clearSpy = spyOn(globalThis, 'clearTimeout')
    this.restores.push(() => clearSpy.mockRestore())
    clearSpy.mockImplementation((handle) => {
      const span = handle === undefined ? undefined : timers.get(handle)
      if (span) {
        span.ms = this.now() - span.startMs
        span.cancelled = true
        timers.delete(handle)
      }
      return Reflect.apply(clear, globalThis, [handle])
    })
  }

  private observePromiseTimers() {
    const delay = timers.setTimeout
    const spy = spyOn(timers, 'setTimeout')
    this.restores.push(() => spy.mockRestore())
    spy.mockImplementation((ms, value, options) => {
      if (!this.context.getStore()) return delay(ms, value, options)
      const caller = new Error().stack?.split('\n').slice(2, 7).join('\n')
      if (!/[/\\]store[/\\]mutate\.js/.test(caller ?? ''))
        return delay(ms, value, options)
      const span = this.start('store:mutate-backoff')
      span.requestedMs = ms
      span.caller = caller?.slice(0, 800)
      return delay(ms, value, options).then(
        (result) => {
          span.ms = this.now() - span.startMs
          return result
        },
        (error: unknown) => {
          span.ms = this.now() - span.startMs
          this.failed(span, error)
          throw error
        },
      )
    })
  }

  private print(reason: string) {
    const elapsed = this.now()
    const rowCount = this.spans.length
    const sink = this.options.emit ?? console.error
    const emit = (row: object) =>
      sink(`AGY_LAYOUT_TRACE ${JSON.stringify(row)}`)
    // Small records survive Bun's output transport; matching counts identify a complete table.
    emit({
      kind: 'header',
      test: this.test,
      reason,
      rowCount,
      pid: process.pid,
      elapsedMs: round(elapsed),
      nativeGranularity:
        'On Windows io:createPrivateFile includes native DACL verification, write and FlushFileBuffers; the addon exposes no separate subphase hooks.',
    })
    for (const [index, span] of this.spans.entries())
      emit({
        kind: 'event',
        index,
        ...span,
        startMs: round(span.startMs),
        ms: round(span.ms ?? elapsed - span.startMs),
        pending: span.ms === undefined,
      })
    emit({ kind: 'footer', test: this.test, reason, rowCount })
  }

  finish(outcome: TraceOutcome) {
    this.bodySettled()
    try {
      if (outcome !== 'passed') this.print(outcome)
      else if (this.now() > SLOW_MS) this.print('slow, passed')
    } finally {
      for (const restore of this.restores.splice(0).reverse()) restore()
    }
  }
}
