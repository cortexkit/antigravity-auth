/**
 * Account selection, session pinning, rate-limit, cooldown, health, token,
 * toast and usage bookkeeping over one pool of rows, independent of where
 * the rows' credentials live.
 *
 * `AccountSelector` is the single owner of that state. The local
 * `AccountManager` delegates every selection method to one selector over its
 * `ManagedAccount` rows; a vault-backed pool builds a selector over rows that
 * carry only roster metadata. The selector never reads, copies, hashes or
 * serializes a credential: its policy reads only the `SelectableAccount`
 * fields, so a row type with a credential field (the local one) and a row
 * type without one (a vault's) select identically.
 *
 * Persisting a transition is not the selector's concern. Each transition is
 * reported to an injected `SelectionSink` with the exact row object it was
 * decided for, at the point the original manager wrote it, so the owner of
 * the rows decides whether and where it is stored.
 */
import type {
  AccessVerdict,
  CooldownObservation,
  LastSwitchReason,
} from './account-repository-types.ts'
import type {
  AccountSelectionStrategy,
  CooldownReason,
  HeaderStyle,
  AccountModelFamily as ModelFamily,
  RateLimitStateV3,
} from './account-types.ts'
import {
  type Fingerprint,
  type FingerprintVersion,
  generateFingerprint,
  MAX_FINGERPRINT_HISTORY,
} from './fingerprint.ts'
import { getQuotaGroupForModel } from './model-registry.ts'
import type { QuotaGroup, QuotaGroupSummary } from './quota-types.ts'
import {
  type AccountWithMetrics,
  calculateBackoffMs,
  HealthScoreTracker,
  type RateLimitReason,
  selectHybridAccount,
  TokenBucketTracker,
} from './rotation.ts'

