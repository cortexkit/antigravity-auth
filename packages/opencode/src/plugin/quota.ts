/**
 * OpenCode adapter for the harness-agnostic quota manager.
 *
 * Re-exports the core `QuotaManager` types and helpers so call sites in
 * `plugin.ts` and other modules don't need to switch imports. Also wires up
 * the host-specific fetch callback that handles:
 *   1. Token refresh via the existing `refreshAccessToken` path.
 *   2. Persisting rotated refresh tokens via `client.auth.set` (matching
 *      legacy behavior).
 *   3. Resolving project context via `ensureProjectContext`.
 *
 * The legacy `checkAccountsQuota(accounts, client, providerId)` export is
 * retained as a compatibility wrapper that creates a short-lived manager
 * with `force: true` — manual quota screens must always refresh, even if
 * the background manager has backed off.
 */

import {
  type AccountMetadataV3,
  type AccountQuotaResult,
  aggregateGeminiCliQuota,
  aggregateQuota,
  createQuotaManager,
  defaultKeyOf,
  type FetchAccountQuota,
  type FetchAvailableModelsOptions,
  type FetchAvailableModelsResponse,
  fetchAvailableModels,
  fetchGeminiCliQuota,
  type GeminiCliQuotaSummary,
  type QuotaManager,
  type QuotaSummary,
} from '@cortexkit/antigravity-auth-core'

import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  buildGeminiCliUserAgent,
} from '../constants'
import {
  buildSidebarMachineStateFromAccounts,
  setSidebarMachineState,
} from '../sidebar-state'
import {
  accessTokenExpired,
  formatRefreshParts,
  parseRefreshParts,
} from './auth'
import { logQuotaFetch, logQuotaStatus } from './debug'
import { buildAntigravityHarnessUserAgent } from './fingerprint'
import { createLogger } from './logger'
import { ensureProjectContext } from './project'
import { refreshAccessToken } from './token'
import type { OAuthAuthDetails, PluginClient } from './types'

type QuotaFetch = NonNullable<FetchAvailableModelsOptions['fetchVia']>

// Re-export the public surface so existing imports from `./quota` keep working.
const log = createLogger('quota')

export type {
  AccountQuotaResult,
  AccountQuotaStatus,
  GeminiCliQuotaModel,
  GeminiCliQuotaSummary,
  PerModelQuotaEntry,
  QuotaGroup,
  QuotaGroupSummary,
  QuotaManager,
  QuotaManagerOptions,
  QuotaSummary,
} from '@cortexkit/antigravity-auth-core'
export {
  classifyQuotaGroup,
  createQuotaManager,
  defaultKeyOf,
} from '@cortexkit/antigravity-auth-core'

export interface CreateOpenCodeQuotaManagerOptions {
  /** Override the default key derivation (email → refresh-token hash). */
  keyOf?: (account: AccountMetadataV3) => string
  baseBackoffMs?: number
  maxBackoffMs?: number
  fetchTimeoutMs?: number
}

/**
 * Build an OpenCode-wired quota manager.
 *
 * The returned manager owns its cache, in-flight dedupe, and backoff state.
 * Register its `dispose()` with `PluginLifecycle` so refreshes abort on plugin
 * shutdown.
 *
 * The wrapper observes `refreshAccount` / `refreshAccounts` and pushes a
 * redacted sidebar snapshot after every refresh (success or backoff) so
 * the TUI's next poll renders the freshest cached quota. The snapshot is
 * sourced from the live AccountManager view (`getAccountsForSidebar`) so
 * it carries the just-updated percentages; before bootstrapping it is a
 * no-op.
 */
