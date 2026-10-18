import {
  type AccountRepository,
  fetchWithAgyCliTransport,
} from '@cortexkit/antigravity-auth-core'
import { upsertSidebarActiveRouting } from '../sidebar-state'
import { extractAccountAccessErrorDetails } from './account-access'
import {
  type AccountManager,
  createLocalAccountCredentials,
  type ManagedAccount,
  StaleAccountGrantError,
} from './accounts'
import type { GetAuth } from './auth'
import { isOAuthAuth } from './auth'
import type { AntigravityConfig } from './config'
import * as moduleDebug from './debug'
import type { AgyTransport, FetchImpl } from './dependencies'
import { dumpGeminiRequest } from './gemini-dump'
import { createLogger } from './logger'
import type { OperatorSettingsController } from './operator-settings'
import { ensureProjectContext } from './project'
import type { QuotaManager } from './quota'
import {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from './request'
import type { AgySessionRegistry } from './session-context'
import type { RegisterResponseHandoff } from './shared/after-handoff.ts'
import {
  createLocalQuotaRefresh,
  createRequestExecutor,
  type LocalRequestCredentials,
  type RequestRoutingEntry,
  type RequestServicesDeps,
} from './shared/request-services'
import {
  createVaultAccountPool,
  type VaultAccountPool,
  type VaultAccountRow,
  type VaultRequestSource,
} from './shared/vault-request-credentials'
import { AntigravityTokenRefreshError, refreshAccessToken } from './token'
import type { PluginClient } from './types'

const log = createLogger('fetch-interceptor')

/** Production transport — used when the interceptor context omits one. */
const defaultAgyTransport: AgyTransport = (url, init, options) =>
  fetchWithAgyCliTransport(url, init, options)

/** Default `fetchImpl` used when the interceptor context omits one. */
const defaultFetchImpl: FetchImpl = (input, init) =>
  globalThis.fetch(input as RequestInfo, init)

/**
 * Inputs the fetch interceptor needs from the plugin bootstrap. Each plugin
 * instance builds its own interceptor without sharing state with siblings.
 */
export interface FetchInterceptorContext {
  readonly assertAdmission?: () => Promise<void>
  readonly client: PluginClient
  readonly directory: string
  readonly providerId: string
  readonly config: AntigravityConfig
  readonly accountManager: AccountManager
  /**
   * Where `accountManager`'s accounts come from, as the auth loader opened
   * them. `pool-file`: the pre-store pool file, whose tokens are refreshed
   * through the host's OAuth refresh. `store`: the account store, read
   * through `repository`, the same opening the manager was loaded from;
   * tokens are refreshed only by the repository on the selected account's
   * own row reference, and every send is checked against that row.
   */
  readonly accountSource:
    | { readonly kind: 'pool-file' }
    | {
        readonly kind: 'store'
        readonly repository: Pick<AccountRepository, 'read'>
      }
  readonly quotaManager: QuotaManager
  readonly getAuth: GetAuth
  readonly agySessionRegistry: AgySessionRegistry
  /**
   * Live operator settings controller. Optional for backward
   * compatibility — when present, the interceptor reads routing
   * overrides and killswitch thresholds per request.
   */
  readonly operatorSettings?: OperatorSettingsController
  /**
   * Transport adapter used for Antigravity HTTPS requests. Defaults to
   * the production `fetchWithAgyCliTransport` when omitted; tests inject
   * a deterministic stub so the e2e workspace can route calls at a mock
   * server bound to 127.0.0.1.
   */
  readonly agyTransport?: AgyTransport
  /**
   * HTTP primitive used for non-Antigravity URLs. Defaults to
   * `globalThis.fetch`; tests inject a guarded stub that refuses any
   * non-loopback target so a regression cannot silently leak a real
   * network call.
   */
  readonly fetchImpl?: FetchImpl
  readonly onRouting?: (sessionId: string, entry: RequestRoutingEntry) => void
}

/**
 * Public surface exposed to the auth-loader plumbing. `fetch` mirrors the
 * host signature so it can be slotted into `LoaderResult` unchanged.
 */
export interface FetchInterceptor {
  fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    onResponseHandoff?: RegisterResponseHandoff,
  ): Promise<Response>
  dispose(): void | Promise<void>
}

