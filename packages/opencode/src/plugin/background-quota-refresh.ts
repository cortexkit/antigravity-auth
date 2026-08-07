/**
 * Background quota poller.
 *
 * Runs a jittered, `unref()`'d timer that periodically refreshes quota for
 * all accounts and pushes ONE sidebar snapshot per tick. Three-layer
 * cross-process dedup:
 *
 *   1. Freshness gate — the only hard correctness bound for quota snapshots.
 *      Reads `checkedAt` from the on-disk sidebar state; skips quota work when
 *      it is fresher than
 *      `max(intervalMs − 60_000, floor(intervalMs / 2))`. The /2 floor
 *      ensures the gate still fires at the 1-minute minimum interval.
 *
 *   2. Advisory fenced lock — an optimization that lets a single process do
 *      the network work when several wake up simultaneously. Held → skip.
 *
 *   3. Lock throws → FAIL CLOSED (skip this tick, add jitter to next). A
 *      fallback mutex is NOT used here. The correct reasoning is: the
 *      freshness gate (layer 1) already bounds how many refreshes can land;
 *      a secondary "claim marker" file is just a worse re-implementation of
 *      the fenced lock we just failed to acquire — it replicates the same
 *      ownership problem without the protocol guarantees, and any transient
 *      I/O error that made the lock throw will likely affect a claim file
 *      too. The previous poller attempt fell into this trap across three
 *      review rounds; this comment exists so a future reviewer stops
 *      re-litigating it.
 */

import { createHash } from 'node:crypto'
import type {
  AccountMetadataV3,
  QuotaGroup,
  QuotaGroupSummary,
} from '@cortexkit/antigravity-auth-core'
import {
  acquireFencedFileLock,
  type FencedFileLock,
} from '@cortexkit/antigravity-auth-core/file-lock'

import { readSidebarState, toCapturedTier } from '../sidebar-state'
import type { QuotaManager } from './quota'
import { pushSidebarQuotaSnapshot } from './quota'

/**
 * The subset of AccountManager that the poller needs. Using a narrow
 * interface keeps the module decoupled from the large concrete class and
 * lets tests pass minimal stubs without satisfying 90+ methods.
 */
export interface PollerAccountView {
  getAccounts(): Array<{
    index: number
    label?: string
    enabled?: boolean
    parts: { refreshToken: string }
    cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>
    cachedQuotaAccountId?: string
    coolingDownUntil?: number
    /** Captured plan tier ID (raw upstream string). */
    capturedTierId?: string
    /** Captured paid-tier ID (raw upstream string). */
    capturedPaidTierId?: string
    /** Epoch ms when capturedTierId was last recorded. */
    capturedTierAt?: number
    /** Schema version of the most recent tier capture. */
    capturedTierSchemaVersion?: number
  }>
  /** Must return the full AccountMetadataV3 shape so the quota manager
   *  can use token-refresh and project-context fields inside each fetch. */
  getAccountsForQuotaCheck(): AccountMetadataV3[]
  updateQuotaCache(
    accountIndex: number,
    quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>,
    expectedRefreshToken?: string,
  ): void
  /**
   * Apply a subset of quota-result fields (e.g. captured tier) onto the
   * in-memory account record without touching the quota cache itself.
   */
  applyUpdatedAccount(
    accountIndex: number,
    patch: {
      capturedTierId?: string
      capturedPaidTierId?: string
      capturedTierAt?: number
      capturedTierSchemaVersion?: number
    },
    expectedRefreshToken?: string,
  ): void
  requestSaveToDisk(): void
  /**
   * Returns the active account index per model family so the sidebar
   * snapshot can stamp the `current` flag on the right account.
   */
  getActiveIndexByFamily(): { claude: number; gemini: number }
}

/**
 * Opaque identity derived from a refresh token. Three callers keep
 * independent copies: this module, `command-data.ts` (ships into the TUI
 * compiled tree and cannot reach the core barrel), and `index.ts`. All
 * three must produce the same 16-char hex prefix.
 */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

/** Minimum poll interval (1 minute, matching the config schema min). */
const MIN_INTERVAL_MS = 60_000

