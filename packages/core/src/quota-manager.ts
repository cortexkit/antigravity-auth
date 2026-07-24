/**
 * Harness-agnostic attributed quota manager.
 *
 * Owns the per-account quota cache, in-flight de-duplication, and exponential
 * backoff that backgrounds proactive quota refreshes. The manager has no host
 * dependencies — harnesses supply a `fetchAccountQuota` callback that returns
 * the already-attributed `AccountQuotaResult` (with `index`, `email`,
 * `updatedAccount`, etc.) so core stays harness-agnostic.
 *
 * Manual quota dialogs must force a refresh even when background refresh is
 * backed off; proactive refreshes must dedupe by stable account identity and
 * respect backoff. Account identity is supplied via `keyOf` so reorders/
 * removals of the underlying array do not invalidate cache entries.
 */

import { createHash } from 'node:crypto'
import type { AccountMetadataV3 } from './account-types.ts'
import { fetchWithActiveTimeout } from './fetch-timeout.ts'
import { buildAntigravityHarnessUserAgent } from './fingerprint.ts'
import { createLogger } from './logger.ts'
import { getQuotaGroupForModel } from './model-registry.ts'
import type {
  AccountQuotaResult,
  GeminiCliQuotaSummary,
  PerModelQuotaEntry,
  QuotaGroup,
  QuotaGroupSummary,
  QuotaSummary,
  QuotaWindowEntry,
} from './quota-types.ts'

const log = createLogger('quota-manager')

export const QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS = 30_000
export const QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000
export const QUOTA_MANAGER_DEFAULT_TIMEOUT_MS = 10_000

/**
 * Signature for the harness-supplied quota fetch callback.
 *
 * `index`/`email`/`updatedAccount` come from the harness — the manager
 * preserves the harness's attribution and only injects status/error info
 * for disabled accounts and failed fetches.
 */
export type FetchAccountQuota = (
  account: AccountMetadataV3,
  signal: AbortSignal,
) => Promise<AccountQuotaResult>

export interface QuotaManagerOptions {
  fetchAccountQuota: FetchAccountQuota
  /**
   * Stable identity for an account. Used as cache key + backoff key. Should
   * NOT be the array index — reorders and removals would otherwise corrupt
   * cached state. The harness can hash the refresh token or compose email +
   * a refresh-token fallback.
   */
  keyOf: (account: AccountMetadataV3) => string
  now?: () => number
  baseBackoffMs?: number
  maxBackoffMs?: number
  /** Per-fetch active timeout for the harness callback. */
  fetchTimeoutMs?: number
}

export interface RefreshAccountOptions {
  /** Position of the account in the harness-visible array. Preserved on result. */
  index: number
  /** Bypass backoff (used by manual quota dialogs). */
  force?: boolean
}

export interface RefreshAccountsOptions {
  indexFor: (account: AccountMetadataV3) => number
  force?: boolean
}

export interface QuotaManager {
  refreshAccount(
    account: AccountMetadataV3,
    options: RefreshAccountOptions,
  ): Promise<AccountQuotaResult>
  refreshAccounts(
    accounts: AccountMetadataV3[],
    options: RefreshAccountsOptions,
  ): Promise<AccountQuotaResult[]>
  getCached(account: AccountMetadataV3): AccountQuotaResult | undefined
  getBackoffUntil(account: AccountMetadataV3): number
  /** Stable hash for an account, used for log labels. */
  hashedLogLabel(prefix: string, account: AccountMetadataV3 | string): string
  /**
   * Await any in-flight refresh, then cancel and reject subsequent
   * refreshes. Returns a promise so a lifecycle producer can fence its
   * fire-and-forget sidebar writes: awaiting `dispose()` guarantees no
   * refresh is still mid-flight (and therefore cannot enqueue a write)
   * once it resolves.
   */
  dispose(): Promise<void>
  /** Pure helpers exposed for tests and adapter wiring. */
  classifyQuotaGroup: typeof classifyQuotaGroup
  aggregateQuota: typeof aggregateQuota
  aggregateGeminiCliQuota: typeof aggregateGeminiCliQuota
}

interface AccountState {
  consecutiveFailures: number
  backoffUntil: number
  inflight?: Promise<AccountQuotaResult>
  controller?: AbortController
  cached?: AccountQuotaResult
}

