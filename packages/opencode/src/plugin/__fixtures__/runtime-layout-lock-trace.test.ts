import { spyOn } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as promises from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

type LockModule =
  typeof import('../../../../core/src/common-auth-embedded/fs/refresh-file-lock.js')
type Scope = { operation: string; lock?: number; stage?: string }
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

/** Observe lock operations, filesystem I/O and real timer delays without changing their results or timing policy. */
export class RuntimeLayoutLockTrace {
  private readonly context = new AsyncLocalStorage<Scope>()
  private readonly spans: Span[] = []
  private readonly restores: Array<() => void> = []
  private readonly started = performance.now()
  private readonly timer: ReturnType<typeof setTimeout>
  private locks = 0

  constructor(private readonly test: string) {
    // Leave time to print pending release work before Bun's five-second test timeout.
    this.timer = setTimeout(
      () => this.print('NEAR_TIMEOUT snapshot (test still running; may pass)'),
      4_800,
    )
    this.timer.unref()
  }

  private now() {
    return performance.now() - this.started
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
    return this.context.run({ operation: phase }, () =>
      this.measure(phase, undefined, work),
    )
  }

  syncPhase<T>(phase: string, work: () => T): T {
    const span = this.start(phase)
    try {
      return work()
    } catch (error) {
      this.failed(span, error)
      throw error
    } finally {
      span.ms = this.now() - span.startMs
    }
  }

  async run(work: () => Promise<void>) {
    try {
      await work()
    } catch (error) {
      this.print('failure')
      throw error
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
      const path = `${options.path}.${options.name}.lock`
      const scope = {
        operation: this.context.getStore()?.operation ?? 'background',
        lock: this.locks++,
        stage: 'acquire',
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
          this.syncPhase('lock:contended', () => {})
          return lock
        }
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
      'unlink',
      'rename',
      'rm',
      'readFile',
      'writeFile',
      'lstat',
      'stat',
      'readdir',
      'chmod',
    ])
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
        const path = String(args[0])
        const result = await this.measure(`io:${name}`, path, () =>
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
      const span = this.start('timer:setTimeout')
      span.requestedMs = delay ?? 0
      span.caller = new Error().stack
        ?.split('\n')
        .slice(2, 7)
        .join('\n')
        .slice(0, 800)
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

  private print(reason: string) {
    const elapsed = this.now()
    const rows = this.spans.map((span) => ({
      ...span,
      startMs: round(span.startMs),
      ms: round(span.ms ?? elapsed - span.startMs),
      pending: span.ms === undefined,
    }))
    const emit = (row: object) =>
      console.error(`AGY_LAYOUT_TRACE ${JSON.stringify(row)}`)
    // Small records survive Bun's output transport; matching counts identify a complete table.
    emit({
      kind: 'header',
      test: this.test,
      reason,
      rowCount: rows.length,
      pid: process.pid,
      elapsedMs: round(elapsed),
      nativeGranularity:
        'On Windows io:createPrivateFile includes native DACL verification, write and FlushFileBuffers; the addon exposes no separate subphase hooks.',
    })
    for (const [index, row] of rows.entries())
      emit({ kind: 'event', index, ...row })
    emit({ kind: 'footer', test: this.test, rowCount: rows.length })
  }

  stop() {
    clearTimeout(this.timer)
    for (const restore of this.restores.splice(0).reverse()) restore()
  }
}