/** Spread startup jitter so N processes don't all fire at once on launch. */
const STARTUP_JITTER_MS = 30_000

/** Additional jitter added to the next tick when the lock mechanism throws. */
const ERROR_JITTER_MS = 15_000

/** TTL for the renewable advisory poll lock. */
const POLL_LOCK_TTL_MS = 60_000

/** Maximum age of a captured tier before the poller refreshes it. 24 h. */
const TIER_STALENESS_TTL_MS = 24 * 60 * 60 * 1_000

/** A capture at this version distinguishes an absent paid tier from old data. */
const CAPTURED_TIER_SCHEMA_VERSION = 1

export interface BackgroundQuotaRefreshOptions {
  intervalMs: number
  sidebarStateFile: string
  /**
   * Supplier for the live account pool. Called inside each locked phase, so it
   * observes any concurrent add/remove that completed while waiting for the
   * lock.
   */
  getAccountManager: () => PollerAccountView | null
  quotaManager: QuotaManager
  /**
   * Optional tier-refresh callback. When provided, the poller calls this
   * once per tick for the account whose capturedTierAt is missing or older
   * than TIER_STALENESS_TTL_MS. The callback handles its own token-refresh
   * and must resolve to a tier object (or null on failure / nothing to
   * report) -- failure must never reject, since tier is best-effort.
   *
   * Wired in index.ts through the same agyTransport seam the quota manager
   * uses, so e2e tests can inject a mock alongside the mock quota fetch.
   */
  loadAccountTier?: (
    account: AccountMetadataV3,
  ) => Promise<{ id: string; paidId?: string; capturedAt: number } | null>
  /**
   * Clock / randomness seam. Defaults to the system clock.
   */
  now?: () => number
  random?: () => number
  /** Lock acquisition seam used by deterministic concurrency tests. */
  acquireLock?: typeof acquireFencedFileLock
}

/**
 * Per-loader-instance background quota poller.
 *
 * Must be created after the plugin has initialised (so `getAccountManager()`
 * is populated) and disposed via the producer lifecycle phase.
 */
export class BackgroundQuotaRefresh {
  private readonly intervalMs: number
  private readonly sidebarStateFile: string
  private readonly getAccountManager: () => PollerAccountView | null
  private readonly quotaManager: QuotaManager
  private readonly loadAccountTier?: (
    account: AccountMetadataV3,
  ) => Promise<{ id: string; paidId?: string; capturedAt: number } | null>
  private readonly now: () => number
  private readonly random: () => number
  private readonly acquireLock: typeof acquireFencedFileLock

  private timer: ReturnType<typeof setTimeout> | null = null
  /** Resolves when the currently-running tick completes (or immediately if none). */
  private inFlight: Promise<void> | null = null
  private disposed = false

  constructor(options: BackgroundQuotaRefreshOptions) {
    this.intervalMs = options.intervalMs
    this.sidebarStateFile = options.sidebarStateFile
    this.getAccountManager = options.getAccountManager
    this.quotaManager = options.quotaManager
    this.loadAccountTier = options.loadAccountTier
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.acquireLock = options.acquireLock ?? acquireFencedFileLock
  }

