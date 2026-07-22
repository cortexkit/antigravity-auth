import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_PROVIDER_ID,
  type HeaderStyle,
} from './constants'
import { createAutoUpdateCheckerHook } from './hooks/auto-update-checker'
import {
  createAccountAccessService,
  extractAccountAccessErrorDetails,
  promptAccountIndexForVerification,
  promptOpenVerificationUrl,
} from './plugin/account-access'
import {
  type AccountManager,
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  type ModelFamily,
  parseRateLimitReason,
  resolveQuotaGroup,
} from './plugin/accounts'
import { fetchWithAgyCliTransport } from './plugin/agy-transport'
import { accessTokenExpired, isOAuthAuth } from './plugin/auth'
import { createAuthLoader } from './plugin/auth-loader'
import {
  initDiskSignatureCache,
  shutdownDiskSignatureCache,
} from './plugin/cache'
import { applyAntigravityProviderCatalog } from './plugin/catalog'
import {
  createCommandExecuteBefore,
  registerAntigravityCommands,
} from './plugin/commands'
import { initRuntimeConfig, loadConfig } from './plugin/config'
import {
  initializeDebug,
  isDebugEnabled,
  logAccountContext,
  logAntigravityDebugResponse,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  startAntigravityDebugRequest,
} from './plugin/debug'
import {
  extractModelFromUrl,
  getModelFamilyFromUrl,
  isCapacityRetryBudgetExhausted,
  MAX_TOTAL_CAPACITY_RETRIES,
  resolveHeaderRoutingDecision,
  resolveQuotaFallbackHeaderStyle,
  toUrlString,
  toWarmupStreamUrl,
} from './plugin/fetch-routing'
import { dumpGeminiRequest, noteGeminiDumpResponse } from './plugin/gemini-dump'
import { createGoogleSearchTool } from './plugin/google-search-tool'
import { createPluginLifecycle } from './plugin/lifecycle'
import { createLogger, initLogger } from './plugin/logger'
import {
  createOAuthMethods,
  openBrowserWithSystem,
} from './plugin/oauth-methods'
import { persistAccountPool } from './plugin/persist-account-pool'
import { ensureProjectContext } from './plugin/project'
import { createOpenCodeQuotaManager, type QuotaManager } from './plugin/quota'
import {
  createSessionRecoveryHook,
  getRecoverySuccessToast,
} from './plugin/recovery'
import {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from './plugin/request'
import {
  createSyntheticErrorResponse,
  createSyntheticTextResponse,
  isEmptyResponseBody,
} from './plugin/request-helpers'
import {
  getHealthTracker,
  getTokenTracker,
  initHealthTracker,
  initTokenTracker,
} from './plugin/rotation'
import {
  AgySessionRegistry,
  extractOpenCodeSessionIdentity,
} from './plugin/session-context'
import {
  clearAccounts,
  getStoragePath,
  loadAccounts,
  mutateAccountStorage,
} from './plugin/storage'
import {
  AntigravityTokenRefreshError,
  refreshAccessToken,
} from './plugin/token'
import type {
  GetAuth,
  PluginContext,
  PluginResult,
  ProjectContextResult,
} from './plugin/types'
import { initAntigravityVersion } from './plugin/version'

const MAX_WARMUP_SESSIONS = 1000
const MAX_WARMUP_RETRIES = 2
const warmupAttemptedSessionIds = new Set<string>()
const warmupSucceededSessionIds = new Set<string>()

const log = createLogger('plugin')

// Module-level toast debounce to persist across requests (fixes toast spam)
const rateLimitToastCooldowns = new Map<string, number>()
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000
const MAX_TOAST_COOLDOWN_ENTRIES = 100

// Track if "all accounts blocked" toasts were shown to prevent spam in while loop
let softQuotaToastShown = false
let rateLimitToastShown = false

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size > MAX_TOAST_COOLDOWN_ENTRIES) {
    const now = Date.now()
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key)
      }
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns()
  const toastKey = message.replace(/\d+/g, 'X')
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0
  const now = Date.now()
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false
  }
  rateLimitToastCooldowns.set(toastKey, now)
  return true
}

function resetAllAccountsBlockedToasts(): void {
  softQuotaToastShown = false
  rateLimitToastShown = false
}

async function triggerAsyncQuotaRefreshForAccount(
  accountManager: AccountManager,
  accountIndex: number,
  intervalMinutes: number,
  quotaManager: QuotaManager,
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

    // Manager handles in-flight dedupe + backoff internally. Even if the
    // background refresh is currently backed off, we still call into the
    // manager so the cache is updated once the backoff expires — though
    // for proactive background refreshes we want the manager's backoff to
    // take precedence so we don't hammer a failing account.
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
      {
        error: String(err),
      },
    )
  }
}

function trackWarmupAttempt(sessionId: string): boolean {
  if (warmupSucceededSessionIds.has(sessionId)) {
    return false
  }
  if (warmupAttemptedSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupAttemptedSessionIds.values().next().value
    if (first) {
      warmupAttemptedSessionIds.delete(first)
      warmupSucceededSessionIds.delete(first)
    }
  }
  const attempts = getWarmupAttemptCount(sessionId)
  if (attempts >= MAX_WARMUP_RETRIES) {
    return false
  }
  warmupAttemptedSessionIds.add(sessionId)
  return true
}

function getWarmupAttemptCount(sessionId: string): number {
  return warmupAttemptedSessionIds.has(sessionId) ? 1 : 0
}

function markWarmupSuccess(sessionId: string): void {
  warmupSucceededSessionIds.add(sessionId)
  if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupSucceededSessionIds.values().next().value
    if (first) warmupSucceededSessionIds.delete(first)
  }
}

function clearWarmupAttempt(sessionId: string): void {
  warmupAttemptedSessionIds.delete(sessionId)
}

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

/**
 * Parse Go-style duration strings to milliseconds.
 * Supports compound durations: "1h16m0.667s", "1.5s", "200ms", "5m30s"
 *
 * @param duration - Duration string in Go format
 * @returns Duration in milliseconds, or null if parsing fails
 */