/**
 * Default keyOf — prefers email, falls back to refresh-token hash so the
 * same identity is keyed even when emails are missing.
 */
export function defaultKeyOf(account: AccountMetadataV3): string {
  if (account.email) return `e:${account.email.toLowerCase()}`
  const token = account.refreshToken || ''
  return `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

export function createQuotaManager(options: QuotaManagerOptions): QuotaManager {
  const now = options.now ?? (() => Date.now())
  const baseBackoffMs =
    options.baseBackoffMs ?? QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS
  const maxBackoffMs =
    options.maxBackoffMs ?? QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS
  const fetchTimeoutMs =
    options.fetchTimeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS

  const state = new Map<string, AccountState>()
  let disposed = false

  const keyOf = (account: AccountMetadataV3): string => options.keyOf(account)

  const recordSuccess = (key: string): void => {
    const entry = state.get(key)
    if (!entry) return
    entry.consecutiveFailures = 0
    entry.backoffUntil = 0
  }

  const recordFailure = (
    key: string,
  ): { backoffMs: number; backoffUntil: number } => {
    const current = now()
    const entry = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0,
    }
    const failures = entry.consecutiveFailures + 1
    const backoffMs = Math.min(
      maxBackoffMs,
      baseBackoffMs * 2 ** (failures - 1),
    )
    entry.consecutiveFailures = failures
    entry.backoffUntil = current + backoffMs
    state.set(key, entry)
    return { backoffMs, backoffUntil: entry.backoffUntil }
  }

  const cacheResult = (key: string, result: AccountQuotaResult): void => {
    const entry = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0,
    }
    entry.cached = result
    state.set(key, entry)
  }

  const buildDisabledResult = (
    account: AccountMetadataV3,
    index: number,
  ): AccountQuotaResult => ({
    index,
    email: account.email,
    status: 'disabled',
    disabled: true,
    quota: undefined,
    geminiCliQuota: undefined,
    updatedAccount: undefined,
  })

  const buildSkippedResult = (
    account: AccountMetadataV3,
    index: number,
    backoffUntil: number,
  ): AccountQuotaResult => {
    const cached = state.get(keyOf(account))?.cached
    if (cached) {
      return { ...cached, index }
    }
    return {
      index,
      email: account.email,
      status: 'error',
      error: `quota refresh skipped (backoff until ${new Date(backoffUntil).toISOString()})`,
    }
  }

  const refreshAccount = async (
    account: AccountMetadataV3,
    refreshOptions: RefreshAccountOptions,
  ): Promise<AccountQuotaResult> => {
    if (disposed) {
      return {
        index: refreshOptions.index,
        email: account.email,
        status: 'error',
        error: 'quota manager disposed',
      }
    }

    const { index, force = false } = refreshOptions
    const key = keyOf(account)

    if (account.enabled === false) {
      const result = buildDisabledResult(account, index)
      cacheResult(key, result)
      return result
    }

    const current = now()
    const entry = state.get(key)
    if (!force && entry && entry.backoffUntil > current) {
      return buildSkippedResult(account, index, entry.backoffUntil)
    }

    const inflight = entry?.inflight
    if (inflight) {
      // Reuse the cached result of the in-flight fetch, but preserve this
      // caller's requested index for attribution.
      const cached = await inflight
      return { ...cached, index }
    }

    const controller = new AbortController()
    const stored = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0,
    }
    stored.controller = controller
    state.set(key, stored)

    const promise = (async (): Promise<AccountQuotaResult> => {
      try {
        const signal = AbortSignal.timeout(fetchTimeoutMs)
        const composite = controller.signal.aborted
          ? controller.signal
          : AbortSignal.any([controller.signal, signal])

        const result = await options.fetchAccountQuota(account, composite)
        if (controller.signal.aborted) {
          throw new Error('quota manager disposed mid-fetch')
        }
        const attributed: AccountQuotaResult = { ...result, index }
        cacheResult(key, attributed)

        // Adapter contract: `fetchAccountQuota` resolves with an
        // attributed result. Failures should arrive as `{ status: 'error' }`
        // rather than throwing — treat them like thrown failures so backoff
        // actually protects the account from re-hammering. `disabled` and
        // `ok` both count as success (no fetch happened, or it succeeded).
        if (result.status === 'error') {
          const { backoffMs } = recordFailure(key)
          log.debug('quota-refresh-failed', {
            key: hashKey(key),
            backoffMs,
            error: result.error ?? 'attributed error result',
          })
          return attributed
        }

        recordSuccess(key)
        return attributed
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (disposed || controller.signal.aborted) {
          const failureResult: AccountQuotaResult = {
            index,
            email: account.email,
            status: 'error',
            error: message,
          }
          cacheResult(key, failureResult)
          return failureResult
        }
        const { backoffMs } = recordFailure(key)
        log.debug('quota-refresh-failed', {
          key: hashKey(key),
          backoffMs,
          error: message,
        })
        const failureResult: AccountQuotaResult = {
          index,
          email: account.email,
          status: 'error',
          error: message,
        }
        cacheResult(key, failureResult)
        return failureResult
      } finally {
        const finished = state.get(key)
        if (finished) {
          finished.inflight = undefined
          finished.controller = undefined
          state.set(key, finished)
        }
      }
    })()

    stored.inflight = promise
    state.set(key, stored)

    return promise
  }

  const refreshAccounts = async (
    accounts: AccountMetadataV3[],
    refreshOptions: RefreshAccountsOptions,
  ): Promise<AccountQuotaResult[]> => {
    const results: AccountQuotaResult[] = []
    for (const account of accounts) {
      const index = refreshOptions.indexFor(account)
      const result = await refreshAccount(account, {
        index,
        force: refreshOptions.force,
      })
      results.push(result)
    }
    return results
  }

  const getCached = (
    account: AccountMetadataV3,
  ): AccountQuotaResult | undefined => {
    const entry = state.get(keyOf(account))
    return entry?.cached
  }

  const getBackoffUntil = (account: AccountMetadataV3): number => {
    return state.get(keyOf(account))?.backoffUntil ?? 0
  }

  const hashedLogLabel = (
    prefix: string,
    account: AccountMetadataV3 | string,
  ): string => {
    const identity = typeof account === 'string' ? account : keyOf(account)
    return `${prefix} ${hashKey(identity)}`
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    // Snapshot the in-flight refreshes before aborting — the refresh
    // `finally` clears `entry.inflight` as each promise settles, so we
    // must capture the promises first.
    const pending = Array.from(
      state.values(),
      (entry) => entry.inflight,
    ).filter(
      (promise): promise is Promise<AccountQuotaResult> => promise != null,
    )
    // Abort so a genuinely-stuck fetch unwinds promptly (the refresh
    // catches the abort and resolves with an error result rather than
    // hanging dispose), then AWAIT the settled promises. Awaiting after
    // the abort still fences the producer: the opencode quota wrapper's
    // fire-and-forget sidebar write runs in the continuation after the
    // core refresh resolves, so by the time dispose() resolves that
    // write has already been enqueued onto the sidebar chain and the
    // subsequent lifecycle drain will flush it.
    for (const [, entry] of state) {
      entry.controller?.abort()
    }
    if (pending.length > 0) {
      // Each refresh swallows its own errors and resolves; awaiting is a
      // fence, never a rejection surface.
      await Promise.allSettled(pending)
    }
    for (const [, entry] of state) {
      entry.inflight = undefined
    }
  }

  return {
    refreshAccount,
    refreshAccounts,
    getCached,
    getBackoffUntil,
    hashedLogLabel,
    dispose,
    classifyQuotaGroup,
    aggregateQuota,
    aggregateGeminiCliQuota,
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

// ============================================================================
// Pure helpers — also exported for adapter use.
// ============================================================================

/**
 * Classify a model into its quota group.
 */
export function classifyQuotaGroup(
  modelName: string,
  displayName?: string,
): QuotaGroup | null {
  const registryGroup = getQuotaGroupForModel(modelName)
  if (registryGroup) {
    return registryGroup
  }

  const combined = `${modelName} ${displayName ?? ''}`.toLowerCase()
  // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so a
  // `gemini-claude-*` alias (Claude route exposed under a `gemini-`
  // namespace) attributes to the non-gemini pool rather than the gemini
  // pool. `tab_*` autocomplete IDs are already classified by
  // `getQuotaGroupForModel` above (the registry/prefix branches), so
  // this fallback only runs for genuinely-unrecognised model strings.
  if (combined.includes('claude') || combined.includes('gpt-oss')) {
    return 'non-gemini'
  }
  if (combined.includes('gemini')) {
    return 'gemini'
  }
  return null
}

function normalizeRemainingFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) {
    return null
  }
  return timestamp
}

export interface FetchAvailableModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

/**
 * Aggregate per-model quota entries into group summaries + per-model list.
 *
 * Pure helper — exposed for harness adapters that want to reuse the same
 * aggregation logic without re-implementing it.
 */
export function aggregateQuota(
  models?: Record<string, FetchAvailableModelEntry>,
): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {}
  const perModel: PerModelQuotaEntry[] = []
  if (!models) {
    return { groups, perModel, modelCount: 0 }
  }

  let totalCount = 0
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(
      modelName,
      entry.displayName ?? entry.modelName,
    )
    const quotaInfo = entry.quotaInfo
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined
    const resetTime = quotaInfo?.resetTime
    const resetTimestamp = parseResetTime(resetTime)

    totalCount += 1

    perModel.push({
      modelId: modelName,
      displayName: entry.displayName ?? entry.modelName,
      group,
      remainingFraction: remainingFraction ?? 0,
      resetTime,
    })

    if (!group) {
      continue
    }

    const existing = groups[group]
    const nextCount = (existing?.modelCount ?? 0) + 1
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction)

    let nextResetTime = existing?.resetTime
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime)
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    }
  }

  perModel.sort((a, b) => a.modelId.localeCompare(b.modelId))

  return { groups, perModel, modelCount: totalCount }
}

export interface RetrieveUserQuotaBucket {
  remainingAmount?: string
  remainingFraction?: number
  resetTime?: string
  tokenType?: string
  modelId?: string
}

export interface RetrieveUserQuotaResponse {
  buckets?: RetrieveUserQuotaBucket[]
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>
}

// ============================================================================
// retrieveUserQuotaSummary — windowed quota source (2 pools × variable windows)
// ============================================================================

export interface RetrieveUserQuotaSummaryBucket {
  bucketId: string
  displayName: string
  window: 'weekly' | '5h'
  resetTime: string
  remainingFraction: number
  description?: string
}

export interface RetrieveUserQuotaSummaryGroup {
  displayName: string
  description?: string
  buckets: RetrieveUserQuotaSummaryBucket[]
}

export interface RetrieveUserQuotaSummaryResponse {
  groups: RetrieveUserQuotaSummaryGroup[]
  description?: string
}

/**
 * Derive the most-constrained window from a set of window entries.
 * Returns the entry with the smallest `remainingFraction` — this is the
 * binding constraint for the pool. `resetTime` comes from the same window.
 * Returns `undefined` when there are no windows.
 */
function mostConstrainedWindow(
  windows: QuotaWindowEntry[],
): { remainingFraction: number; resetTime: string } | undefined {
  if (windows.length === 0) return undefined
  let best = windows[0]!
  for (let i = 1; i < windows.length; i++) {
    if (windows[i]!.remainingFraction < best.remainingFraction) {
      best = windows[i]!
    }
  }
  return {
    remainingFraction: best.remainingFraction,
    resetTime: best.resetTime,
  }
}

/**
 * Map a retrieveUserQuotaSummary bucketId prefix to our internal pool.
 *
 * bucketId prefixes:
 *   `gemini-*` → gemini
 *   `3p-*`     → non-gemini
 */
function poolForBucketId(bucketId: string): QuotaGroup | null {
  if (bucketId.startsWith('gemini-')) return 'gemini'
  if (bucketId.startsWith('3p-')) return 'non-gemini'
  return null
}

/**
 * Aggregate a retrieveUserQuotaSummary response into a QuotaSummary.
 *
 * Each RUQS group maps to a pool via bucketId prefix. Within a pool,
 * windows are stored ordered (weekly first, then 5h). The pool's
 * `remainingFraction`/`resetTime` derive from the most-constrained window.
 */
export function aggregateQuotaSummary(
  response: RetrieveUserQuotaSummaryResponse,
): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {}
  let totalCount = 0

  for (const group of response.groups) {
    const windows: QuotaWindowEntry[] = []
    for (const bucket of group.buckets) {
      const pool = poolForBucketId(bucket.bucketId)
      if (!pool) continue
      windows.push({
        window: bucket.window,
        remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
        resetTime: bucket.resetTime,
      })
    }
    if (windows.length === 0) continue

    // Order: weekly first, then 5h.
    windows.sort((a, b) => {
      const order: Record<string, number> = { weekly: 0, '5h': 1 }
      return (order[a.window] ?? 2) - (order[b.window] ?? 2)
    })

    const constrained = mostConstrainedWindow(windows)
    const firstBucket = group.buckets[0]
    if (!firstBucket) continue
    const pool = poolForBucketId(firstBucket.bucketId)
    if (!pool || !constrained) continue

    const modelCount = group.description
      ? (group.description.match(/[^,:]+/g)?.length ?? 0)
      : 0

    groups[pool] = {
      remainingFraction: constrained.remainingFraction,
      resetTime: constrained.resetTime,
      modelCount,
      windows,
    }
    totalCount += modelCount
  }

  return { groups, modelCount: totalCount }
}

export interface FetchQuotaSummaryOptions {
  accessToken: string
  /** Managed project ID. Falls back to regular projectId on 403. */
  managedProjectId?: string
  /** Regular project ID — used as fallback when managedProjectId is missing or returns 403. */
  projectId?: string
  endpoints: readonly string[]
  timeoutMs?: number
  userAgent?: string
  fetchVia?: (
    url: string,
    options: RequestInit,
    extra: { timeoutMs: number; signal?: AbortSignal | null },
  ) => Promise<Response>
}

export interface FetchQuotaSummaryResult {
  summary: RetrieveUserQuotaSummaryResponse
  /** True when the result came from the legacy fallback path. */
  fellBackToLegacy?: boolean
}

/**
 * Fetch the windowed quota summary via `retrieveUserQuotaSummary`.
 *
 * Uses the same transport/UA/timeout conventions as `fetchAvailableModels`.
 * On 403 with the managedProjectId, retries with the regular projectId.
 * If that also 403s, falls back to `fetchAvailableModels` so quota never
 * goes dark. On missing managedProjectId, tries projectId first.
 */
export async function fetchQuotaSummary(
  options: FetchQuotaSummaryOptions,
): Promise<FetchQuotaSummaryResult> {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent()
  const transport = options.fetchVia ?? defaultTransport
  const errors: string[] = []

  const endpoint = options.endpoints[0]
  if (!endpoint) {
    throw new Error('No endpoints configured for fetchQuotaSummary')
  }

  const tryBody = async (
    projectId: string,
  ): Promise<RetrieveUserQuotaSummaryResponse | null> => {
    const body = { project: projectId }
    try {
      const response = await transport(
        `${endpoint}/v1internal:retrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: {
            'User-Agent': userAgent,
            Authorization: `Bearer ${options.accessToken}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip',
          },
          body: JSON.stringify(body),
        },
        { timeoutMs },
      )

      if (response.ok) {
        return (await response.json()) as RetrieveUserQuotaSummaryResponse
      }

      const status = response.status
      if (status === 403) {
        errors.push(
          `retrieveUserQuotaSummary 403 at ${endpoint} (project=${projectId.slice(0, 12)}…)`,
        )
        return null
      }

      if (status === 429 || status >= 500) {
        const message = await response.text().catch(() => '')
        errors.push(
          `retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`,
        )
        return null
      }

      const message = await response.text().catch(() => '')
      errors.push(
        `retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`,
      )
      return null
    } catch (error) {
      errors.push(
        `retrieveUserQuotaSummary network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  // Try managedProjectId first, then projectId, then legacy fallback.
  const primary = options.managedProjectId ?? options.projectId
  if (primary) {
    const result = await tryBody(primary)
    if (result) return { summary: result }
  }

  // If primary failed with 403 and we used managedProjectId,
  // retry with regular projectId as fallback (only when distinct).
  const fallbackId =
    options.managedProjectId &&
    options.projectId &&
    options.managedProjectId !== options.projectId
      ? options.projectId
      : undefined
  if (fallbackId) {
    const result = await tryBody(fallbackId)
    if (result) return { summary: result }
  }

  // Give up — the caller should fall back to fetchAvailableModels.
  throw new Error(
    errors.join('; ') || 'fetchQuotaSummary failed: no project ID available',
  )
}

/**
 * Aggregate Gemini CLI quota buckets into a summary.
 */
export function aggregateGeminiCliQuota(
  response: RetrieveUserQuotaResponse,
): GeminiCliQuotaSummary {
  const models: GeminiCliQuotaSummary['models'] = []

  if (!response.buckets || response.buckets.length === 0) {
    return { models }
  }

  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue
    }

    const modelId = bucket.modelId
    const isRelevantModel =
      modelId.startsWith('gemini-3-') ||
      modelId.startsWith('gemini-3.') ||
      modelId.startsWith('gemini-2.5-')
    if (!isRelevantModel) {
      continue
    }

    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime,
    })
  }

  models.sort((a, b) => a.modelId.localeCompare(b.modelId))

  return { models }
}