  /** Start the background timer. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.disposed || this.timer !== null) return
    this.scheduleNext(this.jitteredStartDelay())
  }

  /** Stop the timer and await any in-flight tick. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.inFlight
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private jitteredStartDelay(): number {
    return Math.floor(this.random() * STARTUP_JITTER_MS)
  }

  private jitteredInterval(extraJitterMs = 0): number {
    // ±10% on top of the base interval prevents phase-locking across restarts.
    const jitter = Math.floor(this.random() * this.intervalMs * 0.1)
    return this.intervalMs + jitter + extraJitterMs
  }

  private scheduleNext(delayMs: number): void {
    if (this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      // Re-entry guard: if the previous tick is still in flight (refresh
      // duration > interval), skip this timer callback. The in-flight tick
      // calls scheduleNext itself when it completes, so the poller continues.
      // Without this guard, assigning this.inFlight here would overwrite the
      // first tick's promise and dispose() would await the wrong one.
      if (this.inFlight !== null) return
      this.inFlight = this.runTick()
        .catch(() => {
          // Errors inside runTick are already caught per-phase. An unexpected
          // throw here (before any internal reschedule) means no next tick
          // was queued — reschedule with error jitter so the poller degrades
          // to a delayed tick rather than dying permanently.
          this.scheduleNext(this.jitteredInterval(ERROR_JITTER_MS))
        })
        .finally(() => {
          this.inFlight = null
        })
    }, delayMs)
    // Unreffing lets the process exit while the timer is pending — the poller
    // must never be the reason an idle session stays alive.
    if (this.timer.unref) this.timer.unref()
  }

  private async runTick(): Promise<void> {
    // ── 1. Quota freshness gate ──────────────────────────────────────────
    //
    // Bound: `max(intervalMs − 60_000, floor(intervalMs / 2))`.
    //
    // - intervalMs − 60_000: at 5-minute intervals this is 240 s — tight
    //   enough to prevent double refreshes while allowing drift.
    // - floor(intervalMs / 2): the fallback that keeps the gate non-trivial
    //   at the 1-minute minimum (floor(60000/2) = 30 000 ms, i.e. 30 s).
    const freshnessThresholdMs = Math.max(
      this.intervalMs - MIN_INTERVAL_MS,
      Math.floor(this.intervalMs / 2),
    )
    const state = readSidebarState(this.sidebarStateFile)
    const ageMs = this.now() - state.checkedAt

    // ── 2. Advisory fenced lock ──────────────────────────────────────────
    let lock: FencedFileLock | null = null
    try {
      lock = await this.acquireLock({
        path: this.sidebarStateFile,
        name: 'bg-quota-poll',
        ttlMs: POLL_LOCK_TTL_MS,
      })
    } catch {
      // Lock mechanism threw (I/O error, filesystem issue). FAIL CLOSED:
      // skip this tick. See module-level invariant comment for why we do not
      // invent a fallback mutex here.
      this.scheduleNext(this.jitteredInterval(ERROR_JITTER_MS))
      return
    }

    if (lock === null) {
      // Another process holds the lock — its tier phase owns this tick's
      // metadata work as well as any quota snapshot write.
      this.scheduleNext(this.jitteredInterval())
      return
    }

    try {
      if (ageMs >= freshnessThresholdMs) await this.refresh()
      else await this.refreshTierSlot()
    } finally {
      await lock.release().catch(() => {
        // Release is best-effort; the TTL expires it if we can't reach it.
      })
    }

    if (!this.disposed) {
      this.scheduleNext(this.jitteredInterval())
    }
  }

  private async refresh(): Promise<void> {
    const refreshedQuota = await this.refreshQuota()
    await this.refreshTierSlot()
    if (refreshedQuota) await this.pushSnapshot()
  }

  private async refreshQuota(): Promise<boolean> {
    if (this.disposed) return false

    const manager = this.getAccountManager()
    if (!manager) return false

    const accounts = manager.getAccountsForQuotaCheck()
    if (accounts.length === 0) return false

    // Refresh all accounts, then stamp the live manager once per result.
    // Using the shared quotaManager deduplicates in-flight refreshes with
    // any concurrent modal or fetch-interceptor refresh.
    let results: Awaited<ReturnType<typeof this.quotaManager.refreshAccounts>>
    try {
      results = await this.quotaManager.refreshAccounts(accounts, {
        indexFor: (account) => accounts.indexOf(account),
        // Do not force: the quota manager's per-account dedup and backoff
        // apply — an account that already refreshed recently is skipped.
        force: false,
      })
    } catch {
      return false
    }

    if (this.disposed) return false

    // Re-resolve live indices after the await: a concurrent add/remove may
    // have shifted positions.
    const liveAccounts = manager.getAccounts()
    const liveIndexByToken = new Map<string, number>()
    for (const entry of liveAccounts) {
      liveIndexByToken.set(entry.parts.refreshToken, entry.index)
    }

    let anyUpdated = false
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result?.status !== 'ok' || !result.quota?.groups) continue
      const candidateTokens = [
        result.updatedAccount?.refreshToken,
        accounts[i]?.refreshToken,
      ].filter((token): token is string => Boolean(token))
      const liveIndex = candidateTokens
        .map((token) => liveIndexByToken.get(token))
        .find((index): index is number => index !== undefined)
      if (liveIndex === undefined) continue
      const liveToken = liveAccounts[liveIndex]?.parts.refreshToken
      if (!liveToken) continue
      manager.updateQuotaCache(liveIndex, result.quota.groups, liveToken)
      // Persist tier captured during ensureProjectContext (same tick, no extra
      // network call) so the sidebar snapshot carries it after every poll.
      const uaTier = toCapturedTier(result.updatedAccount ?? {})
      if (uaTier !== undefined) {
        manager.applyUpdatedAccount(
          liveIndex,
          {
            capturedTierId: uaTier.id,
            ...(uaTier.paidId !== undefined
              ? { capturedPaidTierId: uaTier.paidId }
              : {}),
            capturedTierAt: uaTier.capturedAt,
            capturedTierSchemaVersion: CAPTURED_TIER_SCHEMA_VERSION,
          },
          liveToken,
        )
      }
      anyUpdated = true
    }
    if (anyUpdated) manager.requestSaveToDisk()

    return true
  }

  private async refreshTierSlot(): Promise<void> {
    if (this.disposed || !this.loadAccountTier) return

    const manager = this.getAccountManager()
    if (!manager) return

    const liveAccounts = manager.getAccounts()
    const accounts = manager.getAccountsForQuotaCheck()
    const accountByToken = new Map(
      accounts.map((account) => [account.refreshToken, account]),
    )
    const now = this.now()
    let stalestEntry: (typeof liveAccounts)[number] | undefined
    for (const entry of liveAccounts) {
      const needsPaidTierBackfill =
        entry.capturedPaidTierId === undefined &&
        entry.capturedTierSchemaVersion !== CAPTURED_TIER_SCHEMA_VERSION
      const isTierStale =
        entry.capturedTierAt === undefined ||
        now - entry.capturedTierAt >= TIER_STALENESS_TTL_MS ||
        needsPaidTierBackfill
      if (
        isTierStale &&
        (stalestEntry === undefined ||
          (entry.capturedTierAt ?? 0) < (stalestEntry.capturedTierAt ?? 0))
      ) {
        stalestEntry = entry
      }
    }

    if (stalestEntry === undefined) return

    const refreshToken = stalestEntry.parts.refreshToken
    const accountForTier = accountByToken.get(refreshToken)
    if (!accountForTier) return

    try {
      const tier = await this.loadAccountTier(accountForTier)
      if (tier === null || this.disposed) return
      const liveEntry = manager
        .getAccounts()
        .find((entry) => entry.parts.refreshToken === refreshToken)
      if (!liveEntry) return
      manager.applyUpdatedAccount(
        liveEntry.index,
        {
          capturedTierId: tier.id,
          ...(tier.paidId !== undefined
            ? { capturedPaidTierId: tier.paidId }
            : {}),
          capturedTierAt: tier.capturedAt,
          capturedTierSchemaVersion: CAPTURED_TIER_SCHEMA_VERSION,
        },
        refreshToken,
      )
      manager.requestSaveToDisk()
    } catch {
      // Tier is best-effort; a failure must never break the tick.
    }
  }

  private async pushSnapshot(): Promise<void> {
    // ONE sidebar write per poll. `pushSidebarQuotaSnapshot` reads the live
    // account view (with the just-updated cached values) and writes atomically.
    const getAccounts = () => {
      const m = this.getAccountManager()
      return m ? m.getAccounts() : null
    }

    await pushSidebarQuotaSnapshot(
      () => {
        const accts = getAccounts()
        if (!accts) return null
        return accts.map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          // Derive current identity from the LIVE refresh token, independent
          // of whatever stamp the cached snapshot carries. Mirrors index.ts's
          // two correct call sites so the sidebar can detect a stale snapshot
          // after an account reorder.
          currentQuotaAccountId: quotaAccountIdentity(entry.parts.refreshToken),
          tier: toCapturedTier(entry),
        }))
      },
      0,
      () => {
        const m = this.getAccountManager()
        return m ? m.getActiveIndexByFamily() : null
      },
    ).catch(() => {
      // Sidebar write failure is not fatal; the next tick will retry.
    })
  }
}
