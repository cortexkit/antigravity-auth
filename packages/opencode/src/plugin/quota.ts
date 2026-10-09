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
  type AccountFlushReport,
  type AccountMetadataV3,
  type AccountQuotaResult,
  type AccountQuotaTarget,
  type AccountRepository,
  type AntigravityQuotaCheckReport,
  aggregateGeminiCliQuota,
  aggregateQuota,
  aggregateQuotaSummary,
  type AccountManager as CoreAccountManager,
  type ManagedAccount as CoreManagedAccount,
  createQuotaManager,
  defaultKeyOf,
  type FetchAccountQuota,
  type FetchAvailableModelsOptions,
  fetchAvailableModels,
  fetchGeminiCliQuota,
  fetchQuotaSummary,
  fetchWithActiveTimeout,
  type GeminiCliQuotaSummary,
  getHealthTracker,
  type QuotaManager,
  type QuotaSummary,
  type RowRef,
  rowRefKey,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'

import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  buildGeminiCliUserAgent,
} from '../constants'
import {
  buildSidebarMachineStateFromAccounts,
  isAccountCurrent,
  type SidebarMachineState,
  setSidebarMachineState,
} from '../sidebar-state'
import {
  createLocalAccountCredentials,
  type LocalAccountCredentials,
} from './accounts'
import {
  accessTokenExpired,
  formatRefreshParts,
  parseRefreshParts,
} from './auth'
import { logQuotaFetch, logQuotaStatus } from './debug'
import { buildAntigravityHarnessUserAgent } from './fingerprint'
import { createLogger, type Logger } from './logger'
import { ensureProjectContext, loadManagedProject } from './project'
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
    getAccountsForSidebar?: () => SidebarQuotaAccount[] | null
    /**
     * Optional provider for the active-account indexes per model family.
     * Wired by the plugin entry so every quota-refresh sidebar snapshot
     * carries the real `current` flag — not a hardcoded `false`.
     */
    getActiveIndexByFamily?: () => {
      claude: number
      gemini: number
    } | null
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
  const getAccountsForSidebar = options.getAccountsForSidebar
  const getActiveIndexByFamily = options.getActiveIndexByFamily
  return withSidebarPushAfterRefresh(
    manager,
    getAccountsForSidebar
      ? (account) =>
          pushSidebarQuotaSnapshot(
            getAccountsForSidebar,
            manager.getBackoffUntil(account),
            getActiveIndexByFamily,
          )
      : undefined,
  )
}

/**
 * Sidebar binding for one location's quota manager. `createOpenCodeQuotaManager`
 * (the OpenCode 1 plugin's quota manager) reads these from process-wide
 * state; a location passes each one explicitly.
 */
export interface LocationQuotaSidebarOptions {
  /**
   * Receives each snapshot: the sidebar file for the OpenCode 1 layout, or
   * an in-memory store for an OpenCode 2 location, which keeps no file.
   */
  write: (state: SidebarMachineState) => Promise<void>
  /** Live account rows for the snapshot; `null` before accounts load. */
  getAccounts: () => SidebarQuotaAccount[] | null
  getActiveIndexByFamily?: () => { claude: number; gemini: number } | null
  /**
   * Health score (0–100, how reliably the account has answered recently)
   * per account index, from this location's account rotation. When omitted
   * the snapshot carries no score, and the sidebar shows its default of 100.
   */
  healthScore?: (index: number) => number
  /** Clock for the snapshot's `checkedAt`. Defaults to `Date.now`. */
  now?: () => number
}

export interface LocationQuotaManagerOptions
  extends CreateOpenCodeQuotaManagerOptions {
  /** This location's logger. Required: there is no module-level fallback. */
  logger: Logger
  /**
   * Fetches one account's quota with this location's credentials and
   * transport. The location's account service supplies it; this module never
   * builds a host client or reads a shared credential cache.
   */
  fetchAccountQuota: FetchAccountQuota
  /** Sidebar snapshot binding; without it refreshes write no snapshot. */
  sidebar?: LocationQuotaSidebarOptions
}

/**
 * Build one location's quota manager. Backoff, in-flight dedupe and the
 * per-account cache belong to the returned manager alone, so a second
 * location never shares another location's backoff or cached results.
 * Refreshes push a sidebar snapshot exactly like `createOpenCodeQuotaManager`
 * does, but to the location's own state file and through its own logger.
 */
