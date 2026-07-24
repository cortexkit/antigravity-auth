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

export interface PluginLifecycle extends Disposable {
  getAccountManager(): AccountManager | null
  replaceAccountRuntime(
    manager: AccountManager,
    refreshQueue: ProactiveRefreshQueue | null,
  ): Promise<void>
  register(disposable: Disposable, phase?: LifecyclePhase): void
}

const NOOP_DRAIN = async (): Promise<void> => {}

export function createPluginLifecycle(
  options: PluginLifecycleOptions,
): PluginLifecycle {
  let accountManager: AccountManager | null = null
  let refreshQueue: ProactiveRefreshQueue | null = null
  let disposal: Promise<void> | null = null
  const producers: Disposable[] = []
  const consumers: Disposable[] = []
  const drainSidebarWrites = options.drainSidebarWrites ?? NOOP_DRAIN

  const disposeAccountRuntime = async (): Promise<void> => {
    const oldQueue = refreshQueue
    const oldManager = accountManager
    refreshQueue = null
    accountManager = null

    await oldQueue?.dispose()
    await oldManager?.dispose()
  }

  const register = (
    disposable: Disposable,
    phase: LifecyclePhase = 'consumer',
  ): void => {
    if (disposal) {
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
    async replaceAccountRuntime(manager, queue) {
      await disposeAccountRuntime()
      if (disposal) {
        await queue?.dispose()
        await manager.dispose()
        return
      }
      accountManager = manager
      refreshQueue = queue
    },
    register,
    dispose() {
      if (!disposal) {
        disposal = (async () => {
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
        })()
      }
      return disposal
    },
  }
}
