import { ANTIGRAVITY_ENDPOINT_FALLBACKS } from '../constants'
import {
  type SidebarRoutingEntry,
  upsertSidebarActiveRouting,
} from '../sidebar-state'
import { extractAccountAccessErrorDetails } from './account-access'
import type { AccountManager } from './accounts'
import {
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  parseRateLimitReason,
  resolveQuotaGroup,
} from './accounts'
import { fetchWithAgyCliTransport } from './agy-transport'
import type { GetAuth } from './auth'
import { accessTokenExpired, isOAuthAuth } from './auth'
import type { AntigravityConfig } from './config'
import {
  isDebugEnabled,
  logAccountContext,
  logAntigravityDebugResponse,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  startAntigravityDebugRequest,
} from './debug'
import { AntigravityKillswitchError } from './errors'
import {
  createRetryState,
  type RateLimitBackoffResult,
  type RetryState,
} from './fetch/retry-state'
import { createWarmupState, type WarmupState } from './fetch/warmup'
import {
  extractModelFromUrl,
  getModelFamilyFromUrl,
  isCapacityRetryBudgetExhausted,
  MAX_TOTAL_CAPACITY_RETRIES,
  resolveHeaderRoutingDecision,
  resolveQuotaFallbackHeaderStyle,
  toUrlString,
  toWarmupStreamUrl,
} from './fetch-routing'
import { dumpGeminiRequest, noteGeminiDumpResponse } from './gemini-dump'
import { evaluateKillswitchForAccount, throwIfAllKilled } from './killswitch'
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
import {
  createSyntheticErrorResponse,
  createSyntheticTextResponse,
  isEmptyResponseBody,
} from './request-helpers'
import { getHealthTracker, getTokenTracker } from './rotation'
import {
  type AgySessionRegistry,
  extractOpenCodeSessionIdentity,
} from './session-context'
import { AntigravityTokenRefreshError, refreshAccessToken } from './token'
import type { PluginClient, ProjectContextResult } from './types'

const log = createLogger('fetch-interceptor')

/**
 * Per-call delay applied before the first 429 retry on the same account.
 * Matches the legacy plugin so callers that compare timing logs see parity.
 */
const FIRST_RETRY_DELAY_MS = 1000

/**
 * Builds a Google-style 401 envelope describing a missing-account failure.
 *
 * The legacy plugin returned `createSyntheticErrorResponse(...)`, which yields
 * a 200 SSE body pretending to be a Gemini stream. That hid the underlying
 * misconfiguration from any caller that inspected `response.status`. Callers
 * (notably OpenCode's HTTP layer) treat 200 as success and silently swallow
 * the payload, so the user sees nothing. Surfacing a real 401 with the
 * standard Google error envelope makes the failure actionable.
 */
function createNoAccountResponse(message: string, model: string): Response {
  const body = {
    error: {
      code: 401,
      message,
      status: 'UNAUTHENTICATED',
    },
  }
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'X-Antigravity-Error-Type': 'no_accounts',
      'X-Antigravity-Requested-Model': model,
    },
  })
}

/** Reads `retry-after-ms` / `retry-after` headers, in that order. */
function retryAfterMsFromResponse(
  response: Response,
  defaultRetryMs: number = 60_000,
): number {
  const retryAfterMsHeader = response.headers.get('retry-after-ms')
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  const retryAfterHeader = response.headers.get('retry-after')
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000
    }
  }

  return defaultRetryMs
}