export function createLocationQuotaManager(
  options: LocationQuotaManagerOptions,
): QuotaManager {
  if (typeof options?.logger?.debug !== 'function') {
    throw new TypeError('createLocationQuotaManager requires a location logger')
  }
  if (typeof options.fetchAccountQuota !== 'function') {
    throw new TypeError(
      'createLocationQuotaManager requires a fetchAccountQuota function',
    )
  }
  const manager = createQuotaManager({
    fetchAccountQuota: options.fetchAccountQuota,
    keyOf: options.keyOf ?? defaultKeyOf,
    baseBackoffMs: options.baseBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
  })
  const sidebar = options.sidebar
  const logger = options.logger
  return withSidebarPushAfterRefresh(
    manager,
    sidebar
      ? (account) =>
          pushSidebarQuotaSnapshot(
            sidebar.getAccounts,
            manager.getBackoffUntil(account),
            sidebar.getActiveIndexByFamily,
            {
              write: sidebar.write,
              logger,
              healthScore: sidebar.healthScore ?? null,
              now: sidebar.now,
            },
          )
      : undefined,
  )
}

/**
 * Wrap a quota manager so every refresh started before disposal pushes one
 * sidebar snapshot after it settles, and so `dispose()` waits for those
 * pushes. A refresh that starts after disposal pushes nothing.
 */