export type BaseQuotaKey = 'claude' | 'gemini-antigravity' | 'gemini-cli'
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`

/**
 * The fields of a pool row that selection and its bookkeeping read or set.
 * None of them is a credential: no refresh or access token, expiry, project,
 * refresh parts or repository ref. A row type may carry more fields (the
 * local `ManagedAccount` carries its credential); the selector never reads
 * them.
 */
export interface SelectableAccount {
  /** The row's position in the pool. It changes on reorder; never an identity. */
  index: number
  enabled: boolean
  lastUsed: number
  /** Reset time per quota key: family, model and header style. */
  rateLimitResetTimes: RateLimitStateV3
  lastSwitchReason?: LastSwitchReason
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  /** When each quota key last selected this row (in memory only). */
  touchedForQuota: Record<string, number>
  consecutiveFailures?: number
  /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
  lastFailureTime?: number
  cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>
  cachedQuotaUpdatedAt?: number
  dailyRequestCounts?: { date: string; claude: number; gemini: number }
  email?: string
  fingerprint?: Fingerprint
  fingerprintHistory?: FingerprintVersion[]
  verificationRequired?: boolean
  verificationRequiredAt?: number
  verificationRequiredReason?: string
  verificationUrl?: string
  accountIneligible?: boolean
  accountIneligibleAt?: number
  accountIneligibleReason?: string
  eligibilityStateUpdatedAt?: number
}

export interface AccountSessionIdentity {
  id: string
  parentId?: string | null
}

/**
 * Where the selector reports each transition, with the exact row object it
 * was decided for. Every method is optional; an absent one drops that
 * effect. Methods are called synchronously, in the order the transitions
 * happen; whatever a sink throws reaches the selector's caller.
 */
export interface SelectionSink<A> {
  /** A rate-limit reset time was set for `key`, or (`'clear'`) dropped. */
  rateLimit?(row: A, key: QuotaKey, resetAt: number | 'clear'): void
  /** A cooldown was set, or (`null`) cleared. */
  cooldown?(row: A, value: CooldownObservation): void
  /** The row was switched to for `reason`. */
  switched?(row: A, reason: LastSwitchReason): void
  /** The row was selected by hybrid selection or marked used at `at`. */
  lastUsed?(row: A, at: number): void
  /**
   * The pool-wide selection of `family` changed to `row` (`null`: none).
   * Session pins are in memory only and are not reported.
   */
  selection?(family: ModelFamily, row: A | null): void
  /** One request of `family` was served by the row at `at`. */
  usage?(row: A, family: ModelFamily, at: number): void
  /** The row's enabled flag was set by a caller. */
  enabled?(row: A, enabled: boolean): void
  /** An access verdict, with its metadata and enabled flag, was recorded. */
  accessVerdict?(row: A, verdict: AccessVerdict): void
  /** The row's fingerprint or its history changed. */
  fingerprint?(row: A): void
  /** Persist the pool soon; called after the transitions above that ask for it. */
  requestSave?(): void
  /**
   * A transition about a row that is no longer in the pool was ignored.
   * Without this method the selector reports it through `onDiagnostic`.
   */
  stale?(row: A, label: string): void
}

/** A tracker the selector owns, or a shared one it resolves on each use. */
type TrackerSource<T> = T | (() => T)

export interface AccountSelectorOptions<A extends SelectableAccount> {
  sink?: SelectionSink<A>
  /**
   * The health scores this selector selects with, keyed by its row indexes.
   * A tracker instance is owned: the selector reindexes it when rows move.
   * A function resolves a shared tracker on each use (the local pool-file
   * manager's process-wide default); a shared tracker is never reindexed,
   * because other pools key it by their own indexes. Absent: a new tracker
   * owned by this selector.
   */
  healthTracker?: TrackerSource<HealthScoreTracker>
  /** The token balances this selector selects with; see `healthTracker`. */
  tokenTracker?: TrackerSource<TokenBucketTracker>
  now?: () => number
  random?: () => number
  pid?: number
  onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void
}

/** How `replaceAccounts` matches and refreshes rows. */
export interface ReplaceAccountsOptions<A extends SelectableAccount> {
  /**
   * The row's identity. Rows whose keys are equal (`SameValueZero`, as a
   * `Map` compares them) are the same member: an object key matches by
   * object identity, a string key by value. A key is read from a current
   * row as the row is now, so a row whose identity was legitimately
   * advanced in place (a local credential refresh) is matched under its
   * successor identity.
   */
  keyOf(row: A): unknown
  /**
   * Brings a kept row up to date with the matched fresh row. Defaults to
   * `refreshSelectableRow`. Not called when the fresh row is the kept row.
   */
  refresh?(prior: A, fresh: A): void
  /**
   * The pool-wide selection of `family` when its row left. Defaults to
   * none (-1). Not reported to the sink.
   */
  selectionFallback?(family: ModelFamily, accounts: readonly A[]): number
}

/** The rows a membership change added and removed. */
export interface AccountsReplaced<A> {
  added: A[]
  removed: A[]
}

export function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return value < 0 ? 0 : Math.floor(value)
}

export function getQuotaKey(
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
  account: SelectableAccount,
  key: QuotaKey,
  now: () => number,
): boolean {
  const resetTime = account.rateLimitResetTimes[key]
  return resetTime !== undefined && now() < resetTime
}

function isRateLimitedForFamily(
  account: SelectableAccount,
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
  account: SelectableAccount,
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
  account: SelectableAccount,
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
  account: SelectableAccount,
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
 * Bookkeeping a pool holds only in memory: a fresh roster row cannot know
 * it, so a refresh keeps it on the kept row.
 */
const IN_MEMORY_FIELDS: ReadonlySet<string> = new Set([
  'index',
  'touchedForQuota',
  'consecutiveFailures',
  'lastFailureTime',
])

/**
 * The default refresh of a kept row from its fresh roster row: every field
 * the fresh row has replaces the kept one, and every field it lacks is
 * removed, so no stale enabled flag, cooldown, quota reading, verdict or
 * other roster metadata survives. Only in-memory bookkeeping is kept
 * (quota-key touches, consecutive failures, the row's index), plus two
 * observations this pool may hold before its roster shows them: the later
 * `lastUsed`, and per rate-limit key the later reset time.
 */
export function refreshSelectableRow<A extends SelectableAccount>(
  prior: A,
  fresh: A,
): void {
  const lastUsed = Math.max(prior.lastUsed, fresh.lastUsed)
  const rates: RateLimitStateV3 = { ...fresh.rateLimitResetTimes }
  for (const [key, value] of Object.entries(prior.rateLimitResetTimes)) {
    const stored = rates[key]
    if (value !== undefined && (stored === undefined || value > stored)) {
      rates[key] = value
    }
  }
  for (const key of Object.keys(prior)) {
    if (!IN_MEMORY_FIELDS.has(key) && !Object.hasOwn(fresh, key)) {
      Reflect.deleteProperty(prior, key)
    }
  }
  for (const [key, value] of Object.entries(fresh)) {
    if (!IN_MEMORY_FIELDS.has(key)) Reflect.set(prior, key, value)
  }
  prior.lastUsed = lastUsed
  prior.rateLimitResetTimes = rates
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
const FAMILIES: readonly ModelFamily[] = ['claude', 'gemini']

/**
 * The one owner of a pool's selection state: its rows, the per-family
 * selection and round-robin cursors, per-session pins (with parent ids,
 * used rows, cursors and PID-offset flags), session usage, toast debounce,
 * health and token trackers, and the clock, random source and pid they use.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per quota key (family, model and header style),
 * so an account rate-limited for Claude can still be used for Gemini.
 *
 * Rows are held by reference, never copied, and their selection fields are
 * updated in place. Index-keyed state follows a row across a membership
 * change only through `replaceAccounts` or `removeAccount`, which match rows
 * by identity, never by position.
 */
export class AccountSelector<A extends SelectableAccount> {
  private accounts: A[] = []
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
  private readonly sessionStartTime: number
  private sessionRequestCounts: Map<
    string,
    { claude: number; gemini: number }
  > = new Map()
  private sessionUsedAccounts: Set<number> = new Set()
  private readonly requestSessionStates = new Map<string, AccountSessionState>()

  private readonly sink: SelectionSink<A>
  private readonly healthSource: TrackerSource<HealthScoreTracker>
  private readonly tokenSource: TrackerSource<TokenBucketTracker>
  private readonly onDiagnostic: AccountSelectorOptions<A>['onDiagnostic']
  private readonly now: () => number
  private readonly random: () => number
  private readonly pid: number

  constructor(options: AccountSelectorOptions<A> = {}) {
    this.sink = options.sink ?? {}
    this.onDiagnostic = options.onDiagnostic
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? (() => Math.random())
    this.pid = options.pid ?? process.pid
    this.healthSource = options.healthTracker ?? new HealthScoreTracker()
    this.tokenSource = options.tokenTracker ?? new TokenBucketTracker()
    this.sessionStartTime = this.now()
  }

  /**
   * The health scores this selector selects with, keyed by its current row
   * indexes. Record request outcomes here.
   */
  get healthTracker(): HealthScoreTracker {
    const source = this.healthSource
    return typeof source === 'function' ? source() : source
  }

  /** The token balances this selector selects with; see `healthTracker`. */
  get tokenTracker(): TokenBucketTracker {
    const source = this.tokenSource
    return typeof source === 'function' ? source() : source
  }

  /**
   * The rows in pool order: the selector's own array, not a copy. Callers
   * must not change it; membership changes go through `replaceAccounts`
   * and `removeAccount`.
   */
  get rows(): readonly A[] {
    return this.accounts
  }

  /** Asks the sink to persist the pool soon (`SelectionSink.requestSave`). */
  requestSaveToDisk(): void {
    this.sink.requestSave?.()
  }

  /** Whether `row` is (by object identity) one of the pool's rows. */
  has(row: A): boolean {
    return this.accounts.includes(row)
  }

  // ========== Membership ==========

  /**
   * Installs the rows of an initial load, without matching them to earlier
   * rows, and sets each given family's selection and round-robin cursor to
   * the given index. The selector takes the array; each row's `index` must
   * be its position. For later changes use `replaceAccounts`.
   */
  resetAccounts(
    accounts: A[],
    selection?: Partial<Record<ModelFamily, number>>,
  ): void {
    this.accounts = accounts
    for (const family of FAMILIES) {
      const index = selection?.[family]
      if (index === undefined) continue
      this.currentAccountIndexByFamily[family] = index
      this.cursorByFamily[family] = index
    }
  }

  /**
   * Replaces the pool's rows with `next`, matched by `options.keyOf`, never
   * by position or by any credential.
   *
   * A row whose key is unchanged stays the same object, refreshed from its
   * fresh row (see `ReplaceAccountsOptions.refresh`), and keeps its session
   * pins, used marks, health and token entries, session request counts and
   * toast state at its new index. A row with a new key, a replaced
   * credential included, is a new member that inherits nothing, even at the
   * position its predecessor held. A row whose key is missing leaves: its
   * pins and marks are dropped, a pool-wide selection on it falls back to
   * `options.selectionFallback`, and any later transition about its object
   * is ignored rather than applied to the row now at its old index. A row
   * whose key is `undefined` is never matched. Round-robin cursors are
   * counters and are kept.
   */
  replaceAccounts(
    next: readonly A[],
    options: ReplaceAccountsOptions<A>,
  ): AccountsReplaced<A> {
    const fallback = options.selectionFallback
    return this.reconcile(
      next,
      options.keyOf,
      options.refresh ?? refreshSelectableRow,
      (family, _former, accounts) => fallback?.(family, accounts) ?? -1,
    )
  }

  /**
   * Removes one row. Rows after it move up one place, and their pins, used
   * marks, trackers and counts move with them; the removed row's are
   * dropped. A pool-wide selection on the removed row passes to the row
   * that takes its place, and round-robin cursors past it step back one,
   * as the pool-file manager always did. False when `row` is not loaded.
   */
  removeAccount(row: A): boolean {
    const removedIndex = this.accounts.indexOf(row)
    if (removedIndex < 0) {
      return false
    }
    const next = this.accounts.filter((account) => account !== row)
    this.reconcile(
      next,
      (account) => account,
      () => {},
      (_family, former, accounts) => (former < accounts.length ? former : -1),
    )
    if (next.length === 0) {
      this.cursorByFamily = { claude: 0, gemini: 0 }
      this.requestSessionStates.clear()
      return true
    }
    const shift = (cursor: number) =>
      (cursor > removedIndex ? cursor - 1 : cursor) % next.length
    for (const family of FAMILIES) {
      this.cursorByFamily[family] = shift(this.cursorByFamily[family])
      for (const state of this.requestSessionStates.values()) {
        state.cursorByFamily[family] = shift(state.cursorByFamily[family])
      }
    }
    return true
  }

  /**
   * The shared part of every membership change: matches `next` to the
   * current rows by key, then moves all index-keyed state to the kept rows'
   * new indexes and drops the state of rows that left. `fallback` gives the
   * pool-wide selection of a family whose selected row left.
   */
  private reconcile(
    next: readonly A[],
    keyOf: (row: A) => unknown,
    refresh: (prior: A, fresh: A) => void,
    fallback: (
      family: ModelFamily,
      former: number,
      accounts: readonly A[],
    ) => number,
  ): AccountsReplaced<A> {
    const previous = new Map<unknown, A>()
    for (const account of this.accounts) {
      const key = keyOf(account)
      if (key !== undefined) previous.set(key, account)
    }
    const accounts: A[] = []
    const moved = new Map<number, number>()
    const added: A[] = []
    for (const fresh of next) {
      const key = keyOf(fresh)
      const prior = key === undefined ? undefined : previous.get(key)
      if (prior === undefined) {
        fresh.index = accounts.length
        accounts.push(fresh)
        added.push(fresh)
        continue
      }
      previous.delete(key)
      moved.set(prior.index, accounts.length)
      if (prior !== fresh) refresh(prior, fresh)
      prior.index = accounts.length
      accounts.push(prior)
    }
    const kept = new Set(accounts)
    const removed = this.accounts.filter((account) => !kept.has(account))

    const remap = (index: number) => moved.get(index) ?? -1
    const remapSet = (indexes: Set<number>) =>
      new Set([...indexes].map(remap).filter((index) => index >= 0))
    this.accounts = accounts
    for (const family of FAMILIES) {
      const former = this.currentAccountIndexByFamily[family]
      const index = remap(former)
      this.currentAccountIndexByFamily[family] =
        index >= 0 || accounts.length === 0
          ? index
          : fallback(family, former, accounts)
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
    // A shared tracker is keyed by other pools' indexes too; only a tracker
    // this selector owns is moved.
    if (typeof this.healthSource !== 'function') {
      this.healthSource.reindex(moved)
    }
    if (typeof this.tokenSource !== 'function') {
      this.tokenSource.reindex(moved)
    }
    return { added, removed }
  }

  /**
   * Whether `row` is still loaded. A transition about a row that left is
   * reported as ignored and must not be applied through its old index,
   * which may now name another row.
   */
  private isLoaded(row: A, label: string): boolean {
    if (this.accounts.includes(row)) return true
    if (this.sink.stale !== undefined) {
      this.sink.stale(row, label)
    } else {
      this.onDiagnostic?.(
        `Account ${label} ignored: the account is no longer loaded`,
      )
    }
    return false
  }

  // ========== Selection ==========

  getAccountCount(): number {
    return this.getEnabledAccounts().length
  }

  getTotalAccountCount(): number {
    return this.accounts.length
  }

  getEnabledAccounts(): A[] {
    return this.accounts.filter((account) => account.enabled !== false)
  }

  getAccounts(): A[] {
    return [...this.accounts]
  }

  /**
   * Copies of the rows with their own rate-limit maps. A row type with
   * nested fields of its own (the local manager's credential parts) copies
   * those itself; this copies only what is on the row.
   */
  getAccountsSnapshot(): A[] {
    return this.accounts.map((a) => ({
      ...a,
      rateLimitResetTimes: { ...a.rateLimitResetTimes },
    }))
  }

  private getEffectiveSoftQuotaThreshold(thresholdPercent: number): number {
    // Soft-quota protection only has a purpose when another enabled account
    // exists to rotate to. Never block the sole usable account.
    return this.getEnabledAccounts().length > 1 ? thresholdPercent : 100
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

  /** Sets the pool-wide selection of a family; a change is reported. */
  private setGlobalActiveIndex(family: ModelFamily, index: number): void {
    if (this.currentAccountIndexByFamily[family] === index) return
    this.currentAccountIndexByFamily[family] = index
    this.sink.selection?.(family, this.accounts[index] ?? null)
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
    accounts: A[],
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): A[] {
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
  ): A | null {
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
    account: A,
    reason: LastSwitchReason,
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): void {
    account.lastSwitchReason = reason
    // An account that left the pool no longer has a position here; its
    // old index may name another account now.
    if (!this.isLoaded(account, 'switch')) {
      return
    }
    this.sink.switched?.(account, reason)
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
  ): A | null {
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
  ): A | null {
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
    account: A,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = 'antigravity',
    model?: string | null,
  ): void {
    const key = getQuotaKey(family, headerStyle, model)
    this.setRateLimit(account, key, this.now() + retryAfterMs)
  }

  private setRateLimit(account: A, key: QuotaKey, resetAt: number): void {
    account.rateLimitResetTimes[key] = resetAt
    const report = this.sink.rateLimit
    if (report !== undefined && this.isLoaded(account, 'state change')) {
      report.call(this.sink, account, key, resetAt)
    }
  }

  private clearRateLimit(account: A, key: QuotaKey): void {
    delete account.rateLimitResetTimes[key]
    const report = this.sink.rateLimit
    if (report !== undefined && this.isLoaded(account, 'state change')) {
      report.call(this.sink, account, key, 'clear')
    }
  }

  private touchLastUsed(account: A): void {
    const now = this.now()
    account.lastUsed = now
    const report = this.sink.lastUsed
    if (report !== undefined && this.isLoaded(account, 'state change')) {
      report.call(this.sink, account, now)
    }
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
  ): A | null {
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
    account: A,
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

  markRequestSuccess(account: A): void {
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
    account: A,
    cooldownMs: number,
    reason: CooldownReason,
  ): void {
    const until = this.now() + cooldownMs
    account.coolingDownUntil = until
    account.cooldownReason = reason
    const report = this.sink.cooldown
    if (report !== undefined && this.isLoaded(account, 'state change')) {
      report.call(this.sink, account, { until, reason })
    }
  }

  isAccountCoolingDown(account: A): boolean {
    if (account.coolingDownUntil === undefined) {
      return false
    }
    if (this.now() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account)
      return false
    }
    return true
  }

  clearAccountCooldown(account: A): void {
    const hadCooldown =
      account.coolingDownUntil !== undefined ||
      account.cooldownReason !== undefined
    delete account.coolingDownUntil
    delete account.cooldownReason
    const report = this.sink.cooldown
    if (
      hadCooldown &&
      report !== undefined &&
      this.isLoaded(account, 'state change')
    ) {
      report.call(this.sink, account, null)
    }
  }

  getAccountCooldownReason(account: A): CooldownReason | undefined {
    return this.isAccountCoolingDown(account)
      ? account.cooldownReason
      : undefined
  }

  markTouchedForQuota(account: A, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = this.now()
  }

  isFreshForQuota(account: A, quotaKey: string): boolean {
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
  ): A[] {
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
    account: A,
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
    account: A,
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
    this.sink.enabled?.(account, enabled)

    this.sink.requestSave?.()
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

  /**
   * Sets `row`'s enabled flag without reporting it, as when its store
   * already changed the flag, and moves a selection off it when it is
   * disabled. A row that left the pool changes only its own flag, never the
   * row now at its old index.
   */
  setEnabledInMemory(row: A, enabled: boolean): void {
    if (this.accounts.includes(row)) {
      this.applyEnabled(row.index, enabled)
    } else {
      row.enabled = enabled
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
    this.sink.accessVerdict?.(account, {
      kind: 'verification-required',
      observedAt: timestamp,
      ...(account.verificationRequiredReason !== undefined
        ? { reason: account.verificationRequiredReason }
        : {}),
      ...(normalizedVerifyUrl ? { verificationUrl: normalizedVerifyUrl } : {}),
    })
    this.sink.requestSave?.()

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
    this.sink.accessVerdict?.(account, {
      kind: 'ineligible',
      observedAt: timestamp,
      reason: account.accountIneligibleReason,
    })
    this.sink.requestSave?.()
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
      this.sink.accessVerdict?.(account, {
        kind: 'cleared',
        observedAt,
        enable: enableAccount,
      })
      this.sink.requestSave?.()
    }
    return true
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
    this.sink.fingerprint?.(account)
    this.sink.requestSave?.()

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

    this.sink.fingerprint?.(account)
    this.sink.requestSave?.()

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
    this.sink.usage?.(account, family, account.lastUsed)

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
    account: A,
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
