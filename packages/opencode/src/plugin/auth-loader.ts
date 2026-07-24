import { createHash } from 'node:crypto'
import {
  buildSidebarMachineStateFromAccounts,
  setSidebarMachineState,
} from '../sidebar-state'
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
import {
  AccountStorageUnreadableError,
  clearAccounts,
  loadAccounts,
} from './storage'
import type {
  GetAuth,
  LoaderResult,
  PluginClient,
  Provider,
  ProviderModel,
} from './types'

const log = createLogger('auth-loader')

/**
 * Opaque identity derived from a refresh token. Mirrors the local
 * helper in `account-manager.ts` and `command-data.ts` — the auth-loader
 * stays independent because it ships in the plugin's import graph and
 * can't reach into the core barrel for `quotaAccountIdentity`. The
 * sidebar projection uses this hash to detect a stale quota snapshot
 * captured for a different account after an index shift.
 */
function refreshTokenIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

export interface AuthFetchRuntime {
  fetch: LoaderResult['fetch']
  dispose(): Promise<void> | void
}

export type CreateAuthFetch = (input: {
  accountManager: AccountManager
  getAuth: GetAuth
}) => AuthFetchRuntime

/**
 * Loader returned by `createAuthLoader`. The function loads the
 * account pool from disk and installs the runtime.
 */
export type LoadAndInstallRuntime = (
  getAuth: GetAuth,
  provider: Provider,
) => Promise<LoaderResult | Record<string, unknown>>

/**
 * Reload the live AccountManager + fetch runtime without going through
 * the full startup loader. Used by the OAuth add flow so the new account
 * is visible to routing immediately after `persistAccountPool`.
 */
export type ReloadAccountRuntime = (getAuth: GetAuth) => Promise<void>

export interface AuthLoaderHandle {
  load: LoadAndInstallRuntime
  reload: ReloadAccountRuntime
}

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
}: CreateAuthLoaderOptions): LoadAndInstallRuntime & AuthLoaderHandle {
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
  // Reload chain — `installRuntime` swaps the fetch runtime and
  // (previously) discarded the previous runtime's dispose with `void`,
  // so two overlapping reloads could interleave teardown. Serialize
  // reloads through a single shared promise so each new install waits
  // for the previous one to fully settle (including its dispose)
  // before tearing down the runtime it depends on.
  let reloadChain: Promise<void> = Promise.resolve()

  lifecycle.register(
    {
      async dispose() {
        const runtime = fetchRuntime
        fetchRuntime = null
        await runtime?.dispose()
      },
    },
    'producer',
  )

  // Reload hook: invoked after out-of-band storage mutations (e.g.
  // OAuth add) so the live AccountManager + fetch interceptor see the
  // newly-persisted account without waiting for a plugin restart. The
  // handle returned below wires this through to the OAuth finish flow.
  let reloadRuntime: ReloadAccountRuntime = async () => {}

  const installRuntime = async (
    accountManager: AccountManager,
    getAuth: GetAuth,
  ): Promise<void> => {
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

    // Swap the fetch runtime FIRST so the host's captured fetch
    // reference (a call-time delegating wrapper below) immediately
    // routes through the new interceptor, then await the previous
    // runtime's dispose. The swap-then-dispose order guarantees there
    // is no fetch gap between the old and new runtimes.
    const previousRuntime = fetchRuntime
    fetchRuntime = createFetch({ accountManager, getAuth })
    await previousRuntime?.dispose()

    // Push the freshly materialized account pool into the sidebar so the
    // TUI's next poll renders the labels / health / cooldown it needs
    // without waiting for the first fetch to complete.
    await setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(
        accountManager.getAccounts().map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          current: false,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          // Stamp the sidebar snapshot so the projection can detect a
          // stale cache that landed on the wrong account (the manager's
          // `cachedQuotaAccountId` is keyed to whatever account actually
          // produced the snapshot — the live refresh-token hash is the
          // expected identity at this slot).
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          currentQuotaAccountId: refreshTokenIdentity(entry.parts.refreshToken),
        })),
      ),
    )
  }

  async function runLoader(
    getAuth: GetAuth,
    provider: Provider,
  ): Promise<LoaderResult | Record<string, unknown>> {
    onGetAuth?.(getAuth)
    let auth = await getAuth()

    if (!isOAuthAuth(auth)) {
      let storedAccounts: Awaited<ReturnType<typeof loadAccounts>>
      try {
        storedAccounts = await deps.loadAccounts()
      } catch (error) {
        // Fail closed: do NOT proceed with `clearAccounts()` (which
        // would destroy a recoverable corrupt file) and do NOT
        // fabricate an empty pool. Surface the unreadable error so
        // the caller can prompt the user to repair or remove the
        // file. Backup path + reason are carried in `error.details`.
        if (error instanceof AccountStorageUnreadableError) {
          log.error('Refusing to start: account storage is unreadable', {
            path: error.details.path,
            reason: error.details.reason,
            backupPath: error.details.backupPath,
          })
          try {
            await client.tui.showToast({
              body: {
                message: `Account storage at ${error.details.path} is unreadable (${error.details.reason}). The plugin will not start until the file is repaired or removed.${error.details.backupPath ? ` A backup was written to ${error.details.backupPath}.` : ''}`,
                variant: 'error',
                duration: 30_000,
              },
            })
          } catch {}
        }
        throw error
      }
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
    await installRuntime(accountManager, getAuth)

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
        if (model) (model as ProviderModel).cost = { input: 0, output: 0 }
      }
    }

    return {
      apiKey: '',
      // Return a stable delegating wrapper that reads `fetchRuntime`
      // at CALL time. A direct `fetchRuntime!.fetch` reference would
      // capture the current runtime; the host keeps that reference
      // across `reload()` calls, so a captured fetch would still route
      // through the OLD interceptor after an OAuth add. The wrapper
      // matches the host's `LoaderResult.fetch` signature exactly
      // (no `this` binding) so behavior is preserved.
      fetch: (input, init) => fetchRuntime!.fetch(input, init),
    }
  }

  reloadRuntime = async (getAuth: GetAuth): Promise<void> => {
    const auth = await getAuth()
    if (!isOAuthAuth(auth)) return
    const nextManager = await deps.loadAccountManager(auth)
    await installRuntime(nextManager, getAuth)
  }

  // Return a callable object: `plugin.auth.loader` is invoked with
  // `(getAuth, provider)` (host contract), and `authLoader.reload(...)`
  // rebuilds the runtime after out-of-band storage mutations (OAuth add).
  // The callable closes over `runLoader` directly so the `this`-context
  // binding stays unbound.
  async function authLoaderCallable(
    getAuth: GetAuth,
    provider: Provider,
  ): Promise<LoaderResult | Record<string, unknown>> {
    return runLoader(getAuth, provider)
  }
  async function reload(getAuth: GetAuth): Promise<void> {
    const next = reloadChain.then(() => reloadRuntime(getAuth))
    reloadChain = next.catch(() => {})
    return next
  }
  // `load` mirrors the authLoaderCallable so the public handle
  // (`AuthLoaderHandle.load`) exposes the same entry point the host
  // invokes. Without this assignment, contract consumers read
  // `.load` as undefined and the documented type would lie.
  const authLoader = Object.assign(authLoaderCallable, {
    reload,
    load: authLoaderCallable,
  })
  return authLoader as LoadAndInstallRuntime & AuthLoaderHandle
}
