import type { AccountManager } from './accounts'
import type { ProactiveRefreshQueue } from './refresh-queue'

export interface Disposable {
  dispose(): Promise<void> | void
}

export interface PluginLifecycleOptions {
  sessionRegistry: { clear(): void }
  shutdownDiskSignatureCache: () => Promise<void>
  clearFetchState: () => void
}

export interface PluginLifecycle extends Disposable {
  getAccountManager(): AccountManager | null
  replaceAccountRuntime(
    manager: AccountManager,
    refreshQueue: ProactiveRefreshQueue | null,
  ): Promise<void>
  register(disposable: Disposable): void
}

export function createPluginLifecycle(
  options: PluginLifecycleOptions,
): PluginLifecycle {
  let accountManager: AccountManager | null = null
  let refreshQueue: ProactiveRefreshQueue | null = null
  let disposal: Promise<void> | null = null
  const registered: Disposable[] = []

  const disposeAccountRuntime = async (): Promise<void> => {
    const oldQueue = refreshQueue
    const oldManager = accountManager
    refreshQueue = null
    accountManager = null

    await oldQueue?.dispose()
    await oldManager?.dispose()
  }

  const register = (disposable: Disposable): void => {
    if (disposal) {
      void disposable.dispose()
      return
    }
    registered.push(disposable)
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
          for (const disposable of registered) {
            await disposable.dispose()
          }
          registered.length = 0
        })()
      }
      return disposal
    },
  }
}
