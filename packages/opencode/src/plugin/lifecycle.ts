import type { AccountManager } from './accounts'
import type { ProactiveRefreshQueue } from './refresh-queue'

export interface Disposable {
  dispose(): Promise<void> | void
}

/**
 * Lifecycle phase for a registered disposable.
 *
 * - `producer`: runs on the same side of the sidebar drain as the
 *   fetch interceptor — the lifecycle disposes producers BEFORE the
 *   sidebar drain so a producer racing with shutdown cannot enqueue
 *   a write that lands after the drain asserts the queue is empty.
 * - `consumer`: runs AFTER the sidebar drain. These are the sinks
 *   (RPC server, file logger) that the TUI / host talk to and that
 *   must stay alive until every queued write has landed.
 */
export type LifecyclePhase = 'producer' | 'consumer'

export interface PluginLifecycleOptions {
  sessionRegistry: { clear(): void }
  shutdownDiskSignatureCache: () => Promise<void>
  clearFetchState: () => void
  /**
   * Optional drain hook for in-flight sidebar-state writes. Lifecycle
   * awaits this AFTER producers are disposed but BEFORE consumers are
   * disposed, so:
   *   1. producers have stopped (no new writes can land)
   *   2. every queued write has flushed
   *   3. the file logger + RPC server are still alive
   */
  drainSidebarWrites?: () => Promise<void>
}

/**
 * The request runtime serving an account manager. When its manager is
 * replaced it is retired: it refuses new requests and keeps the ones it
 * already admitted, so the manager they use stays open until they finish.
 */
export interface AccountRequestRuntime {
  /** Refuses new requests; resolves once admitted requests have finished. */
  retire(): Promise<void>
  /** Aborts admitted requests; resolves once they have finished. */
  dispose(): Promise<void> | void
}

export interface PluginLifecycle extends Disposable {
  getAccountManager(): AccountManager | null
  /** True from the start of final shutdown, before any disposal hook runs. */
  isClosing(): boolean
  /**
   * Publishes `manager` as the account manager and `requests` as the runtime
   * serving it. The previous refresh queue stops at once, and the
   * replacement waits for a refresh it already has under way. When the
   * previous manager had no request runtime it is then disposed before the
   * replacement is published; otherwise that runtime is retired and the
   * manager is disposed only after both the refresh and the retirement have
   * finished. Final disposal aborts and awaits such a retirement. Resolves
   * `false`, disposing everything offered, once the lifecycle is disposing.
   */
  replaceAccountRuntime(
    manager: AccountManager,
    refreshQueue: ProactiveRefreshQueue | null,
    requests?: AccountRequestRuntime | null,
  ): Promise<boolean>
  register(disposable: Disposable, phase?: LifecyclePhase): void
}

const NOOP_DRAIN = async (): Promise<void> => {}