function withSidebarPushAfterRefresh(
  manager: QuotaManager,
  push: ((account: AccountMetadataV3) => Promise<void>) | undefined,
): QuotaManager {
  const originalRefreshAccount = manager.refreshAccount
  const originalRefreshAccounts = manager.refreshAccounts
  let disposed = false
  const inFlight = new Set<Promise<unknown>>()

  const pushAfterRefresh = async (
    account: AccountMetadataV3,
  ): Promise<void> => {
    if (!push) return
    await push(account).catch(() => {
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

/** One live account row a sidebar quota snapshot is built from. */
export interface SidebarQuotaAccount {
  index: number
  label?: string
  enabled?: boolean
  coolingDownUntil?: number
  cachedQuota?: AccountMetadataV3['cachedQuota']
  cachedQuotaAccountId?: string
  currentQuotaAccountId?: string
  /** Captured plan tier to surface in the sidebar state file. */
  tier?: { id: string; paidId?: string; capturedAt: number }
}

/**
 * Where a sidebar quota snapshot goes and which state it reads. Omitted
 * fields use process-wide defaults, as the OpenCode 1 plugin (one location
 * per process) always has: the default sidebar file, module logger, health
 * tracker and wall clock.
 */
export interface SidebarQuotaSnapshotOptions {
  /** Sidebar state file to write. Defaults to the process-wide file. */
  stateFile?: string
  /**
   * Receives the redacted quota snapshot (account rows, `checkedAt` and
   * backoff) instead of it being written to a sidebar file. When given,
   * `stateFile` is ignored and no file is written.
   */
  write?: (state: SidebarMachineState) => Promise<void>
  /** Receives best-effort write failures. Defaults to the module logger. */
  logger?: Pick<Logger, 'debug'>
  /**
   * Health score per account index. `undefined` reads the process-wide
   * tracker; `null` writes no score so the projection uses its default.
   */
  healthScore?: ((index: number) => number) | null
  /** Clock for `checkedAt`. Defaults to `Date.now`. */
  now?: () => number
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
  getAccounts: () => SidebarQuotaAccount[] | null,
  backoffUntil: number = 0,
  getActiveIndexByFamily?: () => {
    claude: number
    gemini: number
  } | null,
  options: SidebarQuotaSnapshotOptions = {},
): Promise<void> {
  const accounts = getAccounts()
  if (!accounts || accounts.length === 0) return
  const activeByFamily = getActiveIndexByFamily?.() ?? null
  // `undefined` keeps the process-wide health tracker the OpenCode 1 plugin
  // uses; `null` means the caller has no health source and the sidebar shows
  // its default.
  const healthScore =
    options.healthScore === undefined
      ? (index: number) => getHealthTracker().getScore(index)
      : options.healthScore
  const now = options.now ?? Date.now
  const write =
    options.write ??
    ((state: SidebarMachineState) =>
      setSidebarMachineState(
        state,
        options.stateFile === undefined ? {} : { stateFile: options.stateFile },
      ))
  try {
    await write(
      buildSidebarMachineStateFromAccounts(
        accounts.map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          current: activeByFamily
            ? isAccountCurrent(entry.index, activeByFamily)
            : false,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          currentQuotaAccountId: entry.currentQuotaAccountId,
          ...(healthScore ? { healthScore: healthScore(entry.index) } : {}),
          tier: entry.tier,
        })),
        {
          checkedAt: now(),
          quotaBackoffUntil: backoffUntil > 0 ? backoffUntil : undefined,
        },
      ),
    )
  } catch (error) {
    ;(options.logger ?? log).debug('sidebar-quota-write-failed', {
      error: String(error),
    })
  }
}

/**
 * Legacy fallback: fetchAvailableModels → aggregateQuota. Used when
 * `fetchQuotaSummary` rejects (network, 403, etc.). Extracted so the
 * concurrent fetch path can reuse the same fallback logic without
 * duplicating the catch chain.
 */
async function fetchLegacyModelsFallback(options: {
  accessToken: string
  projectId: string
  fetchVia?: QuotaFetch
}): Promise<QuotaSummary> {
  try {
    const modelsResponse = await fetchAvailableModels({
      accessToken: options.accessToken,
      projectId: options.projectId,
      endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
      userAgent: buildAntigravityHarnessUserAgent(),
      timeoutMs: 10_000,
      ...(options.fetchVia ? { fetchVia: options.fetchVia } : {}),
    })
    if (modelsResponse.models) {
      return aggregateQuota(modelsResponse.models)
    }
    return {
      groups: {},
      modelCount: 0,
      error: 'Failed to fetch Antigravity quota (legacy fallback)',
    }
  } catch {
    return {
      groups: {},
      modelCount: 0,
      error: 'Failed to fetch Antigravity quota',
    }
  }
}

/**
 * Fetches both quota payloads for one account with a bearer and project the
 * caller already resolved: the windowed quota summary (with the legacy
 * model-list fallback) and the Gemini CLI quota. Shared by the OpenCode 1
 * fetcher and `createAuthorizedFetchAccountQuota`.
 */
async function fetchQuotaPayloads(options: {
  accessToken: string
  managedProjectId: string | undefined
  projectId: string
  fetchVia: QuotaFetch | undefined
  logger: Pick<Logger, 'debug'>
}): Promise<{
  quota: QuotaSummary
  geminiCliQuota: GeminiCliQuotaSummary
  fellBackToLegacy: boolean
}> {
  const { accessToken, managedProjectId, projectId, fetchVia } = options
  // Two independent payload contracts: the windowed summary
  // (with legacy fallback) and the gemini-CLI quota. They share
  // access + project but target different endpoints, so the
  // two 10s timeouts ran back-to-back for ~20s per account on
  // modal open. Run them concurrently; either rejection is
  // handled by its own branch and the result is still merged.
  const fetchSummaryPayload = (async (): Promise<{
    result: QuotaSummary
    fellBackToLegacy: boolean
  }> => {
    try {
      const summaryResult = await fetchQuotaSummary({
        accessToken,
        managedProjectId,
        projectId,
        endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
        userAgent: buildAntigravityHarnessUserAgent(),
        timeoutMs: 10_000,
        ...(fetchVia ? { fetchVia } : {}),
      })
      return {
        result: aggregateQuotaSummary(summaryResult.summary),
        fellBackToLegacy: summaryResult.fellBackToLegacy ?? false,
      }
    } catch {
      return {
        result: await fetchLegacyModelsFallback({
          accessToken,
          projectId,
          fetchVia,
        }),
        fellBackToLegacy: true,
      }
    }
  })()

  // CLI fetch is independent of the summary fetch. A CLI failure must
  // NOT kill the summary result, but it also must not be laundered into
  // "No Gemini CLI quota available" (a permanent-looking status) when
  // the real cause is a transient network error. Capture the error
  // message separately so the annotated result can carry it.
  let geminiCliFetchError: string | undefined
  const fetchGeminiCliPayload = fetchGeminiCliQuota({
    accessToken,
    projectId,
    endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
    userAgent: buildGeminiCliUserAgent(),
    timeoutMs: 10_000,
    ...(fetchVia ? { fetchVia } : {}),
  }).catch((error: unknown) => {
    geminiCliFetchError = error instanceof Error ? error.message : String(error)
    options.logger.debug('fetchGeminiCliQuota failed', {
      error: geminiCliFetchError,
    })
    return { buckets: undefined } as Awaited<
      ReturnType<typeof fetchGeminiCliQuota>
    >
  })

  const [summary, geminiCliResponse] = await Promise.all([
    fetchSummaryPayload,
    fetchGeminiCliPayload,
  ])

  const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse)
  const annotated: GeminiCliQuotaSummary =
    geminiCliResponse.buckets === undefined ||
    geminiCliResponse.buckets.length === 0
      ? {
          ...geminiCliQuotaResult,
          error:
            // A real fetch exception is a transient failure, not a
            // "no CLI configured" scenario — propagate the actual message.
            geminiCliFetchError ??
            (geminiCliQuotaResult.models.length === 0
              ? 'No Gemini CLI quota available'
              : undefined),
        }
      : geminiCliQuotaResult
  return {
    quota: summary.result,
    geminiCliQuota: annotated,
    fellBackToLegacy: summary.fellBackToLegacy,
  }
}

