import { AccountManager } from './accounts'
import { isOAuthAuth } from './auth'
import {
  buildAuthFromStoredAccount,
  detectAuthStorageDrift,
} from './auth-drift'
import type { AntigravityConfig } from './config'
import { getLogFilePath, isDebugEnabled } from './debug'
import type { PluginLifecycle } from './lifecycle'
import { createLogger } from './logger'
import {
  createProactiveRefreshQueue,
  type ProactiveRefreshQueue,
} from './refresh-queue'
import { clearAccounts, loadAccounts } from './storage'
import type { GetAuth, LoaderResult, PluginClient, PluginResult } from './types'

const log = createLogger('auth-loader')

export interface AuthFetchRuntime {
  fetch: LoaderResult['fetch']
  dispose(): Promise<void> | void
}

export type CreateAuthFetch = (input: {
  accountManager: AccountManager
  getAuth: GetAuth
}) => AuthFetchRuntime

interface AuthLoaderDependencies {
  loadAccounts: typeof loadAccounts
  clearAccounts: typeof clearAccounts
  loadAccountManager(
    auth: Parameters<typeof AccountManager.loadFromDisk>[0],
  ): Promise<AccountManager>
  createRefreshQueue: typeof createProactiveRefreshQueue
  isDebugEnabled: typeof isDebugEnabled
  getLogFilePath: typeof getLogFilePath
}

interface CreateAuthLoaderOptions {
  client: PluginClient
  providerId: string
  config: AntigravityConfig
  lifecycle: PluginLifecycle
  createFetch: CreateAuthFetch
  onGetAuth?(getAuth: GetAuth): void
  dependencies?: Partial<AuthLoaderDependencies>
}

export function createAuthLoader({
  client,
  providerId,
  config,
  lifecycle,
  createFetch,
  onGetAuth,
  dependencies,
}: CreateAuthLoaderOptions): PluginResult['auth']['loader'] {
  const deps: AuthLoaderDependencies = {
    loadAccounts: dependencies?.loadAccounts ?? loadAccounts,
    clearAccounts: dependencies?.clearAccounts ?? clearAccounts,
    loadAccountManager:
      dependencies?.loadAccountManager ??
      ((auth) => AccountManager.loadFromDisk(auth)),
    createRefreshQueue:
      dependencies?.createRefreshQueue ?? createProactiveRefreshQueue,
    isDebugEnabled: dependencies?.isDebugEnabled ?? isDebugEnabled,
    getLogFilePath: dependencies?.getLogFilePath ?? getLogFilePath,
  }
  let fetchRuntime: AuthFetchRuntime | null = null

  lifecycle.register({
    async dispose() {
      const runtime = fetchRuntime
      fetchRuntime = null
      await runtime?.dispose()
    },
  })

  return async (getAuth, provider) => {
    onGetAuth?.(getAuth)
    let auth = await getAuth()

    if (!isOAuthAuth(auth)) {
      const storedAccounts = await deps.loadAccounts()
      const drift = detectAuthStorageDrift(auth, storedAccounts)
      if (drift.status === 'restorable' && drift.account) {
        auth = buildAuthFromStoredAccount(drift.account)
        try {
          await client.auth.set({
            path: { id: providerId },
            body: {
              type: 'oauth',
              refresh: auth.refresh,
              access: auth.access ?? '',
              expires: auth.expires ?? 0,
            },
          })
          log.info('Restored Antigravity OAuth auth from account storage', {
            reason: drift.reason,
            email: drift.account.email,
          })
        } catch (error) {
          log.warn(
            'Failed to restore Antigravity OAuth auth from account storage',
            { error: String(error) },
          )
        }
      }
    }

    if (!isOAuthAuth(auth)) {
      try {
        await deps.clearAccounts()
      } catch {}
      return {}
    }

    const accountManager = await deps.loadAccountManager(auth)
    if (accountManager.getAccountCount() > 0) {
      accountManager.requestSaveToDisk()
    }

    let refreshQueue: ProactiveRefreshQueue | null = null
    if (
      config.proactive_token_refresh &&
      accountManager.getAccountCount() > 0
    ) {
      refreshQueue = deps.createRefreshQueue(client, providerId, {
        enabled: config.proactive_token_refresh,
        bufferSeconds: config.proactive_refresh_buffer_seconds,
        checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
      })
      refreshQueue.setAccountManager(accountManager)
    }

    await lifecycle.replaceAccountRuntime(accountManager, refreshQueue)
    refreshQueue?.start()

    const previousRuntime = fetchRuntime
    fetchRuntime = createFetch({ accountManager, getAuth })
    await previousRuntime?.dispose()

    if (deps.isDebugEnabled()) {
      const logPath = deps.getLogFilePath()
      if (logPath) {
        try {
          await client.tui.showToast({
            body: { message: `Debug log: ${logPath}`, variant: 'info' },
          })
        } catch {}
      }
    }

    if (provider.models) {
      for (const model of Object.values(provider.models)) {
        if (model) model.cost = { input: 0, output: 0 }
      }
    }

    return {
      apiKey: '',
      fetch: fetchRuntime.fetch,
    }
  }
}