export function createOpenCodeQuotaManager(
  client: PluginClient,
  providerId: string = ANTIGRAVITY_PROVIDER_ID,
  options: CreateOpenCodeQuotaManagerOptions & {
    /**
     * Optional account-snapshot provider. Wired by the plugin entry to
     * the live `AccountManager.getAccounts()` so each refresh can build
     * a sidebar snapshot from the actual cached quota + cooldown. When
     * omitted, the wrapper falls back to a no-op snapshot push.
     */
    getAccountsForSidebar?: () => Array<{
      index: number
      email?: string
      enabled?: boolean
      coolingDownUntil?: number
      cachedQuota?: AccountMetadataV3['cachedQuota']
    }> | null
    /**
     * Optional transport adapter used for both `fetchAvailableModels`
     * and the project-context lookup. When omitted, the production
     * `fetchWithAgyCliTransport` runs and binds to the real
     * Antigravity endpoints; the e2e harness injects a mock here so
     * quota refresh + project discovery stay on the loopback server.
     */
    fetchVia?: QuotaFetch
  } = {},
): QuotaManager {
  const fetchAccountQuota = makeFetchAccountQuota(
    client,
    providerId,
    options.fetchVia,
  )
  const manager = createQuotaManager({
    fetchAccountQuota,
    keyOf: options.keyOf ?? defaultKeyOf,
    baseBackoffMs: options.baseBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
  })
  const originalRefreshAccount = manager.refreshAccount
  const originalRefreshAccounts = manager.refreshAccounts
  const getAccountsForSidebar = options.getAccountsForSidebar
  let disposed = false
  const inFlight = new Set<Promise<unknown>>()

  const pushAfterRefresh = async (
    account: AccountMetadataV3,
  ): Promise<void> => {
    if (!getAccountsForSidebar) return
    await pushSidebarQuotaSnapshot(
      getAccountsForSidebar,
      manager.getBackoffUntil(account),
    ).catch(() => {
      // Sidebar persistence remains best-effort when lock contention
      // outlives its retry budget.
    })
  }

  const track = <T>(operation: Promise<T>): Promise<T> => {
    inFlight.add(operation)
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    )
    return operation
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await manager.dispose()
    await Promise.allSettled(inFlight)
  }

  return {
    ...manager,
    async refreshAccount(account, refreshOptions) {
      const shouldPush = !disposed
      return track(
        (async () => {
          const result = await originalRefreshAccount(account, refreshOptions)
          if (shouldPush) await pushAfterRefresh(account)
          return result
        })(),
      )
    },
    async refreshAccounts(accounts, refreshOptions) {
      const shouldPush = !disposed
      return track(
        (async () => {
          const results = await originalRefreshAccounts(
            accounts,
            refreshOptions,
          )
          // Push one snapshot per batch — the AccountManager's view is updated
          // by the caller (oauth-methods / fetch-interceptor) BEFORE we read
          // here, so a single post-batch snapshot captures the full diff.
          const lastAccount = accounts[accounts.length - 1]
          if (shouldPush && lastAccount) await pushAfterRefresh(lastAccount)
          return results
        })(),
      )
    },
    dispose,
  }
}

/**
 * Compatibility wrapper used by code paths that want a one-shot check across
 * the full account pool with no shared cache.
 *
 * Equivalent to spinning up a short-lived manager with `force: true` so
 * manual quota dialogs always reflect the latest data even if the background
 * manager has backed off.
 */
export async function checkAccountsQuotaWith(
  accounts: AccountMetadataV3[],
  fetchAccountQuota: FetchAccountQuota,
): Promise<AccountQuotaResult[]> {
  const manager = createQuotaManager({
    fetchAccountQuota,
    keyOf: defaultKeyOf,
  })
  try {
    return await manager.refreshAccounts(accounts, {
      indexFor: (account) => accounts.indexOf(account),
      force: true,
    })
  } finally {
    manager.dispose()
  }
}

export async function checkAccountsQuotaStandalone(
  accounts: AccountMetadataV3[],
  options: { refresh: boolean },
): Promise<AccountQuotaResult[]> {
  if (!options.refresh) {
    return accounts.map((account, index) => ({
      index,
      email: account.email,
      status: account.enabled === false ? 'disabled' : 'ok',
      disabled: account.enabled === false,
      quota: {
        groups: account.cachedQuota ?? {},
        modelCount: Object.keys(account.cachedQuota ?? {}).length,
      },
    }))
  }
  return checkAccountsQuotaWith(
    accounts,
    makeFetchAccountQuota(undefined, ANTIGRAVITY_PROVIDER_ID),
  )
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId: string = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  return checkAccountsQuotaWith(
    accounts,
    makeFetchAccountQuota(client, providerId),
  )
}

/**
 * Push a quota refresh into the sidebar. Called by every quota refresh
 * call site (manual `/antigravity-quota`, the `check` menu action, and the
 * background refresh in `fetch-interceptor`) AFTER the results have been
 * folded back into the AccountManager's cached quota. The function reads
 * the live account snapshot through `getAccounts` so the redacted entry
 * carries the just-refreshed percentages — not the previous tick's stale
 * numbers and not `undefined`.
 *
 * The mapping is deliberately tolerant: if `getAccounts` returns `null`
 * (e.g. before the plugin has finished bootstrapping) the call is a no-op.
 * On lock contention the error is logged-and-swallowed so a quota dialog
 * never fails just because the sidebar file is busy.
 */