/** Result of re-checking a local grant immediately before one request. */
export type LocalQuotaGrantCheck =
  | { readonly status: 'current' }
  | { readonly status: 'stale'; readonly reason: string }

/**
 * The bearer and project one quota check may use, or why it may not run.
 * Only a LOCAL credential (a stored OAuth grant the caller resolved for the
 * exact account being checked) can authorize a check here. A vault
 * credential needs a fresh admission for every physical request and goes
 * through the vault source's own per-send admission instead.
 */
export type LocalQuotaCheckAuthorization =
  | {
      readonly status: 'authorized'
      readonly domain: 'local'
      readonly accessToken: string
      readonly projectId: string
      readonly managedProjectId?: string
      /**
       * Required per-send freshness check, bound by the caller to the
       * account reference it captured and to this access token. It runs
       * immediately before every physical quota request (after every earlier
       * await of that request); `stale` means the account no longer holds
       * that exact credential, and no further request of the check is sent.
       */
      readonly confirmSend: (
        signal: AbortSignal,
      ) => Promise<LocalQuotaGrantCheck>
    }
  | { readonly status: 'refused'; readonly reason: string }

export interface AuthorizedFetchAccountQuotaOptions {
  /**
   * Resolves the local bearer and project for exactly the account being
   * checked. It is called once per check, before this fetcher awaits
   * anything, with the same account object the quota manager handed in, so
   * the callback can capture that account's identity (for example a
   * repository row reference it carries) before any other work runs. This
   * fetcher never refreshes, caches or stores a token.
   */
  authorize(
    account: AccountMetadataV3,
    signal: AbortSignal,
  ): Promise<LocalQuotaCheckAuthorization>
  /** Receives the fetcher's diagnostic records; never tokens. */
  logger: Pick<Logger, 'debug'>
  /**
   * Transport for one check's quota requests, given the check's abort
   * signal. Without it, requests go through `fetchWithActiveTimeout` (the
   * core package's default quota transport) with that signal.
   */
  transport?: (signal: AbortSignal) => QuotaFetch
}

/** Raised inside a check when a request's local grant is no longer current. */
class LocalQuotaGrantStaleError extends Error {
  override readonly name = 'LocalQuotaGrantStaleError'
}

/**
 * A quota fetcher for LOCAL credentials whose bearer and project come from
 * the caller's `authorize` callback instead of the account's stored refresh
 * token. The network requests and result shape are the OpenCode 1
 * fetcher's (`fetchQuotaPayloads`), sent through a transport that calls the
 * authorization's `confirmSend` before every physical request.
 *
 * - A disabled account is answered without calling `authorize`.
 * - A refused authorization, an authorization that is not `local`, or a
 *   throw from `authorize` is answered as an error result without any
 *   request.
 * - Once `confirmSend` reports `stale`, no further request of the check is
 *   sent and the whole check is answered as an error, so a reading taken
 *   for a replaced or removed credential is never applied.
 * - The result never carries `updatedAccount`: any credential or project
 *   change belongs to the `authorize` callback, which knows which stored row
 *   it may write to.
 */
