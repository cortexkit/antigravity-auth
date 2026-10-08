/**
 * Proactive Token Refresh Queue
 *
 * Ported from LLM-API-Key-Proxy's BackgroundRefresher.
 *
 * This module provides background token refresh to ensure OAuth tokens
 * remain valid without blocking user requests. It periodically checks
 * all accounts and refreshes tokens that are approaching expiry.
 *
 * Features:
 * - Non-blocking background refresh (doesn't block requests)
 * - Configurable refresh buffer (default: 30 minutes before expiry)
 * - Configurable check interval (default: 5 minutes)
 * - Serialized refresh to prevent concurrent refresh storms
 * - Integrates with existing AccountManager and token refresh logic
 * - Silent operation: no console output, uses structured logger
 */

import type { AccountManager, ManagedAccount } from './accounts'
import { createLogger, type Logger } from './logger'
import { refreshAccessToken } from './token'
import type { OAuthAuthDetails, PluginClient } from './types'

const log = createLogger('refresh-queue')

/**
 * The account-manager methods the queue uses. Narrower than the concrete
 * class so a location can hand in its own account view.
 */
export type RefreshQueueAccountView = Pick<
  AccountManager,
  'getAccounts' | 'toAuthDetails' | 'updateFromAuth' | 'saveToDisk'
>

/** Refreshes one account's OAuth token; resolves `undefined` when it cannot. */
export type RefreshQueueTokenRefresher = (
  auth: OAuthAuthDetails,
  account: ManagedAccount,
) => Promise<OAuthAuthDetails | undefined>

/**
 * Per-location collaborators. A location passes its own logger and token
 * refresher, so the queue never logs through the module logger or refreshes
 * through the OpenCode 1 host client (`PluginClient`).
 */
export interface ProactiveRefreshDependencies {
  logger: Logger
  refreshToken: RefreshQueueTokenRefresher
}

/** Configuration for the proactive refresh queue */
export interface ProactiveRefreshConfig {
  /** Enable proactive token refresh (default: true) */
  enabled: boolean
  /** Seconds before expiry to trigger proactive refresh (default: 1800 = 30 minutes) */
  bufferSeconds: number
  /** Interval between refresh checks in seconds (default: 300 = 5 minutes) */
  checkIntervalSeconds: number
}

export const DEFAULT_PROACTIVE_REFRESH_CONFIG: ProactiveRefreshConfig = {
  enabled: true,
  bufferSeconds: 1800, // 30 minutes
  checkIntervalSeconds: 300, // 5 minutes
}

/** State for tracking refresh operations */
interface RefreshQueueState {
  isRunning: boolean
  intervalHandle: ReturnType<typeof setInterval> | null
  initialTimeoutHandle: ReturnType<typeof setTimeout> | null
  isRefreshing: boolean
  lastCheckTime: number
  lastRefreshTime: number
  refreshCount: number
  errorCount: number
}

/**
 * Proactive Token Refresh Queue
 *
 * Runs in the background and proactively refreshes tokens before they expire.
 * This ensures that user requests never block on token refresh.
 *
 * All logging is silent by default - uses structured logger with TUI integration.
 */
export class ProactiveRefreshQueue {
  private readonly config: ProactiveRefreshConfig
  private readonly log: Logger
  private readonly refresh: RefreshQueueTokenRefresher
  private accountManager: RefreshQueueAccountView | null = null
  private inflightRefresh: Promise<void> | null = null

  private state: RefreshQueueState = {
    isRunning: false,
    intervalHandle: null,
    initialTimeoutHandle: null,
    isRefreshing: false,
    lastCheckTime: 0,
    lastRefreshTime: 0,
    refreshCount: 0,
    errorCount: 0,
  }

  /**
   * `client` and `providerId` bind the OpenCode 1 token refresh. When
   * `dependencies` is given, its logger and refresher are used instead and
   * the client is never called.
   */
  constructor(
    client: PluginClient | null,
    providerId: string,
    config?: Partial<ProactiveRefreshConfig>,
    dependencies?: ProactiveRefreshDependencies,
  ) {
    if (dependencies) {
      this.log = dependencies.logger
      this.refresh = dependencies.refreshToken
    } else {
      if (!client) {
        throw new TypeError(
          'ProactiveRefreshQueue needs a host client or explicit dependencies',
        )
      }
      this.log = log
      this.refresh = (auth) => refreshAccessToken(auth, client, providerId)
    }
    this.config = {
      ...DEFAULT_PROACTIVE_REFRESH_CONFIG,
      ...config,
    }
  }

  /**
   * Set the account manager to use for refresh operations.
   * Must be called before start().
   */
  setAccountManager(manager: RefreshQueueAccountView): void {
    this.accountManager = manager
  }

  /**
   * Check if a token needs proactive refresh.
   * Returns true if the token expires within the buffer period.
   */
  needsRefresh(account: ManagedAccount): boolean {
    if (!account.expires) {
      // No expiry set - assume it's fine
      return false
    }

    const now = Date.now()
    const bufferMs = this.config.bufferSeconds * 1000
    const refreshThreshold = now + bufferMs

    return account.expires <= refreshThreshold
  }

  /**
   * Check if a token is already expired.
   */
  isExpired(account: ManagedAccount): boolean {
    if (!account.expires) {
      return false
    }
    return account.expires <= Date.now()
  }

  /**
   * Get all accounts that need proactive refresh.
   */
  getAccountsNeedingRefresh(): ManagedAccount[] {
    if (!this.accountManager) {
      return []
    }

    return this.accountManager.getAccounts().filter((account) => {
      // Skip disabled accounts - they shouldn't receive proactive refresh
      if (account.enabled === false) {
        return false
      }
      // Only refresh if not already expired (let the main flow handle expired tokens)
      if (this.isExpired(account)) {
        return false
      }
      return this.needsRefresh(account)
    })
  }

