import { createHash } from 'node:crypto'
import { rowRefKey, sameRowRef } from './account-identity.ts'
import {
  AccountRepositoryError,
  applyCooldownObservation,
  applyRateLimitObservation,
  applySwitch,
} from './account-repository.ts'
import type {
  AccessVerdict,
  AccountFlushReport,
  AccountRefreshOptions,
  AccountRefreshOutcome,
  AccountRepository,
  AccountRepositoryFailure,
  AccountRepositoryRead,
  AccountRow,
  CooldownObservation,
  LastSwitchReason,
  ProviderMetadata,
  QuotaState,
  RoutingSettings,
  RoutingTarget,
  RowRef,
  StoredQuotaGroup,
} from './account-repository-types.ts'
import type { AccountStorageStore } from './account-storage.ts'
import { AccountStorageLockContentionError } from './account-storage.ts'
import type {
  AccountMetadataV3,
  AccountSelectionStrategy,
  AccountStorageV4,
  CooldownReason,
  HeaderStyle,
  AccountModelFamily as ModelFamily,
  RateLimitStateV3,
} from './account-types.ts'
import { formatRefreshParts, parseRefreshParts } from './auth.ts'
import type { OAuthAuthDetails, RefreshParts } from './auth-types.ts'
import {
  type Fingerprint,
  type FingerprintVersion,
  generateFingerprint,
  MAX_FINGERPRINT_HISTORY,
  updateFingerprintVersion,
} from './fingerprint.ts'
import { getQuotaGroupForModel } from './model-registry.ts'
import {
  normalizeLegacyCachedQuota,
  type QuotaGroup,
  type QuotaGroupSummary,
} from './quota-types.ts'
import {
  type AccountWithMetrics,
  getHealthTracker,
  getTokenTracker,
  HealthScoreTracker,
  selectHybridAccount,
  TokenBucketTracker,
} from './rotation.ts'

export type {
  AccountSelectionStrategy,
  CooldownReason,
  HeaderStyle,
  ModelFamily,
}

function isStorageLockContention(error: unknown): boolean {
  if (error instanceof AccountStorageLockContentionError) return true
  const message = String(error)
  return (
    message.includes('Lock file is already being held') ||
    message.includes('ELOCKED')
  )
}

export interface AccountManagerOptions {
  /**
   * The pre-store pool file's store. Exactly one of `store` and
   * `repository` is given.
   */
  store?: AccountStorageStore
  storagePath?: string
  /**
   * The account repository. With it, every persisted change becomes an
   * attributed write on the row the account was loaded from (see
   * `AccountManager.fromRepository`); the pool file is never written.
   */
  repository?: AccountRepository
  /**
   * The health scores and token balances this manager's selection uses,
   * keyed by its account indexes. A repository-backed manager uses the
   * trackers the caller supplies, or new instances with the default
   * configuration. A pool-file manager without supplied trackers uses the
   * process-wide defaults (`getHealthTracker`, `getTokenTracker`).
   */
  healthTracker?: HealthScoreTracker
  tokenTracker?: TokenBucketTracker
  now?: () => number
  random?: () => number
  pid?: number
  onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void
}

export type { RateLimitReason } from './rotation.ts'
export {
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  parseRateLimitReason,
} from './rotation.ts'

import type { RateLimitReason } from './rotation.ts'
import { calculateBackoffMs } from './rotation.ts'