export async function pushSidebarQuotaSnapshot(
  getAccounts: () => Array<{
    index: number
    email?: string
    enabled?: boolean
    coolingDownUntil?: number
    cachedQuota?: AccountMetadataV3['cachedQuota']
  }> | null,
  backoffUntil: number = 0,
): Promise<void> {
  const accounts = getAccounts()
  if (!accounts || accounts.length === 0) return
  try {
    await setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(
        accounts.map((entry) => ({
          index: entry.index,
          email: entry.email,
          enabled: entry.enabled,
          current: false,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
        })),
        {
          checkedAt: Date.now(),
          quotaBackoffUntil: backoffUntil > 0 ? backoffUntil : undefined,
        },
      ),
    )
  } catch (error) {
    log.debug('sidebar-quota-write-failed', { error: String(error) })
  }
}

function makeFetchAccountQuota(
  client: PluginClient | undefined,
  providerId: string,
  fetchVia?: QuotaFetch,
): FetchAccountQuota {
  return async (account, signal) => {
    const index = 0
    const disabled = account.enabled === false
    if (disabled) {
      return {
        index,
        email: account.email,
        status: 'disabled',
        disabled: true,
      }
    }

    if (signal.aborted) {
      return {
        index,
        email: account.email,
        status: 'error',
        error:
          signal.reason instanceof Error ? signal.reason.message : 'aborted',
      }
    }

    let auth = buildAuthFromAccount(account)
    let rotatedRefresh: string | undefined

    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(
          auth,
          client as PluginClient,
          providerId,
        )
        if (!refreshed) {
          throw new Error('Token refresh failed')
        }
        if (refreshed.refresh !== auth.refresh) {
          rotatedRefresh = refreshed.refresh
        }
        auth = refreshed
      }

      const projectContext = await ensureProjectContext(auth)
      auth = projectContext.auth
      const updatedAccount = applyAccountUpdates(account, auth)

      if (rotatedRefresh && client) {
        await persistRotatedRefresh(client, providerId, auth).catch(() => {})
      }

      const [antigravityResponse, geminiCliResponse] = await Promise.all([
        fetchAvailableModels({
          accessToken: auth.access ?? '',
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildAntigravityHarnessUserAgent(),
          timeoutMs: 10_000,
          ...(fetchVia ? { fetchVia } : {}),
        }).catch((): FetchAvailableModelsResponse => ({ models: undefined })),
        fetchGeminiCliQuota({
          accessToken: auth.access ?? '',
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildGeminiCliUserAgent(),
          timeoutMs: 10_000,
          ...(fetchVia ? { fetchVia } : {}),
        }),
      ])

      let quotaResult: QuotaSummary
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: 'Failed to fetch Antigravity quota',
        }
      } else {
        quotaResult = aggregateQuota(antigravityResponse.models)
      }

      const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse)
      const annotated: GeminiCliQuotaSummary =
        geminiCliResponse.buckets === undefined ||
        geminiCliResponse.buckets.length === 0
          ? {
              ...geminiCliQuotaResult,
              error:
                geminiCliQuotaResult.models.length === 0
                  ? 'No Gemini CLI quota available'
                  : undefined,
            }
          : geminiCliQuotaResult

      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100
        logQuotaStatus(account.email, index, remainingPercent, family)
      }

      logQuotaFetch('complete', 1, 'ok=1 errors=0')

      return {
        index,
        email: account.email,
        status: 'ok',
        disabled: false,
        quota: quotaResult,
        geminiCliQuota: annotated,
        updatedAccount,
      }
    } catch (error) {
      logQuotaFetch(
        'error',
        undefined,
        `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        index,
        email: account.email,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        disabled: false,
      }
    }
  }
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: 'oauth',
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  }
}

function applyAccountUpdates(
  account: AccountMetadataV3,
  auth: OAuthAuthDetails,
): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh)
  if (!parts.refreshToken) {
    return undefined
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  }

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId

  return changed ? updated : undefined
}

async function persistRotatedRefresh(
  client: PluginClient,
  providerId: string,
  auth: OAuthAuthDetails,
): Promise<void> {
  await client.auth.set({
    path: { id: providerId },
    body: {
      type: 'oauth',
      refresh: auth.refresh,
      access: auth.access ?? '',
      expires: auth.expires ?? 0,
    },
  })
}