/** Formats a millisecond duration the way the legacy toast pipeline did. */
function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/**
 * Sleep for `ms` milliseconds, rejecting with the abort reason when the
 * supplied signal fires before the timer elapses.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Aborted'),
      )
      return
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      cleanup()
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error('Aborted'),
      )
    }

    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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
 * Wraps the upstream fetch with the full account-rotation, rate-limit, and
 * quota-fallback pipeline. Each interceptor owns its retry/warmup bookkeeping
 * so disposing the plugin releases every counter.
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
    // directory is part of the contract but not consumed by this interceptor;
    // callers use it when constructing sibling services (e.g. project context).
  } = context
  void (context as { directory: string }).directory

  const retryState: RetryState = createRetryState()
  const warmupState: WarmupState = createWarmupState()
  let disposed = false

  // Capture the host fetch at factory time so the interceptor never shadows
  // it with its own (recursive) fetch binding. Production wires this up via
  // the OpenCode plugin runtime; tests inject a mock by stubbing globalThis.
  const upstreamFetch = globalThis.fetch.bind(globalThis)

  async function triggerAsyncQuotaRefreshForAccount(
    accountIndex: number,
    intervalMinutes: number,
  ): Promise<void> {
    if (intervalMinutes <= 0) return

    const accounts = accountManager.getAccounts()
    const account = accounts[accountIndex]
    if (!account || account.enabled === false) return

    const intervalMs = intervalMinutes * 60 * 1000
    const age =
      account.cachedQuotaUpdatedAt != null
        ? Date.now() - account.cachedQuotaUpdatedAt
        : Infinity

    if (age < intervalMs) return

    let singleAccount:
      | ReturnType<AccountManager['getAccountsForQuotaCheck']>[number]
      | undefined
    try {
      const accountsForCheck = accountManager.getAccountsForQuotaCheck()
      singleAccount = accountsForCheck[accountIndex]
      if (!singleAccount) return

      const result = await quotaManager.refreshAccount(singleAccount, {
        index: accountIndex,
      })

      if (result.status === 'ok' && result.quota?.groups) {
        accountManager.updateQuotaCache(accountIndex, result.quota.groups)
        accountManager.requestSaveToDisk()
      }
    } catch (err) {
      log.debug(
        `quota-refresh-failed ${singleAccount ? quotaManager.hashedLogLabel('account', singleAccount) : `idx-${accountIndex}`}`,
        { error: String(err) },
      )
    }
  }

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

    // Normalize Request/URL inputs to (urlString, init) so the string-based
    // transform pipeline sees the real method/headers/body. Without this,
    // fetch(new Request(...)) would carry its payload on the Request object
    // where our string path can't read it.
    if (typeof input !== 'string') {
      if (input instanceof Request) {
        const req = input
        const headers = new Headers(req.headers)
        if (init?.headers) {
          new Headers(init.headers).forEach((v, k) => {
            headers.set(k, v)
          })
        }
        const bodyBuffer = req.body
          ? await req.clone().arrayBuffer()
          : undefined
        init = {
          method: init?.method ?? req.method,
          headers,
          body:
            init?.body ?? (bodyBuffer ? Buffer.from(bodyBuffer) : undefined),
          signal: init?.signal ?? req.signal,
        }
        input = req.url
      } else {
        input = String((input as URL).href ?? input)
      }
    }

    const localImageTitle = getImageModelLocalTitle(input, init)
    if (localImageTitle !== undefined) {
      return createSyntheticTextResponse(localImageTitle, {
        'X-Antigravity-Response-Type': 'local_title',
      })
    }

    const requestSessionIdentity = extractOpenCodeSessionIdentity(init?.headers)
    const agyRequestScope = agySessionRegistry.beginRequest(
      requestSessionIdentity,
    )
    const agyRequestSession = agyRequestScope.session
    const accountSessionIdentity = requestSessionIdentity.sessionId
      ? {
          id: requestSessionIdentity.sessionId,
          parentId: requestSessionIdentity.parentSessionId,
        }
      : undefined
    const isChildRequest = requestSessionIdentity.parentSessionId !== null

    if (accountManager.getAccountCount() === 0) {
      // Surface a real 401 with the Google error envelope instead of a
      // 200 SSE body — OpenCode's HTTP layer treats 200 as success and
      // would otherwise swallow the misconfiguration silently.
      const urlString = typeof input === 'string' ? input : toUrlString(input)
      const modelFromUrl = extractModelFromUrl(urlString) ?? 'unknown'
      return createNoAccountResponse(
        'No Antigravity accounts configured. Run `opencode auth login`.',
        modelFromUrl,
      )
    }

    const urlString = toUrlString(input)
    const family = getModelFamilyFromUrl(urlString)
    const model = extractModelFromUrl(urlString)
    const debugLines: string[] = []
    const pushDebug = (line: string) => {
      if (!isDebugEnabled()) return
      debugLines.push(line)
    }
    pushDebug(`request=${urlString}`)
    if (requestSessionIdentity.sessionId) {
      pushDebug(
        `[Session] id=${requestSessionIdentity.sessionId}` +
          ` parent=${requestSessionIdentity.parentSessionId ?? 'none'}` +
          ` child=${isChildRequest}`,
      )
    }
    const cachedStats = getLastCacheStats()
    if (cachedStats) {
      const label = cachedStats.hitRate > 0 ? 'HIT' : 'MISS'
      pushDebug(
        `[Cache] ${label} model=${cachedStats.model} read=${cachedStats.read} total=${cachedStats.total} hitRate=${cachedStats.hitRate}%`,
      )
    }

    type FailureContext = {
      response: Response
      streaming: boolean
      debugContext: ReturnType<typeof startAntigravityDebugRequest>
      requestedModel?: string
      projectId?: string
      endpoint?: string
      effectiveModel?: string
      sessionId?: string
      toolDebugMissing?: number
      toolDebugSummary?: string
      toolDebugPayload?: string
      dumpContext?: ReturnType<typeof dumpGeminiRequest>
    }

    let lastFailure: FailureContext | null = null
    let lastError: Error | null = null
    const abortSignal = init?.signal ?? undefined

    const checkAborted = () => {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('Aborted')
      }
    }

    const quietMode = config.quiet_mode
    const toastScope = config.toast_scope

    // Apply operator-controlled routing overrides live. The slash
    // commands mutate these values through `applyCommand`; reading
    // them per-request means a runtime flip takes effect on the next
    // dispatched call without restarting the plugin.
    const operatorRouting = operatorSettings?.get().routing
    const effectiveConfig: AntigravityConfig = {
      ...config,
      cli_first: operatorRouting?.cli_first ?? config.cli_first,
      quota_style_fallback:
        operatorRouting?.quota_style_fallback ?? config.quota_style_fallback,
    }

    const showToast = async (
      message: string,
      variant: 'info' | 'warning' | 'success' | 'error',
    ) => {
      log.debug('toast', {
        message,
        variant,
        isChildSession: isChildRequest,
        toastScope,
      })

      if (quietMode) return
      if (abortSignal?.aborted) return

      if (toastScope === 'root_only' && isChildRequest) {
        log.debug('toast-suppressed-child-session', {
          message,
          variant,
          parentID: requestSessionIdentity.parentSessionId,
        })
        return
      }

      if (variant === 'warning' && message.toLowerCase().includes('rate')) {
        if (!retryState.shouldShowRateLimitToast(message)) {
          return
        }
      }

      try {
        await client.tui.showToast({ body: { message, variant } })
      } catch {
        // TUI may not be available
      }
    }

    const hasOtherAccountWithAntigravity = (currentAccount: any): boolean => {
      if (family !== 'gemini') return false
      return accountManager.hasOtherAccountWithAntigravityAvailable(
        currentAccount.index,
        family,
        model,
      )
    }

    let accountSwitchCount = 0
    const maxAccountSwitches = config.max_account_switches ?? 2
    let previousAccountIndex = -1
    let needsCacheWarmup = false

    while (true) {
      checkAborted()
      const accountCount = accountManager.getAccountCount()
      const routingDecision = resolveHeaderRoutingDecision(
        urlString,
        family,
        effectiveConfig,
      )
      const { preferredHeaderStyle, explicitQuota, allowQuotaFallback } =
        routingDecision

      if (accountCount === 0) {
        // Mirror the no-account short-circuit inside the retry loop so callers
        // that race with account removal still get a proper 401 instead of a
        // hang or a synthetic 200.
        return createNoAccountResponse(
          'No Antigravity accounts available. Run `opencode auth login`.',
          model ?? 'unknown',
        )
      }

      const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
        config.soft_quota_cache_ttl_minutes,
        config.quota_refresh_interval_minutes,
      )

      // Operator killswitch — drop candidates whose freshest cached
      // quota remaining-percent is below the configured floor. Fail
      // open on missing/stale quota so a cold start cannot deadlock
      // the pipeline.
      const operatorKillswitch = operatorSettings?.get().killswitch
      const eligibleAccounts = accountManager.getAccounts().filter((entry) => {
        if (!operatorKillswitch?.enabled) return true
        const decision = evaluateKillswitchForAccount(
          entry,
          family,
          {
            routing:
              effectiveConfig.cli_first !== undefined
                ? {
                    cli_first: effectiveConfig.cli_first,
                    quota_style_fallback:
                      !!effectiveConfig.quota_style_fallback,
                  }
                : { cli_first: false, quota_style_fallback: false },
            killswitch: operatorKillswitch,
            log_level: 'info',
          },
          { now: Date.now() },
        )
        return decision.allowed
      })

      if (eligibleAccounts.length === 0 && accountCount > 0) {
        try {
          throwIfAllKilled({
            family,
            model: model ?? 'unknown',
            accounts: accountManager.getAccounts(),
            settings: {
              routing: { cli_first: false, quota_style_fallback: false },
              killswitch: operatorKillswitch ?? {
                enabled: false,
                minimum_remaining_percent: 0,
              },
              log_level: 'info',
            },
          })
        } catch (error) {
          if (error instanceof AntigravityKillswitchError) {
            log.warn('killswitch-all-excluded', {
              family,
              model,
              threshold: error.thresholdPercent,
              summaries: error.summaries,
            })
            return createSyntheticErrorResponse(
              error.message,
              model ?? 'unknown',
            )
          }
          throw error
        }
      }

      let account = accountManager.getCurrentOrNextForFamily(
        family,
        model,
        config.account_selection_strategy,
        preferredHeaderStyle,
        config.pid_offset_enabled,
        config.soft_quota_threshold_percent,
        softQuotaCacheTtlMs,
        accountSessionIdentity,
      )

      // After core selection, re-check the killswitch on the chosen
      // candidate. If it's killed, mark ineligible and retry.
      if (account && operatorKillswitch?.enabled) {
        const decision = evaluateKillswitchForAccount(
          account,
          family,
          {
            routing: { cli_first: false, quota_style_fallback: false },
            killswitch: operatorKillswitch,
            log_level: 'info',
          },
          { now: Date.now() },
        )
        if (!decision.allowed) {
          pushDebug(
            `killswitch-excluded idx=${account.index} remaining=${decision.remainingPercent} threshold=${decision.thresholdPercent}`,
          )
          account = null
        }
      }

      if (!account && allowQuotaFallback) {
        const alternateHeaderStyle: 'antigravity' | 'gemini-cli' =
          preferredHeaderStyle === 'antigravity' ? 'gemini-cli' : 'antigravity'
        account = accountManager.getCurrentOrNextForFamily(
          family,
          model,
          config.account_selection_strategy,
          alternateHeaderStyle,
          config.pid_offset_enabled,
          config.soft_quota_threshold_percent,
          softQuotaCacheTtlMs,
          accountSessionIdentity,
        )
        if (account) {
          pushDebug(
            `selected-by-fallback idx=${account.index} preferred=${preferredHeaderStyle} alternate=${alternateHeaderStyle}`,
          )
        }
      }

      if (!account) {
        if (
          accountManager.areAllAccountsOverSoftQuota(
            family,
            config.soft_quota_threshold_percent,
            softQuotaCacheTtlMs,
            model,
          )
        ) {
          const threshold = config.soft_quota_threshold_percent
          const softQuotaWaitMs = accountManager.getMinWaitTimeForSoftQuota(
            family,
            threshold,
            softQuotaCacheTtlMs,
            model,
          )
          const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000

          if (
            softQuotaWaitMs === null ||
            (maxWaitMs > 0 && softQuotaWaitMs > maxWaitMs)
          ) {
            const waitTimeFormatted = softQuotaWaitMs
              ? formatWaitTime(softQuotaWaitMs)
              : 'unknown'
            await showToast(
              `All accounts over ${threshold}% quota threshold. Resets in ${waitTimeFormatted}.`,
              'error',
            )
            return createSyntheticErrorResponse(
              `Quota protection: All ${accountCount} account(s) are over ${threshold}% usage for ${family}. ` +
                `Quota resets in ${waitTimeFormatted}. ` +
                `Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable.`,
              model ?? 'unknown',
            )
          }

          pushDebug(
            `all-over-soft-quota family=${family} accounts=${accountCount} waitMs=${softQuotaWaitMs}`,
          )

          if (!retryState.softQuotaToastShown()) {
            await showToast(
              `All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime(softQuotaWaitMs)}...`,
              'warning',
            )
            retryState.markSoftQuotaToastShown()
          }

          await sleep(softQuotaWaitMs, abortSignal)
          continue
        }

        const strictWait = !allowQuotaFallback
        const waitMs =
          accountManager.getMinWaitTimeForFamily(
            family,
            model,
            preferredHeaderStyle,
            strictWait,
          ) || 60_000

        pushDebug(
          `all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`,
        )
        if (isDebugEnabled()) {
          logAccountContext('All accounts rate-limited', {
            index: -1,
            family,
            totalAccounts: accountCount,
          })
          logRateLimitSnapshot(family, accountManager.getAccountsSnapshot())
        }

        const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000
        if (maxWaitMs > 0 && waitMs > maxWaitMs) {
          const waitTimeFormatted = formatWaitTime(waitMs)
          await showToast(
            `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
            'error',
          )
          return createSyntheticErrorResponse(
            `All ${accountCount} account(s) rate-limited for ${family}. ` +
              `Quota resets in ${waitTimeFormatted}. ` +
              `Add more accounts with \`opencode auth login\` or wait and retry.`,
            model ?? 'unknown',
          )
        }

        if (!retryState.rateLimitToastShown()) {
          const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000))
          await showToast(
            `All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`,
            'warning',
          )
          retryState.markRateLimitToastShown()
        }

        await sleep(waitMs, abortSignal)
        continue
      }

      // Account is available - reset the toast flag
      retryState.resetAllAccountsBlockedToasts()

      pushDebug(
        `selected idx=${account.index} email=${account.email ?? ''} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`,
      )

      if (previousAccountIndex >= 0 && previousAccountIndex !== account.index) {
        needsCacheWarmup = config.cache_warmup_on_switch
        pushDebug(
          `account-switch: ${previousAccountIndex} → ${account.index}, warmup=${needsCacheWarmup}`,
        )
      }
      previousAccountIndex = account.index
      accountManager.recordSessionUsage(account.index, accountSessionIdentity)
      if (isDebugEnabled()) {
        logAccountContext('Selected', {
          index: account.index,
          email: account.email,
          family,
          totalAccounts: accountCount,
          rateLimitState: account.rateLimitResetTimes,
        })
      }

      if (
        accountCount > 1 &&
        accountManager.shouldShowAccountToast(account.index)
      ) {
        const accountLabel = account.email || `Account ${account.index + 1}`
        const enabledAccounts = accountManager.getEnabledAccounts()
        const enabledPosition =
          enabledAccounts.findIndex((a) => a.index === account.index) + 1
        await showToast(
          `Using ${accountLabel} (${enabledPosition}/${accountCount})`,
          'info',
        )
        accountManager.markToastShown(account.index)
      }

      accountManager.requestSaveToDisk()

      let authRecord = accountManager.toAuthDetails(account)

      if (accessTokenExpired(authRecord)) {
        try {
          const refreshed = await refreshAccessToken(
            authRecord,
            client,
            providerId,
          )
          if (!refreshed) {
            const { failures, shouldCooldown, cooldownMs } =
              retryState.trackAccountFailure(account.index)
            getHealthTracker().recordFailure(account.index)
            lastError = new Error('Antigravity token refresh failed')
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(
                account,
                cooldownMs,
                'auth-failure',
              )
              accountManager.markRateLimited(
                account,
                cooldownMs,
                family,
                'antigravity',
                model,
              )
              pushDebug(
                `token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`,
              )
            }
            continue
          }
          retryState.resetAccountFailureState(account.index)
          accountManager.updateFromAuth(account, refreshed)
          authRecord = refreshed
          try {
            await accountManager.saveToDisk()
          } catch (error) {
            log.error('Failed to persist refreshed auth', {
              error: String(error),
            })
          }
        } catch (error) {
          if (
            error instanceof AntigravityTokenRefreshError &&
            error.code === 'invalid_grant'
          ) {
            const removed = accountManager.removeAccount(account)
            if (removed) {
              log.warn(
                'Removed revoked account from pool - reauthenticate via `opencode auth login`',
              )
              try {
                await accountManager.saveToDiskReplace()
              } catch (persistError) {
                log.error('Failed to persist revoked account removal', {
                  error: String(persistError),
                })
              }
            }

            if (accountManager.getAccountCount() === 0) {
              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: { type: 'oauth', refresh: '', access: '', expires: 0 },
                })
              } catch (storeError) {
                log.error(
                  'Failed to clear stored Antigravity OAuth credentials',
                  {
                    error: String(storeError),
                  },
                )
              }

              return createNoAccountResponse(
                'All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.',
                model ?? 'unknown',
              )
            }

            lastError = error
            continue
          }

          const { failures, shouldCooldown, cooldownMs } =
            retryState.trackAccountFailure(account.index)
          getHealthTracker().recordFailure(account.index)
          lastError = error instanceof Error ? error : new Error(String(error))
          if (shouldCooldown) {
            accountManager.markAccountCoolingDown(
              account,
              cooldownMs,
              'auth-failure',
            )
            accountManager.markRateLimited(
              account,
              cooldownMs,
              family,
              'antigravity',
              model,
            )
            pushDebug(
              `token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`,
            )
          }
          continue
        }
      }

      const accessToken = authRecord.access
      if (!accessToken) {
        lastError = new Error('Missing access token')
        if (accountCount <= 1) {
          return createSyntheticErrorResponse(
            'Missing access token. Run `opencode auth login` to reauthenticate.',
            model ?? 'unknown',
          )
        }
        continue
      }

      let projectContext: ProjectContextResult
      try {
        projectContext = await ensureProjectContext(authRecord)
        retryState.resetAccountFailureState(account.index)
      } catch (error) {
        const { failures, shouldCooldown, cooldownMs } =
          retryState.trackAccountFailure(account.index)
        getHealthTracker().recordFailure(account.index)
        lastError = error instanceof Error ? error : new Error(String(error))
        if (shouldCooldown) {
          accountManager.markAccountCoolingDown(
            account,
            cooldownMs,
            'project-error',
          )
          accountManager.markRateLimited(
            account,
            cooldownMs,
            family,
            'antigravity',
            model,
          )
          pushDebug(
            `project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`,
          )
        }
        continue
      }

      if (
        projectContext.auth.refresh !== authRecord.refresh ||
        projectContext.auth.access !== authRecord.access
      ) {
        accountManager.updateFromAuth(account, projectContext.auth)
        authRecord = projectContext.auth
        try {
          await accountManager.saveToDisk()
        } catch (error) {
          log.error('Failed to persist project context', {
            error: String(error),
          })
        }
      }

      const runThinkingWarmup = async (
        prepared: ReturnType<typeof prepareAntigravityRequest>,
        projectId: string,
      ): Promise<void> => {
        if (!config.thinking_warmup) return
        if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) return
        if (!warmupState.trackAttempt(prepared.sessionId)) return

        const warmupBody = buildThinkingWarmupBody(
          typeof prepared.init.body === 'string'
            ? prepared.init.body
            : undefined,
          Boolean(
            prepared.effectiveModel?.toLowerCase().includes('claude') &&
              prepared.effectiveModel?.toLowerCase().includes('thinking'),
          ),
        )
        if (!warmupBody) return

        const warmupUrl = toWarmupStreamUrl(prepared.request)
        const warmupHeaders = new Headers(prepared.init.headers ?? {})
        warmupHeaders.set('accept', 'text/event-stream')

        const warmupInit: RequestInit = {
          ...prepared.init,
          method: prepared.init.method ?? 'POST',
          headers: warmupHeaders,
          body: warmupBody,
        }

        const warmupDebugContext = startAntigravityDebugRequest({
          originalUrl: warmupUrl,
          resolvedUrl: warmupUrl,
          method: warmupInit.method,
          headers: warmupHeaders,
          body: warmupBody,
          streaming: true,
          projectId,
        })

        try {
          pushDebug('thinking-warmup: start')
          const warmupResponse =
            prepared.headerStyle === 'antigravity'
              ? await fetchWithAgyCliTransport(warmupUrl, warmupInit, {
                  signal: abortSignal,
                  onDebug: pushDebug,
                })
              : await upstreamFetch(warmupUrl, warmupInit)
          const transformed = await transformAntigravityResponse(
            warmupResponse,
            true,
            warmupDebugContext,
            prepared.requestedModel,
            projectId,
            warmupUrl,
            prepared.effectiveModel,
            prepared.sessionId,
          )
          await transformed.text()
          warmupState.markSuccess(prepared.sessionId)
          pushDebug('thinking-warmup: done')
        } catch (error) {
          warmupState.clearWarmupAttempt(prepared.sessionId)
          pushDebug(
            `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const runCacheWarmupProbe = async (
        prepared: ReturnType<typeof prepareAntigravityRequest>,
      ): Promise<void> => {
        if (!needsCacheWarmup) return
        needsCacheWarmup = false

        const bodyStr =
          typeof prepared.init.body === 'string'
            ? prepared.init.body
            : undefined
        if (!bodyStr) return

        try {
          pushDebug('cache-warmup-probe: start')

          const probeInit = {
            ...prepared.init,
            method: 'POST' as const,
            body: bodyStr,
          }
          const probeResponse =
            prepared.headerStyle === 'antigravity'
              ? await fetchWithAgyCliTransport(
                  toUrlString(prepared.request),
                  probeInit,
                  {
                    signal: abortSignal,
                    onDebug: pushDebug,
                  },
                )
              : await upstreamFetch(toUrlString(prepared.request), probeInit)

          if (probeResponse.body) {
            const reader = probeResponse.body.getReader()
            await reader.read()
            await reader.cancel()
          }

          const status = probeResponse.status
          if (status >= 400) {
            let errorSnippet = ''
            try {
              const errText = await probeResponse.text().catch(() => '')
              errorSnippet = errText.slice(0, 200)
            } catch {
              /* ignore */
            }
            pushDebug(
              `cache-warmup-probe: done status=${status}${errorSnippet ? ` error=${errorSnippet}` : ''}`,
            )
          } else {
            pushDebug(
              `cache-warmup-probe: done status=${status} (aborted after first chunk)`,
            )
          }
        } catch (error) {
          pushDebug(
            `cache-warmup-probe: failed ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      let apiRequestCount = 0
      let shouldSwitchAccount = false
      let headerStyle = preferredHeaderStyle
      pushDebug(`headerStyle=${headerStyle} explicit=${explicitQuota}`)
      if (account.fingerprint) {
        pushDebug(
          `fingerprint: deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`,
        )
      }

      if (
        accountManager.isRateLimitedForHeaderStyle(
          account,
          family,
          headerStyle,
          model,
        )
      ) {
        if (
          allowQuotaFallback &&
          family === 'gemini' &&
          headerStyle === 'antigravity'
        ) {
          if (
            accountManager.hasOtherAccountWithAntigravityAvailable(
              account.index,
              family,
              model,
            )
          ) {
            pushDebug(
              `antigravity rate-limited on account ${account.index}, but available on other accounts. Switching.`,
            )
            shouldSwitchAccount = true
          } else {
            const alternateStyle = accountManager.getAvailableHeaderStyle(
              account,
              family,
              model,
            )
            const fallbackStyle = resolveQuotaFallbackHeaderStyle({
              family,
              headerStyle,
              alternateStyle,
            })
            if (fallbackStyle) {
              await showToast(
                `Antigravity quota exhausted on all accounts. Using Gemini CLI quota.`,
                'warning',
              )
              headerStyle = fallbackStyle
              pushDebug(
                `all-accounts antigravity exhausted, quota fallback: ${headerStyle}`,
              )
            } else {
              shouldSwitchAccount = true
            }
          }
        } else if (allowQuotaFallback && family === 'gemini') {
          const alternateStyle = accountManager.getAvailableHeaderStyle(
            account,
            family,
            model,
          )
          const fallbackStyle = resolveQuotaFallbackHeaderStyle({
            family,
            headerStyle,
            alternateStyle,
          })
          if (fallbackStyle) {
            const quotaName =
              headerStyle === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity'
            const altQuotaName =
              fallbackStyle === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity'
            await showToast(
              `${quotaName} quota exhausted, using ${altQuotaName} quota`,
              'warning',
            )
            headerStyle = fallbackStyle
            pushDebug(`quota fallback: ${headerStyle}`)
          } else {
            shouldSwitchAccount = true
          }
        } else {
          shouldSwitchAccount = true
        }
      }

      let totalCapacityRetries = 0

      while (!shouldSwitchAccount) {
        let forceThinkingRecovery = false
        let tokenConsumed = false
        let capacityRetryCount = 0
        let lastEndpointIndex = -1

        for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
          if (i !== lastEndpointIndex) {
            capacityRetryCount = 0
            lastEndpointIndex = i
          }

          const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i]

          if (
            headerStyle === 'gemini-cli' &&
            currentEndpoint !== 'https://cloudcode-pa.googleapis.com'
          ) {
            pushDebug(
              `Skipping sandbox endpoint ${currentEndpoint} for gemini-cli headerStyle`,
            )
            continue
          }

          try {
            const prepared = prepareAntigravityRequest(
              input,
              init,
              accessToken,
              projectContext.effectiveProjectId,
              currentEndpoint,
              headerStyle,
              forceThinkingRecovery,
              {
                claudeToolHardening: config.claude_tool_hardening,
                claudePromptAutoCaching: config.claude_prompt_auto_caching,
                fingerprint: account.fingerprint,
                agySession: agyRequestSession,
                agyRequestTimestamp: agyRequestScope.timestamp,
              },
            )

            const originalUrl = toUrlString(input)
            const resolvedUrl = toUrlString(prepared.request)
            pushDebug(`endpoint=${currentEndpoint}`)
            pushDebug(`resolved=${resolvedUrl}`)
            const debugContext = startAntigravityDebugRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              projectId: projectContext.effectiveProjectId,
            })
            const dumpContext = dumpGeminiRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              requestedModel: prepared.requestedModel,
              effectiveModel: prepared.effectiveModel,
              sessionId: prepared.sessionId,
              projectId: projectContext.effectiveProjectId,
            })

            const createFailureContext = (
              failureResponse: Response,
            ): FailureContext => ({
              response: failureResponse,
              streaming: prepared.streaming,
              debugContext,
              requestedModel: prepared.requestedModel,
              projectId: prepared.projectId,
              endpoint: prepared.endpoint,
              effectiveModel: prepared.effectiveModel,
              sessionId: prepared.sessionId,
              toolDebugMissing: prepared.toolDebugMissing,
              toolDebugSummary: prepared.toolDebugSummary,
              toolDebugPayload: prepared.toolDebugPayload,
              dumpContext,
            })

            await runThinkingWarmup(prepared, projectContext.effectiveProjectId)
            await runCacheWarmupProbe(prepared)

            if (config.request_jitter_max_ms > 0) {
              const jitterMs = Math.floor(
                Math.random() * config.request_jitter_max_ms,
              )
              if (jitterMs > 0) {
                await sleep(jitterMs, abortSignal)
              }
            }

            if (config.account_selection_strategy === 'hybrid') {
              tokenConsumed = getTokenTracker().consume(account.index)
            }

            pushDebug(
              `dispatching request via ${prepared.headerStyle} transport`,
            )
            const response =
              prepared.headerStyle === 'antigravity'
                ? await fetchWithAgyCliTransport(
                    toUrlString(prepared.request),
                    prepared.init,
                    { signal: abortSignal, onDebug: pushDebug },
                  )
                : await upstreamFetch(prepared.request, prepared.init)
            apiRequestCount++
            accountManager.recordRequest(account.index, family)
            const requestCounts = accountManager.getDailyRequestCounts(
              account.index,
            )
            if (requestCounts) {
              pushDebug(
                `[Quota] account=${account.index} ${family}_today=${requestCounts[family]} total_${family}_today=${accountManager.getTotalDailyRequests(family)}`,
              )
            }
            pushDebug(
              `status=${response.status} ${response.statusText} (api_request #${apiRequestCount})`,
            )
            noteGeminiDumpResponse(dumpContext, response)

            // Record the final route selection so the sidebar renders the
            // actual account/header-style used by this request. Fire-and-
            // forget — the dispatch path must not wait on a state write.
            const sessionKey = requestSessionIdentity.sessionId
            if (sessionKey) {
              const routingEntry: SidebarRoutingEntry = {
                accountId: `acct-${account.index}`,
                modelFamily: family,
                headerStyle: prepared.headerStyle,
                updatedAt: Date.now(),
              }
              void upsertSidebarActiveRouting(sessionKey, routingEntry, {
                authoritative: true,
              }).catch((error: unknown) => {
                log.debug('sidebar-routing-upsert-failed', {
                  sessionId: sessionKey,
                  error: String(error),
                })
              })
            }

            if (
              response.status === 429 ||
              response.status === 503 ||
              response.status === 529
            ) {
              if (tokenConsumed) {
                getTokenTracker().refund(account.index)
                tokenConsumed = false
              }

              const defaultRetryMs =
                (config.default_retry_after_seconds ?? 60) * 1000
              const _maxBackoffMs = (config.max_backoff_seconds ?? 60) * 1000
              const headerRetryMs = retryAfterMsFromResponse(
                response,
                defaultRetryMs,
              )
              const bodyInfo = await (async () => {
                try {
                  const text = await response.clone().text()
                  try {
                    return JSON.parse(text) as unknown
                  } catch {
                    return null
                  }
                } catch {
                  return null
                }
              })()
              const reasonInfo = bodyInfo
                ? extractRateLimitBodyInfo(bodyInfo)
                : { retryDelayMs: null as number | null }
              const serverRetryMs = reasonInfo.retryDelayMs ?? headerRetryMs

              const rateLimitReason = parseRateLimitReason(
                reasonInfo.reason,
                reasonInfo.message,
                response.status,
              )

              if (
                rateLimitReason === 'MODEL_CAPACITY_EXHAUSTED' ||
                rateLimitReason === 'SERVER_ERROR'
              ) {
                totalCapacityRetries++
                if (isCapacityRetryBudgetExhausted(totalCapacityRetries)) {
                  pushDebug(
                    `Total capacity retries (${MAX_TOTAL_CAPACITY_RETRIES}) exhausted, switching account`,
                  )
                  lastFailure = createFailureContext(response)
                  shouldSwitchAccount = true
                  break
                }

                const baseDelayMs = 1000
                const maxDelayMs = 8000
                const exponentialDelay = Math.min(
                  baseDelayMs * 2 ** capacityRetryCount,
                  maxDelayMs,
                )
                const jitter = exponentialDelay * (0.9 + Math.random() * 0.2)
                const waitMs = Math.round(jitter)
                const waitSec = Math.round(waitMs / 1000)

                pushDebug(
                  `Server busy (${rateLimitReason}) on account ${account.index}, exponential backoff ${waitMs}ms (attempt ${capacityRetryCount + 1}, total ${totalCapacityRetries}/${MAX_TOTAL_CAPACITY_RETRIES})`,
                )

                await showToast(
                  `⏳ Server busy (${response.status}). Retrying in ${waitSec}s...`,
                  'warning',
                )

                await sleep(waitMs, abortSignal)

                if (capacityRetryCount < 1) {
                  capacityRetryCount++
                  i -= 1
                  continue
                } else {
                  pushDebug(
                    `Max capacity retries (1) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`,
                  )
                  const newFingerprint =
                    accountManager.regenerateAccountFingerprint(account.index)
                  if (newFingerprint) {
                    pushDebug(
                      `Fingerprint regenerated for account ${account.index}`,
                    )
                  }
                  continue
                }
              }

              const quotaKey = retryState.headerStyleToQuotaKey(
                headerStyle,
                family,
              )
              const backoff: RateLimitBackoffResult =
                retryState.getRateLimitBackoff(
                  account.index,
                  quotaKey,
                  serverRetryMs,
                )

              const smartBackoffMs = calculateBackoffMs(
                rateLimitReason,
                account.consecutiveFailures ?? 0,
                serverRetryMs,
              )
              const effectiveDelayMs = Math.max(backoff.delayMs, smartBackoffMs)

              pushDebug(
                `429 idx=${account.index} email=${account.email ?? ''} family=${family} delayMs=${effectiveDelayMs} attempt=${backoff.attempt} reason=${rateLimitReason}`,
              )
              if (reasonInfo.message)
                pushDebug(`429 message=${reasonInfo.message}`)
              if (reasonInfo.quotaResetTime)
                pushDebug(`429 quotaResetTime=${reasonInfo.quotaResetTime}`)
              if (reasonInfo.reason)
                pushDebug(`429 reason=${reasonInfo.reason}`)

              logRateLimitEvent(
                account.index,
                account.email,
                family,
                response.status,
                effectiveDelayMs,
                reasonInfo,
              )
              await logResponseBody(debugContext, response, 429)
              getHealthTracker().recordRateLimit(account.index)

              const _accountLabel =
                account.email || `Account ${account.index + 1}`

              if (
                backoff.attempt === 1 &&
                rateLimitReason !== 'QUOTA_EXHAUSTED'
              ) {
                await showToast(`Rate limited. Quick retry in 1s...`, 'warning')
                await sleep(FIRST_RETRY_DELAY_MS, abortSignal)

                if (config.scheduling_mode === 'cache_first') {
                  const maxCacheFirstWaitMs =
                    config.max_cache_first_wait_seconds * 1000
                  if (effectiveDelayMs <= maxCacheFirstWaitMs) {
                    pushDebug(
                      `cache_first: waiting ${effectiveDelayMs}ms for same account to recover`,
                    )
                    await showToast(
                      `⏳ Waiting ${Math.ceil(effectiveDelayMs / 1000)}s for same account (prompt cache preserved)...`,
                      'info',
                    )
                    accountManager.markRateLimitedWithReason(
                      account,
                      family,
                      headerStyle,
                      model,
                      rateLimitReason,
                      serverRetryMs,
                    )
                    await sleep(effectiveDelayMs, abortSignal)
                    i -= 1
                    continue
                  }
                  pushDebug(
                    `cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`,
                  )
                }

                if (config.switch_on_first_rate_limit && accountCount > 1) {
                  accountManager.markRateLimitedWithReason(
                    account,
                    family,
                    headerStyle,
                    model,
                    rateLimitReason,
                    serverRetryMs,
                    config.failure_ttl_seconds * 1000,
                  )
                  shouldSwitchAccount = true
                  break
                }

                i -= 1
                continue
              }

              accountManager.markRateLimitedWithReason(
                account,
                family,
                headerStyle,
                model,
                rateLimitReason,
                serverRetryMs,
                config.failure_ttl_seconds * 1000,
              )
              accountManager.requestSaveToDisk()

              const switchAccountDelayMs = config.switch_account_delay_ms ?? 500

              if (family === 'gemini') {
                if (headerStyle === 'antigravity') {
                  if (hasOtherAccountWithAntigravity(account)) {
                    pushDebug(
                      `antigravity exhausted on account ${account.index}, but available on others. Switching account.`,
                    )
                    await showToast(
                      `Rate limited again. Switching account in ${formatWaitTime(switchAccountDelayMs)}...`,
                      'warning',
                    )
                    await sleep(switchAccountDelayMs, abortSignal)
                    shouldSwitchAccount = true
                    break
                  }

                  if (allowQuotaFallback) {
                    const alternateStyle =
                      accountManager.getAvailableHeaderStyle(
                        account,
                        family,
                        model,
                      )
                    const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                      family,
                      headerStyle,
                      alternateStyle,
                    })
                    if (fallbackStyle) {
                      const safeModelName = model || 'this model'
                      await showToast(
                        `Antigravity quota exhausted for ${safeModelName}. Switching to Gemini CLI quota...`,
                        'warning',
                      )
                      headerStyle = fallbackStyle
                      pushDebug(`quota fallback: ${headerStyle}`)
                      continue
                    }
                  }
                } else if (headerStyle === 'gemini-cli') {
                  if (allowQuotaFallback) {
                    const alternateStyle =
                      accountManager.getAvailableHeaderStyle(
                        account,
                        family,
                        model,
                      )
                    const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                      family,
                      headerStyle,
                      alternateStyle,
                    })
                    if (fallbackStyle) {
                      const safeModelName = model || 'this model'
                      await showToast(
                        `Gemini CLI quota exhausted for ${safeModelName}. Switching to Antigravity quota...`,
                        'warning',
                      )
                      headerStyle = fallbackStyle
                      pushDebug(`quota fallback: ${headerStyle}`)
                      continue
                    }
                  }
                }
              }

              if (accountCount > 1) {
                const quotaMsg = reasonInfo.quotaResetTime
                  ? ` (quota resets ${reasonInfo.quotaResetTime})`
                  : ``
                await showToast(
                  `Rate limited again. Switching account in ${formatWaitTime(switchAccountDelayMs)}...${quotaMsg}`,
                  'warning',
                )
                await sleep(switchAccountDelayMs, abortSignal)
              } else {
                const expBackoffMs = Math.min(
                  FIRST_RETRY_DELAY_MS * 2 ** (backoff.attempt - 1),
                  60000,
                )
                const expBackoffFormatted =
                  expBackoffMs >= 1000
                    ? `${Math.round(expBackoffMs / 1000)}s`
                    : `${expBackoffMs}ms`
                await showToast(
                  `Rate limited. Retrying in ${expBackoffFormatted} (attempt ${backoff.attempt})...`,
                  'warning',
                )
                await sleep(expBackoffMs, abortSignal)
              }

              lastFailure = createFailureContext(response)
              shouldSwitchAccount = true
              break
            }

            const quotaKey = retryState.headerStyleToQuotaKey(
              headerStyle,
              family,
            )
            retryState.resetRateLimitState(account.index, quotaKey)
            retryState.resetAccountFailureState(account.index)

            if (response.status === 403) {
              const errorBodyText = await response
                .clone()
                .text()
                .catch(() => '')
              const extracted = extractAccountAccessErrorDetails(errorBodyText)

              if (extracted.accountIneligible) {
                const ineligibleReason =
                  extracted.message ??
                  'Google marked this account as ineligible for Antigravity.'
                accountManager.markAccountIneligible(
                  account.index,
                  ineligibleReason,
                )

                const label = account.email || `Account ${account.index + 1}`
                if (
                  accountManager.shouldShowAccountToast(account.index, 60000)
                ) {
                  await showToast(
                    `${label} is not eligible for Antigravity and has been disabled. ` +
                      'Recheck it from opencode auth login > Verify accounts.',
                    'warning',
                  )
                  accountManager.markToastShown(account.index)
                }

                pushDebug(
                  `account-ineligible: disabled account ${account.index}`,
                )
                getHealthTracker().recordFailure(account.index)
                lastFailure = createFailureContext(response)
                shouldSwitchAccount = true
                break
              }

              if (extracted.validationRequired) {
                const verificationReason =
                  extracted.message ?? 'Google requires account verification.'
                const cooldownMs = 10 * 60 * 1000

                accountManager.markAccountVerificationRequired(
                  account.index,
                  verificationReason,
                  extracted.verifyUrl,
                )
                accountManager.markAccountCoolingDown(
                  account,
                  cooldownMs,
                  'validation-required',
                )
                accountManager.markRateLimited(
                  account,
                  cooldownMs,
                  family,
                  headerStyle,
                  model,
                )

                const label = account.email || `Account ${account.index + 1}`
                if (
                  accountManager.shouldShowAccountToast(account.index, 60000)
                ) {
                  await showToast(
                    `⚠ ${label} needs verification. Run 'opencode auth login' and use Verify accounts.`,
                    'warning',
                  )
                  accountManager.markToastShown(account.index)
                }

                pushDebug(
                  `verification-required: disabled account ${account.index}`,
                )
                getHealthTracker().recordFailure(account.index)
                lastFailure = createFailureContext(response)
                shouldSwitchAccount = true
                break
              }
            }

            const shouldRetryEndpoint =
              response.status === 403 ||
              response.status === 404 ||
              response.status >= 500

            if (
              shouldRetryEndpoint &&
              i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
            ) {
              await logResponseBody(debugContext, response, response.status)
              lastFailure = createFailureContext(response)
              continue
            }

            if (response.ok) {
              account.consecutiveFailures = 0
              getHealthTracker().recordSuccess(account.index)
              accountManager.markAccountUsed(account.index)

              void triggerAsyncQuotaRefreshForAccount(
                account.index,
                config.quota_refresh_interval_minutes,
              )

              const proactiveThreshold =
                config.proactive_rotation_threshold_percent ?? 20
              if (
                proactiveThreshold > 0 &&
                accountManager.shouldProactivelyRotate(
                  family,
                  model,
                  proactiveThreshold,
                  softQuotaCacheTtlMs,
                  accountSessionIdentity,
                )
              ) {
                const rotated = accountManager.proactivelyRotateForFamily(
                  family,
                  model,
                  headerStyle,
                  config.soft_quota_threshold_percent,
                  softQuotaCacheTtlMs,
                  accountSessionIdentity,
                )
                if (rotated) {
                  const remaining =
                    account.cachedQuota?.[resolveQuotaGroup(family, model)]
                      ?.remainingFraction
                  const remainingPct =
                    remaining != null ? `${(remaining * 100).toFixed(1)}%` : '?'
                  pushDebug(
                    `[ProactiveRotation] account ${account.index} quota ${remainingPct} < ${proactiveThreshold}%, pre-switched to account ${rotated.index} for next request`,
                  )
                  pushDebug(
                    `[ProactiveRotation] ${account.index} → ${rotated.index}` +
                      ` (warm=${accountManager.wasUsedInSession(rotated.index, accountSessionIdentity)})`,
                  )
                }
              }
            }
            logAntigravityDebugResponse(debugContext, response, {
              note: response.ok ? 'Success' : `Error ${response.status}`,
            })
            if (response.ok && !prepared.streaming) {
              await logResponseBody(debugContext, response, response.status)
            }
            if (!response.ok) {
              await logResponseBody(debugContext, response, response.status)

              if (response.status === 400) {
                const cloned = response.clone()
                const bodyText = await cloned.text()
                if (
                  bodyText.includes('Prompt is too long') ||
                  bodyText.includes('prompt_too_long')
                ) {
                  await showToast(
                    'Context too long - use /compact to reduce size',
                    'warning',
                  )
                  const errorMessage = `[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.\n\nAlternatively, you can:\n- Use /clear to start fresh\n- Use /undo to remove recent messages\n- Switch to a model with larger context window`
                  return createSyntheticErrorResponse(
                    errorMessage,
                    prepared.requestedModel,
                  )
                }
              }
            }

            if (response.ok && !prepared.streaming) {
              const maxAttempts = config.empty_response_max_attempts ?? 4
              const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000

              const clonedForCheck = response.clone()
              const bodyText = await clonedForCheck.text()

              if (isEmptyResponseBody(bodyText)) {
                const emptyAttemptKey = `${prepared.sessionId ?? 'none'}:${prepared.effectiveModel ?? 'unknown'}`
                const currentAttempts =
                  retryState.recordEmptyResponseAttempt(emptyAttemptKey)

                pushDebug(
                  `empty-response: attempt ${currentAttempts}/${maxAttempts}`,
                )

                if (currentAttempts < maxAttempts) {
                  await showToast(
                    `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                    'warning',
                  )
                  await sleep(retryDelayMs, abortSignal)
                  continue
                }

                retryState.clearEmptyResponseAttempts()
                return createSyntheticErrorResponse(
                  `Empty response after ${currentAttempts} attempts for model ${prepared.effectiveModel ?? 'unknown'}.`,
                  prepared.effectiveModel ?? 'unknown',
                )
              }

              const _emptyAttemptKeyClean = `${prepared.sessionId ?? 'none'}:${prepared.effectiveModel ?? 'unknown'}`
              retryState.clearEmptyResponseAttempts()
            }

            const transformedResponse = await transformAntigravityResponse(
              response,
              prepared.streaming,
              debugContext,
              prepared.requestedModel,
              prepared.projectId,
              prepared.endpoint,
              prepared.effectiveModel,
              prepared.sessionId,
              prepared.toolDebugMissing,
              prepared.toolDebugSummary,
              prepared.toolDebugPayload,
              debugLines,
              dumpContext,
            )

            const contextError = transformedResponse.headers.get(
              'x-antigravity-context-error',
            )
            if (contextError) {
              if (contextError === 'prompt_too_long') {
                await showToast(
                  'Context too long - use /compact to reduce size, or trim your request',
                  'warning',
                )
              } else if (contextError === 'tool_pairing') {
                await showToast(
                  'Tool call/result mismatch - use /compact to fix, or /undo last message',
                  'warning',
                )
              }
            }

            if (apiRequestCount > 1) {
              pushDebug(
                `[Quota] Total API requests for this user message: ${apiRequestCount} (${apiRequestCount - 1} retries)`,
              )
            }
            const dailyCounts = accountManager.getDailyRequestCounts(
              account.index,
            )
            if (dailyCounts) {
              pushDebug(
                `[Quota] Account ${account.index} (${account.email ?? 'unknown'}) today: claude=${dailyCounts.claude} gemini=${dailyCounts.gemini}`,
              )
            }
            const totalToday = accountManager.getTotalDailyRequests(family)
            pushDebug(
              `[Quota] Total ${family} requests today (all accounts): ${totalToday}`,
            )

            const cachedQuota = account.cachedQuota
            if (cachedQuota) {
              const quotaFamily = resolveQuotaGroup(family, model)
              const groupQuota = cachedQuota[quotaFamily]
              if (groupQuota?.remainingFraction != null) {
                const pct = Math.round(groupQuota.remainingFraction * 100)
                pushDebug(
                  `[Quota] Account ${account.index} cached ${quotaFamily} remaining: ${pct}%${groupQuota.resetTime ? ` (resets ${groupQuota.resetTime})` : ''}`,
                )
              }
            }

            const sessionSummary = accountManager.getSessionSummary()
            if (sessionSummary.durationMinutes >= 1) {
              const familyTotal =
                family === 'claude'
                  ? sessionSummary.totalClaude
                  : sessionSummary.totalGemini
              if (familyTotal > 0) {
                const ratePerHour = sessionSummary.requestsPerHour
                pushDebug(
                  `[Quota] Session: ${sessionSummary.durationMinutes}min, ${familyTotal} ${family} reqs, ~${ratePerHour} reqs/hr, ${sessionSummary.accountsUsed} accounts used`,
                )
              }
            }

            return transformedResponse
          } catch (error) {
            if (tokenConsumed) {
              getTokenTracker().refund(account.index)
              tokenConsumed = false
            }

            if (
              error instanceof Error &&
              error.message === 'THINKING_RECOVERY_NEEDED'
            ) {
              if (!forceThinkingRecovery) {
                pushDebug(
                  'thinking-recovery: API error detected, retrying with forced recovery',
                )
                forceThinkingRecovery = true
                i = -1
                continue
              }

              const recoveryError = error as any
              const originalError = recoveryError.originalError || {
                error: { message: 'Thinking recovery triggered' },
              }

              const recoveryMessage = `${originalError.error?.message || 'Session recovery failed'}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`

              return new Response(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'unrecoverable_error',
                    message: recoveryMessage,
                  },
                }),
                {
                  status: 400,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }

            if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
              lastError =
                error instanceof Error ? error : new Error(String(error))
              continue
            }

            const { failures, shouldCooldown, cooldownMs } =
              retryState.trackAccountFailure(account.index)
            lastError =
              error instanceof Error ? error : new Error(String(error))
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(
                account,
                cooldownMs,
                'network-error',
              )
              accountManager.markRateLimited(
                account,
                cooldownMs,
                family,
                headerStyle,
                model,
              )
              pushDebug(
                `endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`,
              )
            }
            shouldSwitchAccount = true
            break
          }
        }
      }

      if (shouldSwitchAccount) {
        accountSwitchCount++

        if (accountSwitchCount > maxAccountSwitches) {
          pushDebug(
            `account-switch-cap: exceeded max_account_switches=${maxAccountSwitches}, giving up`,
          )
          if (lastFailure) {
            return transformAntigravityResponse(
              lastFailure.response,
              lastFailure.streaming,
              lastFailure.debugContext,
              lastFailure.requestedModel,
              lastFailure.projectId,
              lastFailure.endpoint,
              lastFailure.effectiveModel,
              lastFailure.sessionId,
              lastFailure.toolDebugMissing,
              lastFailure.toolDebugSummary,
              lastFailure.toolDebugPayload,
              debugLines,
              lastFailure.dumpContext,
            )
          }
          return createSyntheticErrorResponse(
            lastError?.message ||
              `Exceeded max account switches (${maxAccountSwitches}). All accounts rate-limited.`,
            model ?? 'unknown',
          )
        }

        if (accountCount <= 1) {
          if (lastFailure) {
            return transformAntigravityResponse(
              lastFailure.response,
              lastFailure.streaming,
              lastFailure.debugContext,
              lastFailure.requestedModel,
              lastFailure.projectId,
              lastFailure.endpoint,
              lastFailure.effectiveModel,
              lastFailure.sessionId,
              lastFailure.toolDebugMissing,
              lastFailure.toolDebugSummary,
              lastFailure.toolDebugPayload,
              debugLines,
              lastFailure.dumpContext,
            )
          }
          return createSyntheticErrorResponse(
            lastError?.message || 'All Antigravity endpoints failed',
            model ?? 'unknown',
          )
        }

        continue
      }

      if (lastFailure) {
        return transformAntigravityResponse(
          lastFailure.response,
          lastFailure.streaming,
          lastFailure.debugContext,
          lastFailure.requestedModel,
          lastFailure.projectId,
          lastFailure.endpoint,
          lastFailure.effectiveModel,
          lastFailure.sessionId,
          lastFailure.toolDebugMissing,
          lastFailure.toolDebugSummary,
          lastFailure.toolDebugPayload,
          debugLines,
          lastFailure.dumpContext,
        )
      }

      return createSyntheticErrorResponse(
        lastError?.message || 'All Antigravity accounts failed',
        model ?? 'unknown',
      )
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    retryState.dispose()
    warmupState.dispose()
  }

  return { fetch, dispose }
}

interface RateLimitBodyInfo {
  retryDelayMs: number | null
  message?: string
  quotaResetTime?: string
  reason?: string
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== 'object') return { retryDelayMs: null }

  const error = (body as { error?: unknown }).error
  const message =
    error && typeof error === 'object'
      ? (error as { message?: string }).message
      : undefined

  const details =
    error && typeof error === 'object'
      ? (error as { details?: unknown[] }).details
      : undefined

  let reason: string | undefined
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const type = (detail as { '@type'?: string })['@type']
      if (typeof type === 'string' && type.includes('google.rpc.ErrorInfo')) {
        const detailReason = (detail as { reason?: string }).reason
        if (typeof detailReason === 'string') {
          reason = detailReason
          break
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const type = (detail as { '@type'?: string })['@type']
      if (typeof type === 'string' && type.includes('google.rpc.RetryInfo')) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay
        if (typeof retryDelay === 'string') {
          const retryDelayMs = parseDurationToMs(retryDelay)
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason }
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const metadata = (detail as { metadata?: Record<string, string> })
        .metadata
      if (metadata && typeof metadata === 'object') {
        const quotaResetDelay = metadata.quotaResetDelay
        const quotaResetTime = metadata.quotaResetTimeStamp
        if (typeof quotaResetDelay === 'string') {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay)
          if (quotaResetDelayMs !== null) {
            return {
              retryDelayMs: quotaResetDelayMs,
              message,
              quotaResetTime,
              reason,
            }
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i)
    const rawDuration = afterMatch?.[1]
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration)
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason }
      }
    }
  }

  return { retryDelayMs: null, message, reason }
}

function parseDurationToMs(duration: string): number | null {
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!)
    const unit = (simpleMatch[2] || 's').toLowerCase()
    switch (unit) {
      case 'h':
        return value * 3600 * 1000
      case 'm':
        return value * 60 * 1000
      case 's':
        return value * 1000
      case 'ms':
        return value
      default:
        return value * 1000
    }
  }

  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi
  let totalMs = 0
  let matchFound = false
  let match: RegExpExecArray | null = null

  while (true) {
    match = compoundRegex.exec(duration)
    if (match === null) break
    matchFound = true
    const value = parseFloat(match[1]!)
    const unit = match[2]?.toLowerCase()
    switch (unit) {
      case 'h':
        totalMs += value * 3600 * 1000
        break
      case 'm':
        totalMs += value * 60 * 1000
        break
      case 's':
        totalMs += value * 1000
        break
      case 'ms':
        totalMs += value
        break
    }
  }

  return matchFound ? totalMs : null
}
