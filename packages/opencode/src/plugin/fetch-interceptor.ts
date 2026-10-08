import { fetchWithAgyCliTransport } from '@cortexkit/antigravity-auth-core'
import { upsertSidebarActiveRouting } from '../sidebar-state'
import { extractAccountAccessErrorDetails } from './account-access'
import type { AccountManager, ManagedAccount } from './accounts'
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
import { getHealthTracker, getTokenTracker } from './rotation'
import type { AgySessionRegistry } from './session-context'
import {
  createLocalQuotaRefresh,
  createRequestExecutor,
  type RequestServicesDeps,
} from './shared/request-services'
import { AntigravityTokenRefreshError, refreshAccessToken } from './token'
import type { PluginClient } from './types'

const log = createLogger('fetch-interceptor')

/** The selected account's grant is no longer its current credential. */
class StaleAccountGrantError extends Error {
  constructor() {
    super('The selected account no longer holds this credential')
    this.name = 'StaleAccountGrantError'
  }
}

/** Production transport — used when the interceptor context omits one. */
const defaultAgyTransport: AgyTransport = (url, init, options) =>
  fetchWithAgyCliTransport(url, init, options)

/** Default `fetchImpl` used when the interceptor context omits one. */
const defaultFetchImpl: FetchImpl = (input, init) =>
  globalThis.fetch(input as RequestInfo, init)

/**
 * Inputs the fetch interceptor needs from the plugin bootstrap. Everything
 * the original closure captured from `plugin.ts` now flows through this
 * record so a fresh interceptor can be built per plugin instance without
 * sharing state with siblings.
 */
export interface FetchInterceptorContext {
  readonly client: PluginClient
  readonly directory: string
  readonly providerId: string
  readonly config: AntigravityConfig
  readonly accountManager: AccountManager
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
}

/**
 * Public surface exposed to the auth-loader plumbing. `fetch` mirrors the
 * host signature so it can be slotted into `LoaderResult` unchanged.
 */
export interface FetchInterceptor {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  dispose(): void
}
/**
 * OpenCode 1 binding of the shared request engine. The retry, rotation and
 * quota-fallback pipeline lives in `createRequestExecutor`; this wrapper
 * decides which requests reach it and binds OpenCode 1's module-level
 * debug/dump/logger/trackers, host toasts, sidebar routing file and host
 * auth store as that engine's collaborators.
 */
export function createFetchInterceptor(
  context: FetchInterceptorContext,
): FetchInterceptor {
  const {
    client,
    providerId,
    config,
    accountManager,
    quotaManager,
    getAuth,
    agySessionRegistry,
    operatorSettings,
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

  const deps: RequestServicesDeps<ManagedAccount> = {
    config,
    accounts: accountManager,
    credentials: {
      domain: 'local',
      toAuthDetails: (account) => accountManager.toAuthDetails(account),
      updateFromAuth: (account, auth) =>
        accountManager.updateFromAuth(account, auth),
      removeAccount: (account) => accountManager.removeAccount(account),
      saveToDisk: () => accountManager.saveToDisk(),
      saveToDiskReplace: () => accountManager.saveToDiskReplace(),
      // OpenCode 1's rows have no repository ref: the selected row's own
      // stored record is refreshed.
      refresh: (account) =>
        refreshAccessToken(
          accountManager.toAuthDetails(account),
          client,
          providerId,
        ),
      // The grant is sent only while the selected row is still in the pool,
      // enabled, and still holds the grant's access token.
      assertGrantCurrent: ({ account, accessToken }) => {
        if (
          !accountManager.getAccounts().includes(account) ||
          account.enabled === false ||
          accountManager.toAuthDetails(account).access !== accessToken
        ) {
          throw new StaleAccountGrantError()
        }
      },
      ensureProject: (auth) => ensureProjectContext(auth),
      isInvalidGrant: (error) =>
        error instanceof AntigravityTokenRefreshError &&
        error.code === 'invalid_grant',
      clearStoredAuth: async () => {
        await client.auth.set({
          path: { id: providerId },
          body: { type: 'oauth', refresh: '', access: '', expires: 0 },
        })
      },
      refreshQuotaAfterSuccess: createLocalQuotaRefresh(
        accountManager,
        quotaManager,
        log,
      ),
    },
    sessions: agySessionRegistry,
    operatorSettings,
    transport: agyTransport,
    fetchImpl: upstreamFetch,
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
    trackers: {
      get health() {
        return getHealthTracker()
      },
      get token() {
        return getTokenTracker()
      },
    },
    classifyAccessError: extractAccountAccessErrorDetails,
    notify: (message, variant) =>
      client.tui.showToast({ body: { message, variant } }),
    onRouting: (sessionId, entry) => {
      void upsertSidebarActiveRouting(sessionId, entry, {
        authoritative: true,
      }).catch((error: unknown) => {
        log.debug('sidebar-routing-upsert-failed', {
          sessionId,
          error: String(error),
        })
      })
    },
  }
  const executor = createRequestExecutor(deps)
  let disposed = false

  async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
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

    const latestAuth = await getAuth()
    if (!isOAuthAuth(latestAuth)) {
      return upstreamFetch(input, init)
    }

    return executor.execute(input, init)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    executor.dispose()
  }

  return { fetch, dispose }
}