function parseDurationToMs(duration: string): number | null {
  // Handle simple formats first for backwards compatibility
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

  // Parse compound Go-style durations: "1h16m0.667s", "5m30s", etc.
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi
  let totalMs = 0
  let matchFound = false
  let match: RegExpExecArray | null = null

  while (true) {
    match = compoundRegex.exec(duration)
    if (match === null) break
    matchFound = true
    const value = parseFloat(match[1]!)
    const unit = match[2]!.toLowerCase()
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

interface RateLimitBodyInfo {
  retryDelayMs: number | null
  message?: string
  quotaResetTime?: string
  reason?: string
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== 'object') {
    return { retryDelayMs: null }
  }

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

async function extractRetryInfoFromBody(
  response: Response,
): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text()
    try {
      const parsed = JSON.parse(text) as unknown
      return extractRateLimitBodyInfo(parsed)
    } catch {
      return { retryDelayMs: null }
    }
  } catch {
    return { retryDelayMs: null }
  }
}

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

// Progressive rate limit retry delays
const FIRST_RETRY_DELAY_MS = 1000 // 1s - first 429 quick retry on same account

/**
 * Rate limit state tracking with time-window deduplication.
 *
 * Problem: When multiple subagents hit 429 simultaneously, each would increment
 * the consecutive counter, causing incorrect exponential backoff (5 concurrent
 * 429s = 2^5 backoff instead of 2^1).
 *
 * Solution: Track per account+quota with deduplication window. Multiple 429s
 * within RATE_LIMIT_DEDUP_WINDOW_MS are treated as a single event.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000 // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000 // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitState {
  consecutive429: number
  lastAt: number
  quotaKey: string // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitState>()

// Track empty response retry attempts (ported from LLM-API-Key-Proxy)
const emptyResponseAttempts = new Map<string, number>()

/**
 * Get rate limit backoff with time-window deduplication.
 *
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-cli", "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
function getRateLimitBackoff(
  accountIndex: number,
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000,
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now()
  const stateKey = `${accountIndex}:${quotaKey}`
  const previous = rateLimitStateByAccountQuota.get(stateKey)

  // Check if this is a duplicate 429 within the dedup window
  if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000
    const backoffDelay = Math.min(
      baseDelay * 2 ** (previous.consecutive429 - 1),
      maxBackoffMs,
    )
    return {
      attempt: previous.consecutive429,
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true,
    }
  }

  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt =
    previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS
      ? previous.consecutive429 + 1
      : 1

  rateLimitStateByAccountQuota.set(stateKey, {
    consecutive429: attempt,
    lastAt: now,
    quotaKey,
  })

  const baseDelay = serverRetryAfterMs ?? 1000
  const backoffDelay = Math.min(baseDelay * 2 ** (attempt - 1), maxBackoffMs)
  return {
    attempt,
    delayMs: Math.max(baseDelay, backoffDelay),
    isDuplicate: false,
  }
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`
  rateLimitStateByAccountQuota.delete(stateKey)
}

/**
 * Reset all rate limit state for an account (all quotas).
 * Used when account is completely healthy.
 */
function resetAllRateLimitStateForAccount(accountIndex: number): void {
  for (const key of rateLimitStateByAccountQuota.keys()) {
    if (key.startsWith(`${accountIndex}:`)) {
      rateLimitStateByAccountQuota.delete(key)
    }
  }
}

function headerStyleToQuotaKey(
  headerStyle: HeaderStyle,
  family: ModelFamily,
): string {
  if (family === 'claude') return 'claude'
  return headerStyle === 'antigravity' ? 'gemini-antigravity' : 'gemini-cli'
}

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<
  number,
  { consecutiveFailures: number; lastFailureAt: number }
>()
const MAX_CONSECUTIVE_FAILURES = 5
const FAILURE_COOLDOWN_MS = 30_000 // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000 // Reset failure count after 2 minutes of no failures

function trackAccountFailure(accountIndex: number): {
  failures: number
  shouldCooldown: boolean
  cooldownMs: number
} {
  const now = Date.now()
  const previous = accountFailureState.get(accountIndex)

  // Reset if last failure was more than 2 minutes ago
  const failures =
    previous && now - previous.lastFailureAt < FAILURE_STATE_RESET_MS
      ? previous.consecutiveFailures + 1
      : 1

  accountFailureState.set(accountIndex, {
    consecutiveFailures: failures,
    lastFailureAt: now,
  })

  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0

  return { failures, shouldCooldown, cooldownMs }
}