/**
 * The interceptor of this plugin's own accounts. The auth loader replaces it
 * whenever it reloads the account pool, and retires the old one instead of
 * disposing it, so requests it already admitted keep running.
 */
export interface LocalFetchInterceptor extends FetchInterceptor {
  /**
   * Refuses later Generative Language requests (they are never passed
   * upstream) and resolves once every request that entered `fetch` before
   * retirement, and its response body, has finished. `dispose` still aborts
   * them.
   */
  retire(): Promise<void>
}

/** The local credential operations that differ between account sources. */
type SourceCredentials = Pick<
  LocalRequestCredentials<ManagedAccount>,
  'refresh' | 'captureGrant' | 'ensureProject' | 'isInvalidGrant'
>

/**
 * A pool-file account: the selected account's stored OAuth record is
 * refreshed through the host's OAuth refresh, and a grant is sent only while
 * that account is still in the pool, enabled and still holds the token.
 */
function poolFileCredentials(
  accountManager: AccountManager,
  client: PluginClient,
  providerId: string,
): SourceCredentials {
  return {
    refresh: (account) =>
      refreshAccessToken(
        accountManager.toAuthDetails(account),
        client,
        providerId,
      ),
    // A pool-file row has no repository identity; its grant is checked
    // against the pool itself.
    captureGrant: ({ account, accessToken }) => ({
      source: 'pool-file',
      check() {
        if (
          !accountManager.getAccounts().includes(account) ||
          account.enabled === false ||
          accountManager.toAuthDetails(account).access !== accessToken
        ) {
          throw new StaleAccountGrantError()
        }
      },
    }),
    ensureProject: (auth) => ensureProjectContext(auth),
    isInvalidGrant: (error) =>
      error instanceof AntigravityTokenRefreshError &&
      error.code === 'invalid_grant',
  }
}

/**
 * An account-store account: refresh, grant check and invalid-grant
 * recognition are the store adapter's own (`createLocalAccountCredentials`
 * over the manager's repository), so a token is refreshed only through the
 * repository on the selected account's row reference and never through the
 * host client. The row reference is captured when the grant is resolved;
 * every send is checked against that exact row, never against whatever the
 * account object holds later, and a grant without one is never sent.
 */
function storeCredentials(
  accountManager: AccountManager,
  repository: Pick<AccountRepository, 'read'>,
): SourceCredentials {
  const credentials = createLocalAccountCredentials(accountManager, {
    repository,
  })
  return {
    refresh: (account) => credentials.refresh(account),
    captureGrant: (grant) => credentials.captureGrant(grant),
    ensureProject: (auth) => credentials.ensureProject(auth),
    isInvalidGrant: (error) => credentials.isInvalidGrant(error),
  }
}

/**
 * The engine collaborators every OpenCode 1 interceptor shares, whatever
 * holds its accounts: wire functions, the module-level debug, dump and
 * logger bindings, host toasts and the sidebar routing file.
 */
function openCode1EngineCollaborators(
  common: Pick<
    FetchInterceptorContext,
    | 'client'
    | 'config'
    | 'agySessionRegistry'
    | 'operatorSettings'
    | 'onRouting'
  > & { transport: AgyTransport },
): Omit<
  RequestServicesDeps<ManagedAccount>,
  'accounts' | 'credentials' | 'trackers'
> {
  const { client } = common
  return {
    config: common.config,
    sessions: common.agySessionRegistry,
    operatorSettings: common.operatorSettings,
    transport: common.transport,
    wire: {
      prepare: prepareAntigravityRequest,
      transformResponse: transformAntigravityResponse,
      buildThinkingWarmupBody,
      getImageModelLocalTitle,
      getLastCacheStats,
    },
    // OpenCode 1's module-level debug namespace provides the debug methods
    // the engine calls.
    debug: moduleDebug,
    dump: { dumpRequest: dumpGeminiRequest },
    logger: log,
    classifyAccessError: extractAccountAccessErrorDetails,
    notify: (message, variant) =>
      client.tui.showToast({ body: { message, variant } }),
    onRouting:
      common.onRouting ??
      ((sessionId, entry) => {
        void upsertSidebarActiveRouting(sessionId, entry, {
          authoritative: true,
        }).catch((error: unknown) => {
          log.debug('sidebar-routing-upsert-failed', {
            sessionId,
            error: String(error),
          })
        })
      }),
  }
}

