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
import {
  AccountSelector,
  type AccountSessionIdentity,
  clampNonNegativeInt,
  type SelectableAccount,
  type SelectionSink,
} from './account-selector.ts'
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
  updateFingerprintVersion,
} from './fingerprint.ts'
import {
  normalizeLegacyCachedQuota,
  type QuotaGroup,
  type QuotaGroupSummary,
} from './quota-types.ts'
import {
  getHealthTracker,
  getTokenTracker,
  HealthScoreTracker,
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

export type {
  AccountSessionIdentity,
  BaseQuotaKey,
  QuotaKey,
} from './account-selector.ts'
export { resolveQuotaGroup } from './account-selector.ts'

/**
 * A local pool account: the selection fields of `SelectableAccount` plus the
 * credential and records only this manager reads. The selector holds these
 * objects but never reads their credential fields.
 */
export interface ManagedAccount extends SelectableAccount {
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
  /**
   * Owns all of this manager's selection state: its accounts, the
   * selection, cursors, session pins, trackers, toast and usage counts.
   * The manager itself handles credentials and persistence.
   */
  private readonly selection: AccountSelector<ManagedAccount>

  /**
   * The selector's accounts in pool order: a view of its array, not a copy
   * and not a second list.
   */
  private get accounts(): readonly ManagedAccount[] {
    return this.selection.rows
  }

  private savePending = false
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private saveInFlight: Promise<void> | null = null
  private disposed = false
  private savePromiseResolvers: Array<{
    resolve: () => void
    reject: (err: unknown) => void
  }> = []

  private readonly store: AccountStorageStore | undefined
  private readonly repository: AccountRepository | undefined
  /** Coalesced absolute-state writes per repository credential. */
  private pendingRowWrites = new Map<string, PendingRowWrite>()
  /** Latest selection per routing target, written at the next save. */
  private pendingSelections = new Map<RoutingTarget, RowRef | null>()
  private readonly storagePath: string
  /** A promise chain that applies reloads in request order. */
  private reloading: Promise<void> = Promise.resolve()
  private readonly onDiagnostic: AccountManagerOptions['onDiagnostic']
  private readonly now: () => number

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
    this.storagePath = options.storagePath ?? ''
    this.onDiagnostic = options.onDiagnostic
    this.now = options.now ?? (() => Date.now())
    const repositoryBacked = options.repository !== undefined
    this.selection = new AccountSelector<ManagedAccount>({
      sink: repositoryBacked
        ? this.repositorySink()
        : {
            requestSave: () => this.requestSaveToDisk(),
            stale: (account, label) => this.ignoreStale(account, label),
          },
      // A repository-backed manager gets its own new trackers. A pool-file
      // manager without supplied trackers shares the process-wide ones
      // (`getHealthTracker`, `getTokenTracker`), as it always has.
      healthTracker:
        options.healthTracker ??
        (repositoryBacked ? new HealthScoreTracker() : getHealthTracker),
      tokenTracker:
        options.tokenTracker ??
        (repositoryBacked ? new TokenBucketTracker() : getTokenTracker),
      now: this.now,
      random: options.random ?? (() => Math.random()),
      pid: options.pid ?? process.pid,
      onDiagnostic: options.onDiagnostic,
    })
    const authParts = authFallback
      ? parseRefreshParts(authFallback.refresh)
      : null

    if (stored && stored.accounts.length === 0) {
      return
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = this.now()
      const accounts = stored.accounts
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
      for (const acc of accounts) {
        if (acc.fingerprint && updateFingerprintVersion(acc.fingerprint)) {
          fingerprintVersionChanged = true
        }
      }

      // The stored selection is resolved against the stored accounts, before
      // an auth-fallback account is added.
      const legacyCursor = clampNonNegativeInt(stored.activeIndex, 0)
      const selection: Partial<Record<ModelFamily, number>> = {}
      if (accounts.length > 0) {
        const defaultIndex = legacyCursor % accounts.length
        for (const family of ['claude', 'gemini'] as const) {
          selection[family] =
            clampNonNegativeInt(
              stored.activeIndexByFamily?.[family],
              defaultIndex,
            ) % accounts.length
        }
      }

      // Persist updated fingerprint versions to disk
      if (fingerprintVersionChanged) {
        this.requestSaveToDisk()
      }

      // If current auth isn't in the loaded accounts, add it to the pool
      if (authFallback && authParts?.refreshToken) {
        const hasMatching = accounts.some(
          (acc) => acc.parts.refreshToken === authParts.refreshToken,
        )
        if (!hasMatching) {
          const now = this.now()
          const newAccount: ManagedAccount = {
            index: accounts.length,
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
          accounts.push(newAccount)
        }
      }

      this.selection.resetAccounts(accounts, selection)
      return
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh)
      if (parts.refreshToken) {
        const now = this.now()
        this.selection.resetAccounts(
          [
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
          ],
          { claude: 0, gemini: 0 },
        )
      }
    }
  }

  /**
   * Where a repository-backed manager's selector reports transitions. Each
   * becomes a write attributed to the exact account it was decided for.
   * Rate limits, cooldowns, switches, `lastUsed` and selections are queued
   * and coalesced until the next save; request counts, enabled flags,
   * access verdicts and fingerprints are written immediately.
   */
  private repositorySink(): SelectionSink<ManagedAccount> {
    return {
      rateLimit: (account, key, resetAt) =>
        this.queueRowWrite(account, (pending) => {
          pending.rateLimits.set(key, resetAt)
        }),
      cooldown: (account, value) =>
        this.queueRowWrite(account, (pending) => {
          pending.cooldown = { value }
        }),
      switched: (account, reason) =>
        this.queueRowWrite(account, (pending) => {
          pending.switchReason = reason
        }),
      lastUsed: (account, at) =>
        this.queueRowWrite(account, (pending) => {
          pending.lastUsed = Math.max(pending.lastUsed ?? 0, at)
        }),
      selection: (family, account) => this.queueSelection(family, account),
      usage: (account, family, at) =>
        this.dispatch(account, 'request count', (repository, ref) =>
          repository.recordUsage(ref, { family, at }),
        ),
      enabled: (account, enabled) =>
        this.dispatch(account, 'enabled flag', (repository, ref) =>
          repository.setEnabled(ref, { enabled, actor: 'user' }),
        ),
      accessVerdict: (account, verdict) =>
        this.persistAccessVerdict(account, verdict),
      fingerprint: (account) => this.persistFingerprint(account),
      requestSave: () => this.requestSaveToDisk(),
      stale: (account, label) => this.ignoreStale(account, label),
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

  /** The stored selection's index for `family` among `accounts`. */
  private routedIndex(
    accounts: readonly ManagedAccount[],
    routing: RoutingSettings | undefined,
    family: ModelFamily,
  ): number {
    const count = accounts.length
    const indexOf = (ref: RowRef | null | undefined): number | undefined => {
      if (ref == null) return undefined
      const found = accounts.findIndex(
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
    const accounts: ManagedAccount[] = []
    const generated: ManagedAccount[] = []
    const versionUpdated: ManagedAccount[] = []
    for (const row of read.rows) {
      const built = this.accountFromRow(row, accounts.length, baseNow)
      if (built === undefined) continue
      if (built.fingerprint === 'generated') generated.push(built.account)
      if (built.fingerprint === 'updated') versionUpdated.push(built.account)
      accounts.push(built.account)
    }
    const selection: Partial<Record<ModelFamily, number>> = {}
    if (accounts.length > 0) {
      for (const family of ['claude', 'gemini'] as const) {
        selection[family] = this.routedIndex(accounts, read.routing, family)
      }
    }
    this.selection.resetAccounts(accounts, selection)
    // Persist each generated or version-updated fingerprint.
    for (const account of [...generated, ...versionUpdated]) {
      this.persistFingerprint(account)
    }
  }

  /**
   * Brings a repository-backed manager up to date with a newer ready read.
   *
   * Accounts are matched by their exact ref (row id, credential epoch and
   * identity, absence included), never by position. An account whose ref is
   * unchanged stays the same object, with its ref object, its session pins,
   * health, token balance and the other in-memory state; only what the read
   * stores is refreshed, newest evidence winning (see `refreshFromRow`). The
   * ref an account is matched under is the one it holds now, so an account
   * this manager refreshed through `refreshAccount` is matched under its
   * successor ref and keeps its pins. A row whose credential was replaced or
   * re-added by anything else, or that is new, becomes a new account. An
   * account the read no longer holds under its ref leaves the manager: pins
   * and selections on it are dropped, writes still queued for it are
   * discarded, and any later write about the old object is ignored rather
   * than sent. A read that is not ready throws and leaves the manager as it
   * was.
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
    const baseNow = this.now()
    const fresh: ManagedAccount[] = []
    const fingerprintOf = new Map<
      ManagedAccount,
      'kept' | 'generated' | 'updated'
    >()
    for (const row of read.rows) {
      const built = this.accountFromRow(row, fresh.length, baseNow)
      if (built === undefined) continue
      fingerprintOf.set(built.account, built.fingerprint)
      fresh.push(built.account)
    }
    const { added } = this.selection.replaceAccounts(fresh, {
      keyOf: (account) =>
        account.ref === undefined ? undefined : rowRefKey(account.ref),
      refresh: (prior, account) =>
        this.refreshFromRow(
          prior,
          account,
          fingerprintOf.get(account) ?? 'kept',
        ),
      // A selection on an account that left falls back to the stored one,
      // as at load; it is not written back.
      selectionFallback: (family, accounts) =>
        this.routedIndex(accounts, read.routing, family),
    })
    const live = new Set(
      this.accounts.flatMap((account) =>
        account.ref === undefined ? [] : [rowRefKey(account.ref)],
      ),
    )
    for (const key of [...this.pendingRowWrites.keys()]) {
      if (!live.has(key)) this.pendingRowWrites.delete(key)
    }
    for (const account of added) {
      if (fingerprintOf.get(account) !== 'kept')
        this.persistFingerprint(account)
    }
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
    if (!this.selection.has(account)) {
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
    if (!this.selection.has(account)) {
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

  /**
   * Queues the pool-wide selection of `family` for the next save. Claude's
   * selection is also recorded as the `active` target, the single active
   * account the pool file kept before it tracked families separately.
   */
  private queueSelection(
    family: ModelFamily,
    account: ManagedAccount | null,
  ): void {
    if (this.repository === undefined) return
    const ref = account?.ref ?? null
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
      this.selection.setEnabledInMemory(account, false)
    }
    return outcome
  }

  /**
   * The health scores this manager selects with, keyed by its current
   * account indexes. Record request outcomes here, not in the process-wide
   * tracker, for a repository-backed manager.
   */
  get healthTracker(): HealthScoreTracker {
    return this.selection.healthTracker
  }

  /** The token balances this manager selects with; see `healthTracker`. */
  get tokenTracker(): TokenBucketTracker {
    return this.selection.tokenTracker
  }

  // ========== Selection, owned by `this.selection` ==========

  getAccountCount(): number {
    return this.selection.getAccountCount()
  }

  getTotalAccountCount(): number {
    return this.selection.getTotalAccountCount()
  }

  getEnabledAccounts(): ManagedAccount[] {
    return this.selection.getEnabledAccounts()
  }

  /** Copies of the accounts, each with its own credential parts and rate limits. */
  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({
      ...a,
      parts: { ...a.parts },
      rateLimitResetTimes: { ...a.rateLimitResetTimes },
    }))
  }

  deleteSessionState(sessionId: string): void {
    this.selection.deleteSessionState(sessionId)
  }

  getCurrentAccountForFamily(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    return this.selection.getCurrentAccountForFamily(family, identity)
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
    return this.selection.getActiveIndexByFamily(identity)
  }

  markSwitched(
    account: ManagedAccount,
    reason: 'rate-limit' | 'initial' | 'rotation',
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): void {
    this.selection.markSwitched(account, reason, family, identity)
  }

  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    return this.selection.shouldShowAccountToast(accountIndex, debounceMs)
  }

  markToastShown(accountIndex: number): void {
    this.selection.markToastShown(accountIndex)
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
    return this.selection.getCurrentOrNextForFamily(
      family,
      model,
      strategy,
      headerStyle,
      pidOffsetEnabled,
      softQuotaThresholdPercent,
      softQuotaCacheTtlMs,
      identity,
      excludeIndexes,
    )
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
    return this.selection.getNextForFamily(
      family,
      model,
      headerStyle,
      softQuotaThresholdPercent,
      softQuotaCacheTtlMs,
      identity,
      excludeIndexes,
    )
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = 'antigravity',
    model?: string | null,
  ): void {
    this.selection.markRateLimited(
      account,
      retryAfterMs,
      family,
      headerStyle,
      model,
    )
  }

  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex: number): void {
    this.selection.markAccountUsed(accountIndex)
  }

  recordSessionUsage(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): void {
    this.selection.recordSessionUsage(accountIndex, identity)
  }

  wasUsedInSession(
    accountIndex: number,
    identity?: AccountSessionIdentity,
  ): boolean {
    return this.selection.wasUsedInSession(accountIndex, identity)
  }

  shouldProactivelyRotate(
    family: ModelFamily,
    model: string | null | undefined,
    thresholdPercent: number,
    cacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): boolean {
    return this.selection.shouldProactivelyRotate(
      family,
      model,
      thresholdPercent,
      cacheTtlMs,
      identity,
    )
  }

  proactivelyRotateForFamily(
    family: ModelFamily,
    model: string | null | undefined,
    headerStyle: HeaderStyle,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    return this.selection.proactivelyRotateForFamily(
      family,
      model,
      headerStyle,
      softQuotaThresholdPercent,
      softQuotaCacheTtlMs,
      identity,
    )
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
    return this.selection.markRateLimitedWithReason(
      account,
      family,
      headerStyle,
      model,
      reason,
      retryAfterMs,
      failureTtlMs,
    )
  }

  markRequestSuccess(account: ManagedAccount): void {
    this.selection.markRequestSuccess(account)
  }

  clearAllRateLimitsForFamily(
    family: ModelFamily,
    model?: string | null,
  ): void {
    this.selection.clearAllRateLimitsForFamily(family, model)
  }

  shouldTryOptimisticReset(
    family: ModelFamily,
    model?: string | null,
  ): boolean {
    return this.selection.shouldTryOptimisticReset(family, model)
  }

  markAccountCoolingDown(
    account: ManagedAccount,
    cooldownMs: number,
    reason: CooldownReason,
  ): void {
    this.selection.markAccountCoolingDown(account, cooldownMs, reason)
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    return this.selection.isAccountCoolingDown(account)
  }

  clearAccountCooldown(account: ManagedAccount): void {
    this.selection.clearAccountCooldown(account)
  }

  getAccountCooldownReason(
    account: ManagedAccount,
  ): CooldownReason | undefined {
    return this.selection.getAccountCooldownReason(account)
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    this.selection.markTouchedForQuota(account, quotaKey)
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    return this.selection.isFreshForQuota(account, quotaKey)
  }

  getFreshAccountsForQuota(
    quotaKey: string,
    family: ModelFamily,
    model?: string | null,
  ): ManagedAccount[] {
    return this.selection.getFreshAccountsForQuota(quotaKey, family, model)
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null,
  ): boolean {
    return this.selection.isRateLimitedForHeaderStyle(
      account,
      family,
      headerStyle,
      model,
    )
  }

  getAvailableHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    model?: string | null,
  ): HeaderStyle | null {
    return this.selection.getAvailableHeaderStyle(account, family, model)
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
    return this.selection.hasOtherAccountWithAntigravityAvailable(
      currentAccountIndex,
      family,
      model,
    )
  }

  setAccountEnabled(accountIndex: number, enabled: boolean): boolean {
    return this.selection.setAccountEnabled(accountIndex, enabled)
  }

  markAccountVerificationRequired(
    accountIndex: number,
    reason?: string,
    verifyUrl?: string,
  ): boolean {
    return this.selection.markAccountVerificationRequired(
      accountIndex,
      reason,
      verifyUrl,
    )
  }

  markAccountIneligible(accountIndex: number, reason?: string): boolean {
    return this.selection.markAccountIneligible(accountIndex, reason)
  }

  clearAccountAccessBlocks(
    accountIndex: number,
    enableAccount = false,
  ): boolean {
    return this.selection.clearAccountAccessBlocks(accountIndex, enableAccount)
  }

  removeAccountByIndex(accountIndex: number): boolean {
    const accounts = this.accounts
    if (accountIndex < 0 || accountIndex >= accounts.length) {
      return false
    }
    const account = accounts[accountIndex]
    if (!account) {
      return false
    }
    return this.removeAccount(account)
  }

  removeAccount(account: ManagedAccount): boolean {
    if (!this.selection.has(account)) {
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
    return this.selection.removeAccount(account)
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
    return this.selection.getMinWaitTimeForFamily(
      family,
      model,
      headerStyle,
      strict,
    )
  }

  getAccounts(): ManagedAccount[] {
    return this.selection.getAccounts()
  }

  private buildStorageSnapshot(): AccountStorageV4 {
    const active = this.selection.getActiveIndexByFamily()
    const claudeIndex = Math.max(0, active.claude)
    const geminiIndex = Math.max(0, active.gemini)

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
    return this.selection.regenerateAccountFingerprint(accountIndex)
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
    return this.selection.restoreAccountFingerprint(accountIndex, historyIndex)
  }

  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[] {
    return this.selection.getAccountFingerprintHistory(accountIndex)
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
    this.selection.recordRequest(accountIndex, family)
  }

  /**
   * Get request counts for an account for today.
   */
  getDailyRequestCounts(
    accountIndex: number,
  ): { date: string; claude: number; gemini: number } | null {
    return this.selection.getDailyRequestCounts(accountIndex)
  }

  /**
   * Get total daily request counts across all accounts for a model family.
   */
  getTotalDailyRequests(family: ModelFamily): number {
    return this.selection.getTotalDailyRequests(family)
  }

  /**
   * Get a summary of daily request distribution across accounts.
   * Returns accounts sorted by request count (descending).
   */
  getDailyRequestSummary(
    family: ModelFamily,
  ): Array<{ index: number; email?: string; count: number }> {
    return this.selection.getDailyRequestSummary(family)
  }

  /**
   * Record a request for the current session (in-memory only).
   */
  recordSessionRequest(accountIndex: number, family: ModelFamily): void {
    this.selection.recordSessionRequest(accountIndex, family)
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
    return this.selection.getSessionSummary()
  }

  isAccountOverSoftQuota(
    account: ManagedAccount,
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean {
    return this.selection.isAccountOverSoftQuota(
      account,
      family,
      thresholdPercent,
      cacheTtlMs,
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
    return this.selection.getOldestQuotaCacheAge()
  }

  areAllAccountsOverSoftQuota(
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
  ): boolean {
    return this.selection.areAllAccountsOverSoftQuota(
      family,
      thresholdPercent,
      cacheTtlMs,
      model,
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
    return this.selection.getMinWaitTimeForSoftQuota(
      family,
      thresholdPercent,
      cacheTtlMs,
      model,
    )
  }
}