export function createAuthorizedFetchAccountQuota(
  options: AuthorizedFetchAccountQuotaOptions,
): FetchAccountQuota {
  return async (account, signal) => {
    const base = { index: 0, email: account.email }
    if (account.enabled === false) {
      return { ...base, status: 'disabled', disabled: true }
    }
    if (signal.aborted) {
      return { ...base, status: 'error', disabled: false, error: 'aborted' }
    }
    let staleReason: string | null = null
    try {
      // Called before the first await, so the callback sees the account as
      // handed in; a synchronous throw lands in the catch below.
      const authorizing = options.authorize(account, signal)
      const authorization = await authorizing
      if (authorization.status !== 'authorized') {
        return {
          ...base,
          status: 'error',
          disabled: false,
          error: `quota check refused (${authorization.reason})`,
        }
      }
      if (authorization.domain !== 'local') {
        return {
          ...base,
          status: 'error',
          disabled: false,
          error: 'quota check refused (unsupported credential domain)',
        }
      }
      if (signal.aborted) {
        return { ...base, status: 'error', disabled: false, error: 'aborted' }
      }
      const send: QuotaFetch =
        options.transport?.(signal) ??
        ((url, init, extra) =>
          fetchWithActiveTimeout(
            url,
            { ...init, signal: extra.signal ?? signal },
            { timeoutMs: extra.timeoutMs },
          ))
      const guarded: QuotaFetch = async (url, init, extra) => {
        if (staleReason !== null)
          throw new LocalQuotaGrantStaleError(staleReason)
        const check = await authorization.confirmSend(signal)
        if (check.status !== 'current') {
          staleReason = check.reason
          throw new LocalQuotaGrantStaleError(check.reason)
        }
        // `confirmSend` (the check that the account still holds this exact
        // credential and access token) has just finished; the request goes
        // out at once, with this quota check's abort signal.
        return send(url, init, { ...extra, signal })
      }
      const payloads = await fetchQuotaPayloads({
        accessToken: authorization.accessToken,
        managedProjectId: authorization.managedProjectId,
        projectId: authorization.projectId,
        fetchVia: guarded,
        logger: options.logger,
      })
      if (staleReason !== null) {
        return {
          ...base,
          status: 'error',
          disabled: false,
          error: `quota check refused (stale grant: ${staleReason})`,
        }
      }
      return {
        ...base,
        status: 'ok',
        disabled: false,
        quota: payloads.quota,
        geminiCliQuota: payloads.geminiCliQuota,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.logger.debug('authorized quota check failed', { error: message })
      return { ...base, status: 'error', disabled: false, error: message }
    }
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
      const updatedAccount = applyAccountUpdates(
        account,
        auth,
        projectContext.capturedTier,
      )

      if (rotatedRefresh && client) {
        await persistRotatedRefresh(client, providerId, auth).catch(() => {})
      }

      let quotaResult: QuotaSummary
      let fellBackToLegacy = false

      const authParts = parseRefreshParts(auth.refresh)
      // Bare refresh tokens have no packed project IDs — fall back to the
      // account record. The real managedProjectId lives on the persisted
      // account, not in the packed refresh string.
      const managedProjectId =
        authParts.managedProjectId ?? account.managedProjectId

      const payloads = await fetchQuotaPayloads({
        accessToken: auth.access ?? '',
        managedProjectId,
        projectId: projectContext.effectiveProjectId,
        fetchVia,
        logger: log,
      })
      quotaResult = payloads.quota
      fellBackToLegacy = payloads.fellBackToLegacy
      const annotated = payloads.geminiCliQuota

      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100
        logQuotaStatus(account.email, index, remainingPercent, family)
      }

      const legacyTag = fellBackToLegacy ? ' legacy=1' : ''
      logQuotaFetch('complete', 1, `ok=1 errors=0${legacyTag}`)

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
  capturedTier?: { id: string; paidId?: string; capturedAt: number },
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
    // Persist the captured tier alongside the project-context write. Only
    // present when the loadCodeAssist payload returned a non-empty currentTier.id.
    ...(capturedTier
      ? {
          capturedTierId: capturedTier.id,
          ...(capturedTier.paidId !== undefined
            ? { capturedPaidTierId: capturedTier.paidId }
            : {}),
          capturedTierAt: capturedTier.capturedAt,
        }
      : {}),
  }

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId ||
    updated.capturedTierId !== account.capturedTierId ||
    updated.capturedPaidTierId !== account.capturedPaidTierId ||
    // capturedAt represents when the tier was LAST CONFIRMED, not when it
    // changed -- always update it on a successful observation so consumers
    // can gate staleness on that timestamp even when the id stays the same.
    (capturedTier !== undefined &&
      updated.capturedTierAt !== account.capturedTierAt)

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

/**
 * Build a per-account tier-loader callback for the background poller.
 *
 * Calls `loadManagedProject` (loadCodeAssist) directly. The
 * `ensureProjectContext` cache answers from a known `managedProjectId`
 * without asking Google, so for an account that already has a project it
 * never returns a tier; the tier is only in loadCodeAssist's answer. One
 * call per account per 24 h.
 *
 * An expired access token is refreshed the same way `makeFetchAccountQuota`
 * refreshes it, so the lookup does not fail just because the token aged.
 *
 * `loadManagedProject` sends through the native TLS transport
 * (`fetchWithAgyCliTransport`), not through a generic `fetch`, so a
 * `fetchVia` override cannot intercept it; `ensureProjectContext` has the
 * same limit. Tier lookup is best-effort; any failure resolves `null`.
 */
export function makeTierLoader(
  client: PluginClient | undefined,
  providerId: string,
): (
  account: AccountMetadataV3,
) => Promise<{ id: string; paidId?: string; capturedAt: number } | null> {
  return async (account) => {
    try {
      let auth = buildAuthFromAccount(account)
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(
          auth,
          client as PluginClient,
          providerId,
        )
        if (!refreshed) return null
        auth = refreshed
      }

      const accessToken = auth.access
      if (!accessToken) return null

      const payload = await loadManagedProject(accessToken)
      if (!payload?.currentTier?.id) return null
      const paidTierId =
        typeof payload.paidTier === 'string'
          ? payload.paidTier
          : payload.paidTier?.id

      return {
        id: payload.currentTier.id,
        ...(paidTierId ? { paidId: paidTierId } : {}),
        capturedAt: Date.now(),
      }
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Account-store quota checks
// ---------------------------------------------------------------------------

/** What one account-store quota check did with its reading. */
export type StoreQuotaOutcome =
  | {
      /**
       * The reading was handed to the manager for exactly the checked row
       * and credential. This does not prove the store kept it:
       * `checkStoreQuota` reads the store back and compares the whole
       * reading.
       */
      readonly status: 'recorded'
      readonly result: AccountQuotaResult
      /** The reading this check produced, as the manager recorded it. */
      readonly reading: RecordedQuotaReading
    }
  | {
      /**
       * The check ran, but the row no longer holds the checked credential
       * (replaced, re-added or removed); the reading is discarded, never
       * attached to whatever holds the row now.
       */
      readonly status: 'discarded'
      readonly result: AccountQuotaResult
    }
  /** The check failed or was refused; nothing was recorded. */
  | { readonly status: 'failed'; readonly result: AccountQuotaResult }

export type { AntigravityQuotaCheckReport }

/**
 * One check's reading, captured at the moment it was handed to the manager,
 * so a later reading for the same row cannot be mistaken for it.
 */
export interface RecordedQuotaReading {
  readonly cachedQuotaAccountId: string | undefined
  readonly cachedQuotaUpdatedAt: number | undefined
  /** Canonical form of the quota groups (`canonicalQuotaGroups`). */
  readonly groups: string
}

interface QuotaGroupFields {
  modelCount: number
  remainingFraction?: number | null
  resetTime?: string | null
  windows?: ReadonlyArray<{
    window: string
    remainingFraction?: number | null
    resetTime?: string | null
  }> | null
}

/**
 * The quota groups a reading carries, in one canonical text: groups by
 * name, each with its model count, remaining fraction, reset time and
 * windows in order; absent and null are the same. The in-memory groups a
 * check records and the groups the store keeps for them give the same text,
 * so the two can be compared exactly.
 */
function canonicalQuotaGroups(
  groups:
    | Readonly<Record<string, QuotaGroupFields | undefined>>
    | null
    | undefined,
): string {
  const entries = Object.entries(groups ?? {})
    .filter(
      (entry): entry is [string, QuotaGroupFields] => entry[1] !== undefined,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, group]) => [
      name,
      group.modelCount,
      group.remainingFraction ?? null,
      group.resetTime ?? null,
      group.windows?.map((window) => [
        window.window,
        window.remainingFraction ?? null,
        window.resetTime ?? null,
      ]) ?? null,
    ])
  return JSON.stringify(entries)
}

/**
 * Quota checks for one plugin account pool served by the account store.
 * The service owns that pool's quota cache, in-flight deduplication and
 * backoff.
 */
export interface StoreQuotaService {
  /** The pool's quota manager (cache, in-flight dedupe and backoff). */
  readonly quotaManager: QuotaManager
  /**
   * Checks one account, named by the quota target the caller took from
   * `getAccountsForQuotaCheck()` (its `rowRef` is the identity). `force`
   * is the manual check: it bypasses backoff.
   */
  refreshAccount(
    target: AccountQuotaTarget,
    options?: { force?: boolean },
  ): Promise<StoreQuotaOutcome>
  /** Checks every account in the pool, not only the selected one. */
  refreshAll(options?: { force?: boolean }): Promise<StoreQuotaOutcome[]>
  /**
   * The menu's manual quota action: checks exactly the accounts named by
   * `refs` (the refs the menu read before the action), bypassing backoff.
   * A ref the manager does not hold at that exact credential is not
   * checked. After the checks, the store is read back: a ref counts as
   * checked only when the store's row at that exact ref holds this check's
   * whole reading (identity stamp, time and every group). A matching time
   * alone is not proof the reading was written.
   */
  checkStoreQuota(refs: readonly RowRef[]): Promise<AntigravityQuotaCheckReport>
  dispose(): Promise<void>
}

export interface StoreQuotaServiceOptions {
  /** The pool's account manager, whose accounts come from the repository. */
  manager: CoreAccountManager
  /** That manager's repository; read back to confirm recorded readings. */
  repository: Pick<AccountRepository, 'read'>
  logger: Logger
  /** Defaults to `createLocalAccountCredentials(manager)`. */
  credentials?: Pick<
    LocalAccountCredentials,
    'refresh' | 'ensureProject' | 'assertGrantCurrent'
  >
  /** Quota request transport; see `createAuthorizedFetchAccountQuota`. */
  transport?: (signal: AbortSignal) => QuotaFetch
  sidebar?: LocationQuotaSidebarOptions
  baseBackoffMs?: number
  maxBackoffMs?: number
  fetchTimeoutMs?: number
}

/**
 * The manager's account holding exactly `ref`. A RowRef names one
 * credential version of one row (row id, credential epoch and recorded
 * identity), so the lookup succeeds only while that row still holds that
 * very credential.
 */
function heldAccount(
  manager: CoreAccountManager,
  ref: RowRef,
): CoreManagedAccount | undefined {
  return manager
    .getAccounts()
    .find(
      (candidate) =>
        candidate.ref !== undefined && sameRowRef(candidate.ref, ref),
    )
}

/**
 * Quota checks for one plugin account pool whose accounts come from the
 * account store. One check, in order:
 * 1. Capture the target's RowRef before any await, and take the manager's
 *    account holding exactly that ref; if none does, the check is refused.
 * 2. If that account's access token has expired, refresh it through the
 *    repository, which commits the new token only to the row still holding
 *    that ref. Neither a token copied from an earlier read nor the host
 *    client is used.
 * 3. Resolve the account's project from the local project cache; a newly
 *    resolved project is recorded through the manager on the account's ref.
 * 4. Before every physical quota request, check that the manager still
 *    holds the same account object, at the same ref, enabled, with the same
 *    access token; otherwise no further request of the check is sent.
 * 5. Hand the reading to the manager only while it still holds that exact
 *    ref; otherwise discard it. The manager's write can still be refused by
 *    the store, so `checkStoreQuota` reads the store back and counts a
 *    check only when the store holds this check's whole reading.
 *
 * Only accounts whose refresh token is stored locally use this service;
 * vault-held accounts never do.
 */
export function createStoreQuotaService(
  options: StoreQuotaServiceOptions,
): StoreQuotaService {
  const { manager, logger } = options
  const credentials =
    options.credentials ?? createLocalAccountCredentials(manager)

  const authorize = async (
    account: AccountQuotaTarget,
  ): Promise<LocalQuotaCheckAuthorization> => {
    const ref = account.rowRef
    if (ref === undefined) {
      return { status: 'refused', reason: 'the account has no store ref' }
    }
    const held = heldAccount(manager, ref)
    if (held === undefined) {
      return { status: 'refused', reason: 'the account changed or was removed' }
    }
    let auth = manager.toAuthDetails(held)
    if (accessTokenExpired(auth)) {
      const refreshed = await credentials.refresh(held)
      if (refreshed === undefined) {
        return { status: 'refused', reason: 'token refresh failed' }
      }
      auth = refreshed
    }
    // A refresh keeps the credential epoch but can record the provider's
    // account identity on the ref and always brings a new access token, so
    // the grant is the account's ref and token as they are now, after it.
    const grantRef = held.ref
    const accessToken = auth.access
    if (grantRef === undefined || !accessToken) {
      return { status: 'refused', reason: 'no access token' }
    }
    const project = await credentials.ensureProject(auth)
    if (project.auth.refresh !== auth.refresh) {
      // The resolved project belongs to this credential: the manager records
      // only the project fields, fenced on this account's ref, so they can
      // never land on another row or a replaced credential.
      manager.updateFromAuth(held, { ...project.auth, access: accessToken })
    }
    const managedProjectId =
      parseRefreshParts(project.auth.refresh).managedProjectId ??
      held.managedProjectId
    return {
      status: 'authorized',
      domain: 'local',
      accessToken,
      projectId: project.effectiveProjectId,
      ...(managedProjectId !== undefined ? { managedProjectId } : {}),
      async confirmSend() {
        try {
          if (held.ref === undefined || !sameRowRef(held.ref, grantRef)) {
            return { status: 'stale', reason: 'the credential changed' }
          }
          credentials.assertGrantCurrent({ account: held, accessToken })
          return { status: 'current' }
        } catch (error) {
          return {
            status: 'stale',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      },
    }
  }

  const quotaManager = createLocationQuotaManager({
    logger,
    fetchAccountQuota: createAuthorizedFetchAccountQuota({
      authorize: (account) => authorize(account as AccountQuotaTarget),
      logger,
      transport: options.transport,
    }),
    // Backoff and cache are per credential: a re-authenticated row starts
    // fresh instead of inheriting its predecessor's state.
    keyOf: (account) => {
      const ref = (account as AccountQuotaTarget).rowRef
      return ref === undefined ? defaultKeyOf(account) : rowRefKey(ref)
    },
    baseBackoffMs: options.baseBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
    sidebar: options.sidebar,
  })

  const record = (
    target: AccountQuotaTarget,
    result: AccountQuotaResult,
  ): StoreQuotaOutcome => {
    if (result.status !== 'ok' || result.quota === undefined) {
      return { status: 'failed', result }
    }
    const held =
      target.rowRef === undefined
        ? undefined
        : heldAccount(manager, target.rowRef)
    if (held === undefined) return { status: 'discarded', result }
    manager.updateQuotaCache(
      held.index,
      result.quota.groups,
      held.parts.refreshToken,
    )
    // Captured now: the account's fields may change before the store is
    // read back, and a later reading must not stand in for this one.
    return {
      status: 'recorded',
      result,
      reading: {
        cachedQuotaAccountId: held.cachedQuotaAccountId,
        cachedQuotaUpdatedAt: held.cachedQuotaUpdatedAt,
        groups: canonicalQuotaGroups(result.quota.groups),
      },
    }
  }

  const refreshAccount: StoreQuotaService['refreshAccount'] = async (
    target,
    refreshOptions = {},
  ) => {
    const index = Math.max(
      0,
      manager
        .getAccountsForQuotaCheck()
        .findIndex(
          (candidate) =>
            candidate.rowRef !== undefined &&
            target.rowRef !== undefined &&
            sameRowRef(candidate.rowRef, target.rowRef),
        ),
    )
    const result = await quotaManager.refreshAccount(target, {
      index,
      force: refreshOptions.force === true,
    })
    return record(target, result)
  }

  return {
    quotaManager,
    refreshAccount,
    async checkStoreQuota(refs) {
      // Targets are taken before any await, so each names the credential
      // the manager held when the action started.
      const targets = manager.getAccountsForQuotaCheck()
      const outcomes = await Promise.all(
        refs.map((ref) => {
          const target = targets.find(
            (candidate) =>
              candidate.rowRef !== undefined &&
              sameRowRef(candidate.rowRef, ref),
          )
          return target === undefined
            ? undefined
            : refreshAccount(target, { force: true })
        }),
      )
      // Wait for queued quota writes before counting an account as checked.
      // If a failed write cannot be attributed to an account, no account's
      // quota reading is confirmed.
      let failedRows: ReadonlySet<string> | 'all' = new Set()
      try {
        await manager.saveToDisk()
      } catch (error) {
        // AccountManagerPersistError includes a flush report, but the public
        // core entry does not export its constructor. Identify it by name and
        // require at least one failed row ID. Only accounts outside the
        // reported failure list can still count as checked; missing or empty
        // failure details confirm none.
        const report =
          error instanceof Error && error.name === 'AccountManagerPersistError'
            ? (error as Error & { report?: AccountFlushReport }).report
            : undefined
        const failedIds = (report?.failures ?? []).map(
          (failure) => failure.rowId,
        )
        failedRows =
          report === undefined ||
          failedIds.length === 0 ||
          failedIds.some((id) => id === undefined)
            ? 'all'
            : new Set(failedIds.filter((id): id is string => id !== undefined))
        logger.debug('quota readings were not all persisted', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const read = await options.repository.read()
      let checked = 0
      refs.forEach((ref, position) => {
        const outcome = outcomes[position]
        if (outcome?.status !== 'recorded') return
        if (failedRows === 'all' || failedRows.has(ref.id)) return
        const row =
          read.status === 'ready'
            ? read.rows.find((candidate) => sameRowRef(candidate.ref, ref))
            : undefined
        if (row?.quota.status !== 'present') return
        const stored = row.quota.quota
        // The store must hold exactly this check's reading: same identity
        // stamp, same time and the same groups. An older reading stored with
        // the same time, or another check's reading of the same row, does
        // not count.
        if (
          stored.cachedQuotaAccountId ===
            outcome.reading.cachedQuotaAccountId &&
          stored.cachedQuotaUpdatedAt ===
            outcome.reading.cachedQuotaUpdatedAt &&
          canonicalQuotaGroups(stored.cachedQuota) === outcome.reading.groups
        ) {
          checked += 1
        }
      })
      return { checked, notChecked: refs.length - checked }
    },
    async refreshAll(refreshOptions = {}) {
      const targets = manager.getAccountsForQuotaCheck()
      const results = await quotaManager.refreshAccounts(targets, {
        indexFor: (account) => targets.indexOf(account as AccountQuotaTarget),
        force: refreshOptions.force === true,
      })
      return results.map((result, position) => {
        const target = targets[position]
        return target === undefined
          ? { status: 'failed' as const, result }
          : record(target, result)
      })
    },
    dispose: () => quotaManager.dispose(),
  }
}
