import { randomUUID } from 'node:crypto'
import type { VaultProviderStateFile } from '@cortexkit/antigravity-auth-core'
import { acquireFencedFileLock } from '@cortexkit/antigravity-auth-core/file-lock'
import { ensureSidebarStateDir } from '../sidebar-state'
import {
  fetchVaultAccountQuota,
  type VaultQuotaCheckOptions,
  type VaultQuotaSource,
} from './quota'
import type { VaultAccountPool } from './shared/vault-request-credentials'
import {
  type VaultQuotaOutcome,
  type VaultQuotaReason,
  vaultQuotaErrorKind,
  vaultQuotaErrorReason,
} from './vault-quota-outcome'
import { checkAndPublishVaultQuota } from './vault-quota-refresh'
import { quotaReadingForVaultRoute } from './vault-sidebar-projection'

const POLL_FENCE_TTL_MS = 60_000
// One renewal window bounds a tick; the lease still renews until cancellation and commits have settled.
const TICK_DEADLINE_MS = POLL_FENCE_TTL_MS

export interface BackgroundVaultQuotaRefreshOptions {
  intervalMs: number
  sidebarStateFile: string
  readAuthority: () => Promise<'vault' | 'local' | 'unreadable'>
  currentVaultPool: () => Promise<{
    source: VaultQuotaSource
    pool: VaultAccountPool
  }>
  readProviderState: () => Promise<VaultProviderStateFile>
  publishSidebar: () => Promise<void>
  transport: NonNullable<VaultQuotaCheckOptions['transport']>
  logger: VaultQuotaCheckOptions['logger']
  now?: () => number
  random?: () => number
  acquireLock?: typeof acquireFencedFileLock
  onOutcome?: (
    level: 'debug' | 'info' | 'warn',
    outcome: VaultQuotaOutcome,
  ) => void
}

