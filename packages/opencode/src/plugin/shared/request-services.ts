/**
 * Shared Antigravity request engine: account selection, retries, endpoint
 * and quota fallback, warmups and response handling for one plugin location.
 *
 * OpenCode 1's `createFetchInterceptor` and the GA location services both
 * call `createRequestExecutor`, so there is exactly one retry loop. Every
 * collaborator with state (accounts, credentials, session metadata, operator
 * settings, wire state, debug log, dump switch, logger, health and token
 * trackers) arrives through `RequestServicesDeps`; this module never reads a
 * module-level OpenCode 1 binding or a host SDK client. Host-only effects
 * (toasts, the sidebar routing file, clearing host-stored OAuth credentials)
 * are optional or explicit callbacks the host binding supplies.
 *
 * The wire rules themselves (payload transformation, header and envelope
 * order, SSE handling) stay in `../request`. The engine receives them as
 * `RequestWire`, which `createRequestWire` binds to one location's signature
 * cache, debug log and logger; the raw sender is called unchanged.
 */
import {
  type AgyTransportOptions,
  accessTokenExpired,
  type AccountManager as CoreAccountManager,
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  type Fingerprint,
  getPublicModelDefinitions,
  getResolverAliasMap,
  type HealthScoreTracker,
  isImageGenerationModel,
  type ManagedAccount,
  type OAuthAuthDetails,
  type ProjectContextResult,
  parseRateLimitReason,
  type QuotaGroup,
  type QuotaGroupSummary,
  type QuotaManager,
  resolveQuotaGroup,
  type TokenBucketTracker,
} from '@cortexkit/antigravity-auth-core'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  type HeaderStyle,
} from '../../constants'
import type { AntigravityConfig } from '../config'
import type { LocationDebug } from '../debug'
import { AntigravityKillswitchError } from '../errors'
import {
  createRetryState,
  type RateLimitBackoffResult,
  type RetryState,
} from '../fetch/retry-state'
import { createWarmupState, type WarmupState } from '../fetch/warmup'
import {
  extractModelFromUrl,
  getModelFamilyFromUrl,
  isCapacityRetryBudgetExhausted,
  MAX_TOTAL_CAPACITY_RETRIES,
  resolveHeaderRoutingDecision,
  resolveQuotaFallbackHeaderStyle,
  toUrlString,
  toWarmupStreamUrl,
} from '../fetch-routing'
import { type GeminiDumpState, noteGeminiDumpResponse } from '../gemini-dump'
import { evaluateKillswitchForAccount, throwIfAllKilled } from '../killswitch'
import type { Logger } from '../logger'
import type { OperatorSettingsController } from '../operator-settings'
import type {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  PrepareRequestOptions,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from '../request'
import {
  createNativeGoogleErrorResponse,
  createSyntheticTextResponse,
  isEmptyResponseBody,
} from '../request-helpers'
import {
  type AgySessionRegistry,
  extractOpenCodeSessionIdentity,
  type OpenCodeSessionIdentity,
} from '../session-context'
import {
  type CapturedLocalGrant,
  isLocalGrantError,
  LocalGrantSupersededError,
} from './local-grant'

/**
 * Wait before retrying the same selection after its first 429.
 */
const FIRST_RETRY_DELAY_MS = 1000

/** Raw Antigravity sender: the core CLI transport or a test double. */
export type RequestTransport = (
  url: string,
  init?: RequestInit,
  options?: AgyTransportOptions,
) => Promise<Response>

/**
 * Standard fetch, used for `gemini-cli` header-style sends and their warmups;
 * `antigravity` header-style sends use the raw HTTP/1.1 AGY sender instead.
 */
export type RequestFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

/**
 * The fields of a pool row the engine reads: selection, logging, killswitch
 * and backoff metadata only. A row carries no credential. OpenCode 1's rows
 * are core `ManagedAccount`s; a vault location supplies metadata-only rows.
 */
export interface RequestAccountRow {
  readonly index: number
  readonly email?: string
  readonly fingerprint?: Fingerprint
  /** Reset to 0 by the engine after a successful send. */
  consecutiveFailures?: number
  readonly rateLimitResetTimes: {
    readonly claude?: number
    readonly gemini?: number
  }
  readonly cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>
  readonly cachedQuotaUpdatedAt?: number
}

type CoreArgs<K extends keyof CoreAccountManager> =
  CoreAccountManager[K] extends (...args: infer P) => unknown ? P : never
type CoreArgsAfterAccount<K extends keyof CoreAccountManager> =
  CoreArgs<K> extends [unknown, ...infer Rest] ? Rest : never
type CoreResult<K extends keyof CoreAccountManager> =
  CoreAccountManager[K] extends (...args: never[]) => infer R ? R : never

/**
 * Selection, rate-limit, toast and usage bookkeeping over one location's
 * rows. It has no credential operation. The arguments and results are the
 * core `AccountManager`'s, with its row type replaced by `A`, so a core
 * manager is a `RequestAccountPool<ManagedAccount>` as is.
 *
 * Account selection stays Antigravity's own policy. It is not delegated to
 * the `@cortexkit/common-auth` `./routing` entry, whose published semantics
 * differ in four ways that would change which account serves a request:
 *
 * 1. Cold start: `admit()` refuses an OAuth row with no quota reading, a
 *    missing window or an unknown reset (`dist/routing/admission.d.ts`,
 *    refusals `needs-first-reading`, `unknown-window`, `unknown-reset`).
 *    Antigravity selection and its killswitch pass such a row.
 * 2. Rate limits: admission keeps one mark per row (`rateLimitMarks` in
 *    `ExclusionInputs`, same file). Antigravity keeps marks per quota key
 *    (family, model and header style) and switches between the two Gemini
 *    quota pools.
 * 3. Strategies: the library routes only `ordered` or `sticky-balanced`
 *    (`RoutingMode`, `dist/routing/ordered.d.ts`), and both routes run
 *    admission (`OrderedRouteInput` and `StickyRouteInput` extend
 *    `AdmissionInput`). Antigravity uses sticky, round-robin and hybrid
 *    (health and token-bucket) selection with PID offset and per-session and
 *    parent-session pinning.
 * 4. Soft quota: Antigravity excludes accounts over
 *    `soft_quota_threshold_percent`, never the only usable account, and
 *    waits for the soonest reset. The library has no admission equivalent;
 *    `reservePercent` only weights sticky selection
 *    (`dist/routing/sticky.d.ts`).
 *
 * The killswitch verdict is a per-row boolean on both sides, but every
 * library route that accepts it also runs the admission gates above.
 */
export interface RequestAccountPool<A extends RequestAccountRow> {
  areAllAccountsOverSoftQuota(
    ...args: CoreArgs<'areAllAccountsOverSoftQuota'>
  ): boolean
  getAccountCount(): number
  getAccounts(): A[]
  getAccountsSnapshot(): A[]
  getEnabledAccounts(): A[]
  getAvailableHeaderStyle(
    account: A,
    ...rest: CoreArgsAfterAccount<'getAvailableHeaderStyle'>
  ): CoreResult<'getAvailableHeaderStyle'>
  getCurrentOrNextForFamily(
    ...args: CoreArgs<'getCurrentOrNextForFamily'>
  ): A | null
  getDailyRequestCounts(
    ...args: CoreArgs<'getDailyRequestCounts'>
  ): CoreResult<'getDailyRequestCounts'>
  getMinWaitTimeForFamily(...args: CoreArgs<'getMinWaitTimeForFamily'>): number
  getMinWaitTimeForSoftQuota(
    ...args: CoreArgs<'getMinWaitTimeForSoftQuota'>
  ): number | null
  getSessionSummary(): CoreResult<'getSessionSummary'>
  getTotalDailyRequests(...args: CoreArgs<'getTotalDailyRequests'>): number
  hasOtherAccountWithAntigravityAvailable(
    ...args: CoreArgs<'hasOtherAccountWithAntigravityAvailable'>
  ): boolean
  isRateLimitedForHeaderStyle(
    account: A,
    ...rest: CoreArgsAfterAccount<'isRateLimitedForHeaderStyle'>
  ): boolean
  markAccountCoolingDown(
    account: A,
    ...rest: CoreArgsAfterAccount<'markAccountCoolingDown'>
  ): void
  markAccountIneligible(...args: CoreArgs<'markAccountIneligible'>): boolean
  markAccountUsed(...args: CoreArgs<'markAccountUsed'>): void
  markAccountVerificationRequired(
    ...args: CoreArgs<'markAccountVerificationRequired'>
  ): boolean
  markRateLimited(
    account: A,
    ...rest: CoreArgsAfterAccount<'markRateLimited'>
  ): void
  markRateLimitedWithReason(
    account: A,
    ...rest: CoreArgsAfterAccount<'markRateLimitedWithReason'>
  ): number
  markToastShown(...args: CoreArgs<'markToastShown'>): void
  proactivelyRotateForFamily(
    ...args: CoreArgs<'proactivelyRotateForFamily'>
  ): A | null
  recordRequest(...args: CoreArgs<'recordRequest'>): void
  recordSessionUsage(...args: CoreArgs<'recordSessionUsage'>): void
  regenerateAccountFingerprint(
    ...args: CoreArgs<'regenerateAccountFingerprint'>
  ): CoreResult<'regenerateAccountFingerprint'>
  requestSaveToDisk(): void
  shouldProactivelyRotate(...args: CoreArgs<'shouldProactivelyRotate'>): boolean
  shouldShowAccountToast(...args: CoreArgs<'shouldShowAccountToast'>): boolean
  wasUsedInSession(...args: CoreArgs<'wasUsedInSession'>): boolean
}

/**
 * Credentials kept on the location's own pool rows (OpenCode 1, or a GA
 * location on its local account repository): the selected row's stored
 * token is refreshed when expired, its project is resolved, and the result
 * is written back to the pool. One token and project serve every send of
 * that selection.
 */
export interface LocalRequestCredentials<A extends RequestAccountRow> {
  readonly domain: 'local'
  /** The stored OAuth record of a row. */
  toAuthDetails(account: A): OAuthAuthDetails
  /** Write a refreshed or project-resolved record back to its row. */
  updateFromAuth(account: A, auth: OAuthAuthDetails): void
  /** Drop a row whose refresh token was revoked; true when it was removed. */
  removeAccount(account: A): boolean
  saveToDisk(): Promise<void>
  saveToDiskReplace(): Promise<void>
  /**
   * Refresh the selected row's expired access token. The row itself is
   * passed; an implementation refreshes exactly that row (a repository
   * adapter captures the row's ref before its first await) and never looks a
   * row up by refresh token. It returns the refreshed record as stored for
   * that row, so later grant checks see the successor credential; undefined
   * means the refresh failed.
   */
  refresh(account: A): Promise<OAuthAuthDetails | undefined>
  /** Resolve the project the request is sent under. */
  ensureProject(auth: OAuthAuthDetails): Promise<ProjectContextResult>
  /** True when a refresh error means the refresh token was revoked. */
  isInvalidGrant(error: unknown): boolean
  /** Clear host-stored OAuth credentials once the last account is removed. */
  clearStoredAuth(): Promise<void>
  /**
   * Capture the bearer and original row reference before any save, project
   * lookup or other await. For store accounts the ref includes row ID, the
   * credential replacement epoch, and authenticated identity; a refresh does
   * not advance that epoch. Later account changes cannot replace this ref.
   *
   * check() runs immediately before main sends, thinking warmups and cache
   * probes. It rejects unavailable metadata or a removed, disabled, replaced
   * or token-superseded credential. A store resolver can separately adopt the
   * current token at the original ref. This request executor may then capture
   * a new grant and rebuild once per request, without modifying the captured
   * check or penalizing the account for an ordinary token change.
   */
  captureGrant(grant: {
    readonly account: A
    readonly accessToken: string
  }): CapturedLocalGrant
  /**
   * Started without awaiting after a successful send, with the selected row
   * and `quota_refresh_interval_minutes`. `createLocalQuotaRefresh` builds
   * it for a core account manager. Absent: no refresh from the request path.
   */
  refreshQuotaAfterSuccess?(account: A, intervalMinutes: number): Promise<void>
}

/**
 * Credentials held by a vault: the engine never sees a stored token. Every
 * physical send (each endpoint attempt, retry and fallback) asks for a fresh
 * admission and uses that admission's token and project for that one send
 * only; nothing is refreshed, cached or written to a pool row.
 */
export interface VaultRequestCredentials<A extends RequestAccountRow> {
  readonly domain: 'vault'
  admit(request: {
    /** The metadata row selected for this send. */
    readonly account: A
    readonly signal: AbortSignal | undefined
  }): Promise<RequestSendAdmission>
}

/** One vault admission, valid for exactly one physical send. */
export interface RequestSendAdmission {
  /** The vault credential this admission serves. */
  readonly credentialId: string
  /** The account the vault asserted for this admission. */
  readonly accountIdentity: string
  /** The record version served; a 401 is reported against it. */
  readonly recordVersion: number
  readonly accessToken: string
  /** The Antigravity project served with this same admission. */
  readonly projectId: string
  /**
   * Reports a 401 served to this send against the exact record version
   * this admission carried. Called without awaiting the result; a rejection
   * is logged and ignored.
   */
  report401(status: number): Promise<unknown>
}

/** Which store holds the selected row's credentials. */
export type RequestCredentials<A extends RequestAccountRow> =
  | LocalRequestCredentials<A>
  | VaultRequestCredentials<A>

/** Wire preparation and response handling, unchanged from `../request`. */
export interface RequestWire {
  prepare: typeof prepareAntigravityRequest
  transformResponse: typeof transformAntigravityResponse
  buildThinkingWarmupBody: typeof buildThinkingWarmupBody
  getImageModelLocalTitle: typeof getImageModelLocalTitle
  getLastCacheStats: typeof getLastCacheStats
}

/** A prepared upstream request, as `RequestWire.prepare` returns it. */
export type PreparedAgyRequest = ReturnType<RequestWire['prepare']>

/** What a Google 403 body says about the account that received it. */
export interface AccountAccessErrorDetails {
  validationRequired: boolean
  accountIneligible: boolean
  message?: string
  verifyUrl?: string
}

/** The account and header style a session's request was finally sent with. */
export interface RequestRoutingEntry {
  accountId: string
  modelFamily: 'claude' | 'gemini'
  headerStyle: 'antigravity' | 'gemini-cli'
  strategy?: 'sticky' | 'round-robin' | 'hybrid'
  updatedAt: number
}

export type RequestNoticeVariant = 'info' | 'warning' | 'success' | 'error'

/** One upstream send's wire inputs, taken from a single credential grant. */
export interface AgyWireRequestInput {
  /** The host's Generative Language URL (or Request). */
  readonly input: RequestInfo
  readonly init?: RequestInit
  readonly accessToken: string
  readonly projectId: string
  /** Antigravity endpoint for this attempt. */
  readonly endpoint?: string
  readonly headerStyle?: HeaderStyle
  /** Close the tool loop and retry after a corrupted-thinking rejection. */
  readonly forceThinkingRecovery?: boolean
  readonly options?: PrepareRequestOptions
}

/**
 * Prepares one upstream Antigravity request: payload transforms, AGY
 * metadata and envelope, header order and the endpoint URL. It is the single
 * entry point the engine uses for every send, and the rules are exactly
 * `RequestWire.prepare`'s.
 */
export function prepareAgyWireRequest(
  wire: Pick<RequestWire, 'prepare'>,
  request: AgyWireRequestInput,
): PreparedAgyRequest {
  return wire.prepare(
    request.input,
    request.init,
    request.accessToken,
    request.projectId,
    request.endpoint,
    request.headerStyle,
    request.forceThinkingRecovery ?? false,
    request.options,
  )
}

/** This location's debug-log methods the engine calls. */
export type RequestDebug = Pick<
  LocationDebug,
  | 'isDebugEnabled'
  | 'logAccountContext'
  | 'logAntigravityDebugResponse'
  | 'logModelFamily'
  | 'logRateLimitEvent'
  | 'logRateLimitSnapshot'
  | 'logResponseBody'
  | 'startAntigravityDebugRequest'
>

/**
 * One location's collaborators for the shared request engine. `A` is the
 * location's pool row type; `credentials.domain` selects how a selected row
 * becomes a token and project.
 */
export interface RequestServicesDeps<A extends RequestAccountRow> {
  readonly config: AntigravityConfig
  readonly accounts: RequestAccountPool<A>
  readonly credentials: RequestCredentials<A>
  /** This location's AGY conversation/trajectory session metadata. */
  readonly sessions: AgySessionRegistry
  /**
   * Live operator settings: routing overrides and the killswitch, which
   * excludes accounts whose remaining quota is below a threshold.
   */
  readonly operatorSettings?: Pick<OperatorSettingsController, 'get'>
  /**
   * Raw HTTP/1.1 AGY sender for `antigravity` header-style sends. The engine
   * transforms the request first, then passes the prepared URL, init and
   * the caller's AbortSignal to it.
   */
  readonly transport: RequestTransport
  /** Standard fetch for `gemini-cli` header-style sends and their warmups. */
  readonly fetchImpl: RequestFetch
  readonly wire: RequestWire
  readonly debug: RequestDebug
  readonly dump: Pick<GeminiDumpState, 'dumpRequest'>
  readonly logger: Logger
  readonly trackers: {
    readonly health: Pick<
      HealthScoreTracker,
      'recordFailure' | 'recordRateLimit' | 'recordSuccess'
    >
    readonly token: Pick<TokenBucketTracker, 'consume' | 'refund'>
  }
  /**
   * Recognises Google's ACCOUNT_INELIGIBLE and VALIDATION_REQUIRED 403
   * bodies. It does not classify quota errors.
   */
  classifyAccessError(bodyText: string): AccountAccessErrorDetails
  /** Host notice (OpenCode 1 toast). Rejections and throws are ignored. */
  notify?(message: string, variant: RequestNoticeVariant): unknown
  /**
   * Records the route a session's request was dispatched on. Called without
   * awaiting; the dispatch path never waits on it and a throw is ignored.
   */
  onRouting?(sessionId: string, entry: RequestRoutingEntry): void
}

/** Per-request inputs the host supplies alongside the HTTP request. */
export interface RequestExecuteOptions {
  /**
   * The host session this request belongs to. When omitted, the OpenCode
   * session headers on the request are read.
   */
  readonly session?: OpenCodeSessionIdentity
  /**
   * The host's request kind. `title` routes the request as a session title
   * (see `routeTitleModel`); every kind other than `primary` keeps its own
   * AGY session metadata. Omitted by OpenCode 1, which has no kind.
   */
  readonly kind?: RequestKind
  /**
   * Raw sender for this request's `antigravity` header-style sends, in place
   * of `RequestServicesDeps.transport`. It receives the transformed request's
   * URL and init, and the caller's AbortSignal object itself.
   */
  readonly transport?: RequestTransport
}

/** The request kinds an OpenCode 2 host reports for a model request. */
export type RequestKind = 'primary' | 'compaction' | 'title' | 'generate'

/**
 * The model a title request is sent to when the host selected one this
 * plugin does not serve as text: an unregistered model or an image model.
 */
export const TITLE_FALLBACK_MODEL = 'gemini-3.5-flash-low'

/**
 * Routes a title request: a registered text model is kept; any other model
 * (unregistered, or an image model) is replaced in the URL by
 * `TITLE_FALLBACK_MODEL`. Everything else in the URL is unchanged.
 */
export function routeTitleModel(url: string): string {
  const model = extractModelFromUrl(url)
  if (model === null) return url
  const registered =
    Object.hasOwn(getPublicModelDefinitions(), model) ||
    Object.hasOwn(getResolverAliasMap(), model)
  if (registered && !isImageGenerationModel(model)) return url
  return url.replace(`/models/${model}`, `/models/${TITLE_FALLBACK_MODEL}`)
}

/**
 * The AGY metadata key for a request: the host session for primary (and
 * kind-less) requests, a separate per-kind key for every other kind.
 */
function agyMetadataIdentity(
  identity: OpenCodeSessionIdentity,
  kind: RequestKind | undefined,
): OpenCodeSessionIdentity {
  if (kind === undefined || kind === 'primary' || !identity.sessionId) {
    return identity
  }
  return {
    sessionId: `${identity.sessionId}#${kind}`,
    parentSessionId: identity.parentSessionId,
  }
}

/** The shared engine bound to one location. */
export interface AntigravityRequestExecutor {
  /**
   * Sends a Generative Language request through account selection, retries
   * and response transformation. Abort uses `init.signal` (or the Request's
   * signal) at every wait and send.
   */
  execute(
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: RequestExecuteOptions,
  ): Promise<Response>
  /** Releases retry and warmup bookkeeping. */
  dispose(): void
}

/**
 * Builds a Google-style 401 envelope describing a missing-account failure.
 *
 * A synthetic 200 SSE body pretending to be a Gemini stream hid the underlying
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

function terminalFetchError(
  lastError: Error | null,
  fallbackMessage: string,
): Error {
  // A synthetic HTTP 200 is parsed as successful assistant text, bypassing the
  // host's retry and error pipeline. Preserve the original exception rather
  // than replacing it with a message-only synthetic response.
  return lastError ?? new Error(fallbackMessage)
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

/** Formats a millisecond duration for human-readable wait/status messages. */
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
 * Background quota refresh after a successful send, for rows held in a core
 * account manager. It reads the row's refresh token, so it applies to local
 * credentials only. A reading for a row removed or replaced meanwhile is
 * dropped.
 */
export function createLocalQuotaRefresh(
  accountManager: Pick<
    CoreAccountManager,
    | 'getAccounts'
    | 'getAccountsForQuotaCheck'
    | 'updateQuotaCache'
    | 'requestSaveToDisk'
  >,
  quotaManager: Pick<QuotaManager, 'refreshAccount' | 'hashedLogLabel'>,
  log: Logger,
): (account: ManagedAccount, intervalMinutes: number) => Promise<void> {
  return async function refreshQuotaAfterSuccess(
    account: ManagedAccount,
    intervalMinutes: number,
  ): Promise<void> {
    if (intervalMinutes <= 0) return

    const accountIndex = accountManager.getAccounts().indexOf(account)
    if (accountIndex === -1 || account.enabled === false) return

    const intervalMs = intervalMinutes * 60 * 1000
    const age =
      account.cachedQuotaUpdatedAt != null
        ? Date.now() - account.cachedQuotaUpdatedAt
        : Infinity

    if (age < intervalMs) return

    let singleAccount:
      | ReturnType<CoreAccountManager['getAccountsForQuotaCheck']>[number]
      | undefined
    try {
      const accountsForCheck = accountManager.getAccountsForQuotaCheck()
      singleAccount = accountsForCheck[accountIndex]
      if (!singleAccount) return

      // The core quota cache write is attributed to the refresh token the
      // reading was taken with, so a reading never lands on a successor.
      const expectedRefreshToken = singleAccount.refreshToken

      const result = await quotaManager.refreshAccount(singleAccount, {
        index: accountIndex,
      })

      if (result.status === 'ok' && result.quota?.groups) {
        // Re-resolve the selected row itself. If it was removed meanwhile,
        // drop the reading rather than writing onto whichever row shifted
        // into its slot.
        const currentIndex = accountManager.getAccounts().indexOf(account)
        if (currentIndex === -1) return
        accountManager.updateQuotaCache(
          currentIndex,
          result.quota.groups,
          expectedRefreshToken,
        )
        accountManager.requestSaveToDisk()
      }
    } catch (err) {
      log.debug(
        `quota-refresh-failed ${singleAccount ? quotaManager.hashedLogLabel('account', singleAccount) : `idx-${accountIndex}`}`,
        { error: String(err) },
      )
    }
  }
}

/**
 * Builds one location's request engine. Each executor owns its retry and
 * warmup bookkeeping, so disposing it releases every counter.
 */
export function createRequestExecutor<A extends RequestAccountRow>(
  deps: RequestServicesDeps<A>,
): AntigravityRequestExecutor {
  const {
    config,
    accounts: accountManager,
    credentials,
    sessions: agySessionRegistry,
    operatorSettings,
    transport: defaultTransport,
    fetchImpl: upstreamFetch,
    wire,
    debug,
    dump,
    logger: log,
    trackers,
    classifyAccessError,
    notify,
    onRouting,
  } = deps

  const retryState: RetryState = createRetryState()
  const warmupState: WarmupState = createWarmupState()

  /** Reports a 401 served to an auxiliary send against its admission. */
  const reportVault401 = (
    admission: RequestSendAdmission | undefined,
    status: number,
  ): void => {
    if (!admission || status !== 401) return
    void Promise.resolve()
      .then(() => admission.report401(status))
      .catch((error: unknown) => {
        log.debug('send-admission-401-report-failed', { error: String(error) })
      })
  }

  const reportRouting = (
    sessionId: string,
    entry: RequestRoutingEntry,
  ): void => {
    if (!onRouting) return
    try {
      onRouting(sessionId, entry)
    } catch (error) {
      log.debug('routing-report-failed', { sessionId, error: String(error) })
    }
  }

  async function execute(
    input: RequestInfo | URL,
    init?: RequestInit,
    options: RequestExecuteOptions = {},
  ): Promise<Response> {
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

    // A host that names the request kind (OpenCode 2) routes titles by that
    // kind only. Without a kind (OpenCode 1) the title prompt itself is
    // recognised, as before.
    const kind = options.kind
    if (kind === undefined || kind === 'title') {
      const localImageTitle = wire.getImageModelLocalTitle(input, init)
      if (localImageTitle !== undefined) {
        return createSyntheticTextResponse(localImageTitle, {
          'X-Antigravity-Response-Type': 'local_title',
        })
      }
    }
    if (kind === 'title') {
      input = routeTitleModel(input)
    }

    // A host that sends each request through its own raw sender (the GA
    // loopback bridge) supplies it per request; every send of this request,
    // warmups included, then goes through it with the same AbortSignal.
    const transport = options.transport ?? defaultTransport
    const requestSessionIdentity =
      options.session ?? extractOpenCodeSessionIdentity(init?.headers)
    // AGY conversation/trajectory/step metadata is kept per session and
    // request kind: a title or compaction request never advances the
    // primary conversation's step counter or shares its trajectory.
    const agyRequestScope = agySessionRegistry.beginRequest(
      agyMetadataIdentity(requestSessionIdentity, kind),
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
    const family = getModelFamilyFromUrl(urlString, debug)
    const model = extractModelFromUrl(urlString)
    const debugLines: string[] = []
    const pushDebug = (line: string) => {
      if (!debug.isDebugEnabled()) return
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
    const cachedStats = wire.getLastCacheStats()
    if (cachedStats) {
      const label = cachedStats.hitRate > 0 ? 'HIT' : 'MISS'
      pushDebug(
        `[Cache] ${label} model=${cachedStats.model} read=${cachedStats.read} total=${cachedStats.total} hitRate=${cachedStats.hitRate}%`,
      )
    }

    type FailureContext = {
      response: Response
      streaming: boolean
      debugContext: ReturnType<LocationDebug['startAntigravityDebugRequest']>
      requestedModel?: string
      projectId?: string
      endpoint?: string
      effectiveModel?: string
      sessionId?: string
      toolDebugMissing?: number
      toolDebugSummary?: string
      toolDebugPayload?: string
      dumpContext?: ReturnType<GeminiDumpState['dumpRequest']>
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
        await notify?.(message, variant)
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
    let localRecaptureUsed = false

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

      // Operator killswitch: an account whose cached remaining quota for
      // this model's quota group is below the configured floor is not
      // eligible. Missing or stale quota counts as eligible, so a cold
      // start cannot block every account.
      const operatorKillswitch = operatorSettings?.get().killswitch
      const eligibleIndexes = operatorKillswitch?.enabled
        ? new Set(
            accountManager
              .getAccounts()
              .filter((entry) => {
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
                  { now: Date.now(), model },
                )
                return decision.allowed
              })
              .map((entry) => entry.index),
          )
        : null

      if (
        eligibleIndexes !== null &&
        eligibleIndexes.size === 0 &&
        accountCount > 0
      ) {
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
            quotaModel: model,
          })
        } catch (error) {
          if (error instanceof AntigravityKillswitchError) {
            log.warn('killswitch-all-excluded', {
              family,
              model,
              threshold: error.thresholdPercent,
              summaries: error.summaries,
            })
            return createNativeGoogleErrorResponse({
              status: 412,
              reason: 'operator_policy',
            })
          }
          throw error
        }
      }

      // The eligibility mask above is computed once for this selection
      // pass and applies to both the initial selection and the header-style
      // fallback below. Selection does not re-evaluate quota, so a killed
      // current account falls through to the next eligible account.
      const killedIndexes =
        eligibleIndexes === null
          ? undefined
          : new Set(
              accountManager
                .getAccounts()
                .map((entry) => entry.index)
                .filter((index) => !eligibleIndexes.has(index)),
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
        killedIndexes,
      )

      // The selected account must be inside the eligibility mask.
      if (
        account &&
        eligibleIndexes !== null &&
        !eligibleIndexes.has(account.index)
      ) {
        pushDebug(
          `killswitch-excluded idx=${account.index} (precomputed eligible set)`,
        )
        account = null
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
          killedIndexes,
        )
        if (account) {
          pushDebug(
            `selected-by-fallback idx=${account.index} preferred=${preferredHeaderStyle} alternate=${alternateHeaderStyle}`,
          )
        }
        // The header-style fallback may not select an account outside the
        // eligibility mask.
        if (
          account &&
          eligibleIndexes !== null &&
          !eligibleIndexes.has(account.index)
        ) {
          pushDebug(
            `killswitch-excluded idx=${account.index} after fallback (precomputed eligible set)`,
          )
          account = null
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
            return createNativeGoogleErrorResponse({
              status: 412,
              reason: 'soft_quota',
              resetAfterMs: softQuotaWaitMs,
            })
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
        const minWaitMs = accountManager.getMinWaitTimeForFamily(
          family,
          model,
          preferredHeaderStyle,
          strictWait,
        )
        const waitMs = minWaitMs || 60_000

        pushDebug(
          `all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`,
        )
        if (debug.isDebugEnabled()) {
          debug.logAccountContext('All accounts rate-limited', {
            index: -1,
            family,
            totalAccounts: accountCount,
          })
          debug.logRateLimitSnapshot(
            family,
            accountManager.getAccountsSnapshot(),
          )
        }

        const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000
        if (maxWaitMs > 0 && waitMs > maxWaitMs) {
          const waitTimeFormatted = formatWaitTime(waitMs)
          await showToast(
            `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
            'error',
          )
          return createNativeGoogleErrorResponse({
            status: 412,
            reason: 'pool_unavailable',
            // Zero means the account manager has no future reset to report.
            // The fallback sleep duration above is not a quota reset estimate.
            resetAfterMs: minWaitMs > 0 ? minWaitMs : undefined,
          })
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
      if (debug.isDebugEnabled()) {
        debug.logAccountContext('Selected', {
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

      // Local credentials only: refresh the row's stored token when it has
      // expired, resolve its project and write both back to the pool; that
      // token and project serve the sends of this selection. The vault
      // domain skips this entirely: it has no stored token, no refresh and
      // no project cache, and takes a fresh admission for every physical
      // send below.
      let localGrant: {
        accessToken: string
        projectId: string
        /** The captured grant's check, run before every physical send. */
        captured: CapturedLocalGrant
      } | null = null
      const prepareLocalGrant = async (
        auth: OAuthAuthDetails,
        captured: CapturedLocalGrant,
        persistProject = true,
      ): Promise<NonNullable<typeof localGrant>> => {
        if (credentials.domain !== 'local' || !auth.access)
          throw new Error('Local credentials were not resolved')
        const context = await credentials.ensureProject(auth)
        // A project cache may carry an older bearer. Only the token fixed
        // before this await belongs to the newly prepared request.
        const projectAuth: OAuthAuthDetails = {
          ...context.auth,
          access: auth.access,
          expires: auth.expires,
        }
        if (persistProject && projectAuth.refresh !== auth.refresh) {
          credentials.updateFromAuth(account, projectAuth)
          try {
            await credentials.saveToDisk()
          } catch (error) {
            log.error('Failed to persist project context', {
              error: String(error),
            })
          }
        }
        return {
          accessToken: auth.access,
          projectId: context.effectiveProjectId,
          captured,
        }
      }
      if (credentials.domain === 'local') {
        let authRecord = credentials.toAuthDetails(account)
        // The grant is captured synchronously the moment its token is fixed
        // (the stored token, or the refresh's successor), before any later
        // await such as the save or project resolution. Its check therefore
        // judges every send against the row this token was resolved for,
        // even if the account object changes during those waits.
        const captureFor = (
          auth: OAuthAuthDetails,
        ): CapturedLocalGrant | undefined =>
          auth.access
            ? credentials.captureGrant({ account, accessToken: auth.access })
            : undefined
        let grantCheck = accessTokenExpired(authRecord)
          ? undefined
          : captureFor(authRecord)

        if (accessTokenExpired(authRecord)) {
          try {
            const refreshed = await credentials.refresh(account)
            if (!refreshed) {
              const { failures, shouldCooldown, cooldownMs } =
                retryState.trackAccountFailure(account.index)
              trackers.health.recordFailure(account.index)
              lastError = new Error('Antigravity token refresh failed')
              // A refresh that yields no credential is an authentication
              // failure. With no other account to try, answer the native 401
              // the missing-token check below gives, rather than retrying
              // until the cooldown turns it into a pool-unavailable 412.
              if (accountCount <= 1) {
                return createNativeGoogleErrorResponse({
                  status: 401,
                  reason: 'missing_access_token',
                })
              }
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
            credentials.updateFromAuth(account, refreshed)
            authRecord = refreshed
            grantCheck = captureFor(authRecord)
            try {
              await credentials.saveToDisk()
            } catch (error) {
              log.error('Failed to persist refreshed auth', {
                error: String(error),
              })
            }
          } catch (error) {
            if (credentials.isInvalidGrant(error)) {
              const removed = credentials.removeAccount(account)
              if (removed) {
                log.warn(
                  'Removed revoked account from pool - reauthenticate via `opencode auth login`',
                )
                try {
                  await credentials.saveToDiskReplace()
                } catch (persistError) {
                  log.error('Failed to persist revoked account removal', {
                    error: String(persistError),
                  })
                }
              }

              if (accountManager.getAccountCount() === 0) {
                try {
                  await credentials.clearStoredAuth()
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

              lastError =
                error instanceof Error ? error : new Error(String(error))
              continue
            }

            const { failures, shouldCooldown, cooldownMs } =
              retryState.trackAccountFailure(account.index)
            trackers.health.recordFailure(account.index)
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
        // Require the account-identity check captured with this access token
        // before dispatch.
        if (!accessToken || grantCheck === undefined) {
          lastError = new Error('Missing access token')
          if (accountCount <= 1) {
            return createNativeGoogleErrorResponse({
              status: 401,
              reason: 'missing_access_token',
            })
          }
          continue
        }

        try {
          localGrant = await prepareLocalGrant(authRecord, grantCheck)
          retryState.resetAccountFailureState(account.index)
        } catch (error) {
          const { failures, shouldCooldown, cooldownMs } =
            retryState.trackAccountFailure(account.index)
          trackers.health.recordFailure(account.index)
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
      }
      const selected = account

      // Credentials for one auxiliary physical send (thinking warmup or cache
      // probe) built from a prepared request. Local: the selection's grant
      // must still be the row's current credential. Vault: a fresh admission
      // for this send alone; its token replaces the prepared one, and its
      // project must be the prepared request's, otherwise the send is
      // skipped rather than sent under a project from another receipt.
      const credentialForAuxiliarySend = async (
        sendInit: RequestInit,
        preparedProjectId: string,
      ): Promise<{ init: RequestInit; admission?: RequestSendAdmission }> => {
        if (credentials.domain === 'vault') {
          const admission = await credentials.admit({
            account: selected,
            signal: abortSignal,
          })
          if (admission.projectId !== preparedProjectId) {
            throw new Error(
              'The vault served another project for this send; skipping it',
            )
          }
          const headers = new Headers(sendInit.headers)
          headers.set('Authorization', `Bearer ${admission.accessToken}`)
          return { init: { ...sendInit, headers }, admission }
        }
        if (!localGrant) {
          throw new Error(
            'Local credentials were not resolved for the selected account',
          )
        }
        await localGrant.captured.check()
        return { init: sendInit }
      }

      const runThinkingWarmup = async (
        prepared: PreparedAgyRequest,
        projectId: string,
      ): Promise<void> => {
        if (!config.thinking_warmup) return
        if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) return
        if (!warmupState.trackAttempt(prepared.sessionId)) return

        const warmupBody = wire.buildThinkingWarmupBody(
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

        const warmupDebugContext = debug.startAntigravityDebugRequest({
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
          const warmupSend = await credentialForAuxiliarySend(
            warmupInit,
            projectId,
          )
          const warmupResponse =
            prepared.headerStyle === 'antigravity'
              ? await transport(warmupUrl, warmupSend.init, {
                  signal: abortSignal,
                  onDebug: pushDebug,
                })
              : await upstreamFetch(warmupUrl, warmupSend.init)
          reportVault401(warmupSend.admission, warmupResponse.status)
          const transformed = await wire.transformResponse(
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
          if (isLocalGrantError(error)) throw error
          pushDebug(
            `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const runCacheWarmupProbe = async (
        prepared: PreparedAgyRequest,
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

          const probeSend = await credentialForAuxiliarySend(
            { ...prepared.init, method: 'POST', body: bodyStr },
            prepared.projectId ?? '',
          )
          const probeResponse =
            prepared.headerStyle === 'antigravity'
              ? await transport(toUrlString(prepared.request), probeSend.init, {
                  signal: abortSignal,
                  onDebug: pushDebug,
                })
              : await upstreamFetch(
                  toUrlString(prepared.request),
                  probeSend.init,
                )
          reportVault401(probeSend.admission, probeResponse.status)

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
          if (isLocalGrantError(error)) {
            needsCacheWarmup = true
            throw error
          }
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
        let capacityRetryCount = 0
        let lastEndpointIndex = -1

        // At most one vault 401 retry per selection, on a rotated admission.
        let rotatedAdmission: RequestSendAdmission | undefined
        let vault401Retried = false
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

          let tokenConsumed = false
          let physicalAttemptStarted = false
          try {
            // One credential grant per physical send, chosen by domain. Vault:
            // a fresh admission for this send only; its token and project come
            // from that one receipt, and a 401 is reported against its record
            // version. Local: the grant resolved above for this selection.
            let sendAdmission: RequestSendAdmission | undefined
            let sendAccessToken: string
            let sendProjectId: string
            if (credentials.domain === 'vault') {
              // A rotated admission taken after a 401 serves exactly the
              // retry it was taken for, then is gone.
              sendAdmission =
                rotatedAdmission ??
                (await credentials.admit({
                  account,
                  signal: abortSignal,
                }))
              rotatedAdmission = undefined
              sendAccessToken = sendAdmission.accessToken
              sendProjectId = sendAdmission.projectId
            } else if (localGrant) {
              sendAccessToken = localGrant.accessToken
              sendProjectId = localGrant.projectId
            } else {
              throw new Error(
                'Local credentials were not resolved for the selected account',
              )
            }
            const prepared = prepareAgyWireRequest(wire, {
              input,
              init,
              accessToken: sendAccessToken,
              projectId: sendProjectId,
              endpoint: currentEndpoint,
              headerStyle,
              forceThinkingRecovery,
              options: {
                claudeToolHardening: config.claude_tool_hardening,
                claudePromptAutoCaching: config.claude_prompt_auto_caching,
                fingerprint: account.fingerprint,
                agySession: agyRequestSession,
                agyRequestTimestamp: agyRequestScope.timestamp,
              },
            })

            const originalUrl = toUrlString(input)
            const resolvedUrl = toUrlString(prepared.request)
            pushDebug(`endpoint=${currentEndpoint}`)
            pushDebug(`resolved=${resolvedUrl}`)
            const debugContext = debug.startAntigravityDebugRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              projectId: sendProjectId,
            })
            const dumpContext = dump.dumpRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              requestedModel: prepared.requestedModel,
              effectiveModel: prepared.effectiveModel,
              sessionId: prepared.sessionId,
              projectId: sendProjectId,
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

            await runThinkingWarmup(prepared, sendProjectId)
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
              tokenConsumed = trackers.token.consume(account.index)
            }

            if (credentials.domain === 'local') {
              if (!localGrant) {
                throw new Error(
                  'Local credentials were not resolved for the selected account',
                )
              }
              await localGrant.captured.check()
            }

            pushDebug(
              `dispatching request via ${prepared.headerStyle} transport`,
            )
            physicalAttemptStarted = true
            const response =
              prepared.headerStyle === 'antigravity'
                ? await transport(
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
            if (
              credentials.domain === 'vault' &&
              sendAdmission &&
              response.status === 401
            ) {
              // Report the 401 against the exact record version this send's
              // admission carried, then take a fresh admission. Only a newer
              // version of the same credential and account may retry this
              // endpoint, once; otherwise the 401 stands.
              try {
                await sendAdmission.report401(response.status)
              } catch (error) {
                log.debug('send-admission-401-report-failed', {
                  error: String(error),
                })
              }
              if (!vault401Retried) {
                const next = await credentials.admit({
                  account,
                  signal: abortSignal,
                })
                if (
                  next.credentialId === sendAdmission.credentialId &&
                  next.accountIdentity === sendAdmission.accountIdentity &&
                  next.recordVersion > sendAdmission.recordVersion
                ) {
                  vault401Retried = true
                  rotatedAdmission = next
                  void response.body?.cancel().catch(() => {})
                  pushDebug(
                    `vault-401: retrying with record version ${next.recordVersion}`,
                  )
                  i -= 1
                  continue
                }
              }
            }

            // Record the final route selection so the sidebar renders the
            // actual account/header-style used by this request. Fire-and-
            // forget — the dispatch path must not wait on a state write.
            const sessionKey = requestSessionIdentity.sessionId
            if (sessionKey) {
              const routingEntry: RequestRoutingEntry = {
                accountId: `acct-${account.index}`,
                modelFamily: family,
                headerStyle: prepared.headerStyle,
                strategy: config.account_selection_strategy,
                updatedAt: Date.now(),
              }
              reportRouting(sessionKey, routingEntry)
            }

            if (
              response.status === 429 ||
              response.status === 503 ||
              response.status === 529
            ) {
              if (tokenConsumed) {
                trackers.token.refund(account.index)
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

              debug.logRateLimitEvent(
                account.index,
                account.email,
                family,
                response.status,
                effectiveDelayMs,
                reasonInfo,
              )
              await debug.logResponseBody(debugContext, response, 429)
              trackers.health.recordRateLimit(account.index)

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
              const extracted = classifyAccessError(errorBodyText)

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
                trackers.health.recordFailure(account.index)
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
                trackers.health.recordFailure(account.index)
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
              await debug.logResponseBody(
                debugContext,
                response,
                response.status,
              )
              lastFailure = createFailureContext(response)
              continue
            }

            if (response.ok) {
              account.consecutiveFailures = 0
              trackers.health.recordSuccess(account.index)
              accountManager.markAccountUsed(account.index)

              if (
                credentials.domain === 'local' &&
                credentials.refreshQuotaAfterSuccess
              ) {
                void credentials
                  .refreshQuotaAfterSuccess(
                    account,
                    config.quota_refresh_interval_minutes,
                  )
                  .catch(() => {})
              }

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
            debug.logAntigravityDebugResponse(debugContext, response, {
              note: response.ok ? 'Success' : `Error ${response.status}`,
            })
            if (response.ok && !prepared.streaming) {
              await debug.logResponseBody(
                debugContext,
                response,
                response.status,
              )
            }
            if (!response.ok) {
              await debug.logResponseBody(
                debugContext,
                response,
                response.status,
              )

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
                  // Only the clone was inspected; the host must receive the
                  // original overflow payload, status, headers and unread body.
                  return response
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
                return createNativeGoogleErrorResponse({
                  status: 502,
                  reason: 'empty_response',
                })
              }

              const _emptyAttemptKeyClean = `${prepared.sessionId ?? 'none'}:${prepared.effectiveModel ?? 'unknown'}`
              retryState.clearEmptyResponseAttempts()
            }

            const transformedResponse = await wire.transformResponse(
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
            if (
              tokenConsumed &&
              (!isLocalGrantError(error) || !physicalAttemptStarted)
            ) {
              trackers.token.refund(account.index)
              tokenConsumed = false
            }

            if (
              credentials.domain === 'local' &&
              localGrant?.captured.source === 'store' &&
              isLocalGrantError(error)
            ) {
              // The one-recapture limit covers main requests, warmups and probes. A
              // superseded unsent preparation is rebuilt on the same selection
              // and request scope, without failure penalties or endpoint retry.
              if (
                error instanceof LocalGrantSupersededError &&
                !localRecaptureUsed
              ) {
                localRecaptureUsed = true
                try {
                  await localGrant.captured.resolveCurrent()
                  const auth = credentials.toAuthDetails(account)
                  if (!auth.access || accessTokenExpired(auth))
                    return createNativeGoogleErrorResponse({
                      status: 412,
                      reason: 'pool_unavailable',
                    })
                  const captured = credentials.captureGrant({
                    account,
                    accessToken: auth.access,
                  })
                  localGrant = await prepareLocalGrant(auth, captured, false)
                  i = -1
                  continue
                } catch {
                  checkAborted()
                }
              }
              return createNativeGoogleErrorResponse({
                status: 412,
                reason: 'pool_unavailable',
              })
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
            return wire.transformResponse(
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
          throw terminalFetchError(
            lastError,
            `Exceeded max account switches (${maxAccountSwitches}). All accounts rate-limited.`,
          )
        }

        if (accountCount <= 1) {
          if (lastFailure) {
            return wire.transformResponse(
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
          throw terminalFetchError(
            lastError,
            'All Antigravity endpoints failed',
          )
        }

        continue
      }

      if (lastFailure) {
        return wire.transformResponse(
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

      throw terminalFetchError(lastError, 'All Antigravity accounts failed')
    }
  }

  function dispose(): void {
    retryState.dispose()
    warmupState.dispose()
  }

  return { execute, dispose }
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