function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex)
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
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
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin =
  (providerId: string) =>
  async ({ client, directory }: PluginContext): Promise<PluginResult> => {
    // Load configuration from files and environment variables
    const config = loadConfig(directory)
    initRuntimeConfig(config)
    const agySessionRegistry = new AgySessionRegistry(directory)
    let cachedGetAuth: GetAuth | null = null
    const quotaManager = createOpenCodeQuotaManager(client, providerId)
    const lifecycle = createPluginLifecycle({
      sessionRegistry: agySessionRegistry,
      shutdownDiskSignatureCache,
      clearFetchState: () => {
        cachedGetAuth = null
      },
    })
    lifecycle.register({
      dispose: () => {
        warmupAttemptedSessionIds.clear()
        warmupSucceededSessionIds.clear()
        rateLimitToastCooldowns.clear()
        rateLimitStateByAccountQuota.clear()
        emptyResponseAttempts.clear()
        accountFailureState.clear()
        resetAllAccountsBlockedToasts()
        quotaManager.dispose()
      },
    })

    // Initialize debug with config
    initializeDebug(config)

    // Initialize structured logger for TUI integration
    initLogger(client)

    // Fetch latest Antigravity version from remote API (non-blocking, falls back to hardcoded)
    await initAntigravityVersion()

    // Initialize health tracker for hybrid strategy
    if (config.health_score) {
      initHealthTracker({
        initial: config.health_score.initial,
        successReward: config.health_score.success_reward,
        rateLimitPenalty: config.health_score.rate_limit_penalty,
        failurePenalty: config.health_score.failure_penalty,
        recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
        minUsable: config.health_score.min_usable,
        maxScore: config.health_score.max_score,
      })
    }

    // Initialize token tracker for hybrid strategy
    if (config.token_bucket) {
      initTokenTracker({
        maxTokens: config.token_bucket.max_tokens,
        regenerationRatePerMinute:
          config.token_bucket.regeneration_rate_per_minute,
        initialTokens: config.token_bucket.initial_tokens,
      })
    }

    // Initialize disk signature cache if keep_thinking is enabled
    // This integrates with the in-memory cacheSignature/getCachedSignature functions
    if (config.keep_thinking) {
      initDiskSignatureCache(config.signature_cache)
    }

    // Initialize session recovery hook with full context
    const sessionRecovery = createSessionRecoveryHook(
      { client, directory },
      config,
    )

    const updateChecker = createAutoUpdateCheckerHook(client, directory, {
      showStartupToast: true,
      autoUpdate: config.auto_update,
    })

    // Event handler for session recovery and updates
    const eventHandler = async (input: {
      event: { type: string; properties?: unknown }
    }) => {
      // Forward to update checker
      await updateChecker.event(input)

      if (input.event.type === 'session.created') {
        const props = input.event.properties as
          | {
              info?: { id?: string; parentID?: string }
            }
          | undefined
        const sessionId = props?.info?.id
        const parentSessionId = props?.info?.parentID ?? null
        if (sessionId) {
          agySessionRegistry.register(sessionId, parentSessionId)
        }

        if (parentSessionId) {
          log.debug('child-session-detected', {
            sessionId,
            parentID: parentSessionId,
          })
        } else {
          const prevSummary = lifecycle.getAccountManager()?.getSessionSummary()
          if (
            prevSummary &&
            (prevSummary.totalClaude > 0 || prevSummary.totalGemini > 0)
          ) {
            log.debug('prev-session-quota-summary', {
              durationMinutes: prevSummary.durationMinutes,
              totalClaude: prevSummary.totalClaude,
              totalGemini: prevSummary.totalGemini,
              requestsPerHour: prevSummary.requestsPerHour,
              accountsUsed: prevSummary.accountsUsed,
            })
          }
          log.debug('root-session-detected', { sessionId })
        }
      }

      if (input.event.type === 'session.deleted') {
        const props = input.event.properties as
          | {
              sessionID?: string
              info?: { id?: string }
            }
          | undefined
        const sessionId = props?.sessionID ?? props?.info?.id
        if (sessionId) {
          agySessionRegistry.delete(sessionId)
          lifecycle.getAccountManager()?.deleteSessionState(sessionId)
        }
      }

      // Handle session recovery
      if (sessionRecovery && input.event.type === 'session.error') {
        const props = input.event.properties as
          | Record<string, unknown>
          | undefined
        const sessionID = props?.sessionID as string | undefined
        const messageID = props?.messageID as string | undefined
        const error = props?.error

        if (sessionRecovery.isRecoverableError(error)) {
          const messageInfo = {
            id: messageID,
            role: 'assistant' as const,
            sessionID,
            error,
          }

          // handleSessionRecovery now does the actual fix (injects tool_result, etc.)
          const recovered =
            await sessionRecovery.handleSessionRecovery(messageInfo)

          // Only send "continue" AFTER successful tool_result_missing recovery
          // (thinking recoveries already resume inside handleSessionRecovery)
          if (recovered && sessionID && config.auto_resume) {
            // For tool_result_missing, we need to send continue after injecting tool_results
            await client.session
              .prompt({
                path: { id: sessionID },
                body: { parts: [{ type: 'text', text: config.resume_text }] },
                query: { directory },
              })
              .catch(() => {})

            // Show success toast (respects toast_scope for child sessions)
            const successToast = getRecoverySuccessToast()
            const isChildRecovery =
              agySessionRegistry.getParentSessionId(sessionID) !== null
            log.debug('recovery-toast', {
              ...successToast,
              isChildSession: isChildRecovery,
              toastScope: config.toast_scope,
            })
            if (!(config.toast_scope === 'root_only' && isChildRecovery)) {
              await client.tui
                .showToast({
                  body: {
                    title: successToast.title,
                    message: successToast.message,
                    variant: 'success',
                  },
                })
                .catch(() => {})
            }
          }
        }
      }
    }

    const googleSearchTool = createGoogleSearchTool({
      getAuth: async () => (cachedGetAuth ? cachedGetAuth() : null),
      client,
      providerId,
    })

    const accountAccess = createAccountAccessService({
      client,
      providerId,
      store: {
        load: loadAccounts,
        mutate: (mutate) => mutateAccountStorage(getStoragePath(), mutate),
        clear: clearAccounts,
        persistAccountPool,
      },
      openBrowser: openBrowserWithSystem,
      prompt: {
        selectAccount: promptAccountIndexForVerification,
        confirmOpenVerificationUrl: promptOpenVerificationUrl,
      },
    })

    return {
      dispose: () => lifecycle.dispose(),
      config: async (opencodeConfig: Record<string, unknown>) => {
        applyAntigravityProviderCatalog(opencodeConfig, providerId)
        registerAntigravityCommands(opencodeConfig)
      },
      'command.execute.before': createCommandExecuteBefore(client),
      event: eventHandler,
      tool: {
        google_search: googleSearchTool,
      },
      auth: {
        provider: providerId,
        loader: createAuthLoader({
          client,
          providerId,
          config,
          lifecycle,
          onGetAuth: (getAuth) => {
            cachedGetAuth = getAuth
          },
          createFetch: ({ accountManager, getAuth }) => ({
            dispose: async () => {},
            async fetch(input, init) {
              if (!isGenerativeLanguageRequest(input)) {
                return fetch(input, init)
              }

              const latestAuth = await getAuth()
              if (!isOAuthAuth(latestAuth)) {
                return fetch(input, init)
              }

              // Normalize Request/URL inputs to (urlString, init) so the
              // string-based transform pipeline sees the real method/headers/body.
              // Without this, fetch(new Request(...)) would carry its payload on the
              // Request object where our string path can't read it.
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
                      init?.body ??
                      (bodyBuffer ? Buffer.from(bodyBuffer) : undefined),
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

              const requestSessionIdentity = extractOpenCodeSessionIdentity(
                init?.headers,
              )
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
              const isChildRequest =
                requestSessionIdentity.parentSessionId !== null

              if (accountManager.getAccountCount() === 0) {
                return createSyntheticErrorResponse(
                  'No Antigravity accounts configured. Run `opencode auth login`.',
                  'unknown',
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

              // Helper to check if request was aborted
              const checkAborted = () => {
                if (abortSignal?.aborted) {
                  throw abortSignal.reason instanceof Error
                    ? abortSignal.reason
                    : new Error('Aborted')
                }
              }

              // Use while(true) loop to handle rate limits with backoff
              // This ensures we wait and retry when all accounts are rate-limited
              const quietMode = config.quiet_mode
              const toastScope = config.toast_scope

              // Helper to show toast without blocking on abort (respects quiet_mode and toast_scope)
              const showToast = async (
                message: string,
                variant: 'info' | 'warning' | 'success' | 'error',
              ) => {
                // Always log to debug regardless of toast filtering
                log.debug('toast', {
                  message,
                  variant,
                  isChildSession: isChildRequest,
                  toastScope,
                })

                if (quietMode) return
                if (abortSignal?.aborted) return

                // Filter toasts for child sessions when toast_scope is "root_only"
                if (toastScope === 'root_only' && isChildRequest) {
                  log.debug('toast-suppressed-child-session', {
                    message,
                    variant,
                    parentID: requestSessionIdentity.parentSessionId,
                  })
                  return
                }

                if (
                  variant === 'warning' &&
                  message.toLowerCase().includes('rate')
                ) {
                  if (!shouldShowRateLimitToast(message)) {
                    return
                  }
                }

                try {
                  await client.tui.showToast({
                    body: { message, variant },
                  })
                } catch {
                  // TUI may not be available
                }
              }

              const hasOtherAccountWithAntigravity = (
                currentAccount: any,
              ): boolean => {
                if (family !== 'gemini') return false
                // Use AccountManager method which properly checks for disabled/cooling-down accounts
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
                // Check for abort at the start of each iteration
                checkAborted()
                const accountCount = accountManager.getAccountCount()
                const routingDecision = resolveHeaderRoutingDecision(
                  urlString,
                  family,
                  config,
                )
                const {
                  cliFirst,
                  preferredHeaderStyle,
                  explicitQuota,
                  allowQuotaFallback,
                } = routingDecision

                if (accountCount === 0) {
                  return createSyntheticErrorResponse(
                    'No Antigravity accounts available. Run `opencode auth login`.',
                    model ?? 'unknown',
                  )
                }

                const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
                  config.soft_quota_cache_ttl_minutes,
                  config.quota_refresh_interval_minutes,
                )

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

                if (!account && allowQuotaFallback) {
                  const alternateHeaderStyle: HeaderStyle =
                    preferredHeaderStyle === 'antigravity'
                      ? 'gemini-cli'
                      : 'antigravity'
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
                    const softQuotaWaitMs =
                      accountManager.getMinWaitTimeForSoftQuota(
                        family,
                        threshold,
                        softQuotaCacheTtlMs,
                        model,
                      )
                    const maxWaitMs =
                      (config.max_rate_limit_wait_seconds ?? 300) * 1000

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

                    const waitSecValue = Math.max(
                      1,
                      Math.ceil(softQuotaWaitMs / 1000),
                    )
                    pushDebug(
                      `all-over-soft-quota family=${family} accounts=${accountCount} waitMs=${softQuotaWaitMs}`,
                    )

                    if (!softQuotaToastShown) {
                      await showToast(
                        `All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime(softQuotaWaitMs)}...`,
                        'warning',
                      )
                      softQuotaToastShown = true
                    }

                    await sleep(softQuotaWaitMs, abortSignal)
                    continue
                  }

                  const strictWait = !allowQuotaFallback
                  // All accounts are rate-limited - wait and retry
                  const waitMs =
                    accountManager.getMinWaitTimeForFamily(
                      family,
                      model,
                      preferredHeaderStyle,
                      strictWait,
                    ) || 60_000
                  const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000))

                  pushDebug(
                    `all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`,
                  )
                  if (isDebugEnabled()) {
                    logAccountContext('All accounts rate-limited', {
                      index: -1,
                      family,
                      totalAccounts: accountCount,
                    })
                    logRateLimitSnapshot(
                      family,
                      accountManager.getAccountsSnapshot(),
                    )
                  }

                  // If wait time exceeds max threshold, return error immediately instead of hanging
                  // 0 means disabled (wait indefinitely)
                  const maxWaitMs =
                    (config.max_rate_limit_wait_seconds ?? 300) * 1000
                  if (maxWaitMs > 0 && waitMs > maxWaitMs) {
                    const waitTimeFormatted = formatWaitTime(waitMs)
                    await showToast(
                      `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
                      'error',
                    )

                    // Return a proper rate limit error response
                    return createSyntheticErrorResponse(
                      `All ${accountCount} account(s) rate-limited for ${family}. ` +
                        `Quota resets in ${waitTimeFormatted}. ` +
                        `Add more accounts with \`opencode auth login\` or wait and retry.`,
                      model ?? 'unknown',
                    )
                  }

                  if (!rateLimitToastShown) {
                    await showToast(
                      `All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`,
                      'warning',
                    )
                    rateLimitToastShown = true
                  }

                  // Wait for the rate-limit cooldown to expire, then retry
                  await sleep(waitMs, abortSignal)
                  continue
                }

                // Account is available - reset the toast flag
                resetAllAccountsBlockedToasts()

                pushDebug(
                  `selected idx=${account.index} email=${account.email ?? ''} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`,
                )

                if (
                  previousAccountIndex >= 0 &&
                  previousAccountIndex !== account.index
                ) {
                  needsCacheWarmup = config.cache_warmup_on_switch
                  pushDebug(
                    `account-switch: ${previousAccountIndex} → ${account.index}, warmup=${needsCacheWarmup}`,
                  )
                }
                previousAccountIndex = account.index
                accountManager.recordSessionUsage(
                  account.index,
                  accountSessionIdentity,
                )
                if (isDebugEnabled()) {
                  logAccountContext('Selected', {
                    index: account.index,
                    email: account.email,
                    family,
                    totalAccounts: accountCount,
                    rateLimitState: account.rateLimitResetTimes,
                  })
                }

                // Show toast when switching to a different account (debounced, quiet_mode handled by showToast)
                if (
                  accountCount > 1 &&
                  accountManager.shouldShowAccountToast(account.index)
                ) {
                  const accountLabel =
                    account.email || `Account ${account.index + 1}`
                  // Calculate position among enabled accounts (not absolute index)
                  const enabledAccounts = accountManager.getEnabledAccounts()
                  const enabledPosition =
                    enabledAccounts.findIndex(
                      (a) => a.index === account.index,
                    ) + 1
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
                        trackAccountFailure(account.index)
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
                    resetAccountFailureState(account.index)
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
                          // Replace (not merge) so the revoked account is not
                          // resurrected from disk by mergeAccountStorage.
                          await accountManager.saveToDiskReplace()
                        } catch (persistError) {
                          log.error(
                            'Failed to persist revoked account removal',
                            { error: String(persistError) },
                          )
                        }
                      }

                      if (accountManager.getAccountCount() === 0) {
                        try {
                          await client.auth.set({
                            path: { id: providerId },
                            body: {
                              type: 'oauth',
                              refresh: '',
                              access: '',
                              expires: 0,
                            },
                          })
                        } catch (storeError) {
                          log.error(
                            'Failed to clear stored Antigravity OAuth credentials',
                            { error: String(storeError) },
                          )
                        }

                        return createSyntheticErrorResponse(
                          'All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.',
                          model ?? 'unknown',
                        )
                      }

                      lastError = error
                      continue
                    }

                    const { failures, shouldCooldown, cooldownMs } =
                      trackAccountFailure(account.index)
                    getHealthTracker().recordFailure(account.index)
                    lastError =
                      error instanceof Error ? error : new Error(String(error))
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
                  resetAccountFailureState(account.index)
                } catch (error) {
                  const { failures, shouldCooldown, cooldownMs } =
                    trackAccountFailure(account.index)
                  getHealthTracker().recordFailure(account.index)
                  lastError =
                    error instanceof Error ? error : new Error(String(error))
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
                  if (!config.thinking_warmup) {
                    return
                  }
                  if (
                    !prepared.needsSignedThinkingWarmup ||
                    !prepared.sessionId
                  ) {
                    return
                  }
                  if (!trackWarmupAttempt(prepared.sessionId)) {
                    return
                  }

                  const warmupBody = buildThinkingWarmupBody(
                    typeof prepared.init.body === 'string'
                      ? prepared.init.body
                      : undefined,
                    Boolean(
                      prepared.effectiveModel
                        ?.toLowerCase()
                        .includes('claude') &&
                        prepared.effectiveModel
                          ?.toLowerCase()
                          .includes('thinking'),
                    ),
                  )
                  if (!warmupBody) {
                    return
                  }

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
                        ? await fetchWithAgyCliTransport(
                            warmupUrl,
                            warmupInit,
                            { signal: abortSignal, onDebug: pushDebug },
                          )
                        : await fetch(warmupUrl, warmupInit)
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
                    markWarmupSuccess(prepared.sessionId)
                    pushDebug('thinking-warmup: done')
                  } catch (error) {
                    clearWarmupAttempt(prepared.sessionId)
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

                    // Send the exact same body as the real request — the server-side cache
                    // key includes the full request payload (systemInstruction, tools,
                    // generationConfig, thinkingConfig, contents). Stripping any field
                    // produces a different hash → cache MISS on the first real request.
                    // The probe aborts after the first SSE chunk, so output generation
                    // cost is negligible regardless of maxOutputTokens settings.
                    const probeInit = {
                      ...prepared.init,
                      method: 'POST',
                      body: bodyStr,
                    }
                    const probeResponse =
                      prepared.headerStyle === 'antigravity'
                        ? await fetchWithAgyCliTransport(
                            toUrlString(prepared.request),
                            probeInit,
                            { signal: abortSignal, onDebug: pushDebug },
                          )
                        : await fetch(toUrlString(prepared.request), probeInit)

                    if (probeResponse.body) {
                      const reader = probeResponse.body.getReader()
                      // Read first chunk to confirm server processed the prefix, then abort
                      await reader.read()
                      await reader.cancel()
                    }

                    const status = probeResponse.status
                    if (status >= 400) {
                      // Log error body for diagnosis
                      let errorSnippet = ''
                      try {
                        const errText = await probeResponse
                          .text()
                          .catch(() => '')
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

                // Track total API requests made for this single user message
                let apiRequestCount = 0

                // Try endpoint fallbacks with single header style based on model suffix
                let shouldSwitchAccount = false
                // Determine header style from model suffix:
                // - Models with antigravity- prefix -> use Antigravity quota
                // - Gemini models without explicit prefix -> follow cli_first
                // - Claude models -> always use Antigravity
                let headerStyle = preferredHeaderStyle
                pushDebug(
                  `headerStyle=${headerStyle} explicit=${explicitQuota}`,
                )
                if (account.fingerprint) {
                  pushDebug(
                    `fingerprint: deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`,
                  )
                }

                // Check if this header style is rate-limited for this account
                if (
                  accountManager.isRateLimitedForHeaderStyle(
                    account,
                    family,
                    headerStyle,
                    model,
                  )
                ) {
                  // Antigravity-first fallback: exhaust antigravity across ALL accounts before gemini-cli
                  if (
                    allowQuotaFallback &&
                    family === 'gemini' &&
                    headerStyle === 'antigravity'
                  ) {
                    // Check if ANY other account has antigravity available
                    if (
                      accountManager.hasOtherAccountWithAntigravityAvailable(
                        account.index,
                        family,
                        model,
                      )
                    ) {
                      // Switch to another account with antigravity (preserve antigravity priority)
                      pushDebug(
                        `antigravity rate-limited on account ${account.index}, but available on other accounts. Switching.`,
                      )
                      shouldSwitchAccount = true
                    } else {
                      // All accounts exhausted antigravity - fall back to gemini-cli on this account
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
                    // gemini-cli rate-limited - try alternate style (antigravity) on same account
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
                      const quotaName =
                        headerStyle === 'gemini-cli'
                          ? 'Gemini CLI'
                          : 'Antigravity'
                      const altQuotaName =
                        fallbackStyle === 'gemini-cli'
                          ? 'Gemini CLI'
                          : 'Antigravity'
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

                // Bound transient capacity retries across all while-loop iterations. Without
                // this total guard, per-endpoint capacityRetryCount can reset after the
                // endpoint loop restarts and keep OpenCode waiting before any step-start.
                let totalCapacityRetries = 0

                while (!shouldSwitchAccount) {
                  // Flag to force thinking recovery on retry after API error
                  let forceThinkingRecovery = false

                  // Track if token was consumed (for hybrid strategy refund on error)
                  let tokenConsumed = false

                  // Track capacity retries per endpoint to prevent infinite loops
                  let capacityRetryCount = 0
                  let lastEndpointIndex = -1

                  for (
                    let i = 0;
                    i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length;
                    i++
                  ) {
                    // Reset capacity retry counter when switching to a new endpoint
                    if (i !== lastEndpointIndex) {
                      capacityRetryCount = 0
                      lastEndpointIndex = i
                    }

                    const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i]

                    // Skip sandbox endpoints for Gemini CLI models - they only work with Antigravity quota
                    // Gemini CLI models must use production endpoint (cloudcode-pa.googleapis.com)
                    if (
                      headerStyle === 'gemini-cli' &&
                      currentEndpoint !== ANTIGRAVITY_ENDPOINT_PROD
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
                          claudePromptAutoCaching:
                            config.claude_prompt_auto_caching,
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

                      await runThinkingWarmup(
                        prepared,
                        projectContext.effectiveProjectId,
                      )

                      await runCacheWarmupProbe(prepared)

                      if (config.request_jitter_max_ms > 0) {
                        const jitterMs = Math.floor(
                          Math.random() * config.request_jitter_max_ms,
                        )
                        if (jitterMs > 0) {
                          await sleep(jitterMs, abortSignal)
                        }
                      }

                      // Consume token for hybrid strategy
                      // Refunded later if request fails (429 or network error)
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
                          : await fetch(prepared.request, prepared.init)
                      apiRequestCount++
                      accountManager.recordRequest(account.index, family)
                      const requestCounts =
                        accountManager.getDailyRequestCounts(account.index)
                      if (requestCounts) {
                        pushDebug(
                          `[Quota] account=${account.index} ${family}_today=${requestCounts[family]} total_${family}_today=${accountManager.getTotalDailyRequests(family)}`,
                        )
                      }
                      pushDebug(
                        `status=${response.status} ${response.statusText} (api_request #${apiRequestCount})`,
                      )
                      noteGeminiDumpResponse(dumpContext, response)

                      // Handle 429 rate limit (or Service Overloaded) with improved logic
                      if (
                        response.status === 429 ||
                        response.status === 503 ||
                        response.status === 529
                      ) {
                        // Refund token on rate limit
                        if (tokenConsumed) {
                          getTokenTracker().refund(account.index)
                          tokenConsumed = false
                        }

                        const defaultRetryMs =
                          (config.default_retry_after_seconds ?? 60) * 1000
                        const maxBackoffMs =
                          (config.max_backoff_seconds ?? 60) * 1000
                        const headerRetryMs = retryAfterMsFromResponse(
                          response,
                          defaultRetryMs,
                        )
                        const bodyInfo =
                          await extractRetryInfoFromBody(response)
                        const serverRetryMs =
                          bodyInfo.retryDelayMs ?? headerRetryMs

                        // [Enhanced Parsing] Pass status to handling logic
                        const rateLimitReason = parseRateLimitReason(
                          bodyInfo.reason,
                          bodyInfo.message,
                          response.status,
                        )

                        // STRATEGY 1: CAPACITY / SERVER ERROR (Transient)
                        // Goal: Wait and Retry SAME Account. DO NOT LOCK.
                        // We handle this FIRST to avoid calling getRateLimitBackoff() and polluting the global rate limit state for transient errors.
                        if (
                          rateLimitReason === 'MODEL_CAPACITY_EXHAUSTED' ||
                          rateLimitReason === 'SERVER_ERROR'
                        ) {
                          totalCapacityRetries++
                          if (
                            isCapacityRetryBudgetExhausted(totalCapacityRetries)
                          ) {
                            pushDebug(
                              `Total capacity retries (${MAX_TOTAL_CAPACITY_RETRIES}) exhausted, switching account`,
                            )
                            lastFailure = createFailureContext(response)
                            shouldSwitchAccount = true
                            break
                          }

                          // Exponential backoff with jitter for capacity errors: 1s → 2s → 4s → 8s (max)
                          // Matches Antigravity-Manager's ExponentialBackoff(1s, 8s)
                          const baseDelayMs = 1000
                          const maxDelayMs = 8000
                          const exponentialDelay = Math.min(
                            baseDelayMs * 2 ** capacityRetryCount,
                            maxDelayMs,
                          )
                          // Add ±10% jitter to prevent thundering herd
                          const jitter =
                            exponentialDelay * (0.9 + Math.random() * 0.2)
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

                          // CRITICAL FIX: Decrement i so that the loop 'continue' retries the SAME endpoint index
                          // (i++ in the loop will bring it back to the current index)
                          // But limit retries to prevent infinite loops (Greptile feedback)
                          if (capacityRetryCount < 1) {
                            capacityRetryCount++
                            i -= 1
                            continue
                          } else {
                            pushDebug(
                              `Max capacity retries (1) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`,
                            ) // Regenerate fingerprint to get fresh device identity before trying next endpoint
                            const newFingerprint =
                              accountManager.regenerateAccountFingerprint(
                                account.index,
                              )
                            if (newFingerprint) {
                              pushDebug(
                                `Fingerprint regenerated for account ${account.index}`,
                              )
                            }
                            continue
                          }
                        }

                        // STRATEGY 2: RATE LIMIT EXCEEDED (RPM) / QUOTA EXHAUSTED / UNKNOWN
                        // Goal: Lock and Rotate (Standard Logic)

                        // Only now do we call getRateLimitBackoff, which increments the global failure tracker
                        const quotaKey = headerStyleToQuotaKey(
                          headerStyle,
                          family,
                        )
                        const { attempt, delayMs, isDuplicate } =
                          getRateLimitBackoff(
                            account.index,
                            quotaKey,
                            serverRetryMs,
                          )

                        // Calculate potential backoffs
                        const smartBackoffMs = calculateBackoffMs(
                          rateLimitReason,
                          account.consecutiveFailures ?? 0,
                          serverRetryMs,
                        )
                        const effectiveDelayMs = Math.max(
                          delayMs,
                          smartBackoffMs,
                        )

                        pushDebug(
                          `429 idx=${account.index} email=${account.email ?? ''} family=${family} delayMs=${effectiveDelayMs} attempt=${attempt} reason=${rateLimitReason}`,
                        )
                        if (bodyInfo.message) {
                          pushDebug(`429 message=${bodyInfo.message}`)
                        }
                        if (bodyInfo.quotaResetTime) {
                          pushDebug(
                            `429 quotaResetTime=${bodyInfo.quotaResetTime}`,
                          )
                        }
                        if (bodyInfo.reason) {
                          pushDebug(`429 reason=${bodyInfo.reason}`)
                        }

                        logRateLimitEvent(
                          account.index,
                          account.email,
                          family,
                          response.status,
                          effectiveDelayMs,
                          bodyInfo,
                        )

                        await logResponseBody(debugContext, response, 429)

                        getHealthTracker().recordRateLimit(account.index)

                        const accountLabel =
                          account.email || `Account ${account.index + 1}`

                        // Progressive retry for standard 429s: 1st 429 → 1s then switch (if enabled) or retry same
                        if (
                          attempt === 1 &&
                          rateLimitReason !== 'QUOTA_EXHAUSTED'
                        ) {
                          await showToast(
                            `Rate limited. Quick retry in 1s...`,
                            'warning',
                          )
                          await sleep(FIRST_RETRY_DELAY_MS, abortSignal)

                          // CacheFirst mode: wait for same account if within threshold (preserves prompt cache)
                          if (config.scheduling_mode === 'cache_first') {
                            const maxCacheFirstWaitMs =
                              config.max_cache_first_wait_seconds * 1000
                            // effectiveDelayMs is the backoff calculated for this account
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
                              // Retry same endpoint after wait
                              i -= 1
                              continue
                            }
                            // Wait time exceeds threshold, fall through to switch
                            pushDebug(
                              `cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`,
                            )
                          }

                          if (
                            config.switch_on_first_rate_limit &&
                            accountCount > 1
                          ) {
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

                          // Same endpoint retry for first RPM hit
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

                        const switchAccountDelayMs =
                          config.switch_account_delay_ms ?? 500

                        // For Gemini, preserve preferred quota across accounts before fallback
                        if (family === 'gemini') {
                          if (headerStyle === 'antigravity') {
                            // Check if any other account has Antigravity quota for this model
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

                            // All accounts exhausted for Antigravity on THIS model.
                            // Before falling back to gemini-cli, check if it's the last option (automatic fallback)
                            if (allowQuotaFallback) {
                              const alternateStyle =
                                accountManager.getAvailableHeaderStyle(
                                  account,
                                  family,
                                  model,
                                )
                              const fallbackStyle =
                                resolveQuotaFallbackHeaderStyle({
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
                              const fallbackStyle =
                                resolveQuotaFallbackHeaderStyle({
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

                        const quotaName =
                          headerStyle === 'antigravity'
                            ? 'Antigravity'
                            : 'Gemini CLI'

                        if (accountCount > 1) {
                          const quotaMsg = bodyInfo.quotaResetTime
                            ? ` (quota resets ${bodyInfo.quotaResetTime})`
                            : ``
                          await showToast(
                            `Rate limited again. Switching account in ${formatWaitTime(switchAccountDelayMs)}...${quotaMsg}`,
                            'warning',
                          )
                          await sleep(switchAccountDelayMs, abortSignal)
                        } else {
                          // Single account: exponential backoff (1s, 2s, 4s, 8s... max 60s)
                          const expBackoffMs = Math.min(
                            FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1),
                            60000,
                          )
                          const expBackoffFormatted =
                            expBackoffMs >= 1000
                              ? `${Math.round(expBackoffMs / 1000)}s`
                              : `${expBackoffMs}ms`
                          await showToast(
                            `Rate limited. Retrying in ${expBackoffFormatted} (attempt ${attempt})...`,
                            'warning',
                          )
                          await sleep(expBackoffMs, abortSignal)
                        }

                        lastFailure = createFailureContext(response)
                        shouldSwitchAccount = true
                        break
                      }

                      // Success - reset rate limit backoff state for this quota
                      const quotaKey = headerStyleToQuotaKey(
                        headerStyle,
                        family,
                      )
                      resetRateLimitState(account.index, quotaKey)
                      resetAccountFailureState(account.index)

                      if (response.status === 403) {
                        const errorBodyText = await response
                          .clone()
                          .text()
                          .catch(() => '')
                        const extracted =
                          extractAccountAccessErrorDetails(errorBodyText)

                        if (extracted.accountIneligible) {
                          const ineligibleReason =
                            extracted.message ??
                            'Google marked this account as ineligible for Antigravity.'
                          accountManager.markAccountIneligible(
                            account.index,
                            ineligibleReason,
                          )

                          const label =
                            account.email || `Account ${account.index + 1}`
                          if (
                            accountManager.shouldShowAccountToast(
                              account.index,
                              60000,
                            )
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
                            extracted.message ??
                            'Google requires account verification.'
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

                          const label =
                            account.email || `Account ${account.index + 1}`
                          if (
                            accountManager.shouldShowAccountToast(
                              account.index,
                              60000,
                            )
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
                        await logResponseBody(
                          debugContext,
                          response,
                          response.status,
                        )
                        lastFailure = createFailureContext(response)
                        continue
                      }

                      // Success or non-retryable error - return the response
                      if (response.ok) {
                        account.consecutiveFailures = 0
                        getHealthTracker().recordSuccess(account.index)
                        accountManager.markAccountUsed(account.index)

                        void triggerAsyncQuotaRefreshForAccount(
                          accountManager,
                          account.index,
                          config.quota_refresh_interval_minutes,
                          quotaManager,
                        )

                        // Proactive rotation: if current account quota is low, pre-switch
                        // to a warm-cache account so the NEXT request avoids a cold cache miss
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
                          const rotated =
                            accountManager.proactivelyRotateForFamily(
                              family,
                              model,
                              headerStyle,
                              config.soft_quota_threshold_percent,
                              softQuotaCacheTtlMs,
                              accountSessionIdentity,
                            )
                          if (rotated) {
                            const remaining =
                              account.cachedQuota?.[
                                resolveQuotaGroup(family, model)
                              ]?.remainingFraction
                            const remainingPct =
                              remaining != null
                                ? `${(remaining * 100).toFixed(1)}%`
                                : '?'
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
                        note: response.ok
                          ? 'Success'
                          : `Error ${response.status}`,
                      })
                      if (response.ok && !prepared.streaming) {
                        await logResponseBody(
                          debugContext,
                          response,
                          response.status,
                        )
                      }
                      if (!response.ok) {
                        await logResponseBody(
                          debugContext,
                          response,
                          response.status,
                        )

                        // Handle 400 "Prompt too long" with synthetic response to avoid session lock
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

                      // Empty response retry logic (ported from LLM-API-Key-Proxy)
                      // For non-streaming responses, check if the response body is empty
                      // and retry if so (up to config.empty_response_max_attempts times)
                      if (response.ok && !prepared.streaming) {
                        const maxAttempts =
                          config.empty_response_max_attempts ?? 4
                        const retryDelayMs =
                          config.empty_response_retry_delay_ms ?? 2000

                        // Clone to check body without consuming original
                        const clonedForCheck = response.clone()
                        const bodyText = await clonedForCheck.text()

                        if (isEmptyResponseBody(bodyText)) {
                          // Track empty response attempts per request
                          const emptyAttemptKey = `${prepared.sessionId ?? 'none'}:${prepared.effectiveModel ?? 'unknown'}`
                          const currentAttempts =
                            (emptyResponseAttempts.get(emptyAttemptKey) ?? 0) +
                            1
                          emptyResponseAttempts.set(
                            emptyAttemptKey,
                            currentAttempts,
                          )

                          pushDebug(
                            `empty-response: attempt ${currentAttempts}/${maxAttempts}`,
                          )

                          if (currentAttempts < maxAttempts) {
                            await showToast(
                              `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                              'warning',
                            )
                            await sleep(retryDelayMs, abortSignal)
                            continue // Retry the endpoint loop
                          }

                          // Clean up and return a synthetic response after max attempts
                          emptyResponseAttempts.delete(emptyAttemptKey)
                          return createSyntheticErrorResponse(
                            `Empty response after ${currentAttempts} attempts for model ${prepared.effectiveModel ?? 'unknown'}.`,
                            prepared.effectiveModel ?? 'unknown',
                          )
                        }

                        // Clean up successful attempt tracking
                        const emptyAttemptKeyClean = `${prepared.sessionId ?? 'none'}:${prepared.effectiveModel ?? 'unknown'}`
                        emptyResponseAttempts.delete(emptyAttemptKeyClean)
                      }

                      const transformedResponse =
                        await transformAntigravityResponse(
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

                      // Check for context errors and show appropriate toast
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
                      const totalToday =
                        accountManager.getTotalDailyRequests(family)
                      pushDebug(
                        `[Quota] Total ${family} requests today (all accounts): ${totalToday}`,
                      )

                      // Post-request quota state: show cached remaining quota for this account
                      const cachedQuota = account.cachedQuota
                      if (cachedQuota) {
                        const quotaFamily = resolveQuotaGroup(family, model)
                        const groupQuota = cachedQuota[quotaFamily]
                        if (groupQuota?.remainingFraction != null) {
                          const pct = Math.round(
                            groupQuota.remainingFraction * 100,
                          )
                          pushDebug(
                            `[Quota] Account ${account.index} cached ${quotaFamily} remaining: ${pct}%${groupQuota.resetTime ? ` (resets ${groupQuota.resetTime})` : ''}`,
                          )
                        }
                      }

                      // Quota consumption rate estimation
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
                      // Refund token on network/API error (only if consumed)
                      if (tokenConsumed) {
                        getTokenTracker().refund(account.index)
                        tokenConsumed = false
                      }

                      // Handle recoverable thinking errors - retry with forced recovery
                      if (
                        error instanceof Error &&
                        error.message === 'THINKING_RECOVERY_NEEDED'
                      ) {
                        // Only retry once with forced recovery to avoid infinite loops
                        if (!forceThinkingRecovery) {
                          pushDebug(
                            'thinking-recovery: API error detected, retrying with forced recovery',
                          )
                          forceThinkingRecovery = true
                          i = -1 // Will become 0 after loop increment, restart endpoint loop
                          continue
                        }

                        // Already tried with forced recovery, give up and return error
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
                          error instanceof Error
                            ? error
                            : new Error(String(error))
                        continue
                      }

                      // All endpoints failed for this account - track failure and try next account
                      const { failures, shouldCooldown, cooldownMs } =
                        trackAccountFailure(account.index)
                      lastError =
                        error instanceof Error
                          ? error
                          : new Error(String(error))
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
                } // end headerStyleLoop

                if (shouldSwitchAccount) {
                  accountSwitchCount++

                  // Cap account switches to prevent cascading quota waste
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

                  // Avoid tight retry loops when there's only one account.
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

                // If we get here without returning, something went wrong
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
            },
          }),
        }),
        methods: createOAuthMethods({
          client,
          providerId,
          config,
          lifecycle,
          accountAccess,
          quotaManager,
          getAuth: async () => (cachedGetAuth ? cachedGetAuth() : undefined),
        }),
      },
    }
  }

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(
  ANTIGRAVITY_PROVIDER_ID,
)
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin

export {
  buildAccountAccessProbeRequest,
  extractAccountAccessErrorDetails,
  interpretAccountAccessProbeResponse,
} from './plugin/account-access'