export type BaseQuotaKey = 'claude' | 'gemini-antigravity' | 'gemini-cli'
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`

export interface ManagedAccount {
  index: number
  /**
   * The repository row and credential this account was loaded from. Every
   * write about the account is fenced on it, so a write decided for a
   * credential that was since replaced or removed never lands on its
   * successor. Absent for accounts loaded from the pre-store pool file.
   */
  ref?: RowRef
  email?: string
  label?: string
  addedAt: number
  lastUsed: number
  parts: RefreshParts
  /** Authoritative project ID from the persisted account record. Survives
   * bare-refresh-token rotations where `parts.projectId` may be lost. */
  projectId?: string
  /** Authoritative managed project ID from the persisted account record.
   * Survives bare-refresh-token rotations where `parts.managedProjectId`
   * may be lost. */
  managedProjectId?: string
  access?: string
  expires?: number
  enabled: boolean
  rateLimitResetTimes: RateLimitStateV3
  lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  touchedForQuota: Record<string, number>
  consecutiveFailures?: number
  /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
  lastFailureTime?: number
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: Fingerprint
  /** History of previous fingerprints for this account */
  fingerprintHistory?: FingerprintVersion[]
  /** Cached quota data from last checkAccountsQuota() call */
  cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>
  /** Opaque identity of the refresh token that produced `cachedQuota`. */
  cachedQuotaAccountId?: string
  cachedQuotaUpdatedAt?: number
  /**
   * Captured plan tier ID from the most recent `loadCodeAssist` response.
   * Raw upstream string (e.g. `"free-tier"`) — never normalised.
   */
  capturedTierId?: string
  /** Raw paid-tier ID from the most recent `loadCodeAssist` response. */
  capturedPaidTierId?: string
  /** Epoch ms when `capturedTierId` was last recorded. */
  capturedTierAt?: number
  /** Schema version of the most recent tier capture, even when paid tier is absent. */
  capturedTierSchemaVersion?: number
  verificationRequired?: boolean
  verificationRequiredAt?: number
  verificationRequiredReason?: string
  verificationUrl?: string
  accountIneligible?: boolean
  accountIneligibleAt?: number
  accountIneligibleReason?: string
  eligibilityStateUpdatedAt?: number
  /** Daily request counts per model family */
  dailyRequestCounts?: {
    date: string
    claude: number
    gemini: number
  }
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return value < 0 ? 0 : Math.floor(value)
}

/**
 * Opaque identity for a refresh token.
 *
 * Antigravity refresh tokens are stable (they do not rotate), so hashing
 * the token produces a durable, prunable identity to detect stale cached
 * quota after an account-index shift.
 */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

function getQuotaKey(
  family: ModelFamily,
  headerStyle: HeaderStyle,
  model?: string | null,
): QuotaKey {
  if (family === 'claude') {
    return 'claude'
  }
  const base =
    headerStyle === 'gemini-cli' ? 'gemini-cli' : 'gemini-antigravity'
  if (model) {
    return `${base}:${model}`
  }
  return base
}

function isRateLimitedForQuotaKey(
  account: ManagedAccount,
  key: QuotaKey,
  now: () => number,
): boolean {
  const resetTime = account.rateLimitResetTimes[key]
  return resetTime !== undefined && now() < resetTime
}

function isRateLimitedForFamily(
  account: ManagedAccount,
  family: ModelFamily,
  now: () => number,
  model?: string | null,
): boolean {
  if (family === 'claude') {
    return isRateLimitedForQuotaKey(account, 'claude', now)
  }

  const antigravityIsLimited = isRateLimitedForHeaderStyle(
    account,
    family,
    'antigravity',
    now,
    model,
  )
  const cliIsLimited = isRateLimitedForHeaderStyle(
    account,
    family,
    'gemini-cli',
    now,
    model,
  )

  return antigravityIsLimited && cliIsLimited
}

function isRateLimitedForHeaderStyle(
  account: ManagedAccount,
  family: ModelFamily,
  headerStyle: HeaderStyle,
  now: () => number,
  model?: string | null,
): boolean {
  clearExpiredRateLimits(account, now)

  if (family === 'claude') {
    return isRateLimitedForQuotaKey(account, 'claude', now)
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model)
    if (isRateLimitedForQuotaKey(account, modelKey, now)) {
      return true
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle)
  return isRateLimitedForQuotaKey(account, baseKey, now)
}

function clearExpiredRateLimits(
  account: ManagedAccount,
  clock: () => number,
): void {
  const now = clock()
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[]
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key]
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key]
    }
  }
}

/**
 * Resolve the quota group for soft quota checks.
 *
 * When a model string is available we use the model-registry lookup first,
 * then fall back to substring matching. When model is null/undefined we
 * fall back based on family:
 * - Claude → "non-gemini" quota group
 * - Gemini → "gemini" quota group
 *
 * @param family - The model family ("claude" | "gemini")
 * @param model - Optional model string for precise resolution
 * @returns The QuotaGroup to use for soft quota checks
 */
export function resolveQuotaGroup(
  family: ModelFamily,
  model?: string | null,
): QuotaGroup {
  if (model) {
    const registryGroup = getQuotaGroupForModel(model)
    if (registryGroup) return registryGroup
    const lower = model.toLowerCase()
    // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so
    // a `gemini-claude-*` alias (Claude route exposed under a `gemini-`
    // namespace) attributes to the non-gemini pool. The model-registry
    // check above already handles registered aliases; this substring
    // fallback mirrors the same precedence rule for unregistered models.
    if (lower.includes('claude') || lower.includes('gpt-oss')) {
      return 'non-gemini'
    }
    if (lower.includes('gemini')) return 'gemini'
  }
  return family === 'claude' ? 'non-gemini' : 'gemini'
}

function isOverSoftQuotaThreshold(
  account: ManagedAccount,
  family: ModelFamily,
  thresholdPercent: number,
  cacheTtlMs: number,
  now: () => number,
  model?: string | null,
): boolean {
  if (thresholdPercent >= 100) return false
  if (!account.cachedQuota) return false

  if (account.cachedQuotaUpdatedAt == null) return false
  const age = now() - account.cachedQuotaUpdatedAt
  if (age > cacheTtlMs) return false

  const quotaGroup = resolveQuotaGroup(family, model)

  const groupData = account.cachedQuota[quotaGroup]
  if (groupData?.remainingFraction == null) return false

  const remainingFraction = Math.max(
    0,
    Math.min(1, groupData.remainingFraction),
  )
  const usedPercent = (1 - remainingFraction) * 100
  const isOverThreshold = usedPercent >= thresholdPercent

  return isOverThreshold
}

/**
 * Absolute-state changes to one repository row waiting for the next save.
 * Later changes to the same field replace earlier ones, so a burst of them
 * becomes one write; counters are never kept here (see `recordRequest`).
 */
interface PendingRowWrite {
  ref: RowRef
  /** Per rate-limit key: a reset time to merge, or `clear` to drop it. */
  rateLimits: Map<string, number | 'clear'>
  cooldown?: { value: CooldownObservation }
  switchReason?: LastSwitchReason
  lastUsed?: number
}

/** Applies a coalesced row write to the metadata read under the row lock. */
function applyPendingRowWrite(
  metadata: ProviderMetadata,
  pending: PendingRowWrite,
): ProviderMetadata {
  let next = metadata
  const resets: Record<string, number> = {}
  const cleared: string[] = []
  for (const [key, value] of pending.rateLimits) {
    if (value === 'clear') cleared.push(key)
    else resets[key] = value
  }
  if (Object.keys(resets).length > 0) {
    next = applyRateLimitObservation(next, resets)
  }
  if (cleared.length > 0 && next.rateLimitResetTimes != null) {
    const rates = { ...next.rateLimitResetTimes }
    for (const key of cleared) delete rates[key]
    next = { ...next, rateLimitResetTimes: rates }
  }
  if (pending.cooldown !== undefined) {
    next = applyCooldownObservation(next, pending.cooldown.value)
  }
  if (pending.switchReason !== undefined) {
    next = applySwitch(next, pending.switchReason)
  }
  if (pending.lastUsed !== undefined && pending.lastUsed > next.lastUsed) {
    next = { ...next, lastUsed: pending.lastUsed }
  }
  return next
}

/**
 * Repository failures a save reports but does not fail on: the write was
 * about a credential the row no longer holds (it is dropped, as intended),
 * or it met lock contention and was queued again for the next save.
 */
const TOLERATED_FAILURES = new Set<AccountRepositoryFailure['kind']>([
  'attribution',
  'unknown-row',
  'lock-contention',
])

/**
 * Thrown by a save, flush or dispose of a repository-backed manager when a
 * write failed. `message` and `failure` are the first failure; `report`
 * holds every failure the repository reported while draining.
 */
export class AccountManagerPersistError extends Error {
  readonly failure: AccountRepositoryFailure
  readonly report: AccountFlushReport

  constructor(failure: AccountRepositoryFailure, report: AccountFlushReport) {
    super(failure.message)
    this.name = 'AccountManagerPersistError'
    this.failure = failure
    this.report = report
  }
}

function present<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value
}

function quotaGroupsOf(
  quota: QuotaState | undefined,
): AccountMetadataV3['cachedQuota'] {
  if (quota?.cachedQuota == null) return undefined
  const groups: NonNullable<AccountMetadataV3['cachedQuota']> = {}
  for (const [name, group] of Object.entries(quota.cachedQuota)) {
    groups[name] = {
      modelCount: group.modelCount,
      ...(group.remainingFraction != null
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(group.resetTime != null ? { resetTime: group.resetTime } : {}),
      ...(group.windows != null
        ? {
            windows: group.windows.map((window) => ({
              window: window.window,
              remainingFraction: window.remainingFraction,
              resetTime: window.resetTime,
            })),
          }
        : {}),
    }
  }
  return groups
}

function storedQuotaGroups(
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>,
): Record<string, StoredQuotaGroup> {
  const stored: Record<string, StoredQuotaGroup> = {}
  for (const [name, group] of Object.entries(groups)) {
    if (group === undefined) continue
    stored[name] = {
      modelCount: group.modelCount,
      ...(group.remainingFraction !== undefined
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(group.resetTime !== undefined ? { resetTime: group.resetTime } : {}),
      ...(group.windows !== undefined
        ? { windows: group.windows.map((window) => ({ ...window })) }
        : {}),
    }
  }
  return stored
}

/** Why a repository row cannot be routed to, or undefined when it can. */
function unroutableReason(row: AccountRow): string | undefined {
  if (row.invalid !== undefined) return `invalid ${row.invalid}`
  if (row.torn) return 'torn'
  if (row.unbound) return `unbound credential (${row.stamp})`
  if (row.credential === undefined) return 'no credential'
  if (row.metadata.status === 'dropped') {
    return `metadata not shown (${row.metadata.reason})`
  }
  return undefined
}

/** When the account's newest access evidence was observed, if ever. */
function accessEvidenceTime(account: ManagedAccount): number | undefined {
  const times = [
    account.verificationRequiredAt,
    account.accountIneligibleAt,
    account.eligibilityStateUpdatedAt,
  ].filter((time): time is number => time !== undefined)
  return times.length === 0 ? undefined : Math.max(...times)
}

/**
 * The request counts of the later day; on the same day, the larger count of
 * each family, since both only ever grow within a day.
 */
function laterCounts(
  a: ManagedAccount['dailyRequestCounts'],
  b: ManagedAccount['dailyRequestCounts'],
): ManagedAccount['dailyRequestCounts'] {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.date !== b.date) return a.date > b.date ? a : b
  return {
    date: a.date,
    claude: Math.max(a.claude, b.claude),
    gemini: Math.max(a.gemini, b.gemini),
  }
}

/**
 * An account handed to a quota check. In memory only: `rowRef` is never
 * written to the pool file, provider metadata, the sidebar or logs.
 */
export interface AccountQuotaTarget extends AccountMetadataV3 {
  /**
   * The repository row and credential the account was loaded under, as it
   * was when the target was taken. A quota reading for this target is
   * recorded against exactly this ref, so one taken before the credential
   * was replaced or the row removed is refused, not attached to its
   * successor. Absent only for accounts of a pool-file manager.
   */
  readonly rowRef?: RowRef
}

export interface AccountSessionIdentity {
  id: string
  parentId?: string | null
}

interface AccountSessionState {
  parentId: string | null
  currentAccountIndexByFamily: Record<ModelFamily, number>
  cursorByFamily: Record<ModelFamily, number>
  offsetAppliedByFamily: Record<ModelFamily, boolean>
  usedAccounts: Set<number>
  lastAccessedAt: number
}

const ACCOUNT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ACCOUNT_SESSION_STATES = 256

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Persists either to the pre-store pool file `antigravity-accounts.json`
 * (whole-pool snapshots through an `AccountStorageStore`) or, when built with
 * `fromRepository`, to the account repository, where every change is an
 * attributed write on the row and credential the account was loaded from.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = []
  private cursorByFamily: Record<ModelFamily, number> = { claude: 0, gemini: 0 }
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  }
  private sessionOffsetApplied: Record<ModelFamily, boolean> = {
    claude: false,
    gemini: false,
  }
  private lastToastAccountIndex = -1
  private lastToastTime = 0

  private savePending = false
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private saveInFlight: Promise<void> | null = null
  private disposed = false
  private savePromiseResolvers: Array<{
    resolve: () => void
    reject: (err: unknown) => void
  }> = []

  private sessionStartTime: number
  private sessionRequestCounts: Map<
    string,
    { claude: number; gemini: number }
  > = new Map()
  private sessionUsedAccounts: Set<number> = new Set()
  private requestSessionStates = new Map<string, AccountSessionState>()

  private readonly store: AccountStorageStore | undefined
  private readonly repository: AccountRepository | undefined
  /** Coalesced absolute-state writes per repository credential. */
  private pendingRowWrites = new Map<string, PendingRowWrite>()
  /** Latest selection per routing target, written at the next save. */
  private pendingSelections = new Map<RoutingTarget, RowRef | null>()
  private readonly storagePath: string
  private readonly ownHealthTracker: HealthScoreTracker | undefined
  private readonly ownTokenTracker: TokenBucketTracker | undefined
  /** A promise chain that applies reloads in request order. */
  private reloading: Promise<void> = Promise.resolve()
  private readonly onDiagnostic: AccountManagerOptions['onDiagnostic']
  private readonly now: () => number
  private readonly random: () => number
  private readonly pid: number

  constructor(
    authFallback: OAuthAuthDetails | undefined,
    stored: AccountStorageV4 | null | undefined,
    options: AccountManagerOptions,
  ) {
    if ((options.store === undefined) === (options.repository === undefined)) {
      throw new Error(
        'AccountManager needs exactly one of a pool-file store and an account repository',
      )
    }
    if (options.repository !== undefined && (stored || authFallback)) {
      throw new Error(
        'a repository-backed AccountManager is loaded with AccountManager.fromRepository',
      )
    }
    this.store = options.store
    this.repository = options.repository
    this.ownHealthTracker =
      options.healthTracker ??
      (options.repository !== undefined ? new HealthScoreTracker() : undefined)
    this.ownTokenTracker =
      options.tokenTracker ??
      (options.repository !== undefined ? new TokenBucketTracker() : undefined)
    this.storagePath = options.storagePath ?? ''
    this.onDiagnostic = options.onDiagnostic
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? (() => Math.random())
    this.pid = options.pid ?? process.pid
    this.sessionStartTime = this.now()
    const authParts = authFallback
      ? parseRefreshParts(authFallback.refresh)
      : null

    if (stored && stored.accounts.length === 0) {
      this.accounts = []
      this.cursorByFamily = { claude: 0, gemini: 0 }
      return
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = this.now()
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== 'string') {
            return null
          }
          const matchesFallback = !!(
            authFallback &&
            authParts?.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          )

          return {
            index,
            email: acc.email,
            label: acc.label,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            // Authoritative record-level fields that survive bare-refresh-token
            // rotations where `parts.*` may be overwritten with undefined.
            projectId: acc.projectId,
            managedProjectId: acc.managedProjectId,
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            enabled: acc.enabled !== false,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
            touchedForQuota: {},
            fingerprint: acc.fingerprint ?? generateFingerprint(),
            fingerprintHistory: acc.fingerprintHistory ?? [],
            cachedQuota: normalizeLegacyCachedQuota(acc.cachedQuota),
            // Restore the opaque identity stamp alongside the quota so the
            // post-load projection can detect a stale snapshot captured
            // for a different account after an index shift.
            cachedQuotaAccountId: acc.cachedQuotaAccountId,
            cachedQuotaUpdatedAt: acc.cachedQuotaUpdatedAt,
            capturedTierId: acc.capturedTierId,
            capturedPaidTierId: acc.capturedPaidTierId,
            capturedTierAt: acc.capturedTierAt,
            capturedTierSchemaVersion: acc.capturedTierSchemaVersion,
            dailyRequestCounts: acc.dailyRequestCounts,
            verificationRequired: acc.verificationRequired,
            verificationRequiredAt: acc.verificationRequiredAt,
            verificationRequiredReason: acc.verificationRequiredReason,
            verificationUrl: acc.verificationUrl,
            accountIneligible: acc.accountIneligible,
            accountIneligibleAt: acc.accountIneligibleAt,
            accountIneligibleReason: acc.accountIneligibleReason,
            eligibilityStateUpdatedAt: acc.eligibilityStateUpdatedAt,
          }
        })
        .filter((a): a is ManagedAccount => a !== null)

      // Update fingerprint versions to match the current runtime version.
      // Saved fingerprints may carry an older version string; this ensures
      // they always reflect the latest fetched (or fallback) version.
      let fingerprintVersionChanged = false
      for (const acc of this.accounts) {
        if (acc.fingerprint && updateFingerprintVersion(acc.fingerprint)) {
          fingerprintVersionChanged = true
        }
      }

      const legacyCursor = clampNonNegativeInt(stored.activeIndex, 0)
      if (this.accounts.length > 0) {
        const defaultIndex = legacyCursor % this.accounts.length
        this.currentAccountIndexByFamily.claude =
          clampNonNegativeInt(
            stored.activeIndexByFamily?.claude,
            defaultIndex,
          ) % this.accounts.length
        this.currentAccountIndexByFamily.gemini =
          clampNonNegativeInt(
            stored.activeIndexByFamily?.gemini,
            defaultIndex,
          ) % this.accounts.length
        this.cursorByFamily.claude = this.currentAccountIndexByFamily.claude
        this.cursorByFamily.gemini = this.currentAccountIndexByFamily.gemini
      }

      // Persist updated fingerprint versions to disk
      if (fingerprintVersionChanged) {
        this.requestSaveToDisk()
      }

      // If current auth isn't in the loaded accounts, add it to the pool
      if (authFallback && authParts?.refreshToken) {
        const hasMatching = this.accounts.some(
          (acc) => acc.parts.refreshToken === authParts.refreshToken,
        )
        if (!hasMatching) {
          const now = this.now()
          const newAccount: ManagedAccount = {
            index: this.accounts.length,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts: authParts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
            fingerprint: generateFingerprint(),
            fingerprintHistory: [],
          }
          this.accounts.push(newAccount)
        }
      }

      return
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh)
      if (parts.refreshToken) {
        const now = this.now()
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
          },
        ]
        this.cursorByFamily = { claude: 0, gemini: 0 }
        this.currentAccountIndexByFamily.claude = 0
        this.currentAccountIndexByFamily.gemini = 0
      }
    }
  }

  /**
   * A manager over the rows of a ready repository read. Rows that cannot be
   * routed to (no credential, torn, unbound, invalid, or metadata the store
   * keeps but does not show) are left out and reported through
   * `onDiagnostic`; selection follows the stored row refs, falling back to
   * the stored indexes as the pool-file loader did.
   */
  static fromRepository(
    read: AccountRepositoryRead,
    options: Omit<
      AccountManagerOptions,
      'store' | 'storagePath' | 'repository'
    > & {
      repository: AccountRepository
    },
  ): AccountManager {
    if (read.status !== 'ready') {
      throw new Error(
        `the account repository is not ready (${read.status}); resolve it before routing`,
      )
    }
    const manager = new AccountManager(undefined, null, options)
    manager.loadRepositoryRows(read)
    return manager
  }

  /**
   * The account a ready repository row describes, or undefined (reported
   * through `onDiagnostic`) for a row that cannot be routed to. `fingerprint`
   * says whether the stored fingerprint was kept, generated because the row
   * had none, or brought to the current runtime version.
   */
  private accountFromRow(
    row: AccountRow,
    index: number,
    baseNow: number,
  ):
    | {
        account: ManagedAccount
        fingerprint: 'kept' | 'generated' | 'updated'
      }
    | undefined {
    const reason = unroutableReason(row)
    const credential = row.credential
    if (reason !== undefined || credential === undefined) {
      this.onDiagnostic?.('Skipped an account row that cannot be routed to', {
        rowId: row.ref.id,
        reason: reason ?? 'no credential',
      })
      return undefined
    }
    const meta =
      row.metadata.status === 'present' ? row.metadata.metadata : undefined
    const quota = row.quota.status === 'present' ? row.quota.quota : undefined
    const rateLimitResetTimes: RateLimitStateV3 = {}
    for (const [key, value] of Object.entries(
      meta?.rateLimitResetTimes ?? {},
    )) {
      if (typeof value === 'number') rateLimitResetTimes[key] = value
    }
    const projectId = present(meta?.projectId)
    const managedProjectId = present(meta?.managedProjectId)
    const counts = present(meta?.dailyRequestCounts)
    const account: ManagedAccount = {
      index,
      ref: row.ref,
      email: present(meta?.email),
      label: present(meta?.label),
      addedAt: meta?.addedAt ?? row.storeAddedAt ?? baseNow,
      lastUsed: meta?.lastUsed ?? 0,
      parts: {
        refreshToken: credential.refreshToken,
        projectId,
        managedProjectId,
      },
      projectId,
      managedProjectId,
      access: credential.accessToken,
      expires: credential.expiresAt,
      enabled: row.enabled,
      rateLimitResetTimes,
      lastSwitchReason: present(meta?.lastSwitchReason),
      coolingDownUntil: present(meta?.coolingDownUntil),
      cooldownReason: present(meta?.cooldownReason),
      touchedForQuota: {},
      // Copy the fingerprint before storing it: the manager updates it in
      // place, and the caller owns the read.
      fingerprint: structuredClone(present(meta?.fingerprint)),
      fingerprintHistory:
        structuredClone(present(meta?.fingerprintHistory)) ?? [],
      cachedQuota: normalizeLegacyCachedQuota(quotaGroupsOf(quota)),
      cachedQuotaAccountId: present(quota?.cachedQuotaAccountId),
      cachedQuotaUpdatedAt: present(quota?.cachedQuotaUpdatedAt),
      capturedTierId: present(meta?.capturedTierId),
      capturedPaidTierId: present(meta?.capturedPaidTierId),
      capturedTierAt: present(meta?.capturedTierAt),
      capturedTierSchemaVersion: present(meta?.capturedTierSchemaVersion),
      dailyRequestCounts:
        counts === undefined
          ? undefined
          : {
              date: counts.date,
              claude: counts.claude,
              gemini: counts.gemini,
            },
      verificationRequired: present(meta?.verificationRequired),
      verificationRequiredAt: present(meta?.verificationRequiredAt),
      verificationRequiredReason: present(meta?.verificationRequiredReason),
      verificationUrl: present(meta?.verificationUrl),
      accountIneligible: present(meta?.accountIneligible),
      accountIneligibleAt: present(meta?.accountIneligibleAt),
      accountIneligibleReason: present(meta?.accountIneligibleReason),
      eligibilityStateUpdatedAt: present(meta?.eligibilityStateUpdatedAt),
    }
    if (account.fingerprint === undefined) {
      account.fingerprint = generateFingerprint()
      return { account, fingerprint: 'generated' }
    }
    if (updateFingerprintVersion(account.fingerprint)) {
      return { account, fingerprint: 'updated' }
    }
    return { account, fingerprint: 'kept' }
  }

  /** The stored selection's index for `family` among the loaded accounts. */
  private routedIndex(
    routing: RoutingSettings | undefined,
    family: ModelFamily,
  ): number {
    const count = this.accounts.length
    const indexOf = (ref: RowRef | null | undefined): number | undefined => {
      if (ref == null) return undefined
      const found = this.accounts.findIndex(
        (account) => account.ref !== undefined && sameRowRef(account.ref, ref),
      )
      return found < 0 ? undefined : found
    }
    const defaultIndex =
      indexOf(routing?.activeRow) ??
      clampNonNegativeInt(routing?.activeIndex, 0) % count
    return (
      indexOf(routing?.activeRowByFamily?.[family]) ??
      clampNonNegativeInt(
        routing?.activeIndexByFamily?.[family],
        defaultIndex,
      ) % count
    )
  }

  private loadRepositoryRows(
    read: Extract<AccountRepositoryRead, { status: 'ready' }>,
  ): void {
    const baseNow = this.now()
    const generated: ManagedAccount[] = []
    const versionUpdated: ManagedAccount[] = []
    for (const row of read.rows) {
      const built = this.accountFromRow(row, this.accounts.length, baseNow)
      if (built === undefined) continue
      if (built.fingerprint === 'generated') generated.push(built.account)
      if (built.fingerprint === 'updated') versionUpdated.push(built.account)
      this.accounts.push(built.account)
    }
    // Persist each generated or version-updated fingerprint.
    for (const account of [...generated, ...versionUpdated]) {
      this.persistFingerprint(account)
    }

    if (this.accounts.length === 0) return
    const families: ModelFamily[] = ['claude', 'gemini']
    for (const family of families) {
      const index = this.routedIndex(read.routing, family)
      this.currentAccountIndexByFamily[family] = index
      this.cursorByFamily[family] = index
    }
  }

  /**
   * Brings a repository-backed manager up to date with a newer ready read.
   *
   * Accounts are matched by their exact ref (row id, credential epoch and
   * identity, absence included), never by position. An account whose ref is
   * unchanged stays the same object, with its ref object, its session pins,
   * health, token balance and the other in-memory state; only what the read
   * stores is refreshed, newest evidence winning (see `refreshFromRow`). A
   * row whose credential was replaced or re-added, or that is new, becomes
   * a new account. An account the read no longer holds under its ref leaves
   * the manager: pins and selections on it are dropped, writes still queued
   * for it are discarded, and any later write about the old object is
   * ignored rather than sent. A read that is not ready throws and leaves the
   * manager as it was.
   *
   * This method applies the read it is given and does not flush or read
   * itself. The caller must flush this manager's queued writes before
   * taking the read, and must apply reads in the order they were taken: an
   * older read applied after a newer one would bring back accounts and refs
   * the pool no longer holds (the store's ref fences still refuse their
   * writes). `refreshFromRepository` does all of this.
   */
  reloadFromRepository(read: AccountRepositoryRead): void {
    if (this.repository === undefined) {
      throw new Error('reloadFromRepository needs a repository-backed manager')
    }
    if (read.status !== 'ready') {
      throw new Error(
        `the account repository is not ready (${read.status}); the manager keeps its accounts`,
      )
    }
    const previous = new Map<string, ManagedAccount>()
    for (const account of this.accounts) {
      if (account.ref !== undefined)
        previous.set(rowRefKey(account.ref), account)
    }
    const baseNow = this.now()
    const next: ManagedAccount[] = []
    const moved = new Map<number, number>()
    const fingerprints: ManagedAccount[] = []
    for (const row of read.rows) {
      const built = this.accountFromRow(row, next.length, baseNow)
      if (built === undefined) continue
      const key = rowRefKey(row.ref)
      const prior = previous.get(key)
      if (prior === undefined) {
        if (built.fingerprint !== 'kept') fingerprints.push(built.account)
        next.push(built.account)
        continue
      }
      previous.delete(key)
      moved.set(prior.index, next.length)
      this.refreshFromRow(prior, built.account, built.fingerprint)
      prior.index = next.length
      next.push(prior)
    }

    const remap = (index: number) => moved.get(index) ?? -1
    const remapSet = (indexes: Set<number>) =>
      new Set([...indexes].map(remap).filter((index) => index >= 0))
    this.accounts = next
    const families: ModelFamily[] = ['claude', 'gemini']
    for (const family of families) {
      const kept = remap(this.currentAccountIndexByFamily[family])
      // A selection on an account that left falls back to the stored one,
      // as at load; it is not written back.
      this.currentAccountIndexByFamily[family] =
        kept >= 0 || next.length === 0
          ? kept
          : this.routedIndex(read.routing, family)
      for (const state of this.requestSessionStates.values()) {
        state.currentAccountIndexByFamily[family] = remap(
          state.currentAccountIndexByFamily[family],
        )
      }
    }
    for (const state of this.requestSessionStates.values()) {
      state.usedAccounts = remapSet(state.usedAccounts)
    }
    this.sessionUsedAccounts = remapSet(this.sessionUsedAccounts)
    const counts = new Map<string, { claude: number; gemini: number }>()
    for (const [key, value] of this.sessionRequestCounts) {
      const index = remap(Number(key))
      if (index >= 0) counts.set(String(index), value)
    }
    this.sessionRequestCounts = counts
    this.lastToastAccountIndex = remap(this.lastToastAccountIndex)
    this.healthTracker.reindex(moved)
    this.tokenTracker.reindex(moved)
    const live = new Set(
      next.flatMap((account) =>
        account.ref === undefined ? [] : [rowRefKey(account.ref)],
      ),
    )
    for (const key of [...this.pendingRowWrites.keys()]) {
      if (!live.has(key)) this.pendingRowWrites.delete(key)
    }
    for (const account of fingerprints) this.persistFingerprint(account)
  }

  /**
   * Flushes this manager's queued writes, takes a fresh read of the
   * repository and applies it with `reloadFromRepository`. Calls run one at
   * a time in the order they were made, so a later call always applies a
   * read taken after the earlier one's. A flush failure is thrown before
   * anything is read; a read that is not ready throws and changes nothing.
   */
  refreshFromRepository(): Promise<void> {
    const repository = this.repository
    if (repository === undefined) {
      return Promise.reject(
        new Error('refreshFromRepository needs a repository-backed manager'),
      )
    }
    const run = this.reloading.then(async () => {
      await this.flushSaveToDisk()
      this.reloadFromRepository(await repository.read())
    })
    this.reloading = run.catch(() => {})
    return run
  }

  /**
   * Refreshes an unchanged account's stored fields from a newer read,
   * keeping what this manager knows to be newer: the later `lastUsed`,
   * access token and evidence times (quota, tier, access verdicts), the
   * later reset of each rate limit, a cooldown or switch it has queued but
   * not yet written, a rate-limit clear it has queued, and request counts
   * of the later day (the larger count per family on the same day). A
   * fingerprint the read lacks keeps the one this manager generated.
   */
  private refreshFromRow(
    prior: ManagedAccount,
    fresh: ManagedAccount,
    fingerprint: 'kept' | 'generated' | 'updated',
  ): void {
    const pending =
      prior.ref === undefined
        ? undefined
        : this.pendingRowWrites.get(rowRefKey(prior.ref))
    const newer = (a: number | undefined, b: number | undefined) =>
      (a ?? Number.NEGATIVE_INFINITY) >= (b ?? Number.NEGATIVE_INFINITY)

    prior.email = fresh.email
    prior.label = fresh.label
    prior.addedAt = fresh.addedAt
    prior.lastUsed = Math.max(prior.lastUsed, fresh.lastUsed)
    prior.parts = fresh.parts
    prior.projectId = fresh.projectId
    prior.managedProjectId = fresh.managedProjectId
    if (newer(fresh.expires, prior.expires)) {
      prior.access = fresh.access
      prior.expires = fresh.expires
    }
    prior.enabled = fresh.enabled

    const rates: RateLimitStateV3 = { ...fresh.rateLimitResetTimes }
    for (const [key, value] of Object.entries(prior.rateLimitResetTimes)) {
      const stored = rates[key]
      if (value !== undefined && (stored === undefined || value > stored)) {
        rates[key] = value
      }
    }
    for (const [key, value] of pending?.rateLimits ?? []) {
      if (value === 'clear') delete rates[key]
    }
    prior.rateLimitResetTimes = rates
    if (pending?.cooldown === undefined) {
      prior.coolingDownUntil = fresh.coolingDownUntil
      prior.cooldownReason = fresh.cooldownReason
    }
    if (pending?.switchReason === undefined) {
      prior.lastSwitchReason = fresh.lastSwitchReason
    }

    if (fingerprint !== 'generated') {
      prior.fingerprint = fresh.fingerprint
      prior.fingerprintHistory = fresh.fingerprintHistory
    }
    if (newer(fresh.cachedQuotaUpdatedAt, prior.cachedQuotaUpdatedAt)) {
      prior.cachedQuota = fresh.cachedQuota
      prior.cachedQuotaAccountId = fresh.cachedQuotaAccountId
      prior.cachedQuotaUpdatedAt = fresh.cachedQuotaUpdatedAt
    }
    if (newer(fresh.capturedTierAt, prior.capturedTierAt)) {
      prior.capturedTierId = fresh.capturedTierId
      prior.capturedPaidTierId = fresh.capturedPaidTierId
      prior.capturedTierAt = fresh.capturedTierAt
      prior.capturedTierSchemaVersion = fresh.capturedTierSchemaVersion
    }
    if (newer(accessEvidenceTime(fresh), accessEvidenceTime(prior))) {
      prior.verificationRequired = fresh.verificationRequired
      prior.verificationRequiredAt = fresh.verificationRequiredAt
      prior.verificationRequiredReason = fresh.verificationRequiredReason
      prior.verificationUrl = fresh.verificationUrl
      prior.accountIneligible = fresh.accountIneligible
      prior.accountIneligibleAt = fresh.accountIneligibleAt
      prior.accountIneligibleReason = fresh.accountIneligibleReason
      prior.eligibilityStateUpdatedAt = fresh.eligibilityStateUpdatedAt
    }
    prior.dailyRequestCounts = laterCounts(
      prior.dailyRequestCounts,
      fresh.dailyRequestCounts,
    )
  }

  // ========== Repository writes ==========

  /**
   * Starts one attributed repository write about `account`. Its failure is
   * reported here and kept by the repository for the next flush, which
   * decides whether a save fails.
   */
  private dispatch(
    account: ManagedAccount,
    label: string,
    write: (repository: AccountRepository, ref: RowRef) => Promise<unknown>,
  ): void {
    const repository = this.repository
    const ref = account.ref
    if (repository === undefined || ref === undefined) return
    if (!this.accounts.includes(account)) {
      this.ignoreStale(account, label)
      return
    }
    write(repository, ref).catch((error: unknown) => {
      this.onDiagnostic?.(`Account ${label} was not persisted`, {
        rowId: ref.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * A write about an account that left the manager at a reload (its
   * credential was replaced or its row removed) is not sent: it was decided
   * for a credential the pool no longer holds under this manager.
   */
  private ignoreStale(account: ManagedAccount, label: string): void {
    this.onDiagnostic?.(
      `Account ${label} ignored: the account is no longer loaded`,
      account.ref === undefined ? undefined : { rowId: account.ref.id },
    )
  }

  /** Queues an absolute-state change of `account` for the next save. */
  private queueRowWrite(
    account: ManagedAccount,
    change: (pending: PendingRowWrite) => void,
  ): void {
    if (this.repository === undefined || account.ref === undefined) return
    if (!this.accounts.includes(account)) {
      this.ignoreStale(account, 'state change')
      return
    }
    const key = rowRefKey(account.ref)
    let pending = this.pendingRowWrites.get(key)
    if (pending === undefined) {
      pending = { ref: account.ref, rateLimits: new Map() }
      this.pendingRowWrites.set(key, pending)
    }
    change(pending)
    this.requestSaveToDisk()
  }

  /** Merges a write that met lock contention back into the queue. */
  private requeueRowWrite(failed: PendingRowWrite): void {
    const key = rowRefKey(failed.ref)
    const newer = this.pendingRowWrites.get(key)
    if (newer === undefined) {
      this.pendingRowWrites.set(key, failed)
    } else {
      for (const [rateKey, value] of failed.rateLimits) {
        if (!newer.rateLimits.has(rateKey)) newer.rateLimits.set(rateKey, value)
      }
      newer.cooldown ??= failed.cooldown
      newer.switchReason ??= failed.switchReason
      if (
        failed.lastUsed !== undefined &&
        (newer.lastUsed === undefined || failed.lastUsed > newer.lastUsed)
      ) {
        newer.lastUsed = failed.lastUsed
      }
    }
    this.requestSaveToDisk()
  }

  /** Records the global selection of `family` (and `active`, as the pool file kept claude's). */
  private queueSelection(family: ModelFamily): void {
    if (this.repository === undefined) return
    const index = this.currentAccountIndexByFamily[family]
    const ref = this.accounts[index]?.ref ?? null
    this.pendingSelections.set(family, ref)
    if (family === 'claude') this.pendingSelections.set('active', ref)
    this.requestSaveToDisk()
  }

  private persistFingerprint(account: ManagedAccount): void {
    const fingerprint = account.fingerprint
    if (fingerprint === undefined) return
    const history = [...(account.fingerprintHistory ?? [])]
    this.dispatch(account, 'fingerprint', (repository, ref) =>
      repository.recordFingerprint(ref, { fingerprint, history }),
    )
  }

  private persistAccessVerdict(
    account: ManagedAccount,
    verdict: AccessVerdict,
  ): void {
    this.dispatch(account, 'access verdict', (repository, ref) =>
      repository.recordAccessVerdict(ref, verdict),
    )
  }

  /** Starts every queued coalesced write. */
  private dispatchQueuedWrites(): void {
    const repository = this.repository
    if (repository === undefined) return
    const rows = [...this.pendingRowWrites.values()]
    const selections = [...this.pendingSelections]
    this.pendingRowWrites = new Map()
    this.pendingSelections = new Map()
    for (const pending of rows) {
      repository
        .updateMetadata(pending.ref, (current, row) => ({
          kind: 'set',
          metadata: applyPendingRowWrite(
            current ?? { addedAt: row.storeAddedAt ?? this.now(), lastUsed: 0 },
            pending,
          ),
        }))
        .catch((error: unknown) => {
          if (
            error instanceof AccountRepositoryError &&
            error.failure.kind === 'lock-contention' &&
            !error.failure.ambiguous
          ) {
            this.requeueRowWrite(pending)
          }
        })
    }
    for (const [target, ref] of selections) {
      repository.selectAccount(target, ref).catch(() => {
        // Reported by the flush that follows.
      })
    }
  }

  /**
   * Starts the queued writes and waits until the repository has drained
   * every write, including the ones started immediately (usage, access,
   * removal). Throws `AccountManagerPersistError` for the first failure that
   * is not tolerated; every failure is reported through `onDiagnostic`.
   */
  private async flushRepositoryWrites(): Promise<void> {
    const repository = this.repository
    if (repository === undefined) return
    this.dispatchQueuedWrites()
    const report = await repository.flush()
    for (const failure of report.failures) {
      this.onDiagnostic?.('Account repository write failed', {
        operation: failure.operation,
        kind: failure.kind,
        rowId: failure.rowId,
        ambiguous: failure.ambiguous,
        message: failure.message,
      })
    }
    const primary = report.failures.find(
      (failure) => !TOLERATED_FAILURES.has(failure.kind),
    )
    if (primary !== undefined)
      throw new AccountManagerPersistError(primary, report)
  }

  /**
   * Refreshes the account's credential through the repository: the only
   * path by which a successor token is stored. A rotation updates the
   * account's bearer and ref (an identity learnt by the refresh is part of
   * it) and reads the committed refresh token back; a contradicted identity
   * disables the account in memory, as the store disabled its row.
   */
  async refreshAccount(
    account: ManagedAccount,
    options?: AccountRefreshOptions,
  ): Promise<AccountRefreshOutcome> {
    const repository = this.repository
    const ref = account.ref
    if (repository === undefined || ref === undefined) {
      throw new Error('refreshAccount needs a repository-backed account')
    }
    const outcome = await repository.refresh(ref, options)
    if (outcome.status === 'rotated') {
      account.ref = outcome.ref
      account.access = outcome.accessToken
      account.expires = outcome.expiresAt
      const read = await repository.read()
      if (read.status === 'ready') {
        const row = read.rows.find((candidate) =>
          sameRowRef(candidate.ref, outcome.ref),
        )
        if (row?.credential !== undefined) {
          account.parts = {
            ...account.parts,
            refreshToken: row.credential.refreshToken,
          }
        }
      }
    } else if (outcome.status === 'identity-contradicted') {
      account.access = undefined
      account.expires = undefined
      this.applyEnabled(account.index, false)
    }
    return outcome
  }

  /**
   * The health scores this manager selects with, keyed by its current
   * account indexes. Record request outcomes here, not in the process-wide
   * tracker, for a repository-backed manager.
   */
  get healthTracker(): HealthScoreTracker {
    return this.ownHealthTracker ?? getHealthTracker()
  }

  /** The token balances this manager selects with; see `healthTracker`. */
  get tokenTracker(): TokenBucketTracker {
    return this.ownTokenTracker ?? getTokenTracker()
  }

  getAccountCount(): number {
    return this.getEnabledAccounts().length
  }

  getTotalAccountCount(): number {
    return this.accounts.length
  }

  getEnabledAccounts(): ManagedAccount[] {
    return this.accounts.filter((account) => account.enabled !== false)
  }

  private getEffectiveSoftQuotaThreshold(thresholdPercent: number): number {
    // Soft-quota protection only has a purpose when another enabled account
    // exists to rotate to. Never block the sole usable account.
    return this.getEnabledAccounts().length > 1 ? thresholdPercent : 100
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({
      ...a,
      parts: { ...a.parts },
      rateLimitResetTimes: { ...a.rateLimitResetTimes },
    }))
  }

  private getRequestSessionState(
    identity: AccountSessionIdentity,
  ): AccountSessionState {
    const now = this.now()
    this.pruneRequestSessionStates(now, identity.id)

    const existing = this.requestSessionStates.get(identity.id)
    if (existing) {
      existing.lastAccessedAt = now
      if (identity.parentId) {
        existing.parentId = identity.parentId
      }
      return existing
    }

    const state: AccountSessionState = {
      parentId: identity.parentId ?? null,
      currentAccountIndexByFamily: { claude: -1, gemini: -1 },
      cursorByFamily: { ...this.cursorByFamily },
      offsetAppliedByFamily: { claude: false, gemini: false },
      usedAccounts: new Set<number>(),
      lastAccessedAt: now,
    }
    this.requestSessionStates.set(identity.id, state)
    return state
  }

  private pruneRequestSessionStates(now: number, preservedId: string): void {
    const expiry = now - ACCOUNT_SESSION_STATE_TTL_MS
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < expiry) {
        this.requestSessionStates.delete(id)
      }
    }

    if (
      this.requestSessionStates.size < MAX_ACCOUNT_SESSION_STATES ||
      this.requestSessionStates.has(preservedId)
    ) {
      return
    }

    let oldestId: string | null = null
    let oldestAccess = Number.POSITIVE_INFINITY
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < oldestAccess) {
        oldestId = id
        oldestAccess = state.lastAccessedAt
      }
    }
    if (oldestId) {
      this.requestSessionStates.delete(oldestId)
    }
  }

  private getActiveIndex(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): number {
    return identity
      ? this.getRequestSessionState(identity).currentAccountIndexByFamily[
          family
        ]
      : this.currentAccountIndexByFamily[family]
  }

  private setActiveIndex(
    family: ModelFamily,
    index: number,
    identity?: AccountSessionIdentity,
  ): void {
    if (!identity) {
      this.setGlobalActiveIndex(family, index)
      return
    }

    const state = this.getRequestSessionState(identity)
    state.currentAccountIndexByFamily[family] = index
    if (!state.parentId) {
      // Preserve a useful persisted starting point without coupling active root sessions.
      this.setGlobalActiveIndex(family, index)
    }
  }

  /** Sets the persisted selection of a family; a change is queued for saving. */
  private setGlobalActiveIndex(family: ModelFamily, index: number): void {
    if (this.currentAccountIndexByFamily[family] === index) return
    this.currentAccountIndexByFamily[family] = index
    this.queueSelection(family)
  }

  private getCursor(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): number {
    return identity
      ? this.getRequestSessionState(identity).cursorByFamily[family]
      : this.cursorByFamily[family]
  }

  private advanceCursor(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): void {
    const nextGlobalCursor = this.cursorByFamily[family] + 1
    this.cursorByFamily[family] = nextGlobalCursor
    if (identity) {
      this.getRequestSessionState(identity).cursorByFamily[family] += 1
    }
  }

  private getUsedAccounts(identity?: AccountSessionIdentity): Set<number> {
    return identity
      ? this.getRequestSessionState(identity).usedAccounts
      : this.sessionUsedAccounts
  }

  private preferAccountOutsideParent(
    accounts: ManagedAccount[],
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): ManagedAccount[] {
    if (!identity) {
      return accounts
    }
    const parentId = this.getRequestSessionState(identity).parentId
    if (!parentId) {
      return accounts
    }
    const parentState = this.requestSessionStates.get(parentId)
    const parentIndex = parentState?.currentAccountIndexByFamily[family] ?? -1
    if (parentIndex < 0) {
      return accounts
    }
    const isolated = accounts.filter((account) => account.index !== parentIndex)
    return isolated.length > 0 ? isolated : accounts
  }

  deleteSessionState(sessionId: string): void {
    this.requestSessionStates.delete(sessionId)
  }

  getCurrentAccountForFamily(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const currentIndex = this.getActiveIndex(family, identity)
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      const account = this.accounts[currentIndex] ?? null
      // Only return account if it's enabled - disabled accounts should not be selected
      if (account && account.enabled !== false) {
        return account
      }
    }
    return null
  }

  /**
   * Numeric active indexes for each model family. Exposed so callers
   * that persist `activeIndexByFamily` (e.g. command-data's remove
   * path) can capture the live cursor per family without going
   * through the account-lookup layer.
   */
  getActiveIndexByFamily(
    identity?: AccountSessionIdentity,
  ): Record<ModelFamily, number> {
    return {
      claude: this.getActiveIndex('claude', identity),
      gemini: this.getActiveIndex('gemini', identity),
    }
  }

  markSwitched(
    account: ManagedAccount,
    reason: 'rate-limit' | 'initial' | 'rotation',
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): void {
    account.lastSwitchReason = reason
    // An account that left at a reload no longer has a position here; its
    // old index may name another account now.
    if (this.repository !== undefined && !this.accounts.includes(account)) {
      this.ignoreStale(account, 'switch')
      return
    }
    this.queueRowWrite(account, (pending) => {
      pending.switchReason = reason
    })
    this.setActiveIndex(family, account.index, identity)
  }

  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = this.now()
    if (accountIndex !== this.lastToastAccountIndex) {
      return true
    }
    return now - this.lastToastTime >= debounceMs
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex
    this.lastToastTime = this.now()
  }

  getCurrentOrNextForFamily(
    family: ModelFamily,
    model?: string | null,
    strategy: AccountSelectionStrategy = 'sticky',
    headerStyle: HeaderStyle = 'antigravity',
    pidOffsetEnabled: boolean = false,
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
    identity?: AccountSessionIdentity,
    /**
     * Account indexes the caller has ruled out (e.g. the operator
     * killswitch pre-filter). Every selection path — pinned session,
     * round-robin, hybrid, and sticky fallback — skips these indexes
     * so a killed current account falls through to the next eligible
     * account instead of collapsing the request into the rate-limit
     * wait path.
     */
    excludeIndexes?: Set<number>,
  ): ManagedAccount | null {
    const quotaKey = getQuotaKey(family, headerStyle, model)
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(
      softQuotaThresholdPercent,
    )

    // OpenCode may run many root and child sessions concurrently in one plugin
    // process. Pin each exact session until its account becomes unavailable.
    if (identity) {
      const pinned = this.getCurrentAccountForFamily(family, identity)
      if (pinned) {
        clearExpiredRateLimits(pinned, this.now)
        const unavailable =
          (excludeIndexes?.has(pinned.index) ?? false) ||
          isRateLimitedForHeaderStyle(
            pinned,
            family,
            headerStyle,
            this.now,
            model,
          ) ||
          isOverSoftQuotaThreshold(
            pinned,
            family,
            effectiveSoftQuotaThreshold,
            softQuotaCacheTtlMs,
            this.now,
            model,
          ) ||
          this.isAccountCoolingDown(pinned)
        if (!unavailable) {
          this.markTouchedForQuota(pinned, quotaKey)
          return pinned
        }
      }
    }

    if (strategy === 'round-robin') {
      const next = this.getNextForFamily(
        family,
        model,
        headerStyle,
        effectiveSoftQuotaThreshold,
        softQuotaCacheTtlMs,
        identity,
        excludeIndexes,
      )
      if (next) {
        this.markTouchedForQuota(next, quotaKey)
        this.setActiveIndex(family, next.index, identity)
      }
      return next
    }

    if (strategy === 'hybrid') {
      const healthTracker = this.healthTracker
      const tokenTracker = this.tokenTracker

      const eligibleAccounts = this.preferAccountOutsideParent(
        this.accounts.filter(
          (acc) => acc.enabled !== false && !excludeIndexes?.has(acc.index),
        ),
        family,
        identity,
      )
      const accountsWithMetrics: AccountWithMetrics[] = eligibleAccounts.map(
        (acc) => {
          clearExpiredRateLimits(acc, this.now)
          return {
            index: acc.index,
            lastUsed: acc.lastUsed,
            healthScore: healthTracker.getScore(acc.index),
            isRateLimited:
              isRateLimitedForHeaderStyle(
                acc,
                family,
                headerStyle,
                this.now,
                model,
              ) ||
              isOverSoftQuotaThreshold(
                acc,
                family,
                effectiveSoftQuotaThreshold,
                softQuotaCacheTtlMs,
                this.now,
                model,
              ),
            isCoolingDown: this.isAccountCoolingDown(acc),
          }
        },
      )

      // Get current account index for stickiness
      const currentIndex = this.getActiveIndex(family, identity)

      const selectedIndex = selectHybridAccount(
        accountsWithMetrics,
        tokenTracker,
        currentIndex,
        50,
        this.now,
      )
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex]
        if (selected) {
          this.touchLastUsed(selected)
          this.markTouchedForQuota(selected, quotaKey)
          this.setActiveIndex(family, selected.index, identity)
          return selected
        }
      }
    }

    // Fallback: sticky selection (used when hybrid finds no candidates)
    // PID-based offset for multi-session distribution (opt-in)
    // Different sessions (PIDs) will prefer different starting accounts
    const offsetApplied = identity
      ? this.getRequestSessionState(identity).offsetAppliedByFamily
      : this.sessionOffsetApplied
    if (
      pidOffsetEnabled &&
      !offsetApplied[family] &&
      this.accounts.length > 1
    ) {
      const pidOffset = this.pid % this.accounts.length
      const activeIndex = this.getActiveIndex(family, identity)
      const baseIndex =
        activeIndex >= 0 ? activeIndex : this.getCursor(family, identity)
      const newIndex = (baseIndex + pidOffset) % this.accounts.length

      this.onDiagnostic?.('Applying PID account offset', {
        pid: this.pid,
        offset: pidOffset,
        family,
        fromIndex: baseIndex,
        toIndex: newIndex,
      })

      this.setActiveIndex(family, newIndex, identity)
      offsetApplied[family] = true
    }

    const current = this.getCurrentAccountForFamily(family, identity)
    if (current && !excludeIndexes?.has(current.index)) {
      clearExpiredRateLimits(current, this.now)
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(
        current,
        family,
        headerStyle,
        this.now,
        model,
      )
      const isOverThreshold = isOverSoftQuotaThreshold(
        current,
        family,
        effectiveSoftQuotaThreshold,
        softQuotaCacheTtlMs,
        this.now,
        model,
      )
      if (
        !isLimitedForRequestedStyle &&
        !isOverThreshold &&
        !this.isAccountCoolingDown(current)
      ) {
        this.markTouchedForQuota(current, quotaKey)
        return current
      }
    }

    const next = this.getNextForFamily(
      family,
      model,
      headerStyle,
      effectiveSoftQuotaThreshold,
      softQuotaCacheTtlMs,
      identity,
      excludeIndexes,
    )
    if (next) {
      this.markTouchedForQuota(next, quotaKey)
      this.setActiveIndex(family, next.index, identity)
    }
    return next
  }

  getNextForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle: HeaderStyle = 'antigravity',
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
    identity?: AccountSessionIdentity,
    /** Indexes ruled out by the caller (e.g. killswitch pre-filter). */
    excludeIndexes?: Set<number>,
  ): ManagedAccount | null {
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(
      softQuotaThresholdPercent,
    )
    const allAvailable = this.accounts.filter((account) => {
      clearExpiredRateLimits(account, this.now)
      return (
        account.enabled !== false &&
        !excludeIndexes?.has(account.index) &&
        !isRateLimitedForHeaderStyle(
          account,
          family,
          headerStyle,
          this.now,
          model,
        ) &&
        !isOverSoftQuotaThreshold(
          account,
          family,
          effectiveSoftQuotaThreshold,
          softQuotaCacheTtlMs,
          this.now,
          model,
        ) &&
        !this.isAccountCoolingDown(account)
      )
    })
    const available = this.preferAccountOutsideParent(
      allAvailable,
      family,
      identity,
    )

    if (available.length === 0) {
      return null
    }

    const usedAccounts = this.getUsedAccounts(identity)
    const sessionUsed = available.filter((account) =>
      usedAccounts.has(account.index),
    )
    const candidates = sessionUsed.length > 0 ? sessionUsed : available

    const cursor = this.getCursor(family, identity)
    const account = candidates[cursor % candidates.length]
    if (!account) {
      return null
    }

    this.advanceCursor(family, identity)
    return account
  }
  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = 'antigravity',
    model?: string | null,
  ): void {
    const key = getQuotaKey(family, headerStyle, model)
    this.setRateLimit(account, key, this.now() + retryAfterMs)
  }

  private setRateLimit(
    account: ManagedAccount,
    key: QuotaKey,
    resetAt: number,
  ): void {
    account.rateLimitResetTimes[key] = resetAt
    this.queueRowWrite(account, (pending) => {
      pending.rateLimits.set(key, resetAt)
    })
  }

  private clearRateLimit(account: ManagedAccount, key: QuotaKey): void {
    delete account.rateLimitResetTimes[key]
    this.queueRowWrite(account, (pending) => {
      pending.rateLimits.set(key, 'clear')
    })
  }

  private touchLastUsed(account: ManagedAccount): void {
    const now = this.now()
    account.lastUsed = now
    this.queueRowWrite(account, (pending) => {
      pending.lastUsed = Math.max(pending.lastUsed ?? 0, now)
    })
  }

  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex: number): void {
    const account = this.accounts.find((a) => a.index === accountIndex)
    if (account) {
      this.touchLastUsed(account)
    }
  }

  recordSessionUsage(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): void {
    this.getUsedAccounts(identity).add(accountIndex)
  }

  wasUsedInSession(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): boolean {
    return this.getUsedAccounts(identity).has(accountIndex)
  }

  shouldProactivelyRotate(
    family: ModelFamily,
    model: string | null | undefined,
    thresholdPercent: number,
    cacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): boolean {
    if (thresholdPercent <= 0) return false

    const current = this.getCurrentAccountForFamily(family, identity)
    if (!current?.cachedQuota || current.cachedQuotaUpdatedAt == null)
      return false

    const age = this.now() - current.cachedQuotaUpdatedAt
    if (age > cacheTtlMs) return false

    const quotaGroup = resolveQuotaGroup(family, model)
    const groupData = current.cachedQuota[quotaGroup]
    if (groupData?.remainingFraction == null) return false

    const remainingPercent = Math.max(
      0,
      Math.min(100, groupData.remainingFraction * 100),
    )
    return remainingPercent < thresholdPercent
  }

  proactivelyRotateForFamily(
    family: ModelFamily,
    model: string | null | undefined,
    headerStyle: HeaderStyle,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const currentIndex = this.getActiveIndex(family, identity)

    const candidates = this.preferAccountOutsideParent(
      this.accounts.filter((acc) => {
        if (acc.enabled === false) return false
        if (acc.index === currentIndex) return false
        clearExpiredRateLimits(acc, this.now)
        if (
          isRateLimitedForHeaderStyle(acc, family, headerStyle, this.now, model)
        )
          return false
        if (
          isOverSoftQuotaThreshold(
            acc,
            family,
            softQuotaThresholdPercent,
            softQuotaCacheTtlMs,
            this.now,
            model,
          )
        )
          return false
        if (this.isAccountCoolingDown(acc)) return false
        return true
      }),
      family,
      identity,
    )

    if (candidates.length === 0) return null

    const usedAccounts = this.getUsedAccounts(identity)
    const warmCandidates = candidates.filter((account) =>
      usedAccounts.has(account.index),
    )
    const pool = warmCandidates.length > 0 ? warmCandidates : candidates

    const quotaGroup = resolveQuotaGroup(family, model)
    pool.sort((a, b) => {
      const aRemaining = a.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0
      const bRemaining = b.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0
      return bRemaining - aRemaining
    })

    const selected = pool[0]
    if (!selected) return null

    const quotaKey = getQuotaKey(family, headerStyle, model)
    this.markTouchedForQuota(selected, quotaKey)
    this.setActiveIndex(family, selected.index, identity)

    return selected
  }

  markRateLimitedWithReason(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null,
    failureTtlMs: number = 3600_000, // Default 1 hour TTL
  ): number {
    const now = this.now()

    // TTL-based reset: if last failure was more than failureTtlMs ago, reset count
    if (
      account.lastFailureTime !== undefined &&
      now - account.lastFailureTime > failureTtlMs
    ) {
      account.consecutiveFailures = 0
    }

    const failures = (account.consecutiveFailures ?? 0) + 1
    account.consecutiveFailures = failures
    account.lastFailureTime = now

    const backoffMs = calculateBackoffMs(
      reason,
      failures - 1,
      retryAfterMs,
      this.random,
    )
    const key = getQuotaKey(family, headerStyle, model)
    this.setRateLimit(account, key, now + backoffMs)

    return backoffMs
  }

  markRequestSuccess(account: ManagedAccount): void {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0
    }
  }

  clearAllRateLimitsForFamily(
    family: ModelFamily,
    model?: string | null,
  ): void {
    for (const account of this.accounts) {
      if (family === 'claude') {
        this.clearRateLimit(account, 'claude')
      } else {
        const antigravityKey = getQuotaKey(family, 'antigravity', model)
        const cliKey = getQuotaKey(family, 'gemini-cli', model)
        this.clearRateLimit(account, antigravityKey)
        this.clearRateLimit(account, cliKey)
      }
      account.consecutiveFailures = 0
    }
  }

  shouldTryOptimisticReset(
    family: ModelFamily,
    model?: string | null,
  ): boolean {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model)
    return minWaitMs > 0 && minWaitMs <= 2_000
  }

  markAccountCoolingDown(
    account: ManagedAccount,
    cooldownMs: number,
    reason: CooldownReason,
  ): void {
    const until = this.now() + cooldownMs
    account.coolingDownUntil = until
    account.cooldownReason = reason
    this.queueRowWrite(account, (pending) => {
      pending.cooldown = { value: { until, reason } }
    })
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false
    }
    if (this.now() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account)
      return false
    }
    return true
  }

  clearAccountCooldown(account: ManagedAccount): void {
    const hadCooldown =
      account.coolingDownUntil !== undefined ||
      account.cooldownReason !== undefined
    delete account.coolingDownUntil
    delete account.cooldownReason
    if (hadCooldown) {
      this.queueRowWrite(account, (pending) => {
        pending.cooldown = { value: null }
      })
    }
  }

  getAccountCooldownReason(
    account: ManagedAccount,
  ): CooldownReason | undefined {
    return this.isAccountCoolingDown(account)
      ? account.cooldownReason
      : undefined
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = this.now()
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    const touchedAt = account.touchedForQuota[quotaKey]
    if (!touchedAt) return true

    const resetTime = account.rateLimitResetTimes[quotaKey as QuotaKey]
    if (resetTime && touchedAt < resetTime) return true

    return false
  }

  getFreshAccountsForQuota(
    quotaKey: string,
    family: ModelFamily,
    model?: string | null,
  ): ManagedAccount[] {
    return this.accounts.filter((acc) => {
      clearExpiredRateLimits(acc, this.now)
      return (
        acc.enabled !== false &&
        this.isFreshForQuota(acc, quotaKey) &&
        !isRateLimitedForFamily(acc, family, this.now, model) &&
        !this.isAccountCoolingDown(acc)
      )
    })
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null,
  ): boolean {
    return isRateLimitedForHeaderStyle(
      account,
      family,
      headerStyle,
      this.now,
      model,
    )
  }

  getAvailableHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    model?: string | null,
  ): HeaderStyle | null {
    clearExpiredRateLimits(account, this.now)
    if (family === 'claude') {
      return isRateLimitedForHeaderStyle(
        account,
        family,
        'antigravity',
        this.now,
      )
        ? null
        : 'antigravity'
    }
    if (
      !isRateLimitedForHeaderStyle(
        account,
        family,
        'antigravity',
        this.now,
        model,
      )
    ) {
      return 'antigravity'
    }
    if (
      !isRateLimitedForHeaderStyle(
        account,
        family,
        'gemini-cli',
        this.now,
        model,
      )
    ) {
      return 'gemini-cli'
    }
    return null
  }

  /**
   * Check if any OTHER account has antigravity quota available for the given family/model.
   *
   * Used to determine whether to switch accounts vs fall back to gemini-cli:
   * - If true: Switch to another account (preserve antigravity priority)
   * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
   *
   * @param currentAccountIndex - Index of the current account (will be excluded from check)
   * @param family - Model family ("gemini" or "claude")
   * @param model - Optional model name for model-specific rate limits
   * @returns true if any other enabled, non-cooling-down account has antigravity available
   */
  hasOtherAccountWithAntigravityAvailable(
    currentAccountIndex: number,
    family: ModelFamily,
    model?: string | null,
  ): boolean {
    // Claude has no gemini-cli fallback - always return false
    // (This method is only relevant for Gemini's dual quota pools)
    if (family === 'claude') {
      return false
    }

    return this.accounts.some((acc) => {
      // Skip current account
      if (acc.index === currentAccountIndex) {
        return false
      }
      // Skip disabled accounts
      if (acc.enabled === false) {
        return false
      }
      // Skip cooling down accounts
      if (this.isAccountCoolingDown(acc)) {
        return false
      }
      // Clear expired rate limits before checking
      clearExpiredRateLimits(acc, this.now)
      // Check if antigravity is available for this account
      return !isRateLimitedForHeaderStyle(
        acc,
        family,
        'antigravity',
        this.now,
        model,
      )
    })
  }

  setAccountEnabled(accountIndex: number, enabled: boolean): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }
    if (enabled && account.accountIneligible) {
      return false
    }
    this.applyEnabled(accountIndex, enabled)
    this.dispatch(account, 'enabled flag', (repository, ref) =>
      repository.setEnabled(ref, { enabled, actor: 'user' }),
    )

    this.requestSaveToDisk()
    return true
  }

  /** Changes the in-memory flag and moves a selection off a disabled account. */
  private applyEnabled(accountIndex: number, enabled: boolean): void {
    const account = this.accounts[accountIndex]
    if (!account) return
    account.enabled = enabled

    if (!enabled) {
      for (const family of Object.keys(
        this.currentAccountIndexByFamily,
      ) as ModelFamily[]) {
        if (this.currentAccountIndexByFamily[family] === accountIndex) {
          const next = this.accounts.find(
            (a, i) => i !== accountIndex && a.enabled !== false,
          )
          this.setGlobalActiveIndex(family, next?.index ?? -1)
        }
      }
    }
  }

  markAccountVerificationRequired(
    accountIndex: number,
    reason?: string,
    verifyUrl?: string,
  ): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }

    const timestamp = this.now()
    account.verificationRequired = true
    account.verificationRequiredAt = timestamp
    account.verificationRequiredReason = reason?.trim() || undefined
    if (
      account.accountIneligible === true ||
      account.accountIneligibleAt !== undefined ||
      account.accountIneligibleReason !== undefined
    ) {
      account.accountIneligible = false
      account.accountIneligibleAt = undefined
      account.accountIneligibleReason = undefined
      account.eligibilityStateUpdatedAt = timestamp
    }

    const normalizedVerifyUrl = verifyUrl?.trim()
    if (normalizedVerifyUrl) {
      account.verificationUrl = normalizedVerifyUrl
    }

    if (account.enabled !== false) {
      this.applyEnabled(accountIndex, false)
    }
    // The verdict, its metadata and the disabled flag land in one
    // attributed transition.
    this.persistAccessVerdict(account, {
      kind: 'verification-required',
      observedAt: timestamp,
      ...(account.verificationRequiredReason !== undefined
        ? { reason: account.verificationRequiredReason }
        : {}),
      ...(normalizedVerifyUrl ? { verificationUrl: normalizedVerifyUrl } : {}),
    })
    this.requestSaveToDisk()

    return true
  }

  markAccountIneligible(accountIndex: number, reason?: string): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }

    const timestamp = this.now()
    account.accountIneligible = true
    account.accountIneligibleAt = timestamp
    account.accountIneligibleReason =
      reason?.trim() || 'Google marked this account as ineligible.'
    account.eligibilityStateUpdatedAt = timestamp
    account.verificationRequired = false
    account.verificationRequiredAt = undefined
    account.verificationRequiredReason = undefined
    account.verificationUrl = undefined

    if (account.enabled !== false) {
      this.applyEnabled(accountIndex, false)
    }
    this.persistAccessVerdict(account, {
      kind: 'ineligible',
      observedAt: timestamp,
      reason: account.accountIneligibleReason,
    })
    this.requestSaveToDisk()
    return true
  }

  clearAccountAccessBlocks(
    accountIndex: number,
    enableAccount = false,
  ): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }

    const wasVerificationRequired = account.verificationRequired === true
    const wasIneligible = account.accountIneligible === true
    const hadMetadata =
      wasVerificationRequired ||
      wasIneligible ||
      account.verificationRequiredAt !== undefined ||
      account.verificationRequiredReason !== undefined ||
      account.verificationUrl !== undefined ||
      account.accountIneligibleAt !== undefined ||
      account.accountIneligibleReason !== undefined ||
      account.eligibilityStateUpdatedAt !== undefined

    account.verificationRequired = false
    account.verificationRequiredAt = undefined
    account.verificationRequiredReason = undefined
    account.verificationUrl = undefined
    account.accountIneligible = false
    account.accountIneligibleAt = undefined
    account.accountIneligibleReason = undefined
    const observedAt = this.now()
    if (wasIneligible || account.eligibilityStateUpdatedAt !== undefined) {
      account.eligibilityStateUpdatedAt = observedAt
    }

    const reenable =
      enableAccount &&
      (wasVerificationRequired || wasIneligible) &&
      account.enabled === false
    if (reenable) {
      this.applyEnabled(accountIndex, true)
    }
    if (reenable || hadMetadata) {
      this.persistAccessVerdict(account, {
        kind: 'cleared',
        observedAt,
        enable: enableAccount,
      })
      this.requestSaveToDisk()
    }
    return true
  }

  removeAccountByIndex(accountIndex: number): boolean {
    if (accountIndex < 0 || accountIndex >= this.accounts.length) {
      return false
    }
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }
    return this.removeAccount(account)
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account)
    if (idx < 0) {
      return false
    }

    // Fenced on the account's credential: a row replaced or re-added since
    // it was loaded is refused rather than removed.
    this.dispatch(account, 'removal', (repository, ref) =>
      repository.remove(ref),
    )
    for (const [key, pending] of this.pendingRowWrites) {
      if (account.ref !== undefined && sameRowRef(pending.ref, account.ref)) {
        this.pendingRowWrites.delete(key)
      }
    }
    this.accounts.splice(idx, 1)
    this.accounts.forEach((acc, index) => {
      acc.index = index
    })

    if (this.accounts.length === 0) {
      this.cursorByFamily = { claude: 0, gemini: 0 }
      this.currentAccountIndexByFamily.claude = -1
      this.currentAccountIndexByFamily.gemini = -1
      this.requestSessionStates.clear()
      return true
    }

    for (const family of ['claude', 'gemini'] as ModelFamily[]) {
      if (this.cursorByFamily[family] > idx) {
        this.cursorByFamily[family] -= 1
      }
      this.cursorByFamily[family] =
        this.cursorByFamily[family] % this.accounts.length

      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1
      }

      for (const state of this.requestSessionStates.values()) {
        const currentIndex = state.currentAccountIndexByFamily[family]
        if (currentIndex === idx) {
          state.currentAccountIndexByFamily[family] = -1
        } else if (currentIndex > idx) {
          state.currentAccountIndexByFamily[family] -= 1
        }
        if (state.cursorByFamily[family] > idx) {
          state.cursorByFamily[family] -= 1
        }
        state.cursorByFamily[family] %= this.accounts.length
      }
    }

    for (const state of this.requestSessionStates.values()) {
      state.usedAccounts = new Set(
        [...state.usedAccounts]
          .filter((accountIndex) => accountIndex !== idx)
          .map((accountIndex) =>
            accountIndex > idx ? accountIndex - 1 : accountIndex,
          ),
      )
    }

    return true
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh)
    // Only the projects packed into the host's refresh string are recorded;
    // the refresh token itself reaches the repository only through
    // `refreshAccount`.
    const projectChange = {
      ...(parts.projectId !== undefined && parts.projectId !== account.projectId
        ? { projectId: parts.projectId }
        : {}),
      ...(parts.managedProjectId !== undefined &&
      parts.managedProjectId !== account.managedProjectId
        ? { managedProjectId: parts.managedProjectId }
        : {}),
    }
    if (Object.keys(projectChange).length > 0) {
      this.dispatch(account, 'project', (repository, ref) =>
        repository.recordProject(ref, projectChange),
      )
    }
    // Preserve existing projectId/managedProjectId if not in the new parts
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId:
        parts.managedProjectId ?? account.parts.managedProjectId,
    }
    // Keep the record-level fields in sync with the authoritative source.
    account.projectId = parts.projectId ?? account.projectId
    account.managedProjectId =
      parts.managedProjectId ?? account.managedProjectId
    account.access = auth.access
    account.expires = auth.expires
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: 'oauth',
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    }
  }

  getMinWaitTimeForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
    strict?: boolean,
  ): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a, this.now)
      return (
        a.enabled !== false &&
        (strict && headerStyle
          ? !isRateLimitedForHeaderStyle(
              a,
              family,
              headerStyle,
              this.now,
              model,
            )
          : !isRateLimitedForFamily(a, family, this.now, model))
      )
    })
    if (available.length > 0) {
      return 0
    }

    const waitTimes: number[] = []
    for (const a of this.accounts) {
      if (family === 'claude') {
        const t = a.rateLimitResetTimes.claude
        if (t !== undefined) waitTimes.push(Math.max(0, t - this.now()))
      } else if (strict && headerStyle) {
        const key = getQuotaKey(family, headerStyle, model)
        const t = a.rateLimitResetTimes[key]
        if (t !== undefined) waitTimes.push(Math.max(0, t - this.now()))
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        const antigravityKey = getQuotaKey(family, 'antigravity', model)
        const cliKey = getQuotaKey(family, 'gemini-cli', model)

        const t1 = a.rateLimitResetTimes[antigravityKey]
        const t2 = a.rateLimitResetTimes[cliKey]

        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - this.now()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - this.now()) : Infinity,
        )
        if (accountWait !== Infinity) waitTimes.push(accountWait)
      }
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts]
  }

  private buildStorageSnapshot(): AccountStorageV4 {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude)
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini)

    return {
      version: 4,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        label: a.label,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId ?? a.projectId,
        managedProjectId: a.parts.managedProjectId ?? a.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        rateLimitResetTimes:
          Object.keys(a.rateLimitResetTimes).length > 0
            ? a.rateLimitResetTimes
            : undefined,
        fingerprint: a.fingerprint,
        fingerprintHistory: a.fingerprintHistory?.length
          ? a.fingerprintHistory
          : undefined,
        cachedQuota:
          a.cachedQuota && Object.keys(a.cachedQuota).length > 0
            ? a.cachedQuota
            : undefined,
        // Persist the opaque identity stamp alongside the quota so a later
        // loadFromDisk + projection can detect a stale snapshot captured
        // for a different account after an index shift.
        cachedQuotaAccountId: a.cachedQuotaAccountId,
        cachedQuotaUpdatedAt: a.cachedQuotaUpdatedAt,
        capturedTierId: a.capturedTierId,
        capturedPaidTierId: a.capturedPaidTierId,
        capturedTierAt: a.capturedTierAt,
        capturedTierSchemaVersion: a.capturedTierSchemaVersion,
        dailyRequestCounts: a.dailyRequestCounts,
        verificationRequired: a.verificationRequired,
        verificationRequiredAt: a.verificationRequiredAt,
        verificationRequiredReason: a.verificationRequiredReason,
        verificationUrl: a.verificationUrl,
        accountIneligible: a.accountIneligible,
        accountIneligibleAt: a.accountIneligibleAt,
        accountIneligibleReason: a.accountIneligibleReason,
        eligibilityStateUpdatedAt: a.eligibilityStateUpdatedAt,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    }
  }

  async saveToDisk(): Promise<void> {
    if (this.repository !== undefined) {
      await this.flushRepositoryWrites()
      return
    }
    await this.requireStore().saveMerged(
      this.storagePath,
      this.buildStorageSnapshot(),
    )
  }

  private requireStore(): AccountStorageStore {
    if (this.store === undefined) {
      throw new Error('this AccountManager persists through its repository')
    }
    return this.store
  }

  /**
   * Persist via full-file replace (no merge). Required after destructive
   * operations (account removal) so a deleted account is not resurrected by
   * mergeAccountStorage re-reading it from disk.
   */
  async saveToDiskReplace(): Promise<void> {
    // A repository-backed manager removes rows by attributed `remove`
    // writes, so nothing can bring a removed row back; draining suffices.
    if (this.repository !== undefined) {
      await this.flushRepositoryWrites()
      return
    }
    const snapshot = this.buildStorageSnapshot()
    await this.requireStore().mutate(this.storagePath, () => snapshot)
  }

  requestSaveToDisk(): void {
    if (this.disposed || this.savePending) {
      return
    }
    this.savePending = true
    this.saveTimeout = setTimeout(() => {
      this.saveInFlight = this.executeSave().finally(() => {
        this.saveInFlight = null
      })
    }, 1000)
  }

  async flushSaveToDisk(): Promise<void> {
    // Writes such as request counts start immediately rather than waiting
    // for a scheduled save, so a repository-backed flush always drains.
    if (this.repository !== undefined) {
      await this.drainRepository()
      return
    }
    if (!this.savePending) {
      await this.saveInFlight
      return
    }
    return new Promise<void>((resolve, reject) => {
      this.savePromiseResolvers.push({ resolve, reject })
    })
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    if (this.repository !== undefined) {
      await this.drainRepository()
      return
    }
    if (this.savePending) {
      await this.executeSave()
    }
    await this.saveInFlight
  }

  /**
   * Cancels a scheduled save and drains every repository write now. A
   * failure rejects every waiting flush and is thrown to the caller.
   */
  private async drainRepository(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    this.savePending = false
    const resolvers = this.savePromiseResolvers
    this.savePromiseResolvers = []
    await this.saveInFlight
    await this.settleRepositoryDrain(resolvers)
  }

  private async settleRepositoryDrain(
    resolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }>,
  ): Promise<void> {
    try {
      await this.flushRepositoryWrites()
    } catch (error) {
      for (const { reject } of resolvers) reject(error)
      throw error
    }
    for (const { resolve } of resolvers) resolve()
  }

  private async executeSave(): Promise<void> {
    this.savePending = false
    this.saveTimeout = null

    const resolvers = this.savePromiseResolvers
    this.savePromiseResolvers = []

    if (this.repository !== undefined) {
      // A scheduled save has no caller to throw to: its failures reach
      // waiting flushes and the diagnostics.
      await this.settleRepositoryDrain(resolvers).catch(() => {})
      return
    }

    try {
      await this.saveToDisk()
      for (const { resolve } of resolvers) {
        resolve()
      }
    } catch (error) {
      if (isStorageLockContention(error)) {
        this.onDiagnostic?.(
          'Skipped account-state persist due to storage lock contention',
          {
            error: String(error),
          },
        )
        for (const { resolve } of resolvers) {
          resolve()
        }
        return
      }

      this.onDiagnostic?.('Failed to persist account state', {
        error: String(error),
      })
      for (const { reject } of resolvers) {
        reject(error)
      }
    }
  }
  // ========== Fingerprint Management ==========

  /**
   * Regenerate fingerprint for an account, saving the old one to history.
   * @param accountIndex - Index of the account to regenerate fingerprint for
   * @returns The new fingerprint, or null if account not found
   */
  regenerateAccountFingerprint(accountIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex]
    if (!account) return null

    // Save current fingerprint to history if it exists
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: this.now(),
        reason: 'regenerated',
      }

      if (!account.fingerprintHistory) {
        account.fingerprintHistory = []
      }

      // Add to beginning of history (most recent first)
      account.fingerprintHistory.unshift(historyEntry)

      // Trim to max history size
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(
          0,
          MAX_FINGERPRINT_HISTORY,
        )
      }
    }

    // Generate and assign new fingerprint
    account.fingerprint = generateFingerprint()
    this.persistFingerprint(account)
    this.requestSaveToDisk()

    return account.fingerprint
  }

  /**
   * Restore a fingerprint from history for an account.
   * @param accountIndex - Index of the account
   * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
   * @returns The restored fingerprint, or null if account/history not found
   */
  restoreAccountFingerprint(
    accountIndex: number,
    historyIndex: number,
  ): Fingerprint | null {
    const account = this.accounts[accountIndex]
    if (!account) return null

    const history = account.fingerprintHistory
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return null
    }

    // Capture the fingerprint to restore BEFORE modifying history
    const fingerprintToRestore = history[historyIndex]!.fingerprint

    // Save current fingerprint to history before restoring (if it exists)
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: this.now(),
        reason: 'restored',
      }

      account.fingerprintHistory!.unshift(historyEntry)

      // Trim to max history size
      if (account.fingerprintHistory!.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory!.slice(
          0,
          MAX_FINGERPRINT_HISTORY,
        )
      }
    }

    // Restore the fingerprint
    account.fingerprint = { ...fingerprintToRestore, createdAt: this.now() }

    this.persistFingerprint(account)
    this.requestSaveToDisk()

    return account.fingerprint
  }

  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[] {
    const account = this.accounts[accountIndex]
    if (!account?.fingerprintHistory) {
      return []
    }
    return [...account.fingerprintHistory]
  }

  updateQuotaCache(
    accountIndex: number,
    quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>,
    expectedRefreshToken?: string,
  ): void {
    const account = this.accounts[accountIndex]
    if (
      !account ||
      (account.parts.refreshToken !== expectedRefreshToken &&
        expectedRefreshToken !== undefined)
    )
      return
    account.cachedQuota = quotaGroups
    // Stamp the cached quota with an opaque identity derived from the refresh
    // token so a later projection can detect a stale snapshot captured for
    // a different account after an index shift.
    account.cachedQuotaAccountId = quotaAccountIdentity(
      account.parts.refreshToken,
    )
    account.cachedQuotaUpdatedAt = this.now()
    // A separate attributed write from the tier; the per-model readings the
    // store keeps are left as they are because this reading carries none.
    const reading: QuotaState = {
      schemaVersion: 1,
      cachedQuotaAccountId: account.cachedQuotaAccountId,
      cachedQuota: storedQuotaGroups(quotaGroups),
      cachedQuotaUpdatedAt: account.cachedQuotaUpdatedAt,
    }
    this.dispatch(account, 'quota reading', (repository, ref) =>
      repository.recordQuota(ref, reading),
    )
  }

  /**
   * Apply a subset of fields from a quota-fetch `updatedAccount` result onto
   * the live in-memory record for the given index. Only patches fields that
   * are present and non-empty in `patch` to avoid overwriting valid state
   * with stale or missing values.
   *
   * Identity guard: if `expectedRefreshToken` is provided and the account at
   * `accountIndex` no longer carries that token (concurrent reorder/replace),
   * the patch is silently dropped.
   *
   * `managedProjectId` is intentionally absent from the patch type: the only
   * caller (`BackgroundQuotaRefresh`) routes through `PollerAccountView` which
   * exposes only `capturedTierId`/`capturedTierAt`; project-context updates
   * happen via `ensureProjectContext`, not through this method.
   */
  applyUpdatedAccount(
    accountIndex: number,
    patch: Partial<
      Pick<
        AccountMetadataV3,
        | 'capturedTierId'
        | 'capturedPaidTierId'
        | 'capturedTierAt'
        | 'capturedTierSchemaVersion'
      >
    >,
    expectedRefreshToken?: string,
  ): void {
    const account = this.accounts[accountIndex]
    if (
      !account ||
      (expectedRefreshToken !== undefined &&
        account.parts.refreshToken !== expectedRefreshToken)
    )
      return
    if (patch.capturedTierId !== undefined) {
      account.capturedTierId = patch.capturedTierId
    }
    if (patch.capturedPaidTierId !== undefined) {
      account.capturedPaidTierId = patch.capturedPaidTierId
    }
    if (patch.capturedTierAt !== undefined) {
      account.capturedTierAt = patch.capturedTierAt
    }
    if (patch.capturedTierSchemaVersion !== undefined) {
      account.capturedTierSchemaVersion = patch.capturedTierSchemaVersion
    }
    const tier: Partial<ProviderMetadata> = {}
    if (patch.capturedTierId !== undefined)
      tier.capturedTierId = patch.capturedTierId
    if (patch.capturedPaidTierId !== undefined) {
      tier.capturedPaidTierId = patch.capturedPaidTierId
    }
    if (patch.capturedTierAt !== undefined)
      tier.capturedTierAt = patch.capturedTierAt
    if (patch.capturedTierSchemaVersion !== undefined) {
      tier.capturedTierSchemaVersion = patch.capturedTierSchemaVersion
    }
    if (Object.keys(tier).length === 0) return
    this.dispatch(account, 'tier', (repository, ref) =>
      repository.updateMetadata(ref, (current, row) => {
        const base = current ?? {
          addedAt: row.storeAddedAt ?? this.now(),
          lastUsed: 0,
        }
        // A capture older than the stored one does not replace it.
        if (
          patch.capturedTierAt !== undefined &&
          typeof base.capturedTierAt === 'number' &&
          patch.capturedTierAt < base.capturedTierAt
        ) {
          return { kind: 'keep' }
        }
        return { kind: 'set', metadata: { ...base, ...tier } }
      }),
    )
  }

  /**
   * Record a successful API request for an account.
   * Tracks per model family with daily reset.
   */
  recordRequest(accountIndex: number, family: ModelFamily): void {
    const account = this.accounts[accountIndex]
    if (!account) return

    const today = new Date(this.now()).toISOString().slice(0, 10)

    if (
      !account.dailyRequestCounts ||
      account.dailyRequestCounts.date !== today
    ) {
      account.dailyRequestCounts = { date: today, claude: 0, gemini: 0 }
    }

    account.dailyRequestCounts[family]++
    account.lastUsed = this.now()
    // Each request is its own increment, computed under the row lock from
    // the stored count, so no request is lost to a concurrent writer.
    const at = account.lastUsed
    this.dispatch(account, 'request count', (repository, ref) =>
      repository.recordUsage(ref, { family, at }),
    )

    // Also track for session
    this.recordSessionRequest(accountIndex, family)
  }

  /**
   * Get request counts for an account for today.
   */
  getDailyRequestCounts(
    accountIndex: number,
  ): { date: string; claude: number; gemini: number } | null {
    const account = this.accounts[accountIndex]
    if (!account?.dailyRequestCounts) return null

    const today = new Date(this.now()).toISOString().slice(0, 10)
    if (account.dailyRequestCounts.date !== today) return null

    return { ...account.dailyRequestCounts }
  }

  /**
   * Get total daily request counts across all accounts for a model family.
   */
  getTotalDailyRequests(family: ModelFamily): number {
    const today = new Date(this.now()).toISOString().slice(0, 10)
    let total = 0
    for (const account of this.accounts) {
      if (account.dailyRequestCounts?.date === today) {
        total += account.dailyRequestCounts[family]
      }
    }
    return total
  }

  /**
   * Get a summary of daily request distribution across accounts.
   * Returns accounts sorted by request count (descending).
   */
  getDailyRequestSummary(
    family: ModelFamily,
  ): Array<{ index: number; email?: string; count: number }> {
    const today = new Date(this.now()).toISOString().slice(0, 10)
    const result: Array<{ index: number; email?: string; count: number }> = []

    for (const account of this.accounts) {
      const count =
        account.dailyRequestCounts?.date === today
          ? account.dailyRequestCounts[family]
          : 0
      if (count > 0) {
        result.push({ index: account.index, email: account.email, count })
      }
    }

    return result.sort((a, b) => b.count - a.count)
  }

  /**
   * Record a request for the current session (in-memory only).
   */
  recordSessionRequest(accountIndex: number, family: ModelFamily): void {
    const key = String(accountIndex)
    const current = this.sessionRequestCounts.get(key) ?? {
      claude: 0,
      gemini: 0,
    }
    current[family]++
    this.sessionRequestCounts.set(key, current)
  }

  /**
   * Get a summary of the current session's request usage.
   */
  getSessionSummary(): {
    durationMinutes: number
    totalClaude: number
    totalGemini: number
    requestsPerHour: number
    accountsUsed: number
    perAccount: Array<{
      index: number
      email?: string
      claude: number
      gemini: number
    }>
  } {
    const durationMs = this.now() - this.sessionStartTime
    const durationMinutes = Math.round(durationMs / 60000)
    const durationHours = durationMs / 3600000

    let totalClaude = 0
    let totalGemini = 0
    const perAccount: Array<{
      index: number
      email?: string
      claude: number
      gemini: number
    }> = []

    for (const [key, counts] of this.sessionRequestCounts) {
      const idx = Number(key)
      const account = this.accounts[idx]
      totalClaude += counts.claude
      totalGemini += counts.gemini
      if (counts.claude > 0 || counts.gemini > 0) {
        perAccount.push({
          index: idx,
          email: account?.email,
          claude: counts.claude,
          gemini: counts.gemini,
        })
      }
    }

    const totalRequests = totalClaude + totalGemini
    const requestsPerHour =
      durationHours > 0 ? Math.round(totalRequests / durationHours) : 0

    return {
      durationMinutes,
      totalClaude,
      totalGemini,
      requestsPerHour,
      accountsUsed: perAccount.length,
      perAccount: perAccount.sort(
        (a, b) => b.claude + b.gemini - (a.claude + a.gemini),
      ),
    }
  }

  isAccountOverSoftQuota(
    account: ManagedAccount,
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean {
    return isOverSoftQuotaThreshold(
      account,
      family,
      this.getEffectiveSoftQuotaThreshold(thresholdPercent),
      cacheTtlMs,
      this.now,
      model,
    )
  }

  /**
   * The accounts a quota check should cover. For a repository-backed
   * manager each target carries the ref its account is loaded under,
   * captured now, before any quota work starts; an account without a ref
   * has no row to attribute a reading to and is left out rather than
   * matched by position, email or token.
   */
  getAccountsForQuotaCheck(): AccountQuotaTarget[] {
    const targets: AccountQuotaTarget[] = []
    for (const a of this.accounts) {
      const target: AccountMetadataV3 = {
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId ?? a.projectId,
        managedProjectId: a.parts.managedProjectId ?? a.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
      }
      if (this.repository === undefined) {
        targets.push(target)
      } else if (a.ref !== undefined) {
        targets.push({ ...target, rowRef: a.ref })
      }
    }
    return targets
  }

  getOldestQuotaCacheAge(): number | null {
    let oldest: number | null = null
    for (const acc of this.accounts) {
      if (acc.enabled === false) continue
      if (acc.cachedQuotaUpdatedAt == null) return null
      const age = this.now() - acc.cachedQuotaUpdatedAt
      if (oldest === null || age > oldest) oldest = age
    }
    return oldest
  }

  areAllAccountsOverSoftQuota(
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean {
    if (thresholdPercent >= 100) return false
    const enabled = this.accounts.filter((a) => a.enabled !== false)
    if (enabled.length <= 1) return false
    return enabled.every((a) =>
      isOverSoftQuotaThreshold(
        a,
        family,
        thresholdPercent,
        cacheTtlMs,
        this.now,
        model,
      ),
    )
  }

  /**
   * Get minimum wait time until any account's soft quota resets.
   * Returns 0 if any account is available (not over threshold).
   * Returns the minimum resetTime across all over-threshold accounts.
   * Returns null if no resetTime data is available.
   */
  getMinWaitTimeForSoftQuota(
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): number | null {
    if (thresholdPercent >= 100) return 0

    const enabled = this.accounts.filter((a) => a.enabled !== false)
    if (enabled.length === 0) return null
    if (enabled.length === 1) return 0

    // If any account is available (not over threshold), no wait needed
    const available = enabled.filter(
      (a) =>
        !isOverSoftQuotaThreshold(
          a,
          family,
          thresholdPercent,
          cacheTtlMs,
          this.now,
          model,
        ),
    )
    if (available.length > 0) return 0

    // All accounts are over threshold - find earliest reset time
    // For gemini family, we MUST have the model to distinguish pro vs flash quotas.
    // Fail-open (return null = no wait info) if model is missing to avoid blocking on wrong quota.
    if (!model && family !== 'claude') return null
    const quotaGroup = resolveQuotaGroup(family, model)
    const now = this.now()
    const waitTimes: number[] = []

    for (const acc of enabled) {
      const groupData = acc.cachedQuota?.[quotaGroup]
      if (groupData?.resetTime) {
        const resetTimestamp = Date.parse(groupData.resetTime)
        if (Number.isFinite(resetTimestamp)) {
          waitTimes.push(Math.max(0, resetTimestamp - now))
        }
      }
    }

    if (waitTimes.length === 0) return null
    const minWait = Math.min(...waitTimes)
    // Treat 0 as stale cache (resetTime in the past) → fail-open to avoid spin loop
    return minWait === 0 ? null : minWait
  }
}
