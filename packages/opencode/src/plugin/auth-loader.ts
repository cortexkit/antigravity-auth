import { createHash } from 'node:crypto'
import {
  type AccountManager as CoreAccountManager,
  createAccountRepositoryFactory,
  type EnrollmentAuthority,
  getHealthTracker,
  loadCommonAuthClaustrum,
  loadCommonAuthStoreModules,
  VAULT_ACCOUNT_REMEDY,
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
import type { FetchImpl } from './dependencies'
import type { PluginLifecycle } from './lifecycle'
import { createLogger } from './logger'
import {
  createLocationProactiveRefreshQueue,
  createProactiveRefreshQueue,
  type ProactiveRefreshQueue,
} from './refresh-queue'
import { isGenerativeLanguageRequest } from './request'
import {
  AccountStorageUnreadableError,
  type AccountStoreOpening,
  clearAccounts,
  initializeFreshAccountStoreFor,
  loadAccounts,
  openAccountStore,
  UNMIGRATED_ACCOUNT_MESSAGE,
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
 * The runtime of this plugin's own accounts. A reload retires the runtime it
 * replaces instead of disposing it: requests it already admitted keep
 * running on the account manager they started with, and that manager is
 * disposed only after they finish.
 */
export interface LocalFetchRuntime extends AuthFetchRuntime {
  /** Refuses new requests; resolves once admitted requests have finished. */
  retire(): Promise<void>
}

/**
 * Request routing uses the repository manager for an active account store.
 * The pool-file manager remains only for the fresh-install compatibility
 * path; an existing pool cannot serve before explicit offline migration.
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
}) => LocalFetchRuntime

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
   * Opens the account store (`openAccountStore`). An existing unmigrated pool
   * makes local requests unavailable without loading the pool. Pending work,
   * rollback, or invalid store files refuse rather than falling back to it.
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
 * A fresh installation may still obtain its first account. An existing pool
 * needs explicit offline migration before local accounts can be used; absence
 * of a store pointer is not permission to serve or update that pool.
 */
function usesPoolFile(opening: AccountStoreOpening): boolean {
  return opening.status === 'initialization-required'
}

async function fetchWithoutLocalAccounts(
  input: Parameters<LoaderResult['fetch']>[0],
  init: Parameters<LoaderResult['fetch']>[1],
  upstreamFetch: FetchImpl,
): Promise<Response> {
  if (!isGenerativeLanguageRequest(input)) return upstreamFetch(input, init)
  const callerSignal =
    init?.signal !== undefined
      ? init.signal
      : input instanceof Request
        ? input.signal
        : undefined
  callerSignal?.throwIfAborted()
  return Response.json(
    {
      error: {
        code: 412,
        status: 'FAILED_PRECONDITION',
        message: UNMIGRATED_ACCOUNT_MESSAGE,
      },
    },
    { status: 412 },
  )
}

interface CreateAuthLoaderOptions {
  publishSidebar?: () => Promise<void>
  client: PluginClient
  providerId: string
  config: AntigravityConfig
  lifecycle: PluginLifecycle
  createFetch: CreateAuthFetch
  fetchImpl?: FetchImpl
  readAuthority?: () => Promise<EnrollmentAuthority>
  createVaultFetch?: () => Promise<AuthFetchRuntime>
  onGetAuth?(getAuth: GetAuth): void
  dependencies?: Partial<AuthLoaderDependencies>
}

export function createAuthLoader({
  publishSidebar,
  client,
  providerId,
  config,
  lifecycle,
  createFetch,
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  readAuthority,
  createVaultFetch,
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
  let closed = false
  const isClosed = (): boolean => closed || lifecycle.isClosing()
  const assertOpen = (): void => {
    if (isClosed()) throw new Error('The account loader is disposed')
  }
  let fetchRuntime: LocalFetchRuntime | null = null
  let localUnavailable = false
  let vaultFetchRuntime: Promise<AuthFetchRuntime> | null = null
  let currentRequestSource: EnrollmentAuthority | undefined
  let latestGetAuth: GetAuth | undefined
  // The reload started by the first local request after vault custody (or
  // before any local runtime exists). Concurrent requests join it instead of
  // each installing a runtime of their own.
  let localRequestReload: Promise<void> | null = null
  // Reload chain — `installRuntime` swaps the fetch runtime and
  // overlapping reloads must not interleave the swap. Serialize
  // reloads through a single shared promise so each new install waits
  // for the previous one to settle before replacing the runtime it
  // installed.
  let reloadChain: Promise<void> = Promise.resolve()

  lifecycle.register(
    {
      async dispose() {
        closed = true
        await reloadChain
        // Every local runtime was handed to the lifecycle, which aborts and
        // drains it (and every retired one) before disposing their managers.
        fetchRuntime = null
        await (await vaultFetchRuntime?.catch(() => null))?.dispose()
        vaultFetchRuntime = null
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
    if (isClosed()) {
      await accountManager.dispose()
      throw new Error('The account loader is disposed')
    }
    currentRequestSource = 'local'
    localUnavailable = false
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
      ...(readAuthority && {
        mayRun: async () => (await readAuthority()) === 'local',
      }),
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
        if (isClosed()) {
          await accountManager.dispose()
          throw new Error('The account loader is disposed')
        }
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

    // A store-backed manager was loaded from this plugin's single store
    // opening; its fetch checks every send against that same repository.
    const opening = source === 'store' ? await openStore() : undefined
    if (isClosed() || (opening !== undefined && opening.status !== 'ready')) {
      await refreshQueue?.dispose()
      await accountManager.dispose()
      throw new Error(
        isClosed()
          ? 'The account loader is disposed'
          : 'the account store closed while it was in use',
      )
    }
    const nextRuntime = createFetch({
      accountManager,
      getAuth,
      source:
        opening === undefined
          ? { kind: 'pool-file' }
          : { kind: 'store', repository: opening.repository },
    })

    // Route new requests to the new runtime FIRST, so the host's captured
    // fetch (a call-time delegating wrapper below) never reaches a runtime
    // after it is retired. The lifecycle then retires the previous runtime:
    // it refuses new requests but finishes the ones it already admitted, and
    // its account manager is disposed only after they have finished.
    fetchRuntime = nextRuntime
    let published: boolean
    try {
      published = await lifecycle.replaceAccountRuntime(
        accountManager,
        refreshQueue,
        {
          retire: () => nextRuntime.retire(),
          // The lifecycle disposes a request runtime only while it is itself
          // disposing; stop admitting requests before their runtime aborts.
          dispose: async () => {
            closed = true
            await nextRuntime.dispose()
          },
        },
      )
    } catch (error) {
      // Nothing owns the new runtime when it was not published; close it
      // and leave no runtime to route to, rather than an untracked one.
      if (fetchRuntime === nextRuntime) fetchRuntime = null
      await nextRuntime.dispose()
      await refreshQueue?.dispose()
      await accountManager.dispose()
      throw error
    }
    if (!published) throw new Error('The account loader is disposed')
    assertOpen()
    refreshQueue?.start()

    // Push the freshly materialized account pool into the sidebar so the
    // TUI's next poll renders the labels / health / cooldown it needs
    // without waiting for the first fetch to complete.
    if (publishSidebar) await publishSidebar()
    else
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
              cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
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

  async function readLocalHostAuth(getAuth: GetAuth) {
    const auth = await getAuth()
    assertOpen()
    // After disconnect, the activation marker is not a local account.
    // Refuse before opening or repairing the pool; a real sign-in is required.
    const claustrum = await loadCommonAuthClaustrum()
    assertOpen()
    claustrum.assertHostSlotMatchesMode({
      mode: 'local',
      auth,
      provider: providerId,
    })
    return auth
  }

  async function runLoader(
    getAuth: GetAuth,
    provider: Provider,
  ): Promise<LoaderResult | Record<string, unknown>> {
    assertOpen()
    onGetAuth?.(getAuth)
    latestGetAuth = getAuth
    const authority = (await readAuthority?.()) ?? 'local'
    assertOpen()
    if (authority !== 'local') return finishLoad(provider)
    let auth = await readLocalHostAuth(getAuth)
    assertOpen()

    const opening = await openStore()
    assertOpen()
    if (opening.status === 'migration-required') {
      localUnavailable = true
      currentRequestSource = 'local'
      return finishLoad(provider)
    }
    if (opening.status === 'ready') {
      // This plugin's account pool now comes only from the store's
      // repository; the retired pool file is never read or cleared here.
      if (!isOAuthAuth(auth) && !readAuthority) {
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
      assertOpen()
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
      assertOpen()
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
    assertOpen()
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

    assertOpen()
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
      fetch: async (input, init) => {
        assertOpen()
        const authority = (await readAuthority?.()) ?? 'local'
        // Shutdown may have begun while the authority was read; nothing is
        // built or sent after admission closes, even while disposal drains.
        assertOpen()
        if (authority === 'unreadable') throw new Error(VAULT_ACCOUNT_REMEDY)
        if (authority === 'vault') {
          currentRequestSource = 'vault'
          if (!createVaultFetch) throw new Error(VAULT_ACCOUNT_REMEDY)
          vaultFetchRuntime ??= createVaultFetch().catch((error) => {
            vaultFetchRuntime = null
            throw error
          })
          const vaultRuntime = await vaultFetchRuntime
          assertOpen()
          return vaultRuntime.fetch(input, init)
        }
        // Check authority first: an approved vault remains usable even when
        // this location's local pool is waiting for offline migration.
        if (localUnavailable) {
          return fetchWithoutLocalAccounts(input, init, fetchImpl)
        }
        if (
          readAuthority &&
          (localRequestReload ||
            currentRequestSource !== 'local' ||
            !fetchRuntime)
        ) {
          if (!latestGetAuth)
            throw new Error('The host sign-in reader is unavailable')
          // Requests arriving together share one reload, so a later one
          // never replaces the runtime an earlier one is already sending on.
          if (!localRequestReload) {
            const started = reload(latestGetAuth).finally(() => {
              if (localRequestReload === started) localRequestReload = null
            })
            localRequestReload = started
          }
          await localRequestReload
          assertOpen()
          if ((await readAuthority()) !== 'local')
            throw new Error(VAULT_ACCOUNT_REMEDY)
          assertOpen()
        }
        if (localUnavailable)
          return fetchWithoutLocalAccounts(input, init, fetchImpl)
        if (currentRequestSource !== 'local' || !fetchRuntime)
          throw new Error('The local account runtime is unavailable')
        return fetchRuntime.fetch(input, init)
      },
    }
  }

  reloadRuntime = async (getAuth: GetAuth): Promise<void> => {
    assertOpen()
    const authority = (await readAuthority?.()) ?? 'local'
    assertOpen()
    if (authority !== 'local') return
    const auth = await readLocalHostAuth(getAuth)
    assertOpen()
    if (!isOAuthAuth(auth) && !readAuthority) return
    const opening = await openStore()
    assertOpen()
    if (opening.status === 'migration-required') {
      localUnavailable = true
      currentRequestSource = 'local'
      return
    }
    if (opening.status === 'ready') {
      const nextManager = await loadAccountManagerFromRepository(
        opening.repository,
      )
      await installRuntime(nextManager, getAuth, 'store')
      return
    }
    if (!usesPoolFile(opening) || !isOAuthAuth(auth)) return
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
    assertOpen()
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