  /**
   * Perform a single refresh check iteration.
   * This is called periodically by the background interval.
   */
  private runRefreshCheck(): Promise<void> {
    if (this.inflightRefresh) {
      return this.inflightRefresh
    }

    this.inflightRefresh = this.performRefreshCheck().finally(() => {
      this.inflightRefresh = null
    })
    return this.inflightRefresh
  }

  private async performRefreshCheck(): Promise<void> {
    if (this.state.isRefreshing) {
      // Already refreshing - skip this iteration
      return
    }

    if (!this.accountManager) {
      return
    }

    this.state.isRefreshing = true
    this.state.lastCheckTime = Date.now()

    try {
      const accountsToRefresh = this.getAccountsNeedingRefresh()

      if (accountsToRefresh.length === 0) {
        return
      }

      this.log.debug('Found accounts needing refresh', {
        count: accountsToRefresh.length,
      })

      // Refresh accounts serially to avoid concurrent refresh storms
      for (const account of accountsToRefresh) {
        if (!this.state.isRunning) {
          // Queue was stopped - abort
          break
        }

        try {
          const auth = this.accountManager.toAuthDetails(account)
          const refreshed = await this.refreshToken(auth, account)

          if (refreshed) {
            this.accountManager.updateFromAuth(account, refreshed)
            this.state.refreshCount++
            this.state.lastRefreshTime = Date.now()

            // Persist the refreshed token
            try {
              await this.accountManager.saveToDisk()
            } catch {
              // Non-fatal - token is refreshed in memory
            }
          }
        } catch (error) {
          this.state.errorCount++
          // Log but don't throw - continue with other accounts
          this.log.warn('Failed to refresh account', {
            accountIndex: account.index,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.state.isRefreshing = false
    }
  }

  /**
   * Refresh a single token.
   */
  private async refreshToken(
    auth: OAuthAuthDetails,
    account: ManagedAccount,
  ): Promise<OAuthAuthDetails | undefined> {
    const minutesUntilExpiry = account.expires
      ? Math.round((account.expires - Date.now()) / 60000)
      : 'unknown'

    this.log.debug('Proactively refreshing token', {
      accountIndex: account.index,
      email: account.email ?? 'unknown',
      minutesUntilExpiry,
    })

    return this.refresh(auth, account)
  }

  /**
   * Start the background refresh queue.
   */
  start(): void {
    if (this.state.isRunning) {
      return
    }

    if (!this.config.enabled) {
      this.log.debug('Proactive refresh disabled by config')
      return
    }

    this.state.isRunning = true
    const intervalMs = this.config.checkIntervalSeconds * 1000

    this.log.debug('Started proactive refresh queue', {
      checkIntervalSeconds: this.config.checkIntervalSeconds,
      bufferSeconds: this.config.bufferSeconds,
    })

    // Run initial check after a short delay (let things settle)
    this.state.initialTimeoutHandle = setTimeout(() => {
      this.state.initialTimeoutHandle = null
      if (this.state.isRunning) {
        this.runRefreshCheck().catch((error) => {
          this.log.error('Initial check failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    }, 5000)

    // Set up periodic checks
    this.state.intervalHandle = setInterval(() => {
      this.runRefreshCheck().catch((error) => {
        this.log.error('Check failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, intervalMs)
  }

  /**
   * Stop the background refresh queue.
   */
  stop(): void {
    if (!this.state.isRunning) {
      return
    }

    this.state.isRunning = false

    if (this.state.intervalHandle) {
      clearInterval(this.state.intervalHandle)
      this.state.intervalHandle = null
    }
    if (this.state.initialTimeoutHandle) {
      clearTimeout(this.state.initialTimeoutHandle)
      this.state.initialTimeoutHandle = null
    }

    this.log.debug('Stopped proactive refresh queue', {
      refreshCount: this.state.refreshCount,
      errorCount: this.state.errorCount,
    })
  }

  async dispose(): Promise<void> {
    this.stop()
    await this.inflightRefresh
  }

  /**
   * Get current queue statistics.
   */
  getStats(): {
    isRunning: boolean
    isRefreshing: boolean
    lastCheckTime: number
    lastRefreshTime: number
    refreshCount: number
    errorCount: number
  } {
    return { ...this.state }
  }

  /**
   * Check if the queue is currently running.
   */
  isRunning(): boolean {
    return this.state.isRunning
  }
}

/**
 * Create a proactive refresh queue instance.
 */
export function createProactiveRefreshQueue(
  client: PluginClient,
  providerId: string,
  config?: Partial<ProactiveRefreshConfig>,
): ProactiveRefreshQueue {
  return new ProactiveRefreshQueue(client, providerId, config)
}

/**
 * Create one location's refresh queue. The location supplies its logger and
 * token refresher; nothing is read from the OpenCode 1 host client or the
 * module logger.
 */
export function createLocationProactiveRefreshQueue(
  dependencies: ProactiveRefreshDependencies,
  config?: Partial<ProactiveRefreshConfig>,
): ProactiveRefreshQueue {
  if (
    typeof dependencies?.logger?.debug !== 'function' ||
    typeof dependencies.refreshToken !== 'function'
  ) {
    throw new TypeError(
      'createLocationProactiveRefreshQueue requires a logger and refreshToken',
    )
  }
  // The provider id is only used by the host-client refresh path, which a
  // queue built with explicit dependencies never takes.
  return new ProactiveRefreshQueue(null, '', config, dependencies)
}
