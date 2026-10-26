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
import { getQuotaGroupForModel, isGeminiArgonModel } from './model-registry.ts'
import type {
  AccountQuotaResult,
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

export type QuotaCheckPurpose = 'required' | 'advisory'

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
  purpose?: QuotaCheckPurpose,
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
  /** Cancels this refresh alongside the manager's existing fetch deadline. */
  signal?: AbortSignal
  /** Only successful-send after-work opts into best-effort authorization. */
  purpose?: QuotaCheckPurpose
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
}

interface AccountState {
  consecutiveFailures: number
  backoffUntil: number
  inflight?: Promise<AccountQuotaResult>
  inflightPurpose?: QuotaCheckPurpose
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
      if (refreshOptions.purpose === 'advisory') {
        log.debug('advisory-quota-skipped-refresh-in-flight')
        return {
          index,
          email: account.email,
          status: 'skipped',
          disabled: false,
        }
      }
      if (entry.inflightPurpose === 'advisory') {
        await inflight
        return refreshAccount(account, refreshOptions)
      }
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
    stored.inflightPurpose = refreshOptions.purpose ?? 'required'
    state.set(key, stored)

    const promise = (async (): Promise<AccountQuotaResult> => {
      // The callback receives the manager-owned controller's signal, which
      // dispose() aborts. The per-fetch deadline is forwarded onto that same
      // controller (keeping the deadline's TimeoutError as the abort reason)
      // instead of combining the two signals with AbortSignal.any, which
      // Node 20.0.0 does not provide. Because the controller can now abort
      // for either reason, only the `disposed` flag means shutdown below.
      // The deadline is created inside the try so an invalid fetchTimeoutMs
      // becomes an ordinary error result; if creating it throws, `deadline`
      // stays undefined and the finally block has no listener to remove.
      let deadline: AbortSignal | undefined
      const forwardDeadline = (): void => controller.abort(deadline?.reason)
      const forwardCancellation = (): void =>
        controller.abort(refreshOptions.signal?.reason)
      try {
        deadline = AbortSignal.timeout(fetchTimeoutMs)
        deadline.addEventListener('abort', forwardDeadline, { once: true })
        if (refreshOptions.signal?.aborted) forwardCancellation()
        else
          refreshOptions.signal?.addEventListener(
            'abort',
            forwardCancellation,
            { once: true },
          )
        const result = await (refreshOptions.purpose === 'advisory'
          ? options.fetchAccountQuota(account, controller.signal, 'advisory')
          : options.fetchAccountQuota(account, controller.signal))
        if (disposed) {
          throw new Error('quota manager disposed mid-fetch')
        }
        const attributed: AccountQuotaResult = {
          ...result,
          index,
          ...(result.status === 'ok' ? { checkedAt: now() } : {}),
        }
        if (result.status === 'skipped') return attributed
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
        // Shutdown is not an account failure, so it records no backoff. A
        // deadline abort is an ordinary failure and falls through to the
        // backoff below.
        if (disposed) {
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
        // The callback has settled, so a later deadline must not abort it.
        deadline?.removeEventListener('abort', forwardDeadline)
        refreshOptions.signal?.removeEventListener('abort', forwardCancellation)
        const finished = state.get(key)
        if (finished) {
          finished.inflight = undefined
          finished.inflightPurpose = undefined
          finished.controller = undefined
          state.set(key, finished)
        }
      }
    })()

    // A refresh that fails before its first await (for example when the
    // deadline cannot be created) has already run its finally block and
    // cleared the controller. Recording that settled promise as in flight
    // would make every later refresh of this account, forced or not, reuse
    // the old error instead of trying again.
    if (stored.controller === controller) {
      stored.inflight = promise
      state.set(key, stored)
    }

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
  hasArgonPool = false,
): QuotaGroup | null {
  // The Argon weekly pool exists only on accounts that report its bucket:
  // elsewhere the model is conserved against the ordinary Gemini pool.
  if (isGeminiArgonModel(modelName)) return hasArgonPool ? 'gemini-argon' : null
  const registryGroup = getQuotaGroupForModel(modelName, hasArgonPool)
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

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>
}

// ============================================================================
// retrieveUserQuotaSummary — windowed quota source (3 pools × variable windows)
// ============================================================================

export interface RetrieveUserQuotaSummaryBucket {
  bucketId: string
  displayName: string
  window: 'weekly' | '5h'
  resetTime: string
  remainingFraction: number
  disabled?: boolean
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
 * Map only quota bucket IDs whose meaning is known to an internal pool.
 * Other IDs may describe separate entitlements and must not affect these pools.
 * Matching is by exact bucket ID: no prefix matching, and no guessed
 * window kinds for a pool (there is no known Argon 5-hour bucket).
 */
function poolForBucketId(bucketId: string): QuotaGroup | null {
  switch (bucketId) {
    case 'gemini-5h':
    case 'gemini-weekly':
      return 'gemini'
    case '3p-5h':
    case '3p-weekly':
      return 'non-gemini'
    case 'gemini-argon-wtu-weekly':
      return 'gemini-argon'
    default:
      return null
  }
}

/**
 * Count models listed in a group's description. The description is
 * typically a comma-separated list of model names ("Claude Sonnet 4.6,
 * Gemini 3.1 Pro, Flash") often prefixed with a label like
 * "Models within this group:". Strip the prefix before splitting so
 * the label itself is not counted as a model. Returns 0 for shapes
 * that don't match a comma-separated list.
 */
function parseDescriptionModelCount(description: string): number {
  const prefixMatch = description.match(/^[^:]+:\s*/)
  const payload = prefixMatch
    ? description.slice(prefixMatch[0].length)
    : description
  if (!payload) return 0
  const entries = payload
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return entries.length
}

/**
 * Map a quota window kind to its duration in milliseconds for
 * deterministic sort order. Unknown windows get MAX_SAFE_INTEGER so
 * they sort last without random reordering across runs.
 */
function windowDurationMs(window: 'weekly' | '5h' | string): number {
  switch (window) {
    case '5h':
      return 5 * 60 * 60 * 1000
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000
    default:
      return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Aggregate a retrieveUserQuotaSummary response into a QuotaSummary.
 *
 * Only known bucket IDs contribute. Their windows are merged across groups,
 * stored shortest-first, and reduced to the most-constrained pool reading.
 */
export function aggregateQuotaSummary(
  response: RetrieveUserQuotaSummaryResponse,
): QuotaSummary {
  const windowsByPool: Record<QuotaGroup, Map<string, QuotaWindowEntry>> = {
    gemini: new Map(),
    'non-gemini': new Map(),
    'gemini-argon': new Map(),
  }
  const modelCounts: Record<QuotaGroup, number> = {
    gemini: 0,
    'non-gemini': 0,
    'gemini-argon': 0,
  }
  const seenBucketIds = new Set<string>()
  const duplicateBucketIds = new Set<string>()

  for (const group of response.groups) {
    const contributingPools = new Set<QuotaGroup>()
    for (const bucket of group.buckets) {
      // A disabled bucket's remaining fraction may be stale, so exclude it from quota calculations.
      if (bucket.disabled === true) continue
      const pool = poolForBucketId(bucket.bucketId)
      if (!pool) continue
      contributingPools.add(pool)
      const window: QuotaWindowEntry = {
        window: bucket.window,
        remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
        resetTime: bucket.resetTime,
      }
      const previous = windowsByPool[pool].get(bucket.bucketId)
      if (seenBucketIds.has(bucket.bucketId)) {
        duplicateBucketIds.add(bucket.bucketId)
      } else {
        seenBucketIds.add(bucket.bucketId)
      }
      if (!previous || window.remainingFraction < previous.remainingFraction) {
        windowsByPool[pool].set(bucket.bucketId, window)
      }
    }

    // Count only groups that contain a known bucket ID for the pool.
    const modelCount = group.description
      ? parseDescriptionModelCount(group.description)
      : 0
    for (const pool of contributingPools) modelCounts[pool] += modelCount
  }

  if (duplicateBucketIds.size > 0) {
    log.debug('duplicate quota summary bucket ids', {
      bucketIds: [...duplicateBucketIds].sort(),
    })
  }

  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {}
  let totalCount = 0
  for (const pool of ['gemini', 'non-gemini', 'gemini-argon'] as const) {
    const windows = [...windowsByPool[pool].values()]
    if (windows.length === 0) continue
    windows.sort(
      (a, b) => windowDurationMs(a.window) - windowDurationMs(b.window),
    )
    const constrained = mostConstrainedWindow(windows)
    if (!constrained) continue
    const modelCount = modelCounts[pool]
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
 * On a 429 or 5xx against one endpoint, falls through to the next entry
 * in `options.endpoints` (matching the legacy fetchers' failover
 * convention). On 403 with the managedProjectId, retries with the
 * regular projectId. If that also 403s, falls back to
 * `fetchAvailableModels` so quota never goes dark. On missing
 * managedProjectId, tries projectId first.
 */
export async function fetchQuotaSummary(
  options: FetchQuotaSummaryOptions,
): Promise<FetchQuotaSummaryResult> {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent()
  const transport = options.fetchVia ?? defaultTransport
  const errors: string[] = []

  if (options.endpoints.length === 0) {
    throw new Error('No endpoints configured for fetchQuotaSummary')
  }

  // Discriminated result so the fallback is only entered on a 403, not on
  // transient errors (429, 5xx, network). A transient failure on the managed
  // project ID must not fall through to the regular projectId — that could
  // return a DIFFERENT project's quota data instead of signalling a retry.
  type TryBodyResult =
    | { ok: true; summary: RetrieveUserQuotaSummaryResponse }
    | { ok: false; reason: '403' | 'transient' }

  const tryBody = async (
    endpoint: string,
    projectId: string,
  ): Promise<TryBodyResult> => {
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
        return {
          ok: true,
          summary: (await response.json()) as RetrieveUserQuotaSummaryResponse,
        }
      }

      const status = response.status
      if (status === 403) {
        errors.push(
          `retrieveUserQuotaSummary 403 at ${endpoint} (project=${projectId.slice(0, 12)}…)`,
        )
        return { ok: false, reason: '403' }
      }

      if (status === 429 || status >= 500) {
        const message = await response.text().catch(() => '')
        errors.push(
          `retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`,
        )
        // Endpoint failover: the caller may have multiple endpoints;
        // continue to the next one with the same project ID.
        return { ok: false, reason: 'transient' }
      }

      const message = await response.text().catch(() => '')
      errors.push(
        `retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`,
      )
      return { ok: false, reason: 'transient' }
    } catch (error) {
      errors.push(
        `retrieveUserQuotaSummary network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { ok: false, reason: 'transient' }
    }
  }

  // Try managedProjectId first, then projectId, then legacy fallback.
  // For each project, iterate the endpoint list so a 500/429 on the
  // primary endpoint falls through to the next entry.
  const primary = options.managedProjectId ?? options.projectId
  let primaryGot403 = false
  if (primary) {
    for (const endpoint of options.endpoints) {
      const result = await tryBody(endpoint, primary)
      if (result.ok) return { summary: result.summary }
      if (result.reason === '403') primaryGot403 = true
    }
  }

  // Retry with the regular projectId ONLY when the managed-project attempt
  // got a 403 (i.e. the managed project does not own the user). A transient
  // failure (429, 5xx, network) must NOT fall through here — the regular
  // projectId could return a different project's quota data.
  const fallbackId =
    primaryGot403 &&
    options.managedProjectId &&
    options.projectId &&
    options.managedProjectId !== options.projectId
      ? options.projectId
      : undefined
  if (fallbackId) {
    for (const endpoint of options.endpoints) {
      const result = await tryBody(endpoint, fallbackId)
      if (result.ok) return { summary: result.summary }
    }
  }

  // Give up — the caller should fall back to fetchAvailableModels.
  throw new Error(
    errors.join('; ') || 'fetchQuotaSummary failed: no project ID available',
  )
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

function defaultTransport(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number },
): Promise<Response> {
  return fetchWithActiveTimeout(url, init, { timeoutMs: options.timeoutMs })
}
