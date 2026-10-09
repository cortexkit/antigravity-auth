import { createHash } from 'node:crypto'
import {
  type AccountManager as CoreAccountManager,
  createAccountRepositoryFactory,
  getHealthTracker,
  loadCommonAuthStoreModules,
} from '@cortexkit/antigravity-auth-core'
import {
  buildSidebarMachineStateFromAccounts,
  isAccountCurrent,
  setSidebarMachineState,
  toCapturedTier,
} from '../sidebar-state'
import {
  AccountManager,
  createLocalAccountCredentials,
  loadAccountManagerFromRepository,
} from './accounts'
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
  createLocationProactiveRefreshQueue,
  createProactiveRefreshQueue,
  type ProactiveRefreshQueue,
} from './refresh-queue'
import {
  AccountStorageUnreadableError,
  type AccountStoreOpening,
  clearAccounts,
  initializeFreshAccountStoreFor,
  loadAccounts,
  openAccountStore,
} from './storage'
import { createAntigravityTokenExchange } from './token'
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

/**
 * The account manager request routing uses for this plugin's account pool:
 * the pool-file manager until that pool is migrated to the account store,
 * then the core manager whose accounts come from the store's repository.
 */
export type RuntimeAccountManager = AccountManager | CoreAccountManager

export type CreateAuthFetch = (input: {
  accountManager: RuntimeAccountManager
  getAuth: GetAuth
  /**
   * Where `accountManager`'s accounts come from: the pool file, or the
   * account store through the repository of the same opening the manager
   * was loaded from.
   */
  source:
    | { kind: 'pool-file' }
    | {
        kind: 'store'
        repository: Extract<
          AccountStoreOpening,
          { status: 'ready' }
        >['repository']
      }
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
  /**
   * This plugin's single opening of its account pool's store. OAuth
   * additions and account commands must use this same opening, so they
   * write through the very repository request routing reads.
   */
  accountStore(): Promise<AccountStoreOpening>
  /** Whether that opening leaves the pool file as the source of accounts. */
  usesPoolFile(opening: AccountStoreOpening): boolean
  /**
   * The explicit first-account step of a genuinely fresh installation: when
   * the plugin's account pool has neither a pool file nor a store
   * (`initialization-required`), creates an empty account store and opens
   * it, so the first login is admitted by the store rather than written to
   * a new pool file. Any other opening is returned unchanged; nothing is
   * initialized over an existing pool file or store.
   */
  initializeFreshStore(): Promise<AccountStoreOpening>
}

interface AuthLoaderDependencies {
  loadAccounts: typeof loadAccounts
  clearAccounts: typeof clearAccounts
  loadAccountManager(
    auth: Parameters<typeof AccountManager.loadFromDisk>[0],
  ): Promise<AccountManager>
  createRefreshQueue: typeof createProactiveRefreshQueue
  /** The proactive queue of a store-backed manager; see `installRuntime`. */
  createStoreRefreshQueue: typeof createLocationProactiveRefreshQueue
  /** Creates the empty store of a fresh installation. */
  initializeFreshStore(): Promise<{ status: string }>
  isDebugEnabled: typeof isDebugEnabled
  getLogFilePath: typeof getLogFilePath
  /**
   * Opens the account store (`openAccountStore`). The pool file is loaded
   * only while the migration has published no store pointer: nothing exists
   * yet (`initialization-required`) or only the pool file does
   * (`migration-required`). Once a pointer names a store generation, every
   * other answer (pending work, rollback, invalid journal or files) stops
   * the loader; it never falls back to the retired pool file.
   */
  openAccountStore(): Promise<AccountStoreOpening>
}

async function initializeDefaultFreshStore(): Promise<{ status: string }> {
  return initializeFreshAccountStoreFor(await loadCommonAuthStoreModules())
}

async function openDefaultAccountStore(): Promise<AccountStoreOpening> {
  const modules = await loadCommonAuthStoreModules()
  return openAccountStore({
    modules,
    createRepository: createAccountRepositoryFactory(modules),
    exchange: createAntigravityTokenExchange(),
  })
}

/**
 * Whether the pool file is still the source of the plugin's accounts: the
 * migration has published no store pointer (nothing exists yet, or only the
 * pool file does, awaiting the offline migration). Once a pointer names a
 * store generation, the pool file is never used again, whatever state that
 * store is in.
 */
function usesPoolFile(opening: AccountStoreOpening): boolean {
  return (
    opening.status === 'initialization-required' ||
    opening.status === 'migration-required'
  )
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
    createStoreRefreshQueue:
      dependencies?.createStoreRefreshQueue ??
      createLocationProactiveRefreshQueue,
    initializeFreshStore:
      dependencies?.initializeFreshStore ?? initializeDefaultFreshStore,
    isDebugEnabled: dependencies?.isDebugEnabled ?? isDebugEnabled,
    getLogFilePath: dependencies?.getLogFilePath ?? getLogFilePath,
    openAccountStore: dependencies?.openAccountStore ?? openDefaultAccountStore,
  }
  // The account store is opened once per plugin; reloads read the same
  // repository again, and it is closed with the plugin.
  let storeOpening: Promise<AccountStoreOpening> | null = null
  const openStore = (): Promise<AccountStoreOpening> => {
    storeOpening ??= deps.openAccountStore().then((opening) => {
      if (opening.status === 'ready') {
        lifecycle.register({
          async dispose() {
            await opening.repository.dispose()
          },
        })
      }
      return opening
    })
    return storeOpening
  }
  const initializeFreshStore = async (): Promise<AccountStoreOpening> => {
    const opening = await openStore()
    if (opening.status !== 'initialization-required') return opening
    const initialized = await deps.initializeFreshStore()
    if (initialized.status !== 'completed') {
      throw new Error(
        'The new account store could not be created yet; try again',
      )
    }
    storeOpening = null
    return openStore()
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
    accountManager: RuntimeAccountManager,
    getAuth: GetAuth,
    source: 'pool-file' | 'store',
  ): Promise<void> => {
    if (accountManager.getAccountCount() > 0) {
      accountManager.requestSaveToDisk()
    }

    // Proactive refresh. The pool-file queue refreshes through the host
    // client and writes the new token back into the pool-file record; for a
    // store-backed manager that would bypass the store, which accepts a new
    // token only from the repository's own refresh fenced on the row's
    // credential. So a store-backed manager gets its own queue whose
    // refresher is `createLocalAccountCredentials(manager).refresh`: each
    // due account is refreshed through the repository on that account's
    // RowRef, and the host client is never used.
    let refreshQueue: ProactiveRefreshQueue | null = null
    const queueConfig = {
      enabled: config.proactive_token_refresh,
      bufferSeconds: config.proactive_refresh_buffer_seconds,
      checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
    }
    if (
      config.proactive_token_refresh &&
      accountManager.getAccountCount() > 0
    ) {
      if (source === 'pool-file' && accountManager instanceof AccountManager) {
        refreshQueue = deps.createRefreshQueue(client, providerId, queueConfig)
        refreshQueue.setAccountManager(accountManager)
      } else if (source === 'store') {
        const opening = await openStore()
        if (opening.status !== 'ready') {
          throw new Error('the account store closed while it was in use')
        }
        const credentials = createLocalAccountCredentials(accountManager, {
          repository: opening.repository,
        })
        refreshQueue = deps.createStoreRefreshQueue(
          {
            logger: log,
            refreshToken: (_auth, account) => credentials.refresh(account),
          },
          queueConfig,
        )
        refreshQueue.setAccountManager(accountManager)
      }
    }

    await lifecycle.replaceAccountRuntime(accountManager, refreshQueue)
    refreshQueue?.start()

    // Swap the fetch runtime FIRST so the host's captured fetch
    // reference (a call-time delegating wrapper below) immediately
    // routes through the new interceptor, then await the previous
    // runtime's dispose. The swap-then-dispose order guarantees there
    // is no fetch gap between the old and new runtimes.
    const previousRuntime = fetchRuntime
    // A store-backed manager was loaded from this plugin's single store
    // opening; its fetch checks every send against that same repository.
    const opening = source === 'store' ? await openStore() : undefined
    if (opening !== undefined && opening.status !== 'ready') {
      throw new Error('the account store closed while it was in use')
    }
    fetchRuntime = createFetch({
      accountManager,
      getAuth,
      source:
        opening === undefined
          ? { kind: 'pool-file' }
          : { kind: 'store', repository: opening.repository },
    })
    await previousRuntime?.dispose()

    // Push the freshly materialized account pool into the sidebar so the
    // TUI's next poll renders the labels / health / cooldown it needs
    // without waiting for the first fetch to complete.
    await setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(
        accountManager.getAccounts().map((entry) => {
          const activeByFamily = accountManager.getActiveIndexByFamily()
          return {
            index: entry.index,
            label: entry.label,
            enabled: entry.enabled,
            current: isAccountCurrent(entry.index, activeByFamily),
            coolingDownUntil: entry.coolingDownUntil,
            healthScore: getHealthTracker().getScore(entry.index),
            cachedQuota: entry.cachedQuota,
            // Stamp the sidebar snapshot so the projection can detect a
            // stale cache that landed on the wrong account (the manager's
            // `cachedQuotaAccountId` is keyed to whatever account actually
            // produced the snapshot — the live refresh-token hash is the
            // expected identity at this slot).
            cachedQuotaAccountId: entry.cachedQuotaAccountId,
            currentQuotaAccountId: refreshTokenIdentity(
              entry.parts.refreshToken,
            ),
            tier: toCapturedTier(entry),
          }
        }),
      ),
    )
  }

  async function runLoader(
    getAuth: GetAuth,
    provider: Provider,
  ): Promise<LoaderResult | Record<string, unknown>> {
    onGetAuth?.(getAuth)
    let auth = await getAuth()

    const opening = await openStore()
    if (opening.status === 'ready') {
      // This plugin's account pool now comes only from the store's
      // repository; the retired pool file is never read or cleared here.
      if (!isOAuthAuth(auth)) {
        log.warn(
          'The host holds no Antigravity sign-in; the account store is left untouched',
        )
        return {}
      }
      const accountManager = await loadAccountManagerFromRepository(
        opening.repository,
      )
      await installRuntime(accountManager, getAuth, 'store')
      return finishLoad(provider)
    }
    if (!usesPoolFile(opening)) {
      const message =
        opening.status === 'refused' || opening.status === 'recovery-required'
          ? opening.message
          : 'The Antigravity account store cannot be opened'
      log.error('Refusing to start: the account store cannot serve', {
        message,
      })
      try {
        await client.tui.showToast({
          body: { message, variant: 'error', duration: 30_000 },
        })
      } catch {}
      throw new Error(message)
    }

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
    await installRuntime(accountManager, getAuth, 'pool-file')
    return finishLoad(provider)
  }

  async function finishLoad(
    provider: Provider,
  ): Promise<LoaderResult | Record<string, unknown>> {
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
    const opening = await openStore()
    if (opening.status === 'ready') {
      const nextManager = await loadAccountManagerFromRepository(
        opening.repository,
      )
      await installRuntime(nextManager, getAuth, 'store')
      return
    }
    if (!usesPoolFile(opening)) return
    const nextManager = await deps.loadAccountManager(auth)
    await installRuntime(nextManager, getAuth, 'pool-file')
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
    accountStore: openStore,
    usesPoolFile,
    initializeFreshStore,
  })
  return authLoader as LoadAndInstallRuntime & AuthLoaderHandle
}
