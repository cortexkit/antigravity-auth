import { spyOn } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as promises from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadVerifiedStoreModules } from './verified-store'

type LockModule =
  typeof import('../../../../core/src/common-auth-embedded/fs/refresh-file-lock.js')
type Scope = { operation: string; lock?: number; phase?: string }
type Phase = Scope & {
  phase: string
  path?: string
  startMs: number
  ms?: number
  error?: string
}
type Lock = {
  id: number
  name: string
  path: string
  caller: string
  operation: string
  startMs: number
  acquiredMs?: number
  releaseStartMs?: number
  releasedMs?: number
  ownerId?: string
  contended?: boolean
  error?: string
  overlaps: number[]
  previous?: number
  markerAttempts: number
  markerBlockedStartMs?: number
  markerBlockedMs?: number
}
type Marker = {
  event: 'created' | 'blocked'
  lock?: number
  phase?: string
  path: string
  atMs: number
  ownerId?: string
  sameProcess?: boolean
  error?: string
}

const round = (ms: number) => Math.round(ms * 10) / 10
const errorCode = (error: unknown) => {
  const detail = error as { code?: string; win32Code?: number }
  return detail?.win32Code === 80 || detail?.win32Code === 183
    ? 'EEXIST'
    : String(detail?.code ?? 'error')
}

/** Observe real I/O only; never change a lease, timer, durability option or result. */
export class AnchorLockTrace {
  readonly phases: Phase[] = []
  readonly locks: Lock[] = []
  readonly markers: Marker[] = []
  private readonly context = new AsyncLocalStorage<Scope>()
  private readonly restores: Array<() => void> = []
  private readonly ownerIds = new Set<string>()
  private readonly started = performance.now()
  private readonly timer: ReturnType<typeof setTimeout>
  private failed = false
  private readonly readFile = promises.readFile

  constructor(
    private readonly test: string,
    private readonly options: { beforeSync?: () => Promise<void> } = {},
  ) {
    // Emit pending spans before Bun's five-second test timeout, not only after a hung release.
    this.timer = setTimeout(() => this.print('exceeded 2000 ms'), 2_000)
    this.timer.unref()
  }

  private now() {
    return performance.now() - this.started
  }

  async phase<T>(phase: string, work: () => Promise<T>): Promise<T> {
    return this.context.run({ operation: phase }, () =>
      this.measure(phase, undefined, work),
    )
  }

  async run(work: () => Promise<void>) {
    try {
      await work()
    } catch (error) {
      this.failed = true
      this.print('failed')
      throw error
    }
  }

  private async measure<T>(
    phase: string,
    path: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const row: Phase = {
      ...this.context.getStore(),
      operation: this.context.getStore()?.operation ?? 'background',
      phase,
      path,
      startMs: this.now(),
    }
    this.phases.push(row)
    try {
      return await work()
    } catch (error) {
      row.error = errorCode(error)
      throw error
    } finally {
      row.ms = this.now() - row.startMs
    }
  }

  private ownerWrite(path: string, bytes: unknown) {
    if (!/\.lock(?:\.evicting[/\\]owner\.json)?$/.test(path)) return
    try {
      const { ownerId } = JSON.parse(String(bytes)) as { ownerId?: string }
      if (ownerId) {
        this.ownerIds.add(ownerId)
        if (path.endsWith('owner.json')) {
          const scope = this.context.getStore()
          this.markers.push({
            event: 'created',
            lock: scope?.lock,
            phase: scope?.phase,
            path: dirname(path),
            atMs: this.now(),
            ownerId,
            sameProcess: true,
          })
        }
      }
    } catch {
      // Only lease metadata is inspected; account bytes are never recorded.
    }
  }