/** Vault-only quota producer. No local account, token refresh or repository is opened. */
export class BackgroundVaultQuotaRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private controller: AbortController | null = null
  private disposed = false
  private started = false
  private readonly now: () => number
  private readonly random: () => number
  private readonly acquireLock: typeof acquireFencedFileLock
  private intervalMs: number
  // The pending timer's start and how long past the interval it adds; null
  // while the first, randomly delayed tick or none is pending.
  private intervalWait: { from: number; extra: number } | null = null

  constructor(private readonly options: BackgroundVaultQuotaRefreshOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.acquireLock = options.acquireLock ?? acquireFencedFileLock
    this.intervalMs = options.intervalMs
  }

  /** The current wait between ticks. */
  get interval(): number {
    return this.intervalMs
  }

  /**
   * Change the wait between ticks. A wait already running is shortened or
   * lengthened to the new interval, counted from when it began, so a change
   * never adds a tick of its own beyond what the new interval allows.
   */
  setIntervalMs(intervalMs: number): void {
    if (intervalMs === this.intervalMs) return
    this.intervalMs = intervalMs
    const wait = this.intervalWait
    if (this.timer === null || wait === null) return
    clearTimeout(this.timer)
    this.timer = null
    this.intervalWait = null
    const remaining = wait.from + intervalMs + wait.extra - this.now()
    this.schedule(Math.max(0, remaining), wait)
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.schedule(Math.floor(this.random() * 30_000))
  }

  /** Custody notifications cancel admitted work as soon as authority changes. */
  abortTick(): void {
    this.controller?.abort()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.abortTick()
    await this.inFlight
  }

  private schedule(
    delay: number,
    intervalWait: { from: number; extra: number } | null = null,
  ): void {
    if (this.disposed || !this.started) return
    this.intervalWait = intervalWait
    this.timer = setTimeout(() => {
      this.timer = null
      this.intervalWait = null
      void this.tick()
    }, delay)
    this.timer.unref?.()
  }

  /** One serialized tick; also used by deterministic composition tests. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const controller = new AbortController()
    this.controller = controller
    let extraJitter = 0
    const startedAt = this.now()
    const outcome: VaultQuotaOutcome = {
      tick: randomUUID(),
      reason: 'authority',
      stage: 'authority',
      elapsedMs: 0,
      rows: 0,
      checked: 0,
      notChecked: 0,
      reasons: {},
    }
    const deadline = setTimeout(() => {
      outcome.reason = 'deadline'
      controller.abort(
        new DOMException('Vault quota tick deadline', 'TimeoutError'),
      )
    }, TICK_DEADLINE_MS)
    deadline.unref?.()
    this.inFlight = this.runTick(controller, outcome)
      .catch((error: unknown) => {
        // Filesystem, authority and transport errors fail closed until the next tick.
        if (outcome.reason !== 'deadline')
          outcome.reason = controller.signal.aborted
            ? outcome.reason === 'authority' || outcome.reason === 'lock-lost'
              ? outcome.reason
              : vaultQuotaErrorReason(controller.signal.reason, 'aborted')
            : vaultQuotaErrorReason(
                error,
                outcome.stage === 'publish'
                  ? 'publish-failed'
                  : outcome.stage === 'roster'
                    ? 'roster-unavailable'
                    : 'state-invalid',
              )
        outcome.errorKind = vaultQuotaErrorKind(error)
        extraJitter = 15_000
      })
      .finally(() => {
        clearTimeout(deadline)
        outcome.elapsedMs = Math.max(0, this.now() - startedAt)
        outcome.notChecked = outcome.rows - outcome.checked
        const level =
          outcome.reason === 'deadline' ||
          outcome.reasons['write-uncertain'] ||
          (outcome.rows > 0 &&
            outcome.checked === 0 &&
            outcome.reason !== 'fresh')
            ? 'warn'
            : outcome.reason === 'recorded'
              ? 'info'
              : 'debug'
        try {
          if (this.options.onOutcome) this.options.onOutcome(level, outcome)
          else this.options.logger.debug('vault-quota-tick', { ...outcome })
        } catch {
          // Diagnostics must not prevent releasing single-flight ownership or scheduling another tick.
        }
        this.inFlight = null
        this.controller = null
        const extra =
          Math.floor(this.random() * this.intervalMs * 0.1) + extraJitter
        this.schedule(this.intervalMs + extra, { from: this.now(), extra })
      })
    return this.inFlight
  }

  private async assertActive(controller: AbortController): Promise<void> {
    controller.signal.throwIfAborted()
    if (this.disposed) controller.abort()
    else if ((await this.options.readAuthority()) !== 'vault')
      controller.abort({ kind: 'not-active' })
    controller.signal.throwIfAborted()
  }

  private async runTick(
    controller: AbortController,
    outcome: VaultQuotaOutcome,
  ): Promise<void> {
    await this.assertActive(controller)
    ensureSidebarStateDir(this.options.sidebarStateFile)
    outcome.stage = 'lock'
    const lock = await this.acquireLock({
      path: this.options.sidebarStateFile,
      name: 'bg-vault-quota-poll',
      ttlMs: POLL_FENCE_TTL_MS,
      renew: true,
    })
    if (!lock) {
      outcome.reason = 'lock-busy'
      return
    }
    // Renewal lasts through quota commits and publication. Losing the fence cancels I/O.
    let released = false
    void lock.whenLost().then(() => {
      if (!released) {
        if (outcome.reason !== 'deadline') outcome.reason = 'lock-lost'
        controller.abort()
      }
    })
    try {
      await this.assertActive(controller)
      await lock.assertOwned()
      outcome.stage = 'roster'
      const { source, pool } = await this.options.currentVaultPool()
      await this.assertActive(controller)
      await pool.sync()
      await this.assertActive(controller)
      // Read durable observations inside the fence, including another process's
      // updates. Sidebar publication time must never postpone quota fetching.
      outcome.stage = 'state'
      const state = await this.options.readProviderState()
      await this.assertActive(controller)
      await lock.assertOwned()
      const threshold = Math.max(
        this.intervalMs - 60_000,
        Math.floor(this.intervalMs / 2),
      )
      const now = this.now()
      outcome.rows = pool.selector.rows.length
      if (outcome.rows === 0) {
        outcome.reason = 'no-rows'
        return
      }
      const due = pool.selector.rows.some((row) => {
        const quota = quotaReadingForVaultRoute(row.route, state)
        const at = quota?.cachedQuotaUpdatedAt
        return (
          quota?.cachedQuota == null ||
          typeof at !== 'number' ||
          !Number.isFinite(at) ||
          at < 0 ||
          now - at >= threshold
        )
      })
      if (!due) {
        outcome.reason = 'fresh'
        return
      }
      outcome.reason = 'fetch-failed'
      let rowFailure: VaultQuotaReason = 'fetch-failed'
      const report = await checkAndPublishVaultQuota(
        {
          pool,
          signal: controller.signal,
          now: this.now,
          onStage: (stage) => {
            outcome.stage = stage
          },
          onOutcome: (reason, error) => {
            if (error !== undefined)
              outcome.errorKind = vaultQuotaErrorKind(error)
            if (reason === 'fetch-failed') reason = rowFailure
            outcome.reasons[reason] = (outcome.reasons[reason] ?? 0) + 1
            if (reason === 'recorded') outcome.checked++
            if (outcome.reason !== 'deadline')
              outcome.reason = outcome.checked > 0 ? 'recorded' : reason
          },
          onError: (error) => {
            const reason = vaultQuotaErrorReason(
              error,
              outcome.stage === 'commit' ? 'state-invalid' : 'fetch-failed',
            )
            outcome.reasons[reason] = (outcome.reasons[reason] ?? 0) + 1
            if (outcome.reason !== 'deadline' && outcome.checked === 0)
              outcome.reason = reason
            outcome.errorKind = vaultQuotaErrorKind(error)
          },
          fetchReading: async (ref, signal) => {
            rowFailure = 'fetch-failed'
            await this.assertActive(controller)
            const fallback = () =>
              fetchVaultAccountQuota({
                source,
                ref,
                signal,
                logger: this.options.logger,
                onFailure: (error, refused) => {
                  const kind = vaultQuotaErrorKind(error)
                  if (kind !== 'unknown' || outcome.errorKind === undefined)
                    outcome.errorKind = kind
                  if (refused)
                    rowFailure = vaultQuotaErrorReason(
                      error,
                      'admission-refused',
                    )
                },
                transport: async (url, init, extra) => {
                  // Re-check just before every physical request, including retries/fallbacks.
                  await this.assertActive(controller)
                  await lock.assertOwned()
                  controller.signal.throwIfAborted()
                  outcome.endpoint = String(url).includes(
                    'retrieveUserQuotaSummary',
                  )
                    ? 'summary'
                    : 'models'
                  try {
                    const response = await this.options.transport(
                      url,
                      { ...init, signal: extra.signal ?? controller.signal },
                      extra,
                    )
                    outcome.status = response.status
                    return response
                  } catch (error) {
                    outcome.errorKind = vaultQuotaErrorKind(error)
                    throw error
                  }
                },
              })
            const reading = source.pollInsulaQuotaForRoute
              ? await source.pollInsulaQuotaForRoute(
                  ref,
                  fallback,
                  signal,
                  (reason) => {
                    rowFailure = `insula-${reason}`
                  },
                )
              : await fallback()
            if (reading === undefined && rowFailure === 'fetch-failed')
              rowFailure = 'insula-skipped'
            await this.assertActive(controller)
            await lock.assertOwned()
            return reading
          },
        },
        async () => {
          outcome.stage = 'publish'
          await this.assertActive(controller)
          await lock.assertOwned()
          await this.options.publishSidebar()
        },
      )
      outcome.checked = report.checked
    } finally {
      released = true
      await lock.release().catch(() => {})
    }
  }
}