// ============================================================================
// Network helpers — used by the OpenCode adapter.
// Re-exported so harnesses can call the same endpoint probes with their own
// retry policy via `fetchWithActiveTimeout`.
// ============================================================================

export interface FetchAvailableModelsOptions {
  accessToken: string
  projectId: string
  endpoints: readonly string[]
  timeoutMs?: number
  userAgent?: string
  /**
   * Override the transport used for the probe. Defaults to
   * `fetchWithActiveTimeout` so callers get the same stream-safe active-fetch
   * timeout that the rest of the core uses.
   */
  fetchVia?: (
    url: string,
    options: RequestInit,
    extra: { timeoutMs: number; signal?: AbortSignal | null },
  ) => Promise<Response>
}

export async function fetchAvailableModels(
  options: FetchAvailableModelsOptions,
): Promise<FetchAvailableModelsResponse> {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent()
  const errors: string[] = []

  const transport = options.fetchVia ?? defaultTransport

  for (const endpoint of options.endpoints) {
    const body = options.projectId ? { project: options.projectId } : {}
    try {
      const response = await transport(
        `${endpoint}/v1internal:fetchAvailableModels`,
        {
          method: 'POST',
          headers: {
            'User-Agent': userAgent,
            Authorization: `Bearer ${options.accessToken}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip',
          },
          body: JSON.stringify(body),
        },
        { timeoutMs },
      )

      if (response.ok) {
        return (await response.json()) as FetchAvailableModelsResponse
      }

      const status = response.status

      if (status === 403 && options.projectId) {
        try {
          const retryResponse = await transport(
            `${endpoint}/v1internal:fetchAvailableModels`,
            {
              method: 'POST',
              headers: {
                'User-Agent': userAgent,
                Authorization: `Bearer ${options.accessToken}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip',
              },
              body: JSON.stringify({}),
            },
            { timeoutMs },
          )
          if (retryResponse.ok) {
            return (await retryResponse.json()) as FetchAvailableModelsResponse
          }
        } catch {
          // Fall through to next endpoint
        }
      }

      if (status === 429 || status >= 500) {
        const message = await response.text().catch(() => '')
        const snippet = message.trim().slice(0, 200)
        errors.push(
          `fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`,
        )
        continue
      }

      const message = await response.text().catch(() => '')
      const snippet = message.trim().slice(0, 200)
      errors.push(
        `fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`,
      )
      break
    } catch (error) {
      errors.push(
        `fetchAvailableModels network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  throw new Error(errors.join('; ') || 'fetchAvailableModels failed')
}

export interface FetchGeminiCliQuotaOptions {
  accessToken: string
  projectId: string
  endpoints: readonly string[]
  timeoutMs?: number
  userAgent?: string
}

export async function fetchGeminiCliQuota(
  options: FetchGeminiCliQuotaOptions,
): Promise<RetrieveUserQuotaResponse> {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent()

  for (const endpoint of options.endpoints) {
    const body = options.projectId ? { project: options.projectId } : {}
    try {
      const response = await defaultTransport(
        `${endpoint}/v1internal:retrieveUserQuota`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': userAgent,
          },
          body: JSON.stringify(body),
        },
        { timeoutMs },
      )

      if (response.ok) {
        return (await response.json()) as RetrieveUserQuotaResponse
      }

      const status = response.status
      if (status === 429 || status >= 500) {
        continue
      }
      return { buckets: [] }
    } catch {}
  }

  return { buckets: [] }
}

async function defaultTransport(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number },
): Promise<Response> {
  return fetchWithActiveTimeout(url, init, { timeoutMs: options.timeoutMs })
}