  private async markerAttempt<T>(path: string, work: () => Promise<T>) {
    const scope = this.context.getStore()
    const lock = scope?.lock === undefined ? undefined : this.locks[scope.lock]
    if (scope?.phase === 'release' && lock) lock.markerAttempts++
    try {
      const result = await work()
      if (
        scope?.phase === 'release' &&
        lock?.markerBlockedStartMs !== undefined
      )
        lock.markerBlockedMs = this.now() - lock.markerBlockedStartMs
      return result
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        if (scope?.phase === 'release' && lock)
          lock.markerBlockedStartMs ??= this.now()
        const marker: Marker = {
          event: 'blocked',
          lock: scope?.lock,
          phase: scope?.phase,
          path,
          atMs: this.now(),
        }
        this.markers.push(marker)
        // POSIX release does not read a colliding marker's owner. This extra,
        // diagnostic-only read distinguishes our own contender from another PID.
        try {
          const text = await this.measure('marker:owner-read', path, () =>
            this.readFile(join(path, 'owner.json'), 'utf8'),
          )
          const owner = JSON.parse(text) as { ownerId?: string }
          marker.ownerId = owner.ownerId
          marker.sameProcess = owner.ownerId
            ? this.ownerIds.has(owner.ownerId)
            : undefined
        } catch (readError) {
          marker.error = errorCode(readError)
        }
      }
      throw error
    }
  }

  async install() {
    await loadVerifiedStoreModules()
    const root = dirname(
      dirname(
        Bun.resolveSync(
          '@cortexkit/antigravity-auth-core/common-auth/store',
          import.meta.dir,
        ),
      ),
    )
    const lockApi = (await import(
      pathToFileURL(join(root, 'fs/refresh-file-lock.js')).href
    )) as LockModule
    const acquire = lockApi.acquireRefreshFileLock
    const acquisitionSpy = spyOn(lockApi, 'acquireRefreshFileLock')
    this.restores.push(() => acquisitionSpy.mockRestore())
    acquisitionSpy.mockImplementation(async (options) => {
      const path = `${options.path}.${options.name}.lock`
      const previous = this.locks.findLast((lock) => lock.path === path)
      const row: Lock = {
        id: this.locks.length,
        name: options.name,
        path,
        operation: this.context.getStore()?.operation ?? 'background',
        caller: new Error().stack?.split('\n').slice(2, 10).join('\n') ?? '',
        startMs: this.now(),
        overlaps: this.locks
          .filter((lock) => lock.path === path && lock.releasedMs === undefined)
          .map((lock) => lock.id),
        previous: previous?.id,
        markerAttempts: 0,
      }
      this.locks.push(row)
      const scope = { operation: row.operation, lock: row.id, phase: 'acquire' }
      return this.context.run(scope, async () => {
        const lock = await this.measure('lock:acquire', path, () =>
          acquire({
            ...options,
            onStep: async (step) => {
              await this.measure(`lock:step:${step}`, path, () =>
                options.onStep?.(step),
              )
            },
          }),
        ).catch((error: unknown) => {
          row.error = errorCode(error)
          row.releasedMs = this.now()
          throw error
        })
        if (!lock) {
          row.contended = true
          row.releasedMs = this.now()
          return lock
        }
        row.acquiredMs = this.now()
        row.ownerId = lock.ownerId
        this.ownerIds.add(lock.ownerId)
        scope.phase = 'hold'
        const release = lock.release.bind(lock)
        lock.release = () => {
          row.releaseStartMs = this.now()
          return this.context.run({ ...scope, phase: 'release' }, async () => {
            try {
              await this.measure('lock:release', path, release)
            } finally {
              row.releasedMs = this.now()
            }
          })
        }
        return lock
      })
    })

    this.observe(promises, ['open', 'mkdir', 'rename', 'rm', 'readFile'])
    const backendPath = Bun.resolveSync('@cortexkit/private-files', root)
    const backend = (await import(pathToFileURL(backendPath).href)) as object
    this.observe(backend, [
      'createPrivateFile',
      'createOwnerOnly',
      'verifySafeParent',
      'verifyOwnerOnly',
      'verifyPrivatePath',
      'securePrivatePath',
      'readOwnerOnly',
    ])
  }

  private observe(api: object, names: string[]) {
    // The same recorder wraps several unrelated async filesystem APIs. Keep
    // their argument lists opaque and forward the original receiver and values.
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
        const invoke = () =>
          this.measure(`io:${name}`, path, () =>
            Reflect.apply(original, api, args),
          )
        const result = await ((name === 'mkdir' ||
          name === 'createOwnerOnly') &&
        path.endsWith('.lock.evicting')
          ? this.markerAttempt(path, invoke)
          : invoke())
        if (name === 'createPrivateFile') this.ownerWrite(path, args[1])
        if (name !== 'open' || !result || typeof result !== 'object')
          return result
        return new Proxy(result, {
          get: (target, key) => {
            const value: unknown = Reflect.get(target, key, target)
            if (typeof value !== 'function') return value
            if (
              !['sync', 'datasync', 'writeFile', 'chmod', 'close'].includes(
                String(key),
              )
            )
              return value.bind(target)
            return (...values: unknown[]) =>
              this.measure(`handle:${String(key)}`, path, async () => {
                if (key === 'sync') await this.options.beforeSync?.()
                const outcome: unknown = await Reflect.apply(
                  value,
                  target,
                  values,
                )
                if (key === 'writeFile') this.ownerWrite(path, values[0])
                return outcome
              })
          },
        })
      })
    }
  }

  print(reason: string) {
    const elapsed = this.now()
    console.error(
      JSON.stringify({
        anchorPhaseTable: this.test,
        reason,
        pid: process.pid,
        elapsedMs: round(elapsed),
        nativeGranularity:
          'On Windows io:createPrivateFile includes native DACL verification, write and FlushFileBuffers; the addon exposes no separate subphase hooks.',
        locks: this.locks.map((lock) => ({
          ...lock,
          acquireMs: round(
            (lock.acquiredMs ?? lock.releasedMs ?? elapsed) - lock.startMs,
          ),
          holdMs:
            lock.acquiredMs === undefined
              ? undefined
              : round((lock.releaseStartMs ?? elapsed) - lock.acquiredMs),
          releaseMs:
            lock.releaseStartMs === undefined
              ? undefined
              : round((lock.releasedMs ?? elapsed) - lock.releaseStartMs),
          markerBlockedMs:
            lock.markerBlockedStartMs === undefined
              ? 0
              : round(
                  lock.markerBlockedMs ??
                    (lock.releasedMs ?? elapsed) - lock.markerBlockedStartMs,
                ),
        })),
        markers: this.markers,
        phases: this.phases.map((phase) => ({
          ...phase,
          startMs: round(phase.startMs),
          ms: round(phase.ms ?? elapsed - phase.startMs),
          pending: phase.ms === undefined,
        })),
      }),
    )
  }

  stop() {
    clearTimeout(this.timer)
    if (this.failed || this.now() >= 2_000) this.print('settled')
    for (const restore of this.restores.reverse()) restore()
  }
}