export function createPluginLifecycle(
  options: PluginLifecycleOptions,
): PluginLifecycle {
  let accountManager: AccountManager | null = null
  let refreshQueue: ProactiveRefreshQueue | null = null
  let accountRequests: AccountRequestRuntime | null = null
  // Replaced account runtimes still being wound down. Each record owns the
  // replaced manager until both its refresh queue has finished any refresh
  // already under way and its request runtime (when it has one) has finished
  // admitted requests; only then is the manager disposed. Records stay here
  // for that whole time so final disposal can abort and await them.
  const retiring = new Set<{
    requests: AccountRequestRuntime | null
    done: Promise<void>
  }>()
  let disposal: Promise<void> | null = null
  let closing = false
  const producers: Disposable[] = []
  const consumers: Disposable[] = []
  const drainSidebarWrites = options.drainSidebarWrites ?? NOOP_DRAIN

  /**
   * Starts winding down a replaced runtime. The queue's timers stop at once;
   * `queueDrained` settles once its refresh in progress has finished, `done`
   * once the manager has been disposed after both drains.
   */
  const retire = (
    manager: AccountManager,
    queue: ProactiveRefreshQueue | null,
    requests: AccountRequestRuntime | null,
  ): { queueDrained: Promise<void>; done: Promise<void> } => {
    const queueDrained = Promise.resolve(queue?.dispose())
    const record = {
      requests,
      done: (async () => {
        const drained = await Promise.allSettled([
          queueDrained,
          requests?.retire(),
        ])
        await manager.dispose()
        const failed = drained.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected',
        )
        if (failed) throw failed.reason
      })(),
    }
    retiring.add(record)
    // A finished record is forgotten. A failed one stays for final disposal
    // to report, unless no request runtime kept it running in the background:
    // then the replacement awaited it and has already reported the failure.
    record.done.then(
      () => retiring.delete(record),
      () => {
        if (!requests) retiring.delete(record)
      },
    )
    void queueDrained.catch(() => {})
    return { queueDrained, done: record.done }
  }

  const disposeAccountRuntime = async (): Promise<void> => {
    const oldQueue = refreshQueue
    const oldManager = accountManager
    const oldRequests = accountRequests
    refreshQueue = null
    accountManager = null
    accountRequests = null

    // Abort the physical I/O of the live runtime and of every retired one,
    // and stop the live refresh queue at the same moment so it starts no
    // new refresh while that I/O drains. Every manager is disposed only
    // after the runtimes and queues using it have finished.
    const retired = [...retiring]
    retiring.clear()
    const aborted = Promise.all([
      oldRequests?.dispose(),
      ...retired.map((record) => record.requests?.dispose()),
    ])
    const liveQueueDrained = Promise.resolve(oldQueue?.dispose())
    void liveQueueDrained.catch(() => {})
    await aborted
    const retirements = await Promise.allSettled(
      retired.map((record) => record.done),
    )
    await liveQueueDrained
    await oldManager?.dispose()
    const failed = retirements.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    )
    if (failed) throw failed.reason
  }

  const register = (
    disposable: Disposable,
    phase: LifecyclePhase = 'consumer',
  ): void => {
    if (closing) {
      void disposable.dispose()
      return
    }
    if (phase === 'producer') {
      producers.push(disposable)
    } else {
      consumers.push(disposable)
    }
  }

  return {
    getAccountManager: () => accountManager,
    isClosing: () => closing,
    async replaceAccountRuntime(manager, queue, requests = null) {
      if (!closing) {
        const oldQueue = refreshQueue
        const oldManager = accountManager
        const oldRequests = accountRequests
        refreshQueue = null
        accountManager = null
        accountRequests = null
        if (oldManager) {
          const retirement = retire(oldManager, oldQueue, oldRequests)
          // Without a request runtime nothing is left running for the old
          // manager, so it is disposed before the replacement is published.
          await (oldRequests ? retirement.queueDrained : retirement.done)
        } else {
          await oldQueue?.dispose()
        }
      }
      if (closing) {
        await requests?.dispose()
        await queue?.dispose()
        await manager.dispose()
        return false
      }
      accountManager = manager
      refreshQueue = queue
      accountRequests = requests
      return true
    },
    register,
    dispose() {
      if (!disposal) {
        // Hooks can synchronously reenter admission or disposal. Publish both
        // closing and the shared completion promise before invoking any hook.
        closing = true
        let finishDisposal: () => void = () => {}
        let failDisposal: (error: unknown) => void = () => {}
        disposal = new Promise<void>((resolve, reject) => {
          finishDisposal = resolve
          failDisposal = reject
        })
        void (async () => {
          await disposeAccountRuntime()
          await options.shutdownDiskSignatureCache()
          options.sessionRegistry.clear()
          options.clearFetchState()
          // 1. Stop and await all producers (e.g. fetch interceptor).
          //    This prevents NEW sidebar writes from being enqueued
          //    while the drain is in flight.
          for (const disposable of producers) {
            await disposable.dispose()
          }
          producers.length = 0
          // 2. Drain sidebar writes. Every write enqueued by a now-stopped
          //    producer lands here before the consumers (RPC server, file
          //    logger) are torn down.
          await drainSidebarWrites()
          // 3. Stop consumers. The TUI's last frame can still observe a
          //    fully landed snapshot because the file logger is still alive
          //    during the drain.
          for (const disposable of consumers) {
            await disposable.dispose()
          }
          consumers.length = 0
        })().then(finishDisposal, failDisposal)
      }
      return disposal
    },
  }
}