/**
 * OpenCode 1 binding of the shared request engine for accounts this plugin
 * holds itself (pool file or account store). The retry, rotation and
 * quota-fallback pipeline lives in `createRequestExecutor`; this wrapper
 * decides which requests reach it and binds the account manager, its
 * source's credential operations and OpenCode 1's collaborators.
 */
export function createFetchInterceptor(
  context: FetchInterceptorContext,
): LocalFetchInterceptor {
  const {
    client,
    providerId,
    accountManager,
    accountSource,
    quotaManager,
    getAuth,
    agyTransport = defaultAgyTransport,
    fetchImpl = defaultFetchImpl,
    // directory is part of the contract but not consumed by this interceptor;
    // callers use it when constructing sibling services (e.g. project context).
  } = context
  void (context as { directory: string }).directory

  // Capture the host fetch at factory time so the interceptor never shadows
  // it with its own (recursive) fetch binding. Production wires this up via
  // the OpenCode plugin runtime; tests inject a mock by stubbing globalThis
  // OR — preferred for e2e — pass `fetchImpl` through the context so the
  // stub survives a process-wide fetch replacement.
  const upstreamFetch = fetchImpl

  const refreshQuotaAfterSuccess = createLocalQuotaRefresh(
    accountManager,
    quotaManager,
    log,
  )
  const executor = createRequestExecutor<ManagedAccount>({
    assertAdmission: context.assertAdmission,
    ...openCode1EngineCollaborators({
      ...context,
      transport: agyTransport,
    }),
    accounts: accountManager,
    credentials: {
      domain: 'local',
      toAuthDetails: (account) => accountManager.toAuthDetails(account),
      updateFromAuth: (account, auth) =>
        accountManager.updateFromAuth(account, auth),
      removeAccount: (account) => accountManager.removeAccount(account),
      saveToDisk: () => accountManager.saveToDisk(),
      saveToDiskReplace: () => accountManager.saveToDiskReplace(),
      ...(accountSource.kind === 'store'
        ? storeCredentials(accountManager, accountSource.repository)
        : poolFileCredentials(accountManager, client, providerId)),
      clearStoredAuth: async () => {
        await context.assertAdmission?.()
        await client.auth.set({
          path: { id: providerId },
          body: { type: 'oauth', refresh: '', access: '', expires: 0 },
        })
      },
      refreshQuotaAfterSuccess: async (account, intervalMinutes, signal) => {
        signal?.throwIfAborted()
        await context.assertAdmission?.()
        signal?.throwIfAborted()
        await refreshQuotaAfterSuccess(account, intervalMinutes, signal)
      },
    },
    // The trackers the manager selects with: its own for a store-backed
    // manager, the process-wide ones for the pool-file manager.
    trackers: {
      get health() {
        return accountManager.healthTracker
      },
      get token() {
        return accountManager.tokenTracker
      },
    },
  })
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let retired = false
  let retirePromise: Promise<void> | undefined
  // Requests that entered `fetch` but have not yet reached the executor
  // (they wait on admission or the host sign-in). Retirement waits for them
  // so the executor admits them before it stops admitting; disposal waits
  // for them so none resumes after it reports done.
  const entering = new Set<Promise<unknown>>()

  async function intercept(
    input: RequestInfo | URL,
    init?: RequestInit,
    onResponseHandoff?: RegisterResponseHandoff,
  ): Promise<Response> {
    await context.assertAdmission?.()
    // Disposal may have begun during the admission read; nothing more is
    // read or sent for this request.
    if (disposed) throw new Error('The local request runtime is disposed')
    if (accountSource.kind === 'pool-file') {
      const latestAuth = await getAuth()
      if (disposed) throw new Error('The local request runtime is disposed')
      if (!isOAuthAuth(latestAuth)) return upstreamFetch(input, init)
    }

    return executor.execute(input, init, { onResponseHandoff })
  }

  async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    onResponseHandoff?: RegisterResponseHandoff,
  ): Promise<Response> {
    if (disposed) {
      // After dispose we deliberately stop intercepting so an in-flight call
      // can still resolve without throwing. The plugin tear-down order may
      // race with a final inflight fetch.
      return upstreamFetch(input, init)
    }

    if (!isGenerativeLanguageRequest(input)) {
      return upstreamFetch(input, init)
    }

    // A retired interceptor has been replaced; a request reaching it now is
    // refused rather than sent without this plugin's credentials.
    if (retired) throw new Error('The local request runtime is retired')

    const pending = intercept(input, init, onResponseHandoff)
    entering.add(pending)
    void pending.then(
      () => entering.delete(pending),
      () => entering.delete(pending),
    )
    return pending
  }

  function retire(): Promise<void> {
    retired = true
    retirePromise ??= (async () => {
      while (entering.size > 0) await Promise.allSettled([...entering])
      await executor.retire()
    })()
    return retirePromise
  }

  function dispose(): Promise<void> {
    disposed = true
    disposePromise ??= (async () => {
      await executor.dispose()
      // Requests still reading their admission or the host sign-in stop at
      // their next check; disposal reports done only once they have.
      while (entering.size > 0) await Promise.allSettled([...entering])
      // A retirement still waiting on those requests settles with them.
      await retirePromise
    })()
    return disposePromise
  }

  return { fetch, retire, dispose }
}

/**
 * Inputs of the OpenCode 1 interceptor for a location whose accounts the
 * vault holds (custody). There is no account manager, host OAuth record or
 * quota manager: accounts are the vault's selectable routes and every
 * credential comes from the vault source.
 */
export interface VaultFetchInterceptorContext
  extends Pick<
    FetchInterceptorContext,
    | 'client'
    | 'config'
    | 'agySessionRegistry'
    | 'operatorSettings'
    | 'agyTransport'
    | 'fetchImpl'
    | 'onRouting'
    | 'assertAdmission'
  > {
  /** This location's custody source (the vault account source). */
  readonly source: VaultRequestSource
  /** Share selection and cached vault state with this activation's menu and sidebar. */
  readonly pool?: VaultAccountPool
}

/**
 * OpenCode 1 binding of the shared request engine for vault-held accounts.
 * Selection runs on an `AccountSelector` over the vault's selectable routes
 * (metadata rows, no credential). Every physical send takes a fresh receipt
 * for the selected route through `createVaultRequestCredentials`: its token
 * and project serve that one send, and a 401 is reported against it.
 * Nothing is refreshed locally, cached or copied from the host's own Google
 * sign-in, which is why no host auth is read here.
 */
export function createVaultFetchInterceptor(
  context: VaultFetchInterceptorContext,
): FetchInterceptor {
  const {
    source,
    agyTransport = defaultAgyTransport,
    fetchImpl = defaultFetchImpl,
  } = context
  const upstreamFetch = fetchImpl
  const pool = context.pool ?? createVaultAccountPool({ source })
  const selector = pool.selector
  const executor = createRequestExecutor<VaultAccountRow>({
    assertAdmission: context.assertAdmission,
    ...openCode1EngineCollaborators({
      ...context,
      transport: agyTransport,
    }),
    accounts: selector,
    credentials: pool.credentials,
    trackers: {
      health: selector.healthTracker,
      token: selector.tokenTracker,
    },
  })

  let disposed = false
  let disposePromise: Promise<void> | undefined

  async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!isGenerativeLanguageRequest(input)) return upstreamFetch(input, init)
    if (disposed) throw new Error('The vault request runtime is disposed')
    await pool.sync()
    return executor.execute(input, init)
  }

  function dispose(): Promise<void> {
    disposed = true
    disposePromise ??= (async () => {
      await executor.dispose()
      await pool.flush()
    })()
    return disposePromise
  }

  return { fetch, dispose }
}
