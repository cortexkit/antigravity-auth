/**
 * One server location's runtime. A location is one workspace directory the
 * host serves; on OpenCode 2 (the 2.x host line) one process can serve
 * several, and each plugin setup there (an activation) gets its own
 * runtime. This module builds the activation's services in order, tears them
 * down in a fixed order and rolls everything back if construction fails.
 *
 * Every service here is created for this location alone: logger,
 * configuration (its own clone of the defaults), debug file, the switch for
 * dumping Gemini requests to disk, operator settings handle, signature-cache
 * handle, quota manager, background quota poller and the queue that
 * refreshes OAuth tokens before they expire. Nothing falls back to the
 * module-level logger, configuration, health tracker or sidebar file that
 * the OpenCode 1 plugin (one location per process) uses, and no credential
 * cache is shared between locations. Disposing one location's runtime never
 * stops another's.
 *
 * Process-shared state stays shared on purpose and is reached only through
 * per-location handles: operator files have one controller per file
 * (`acquireLocationOperatorSettings`), the signature disk cache has one
 * writer per file (`acquireLocationSignatureCache`), and background pollers
 * in different processes coordinate through the sidebar file: a poll is
 * skipped while the file's `checkedAt` is recent, and a lock file beside it
 * lets only one process poll at a time.
 *
 * Teardown order:
 *   1. producers (everything that can still queue sidebar writes) are
 *      stopped and awaited, newest first: the refresh queue, the background
 *      poller and the quota manager, plus anything the host binding adds
 *      (request bridge, RPC handlers);
 *   2. queued sidebar writes drain;
 *   3. consumers close, newest first: signature handle, operator settings,
 *      debug file.
 * Stopping producers before the drain means no write can be queued after
 * the drain has finished; consumers stay open until the last write lands.
 *
 * The functions that use credentials (quota fetch, tier lookup, token
 * refresh) and the account view come from the location's account service.
 * This module never reads account storage or builds a host client.
 */

import type {
  AccountMetadataV3,
  FetchAccountQuota,
} from '@cortexkit/antigravity-auth-core'
import type { acquireFencedFileLock } from '@cortexkit/antigravity-auth-core/file-lock'

import { drainSidebarWrites, toCapturedTier } from '../../sidebar-state.ts'
import {
  BackgroundQuotaRefresh,
  type PollerAccountView,
} from '../background-quota-refresh.ts'
import {
  acquireLocationSignatureCache,
  type LocationSignatureCache,
  type SignatureProcessState,
} from '../cache.ts'
import { createLocationConfig, type LocationConfig } from '../config/index.ts'
import { createLocationDebug, type LocationDebug } from '../debug.ts'
import { createGeminiDumpState, type GeminiDumpState } from '../gemini-dump.ts'
import { createLocationLogger, type LocationLogger } from '../logger.ts'
import type { LocationLogSink } from '../neutral-types.ts'
import {
  acquireLocationOperatorSettings,
  type LocationOperatorSettings,
  type OperatorSettingsRegistry,
} from '../operator-settings.ts'
import {
  createLocationQuotaManager,
  type QuotaManager,
  type SidebarQuotaAccount,
} from '../quota.ts'
import {
  createLocationProactiveRefreshQueue,
  type ProactiveRefreshQueue,
  type RefreshQueueAccountView,
  type RefreshQueueTokenRefresher,
} from '../refresh-queue.ts'

// Ordered resource scope

/** Producers stop before drains; consumers close after drains. */
export type RuntimePhase = 'producer' | 'consumer'

export interface RuntimeResource {
  dispose(): Promise<void> | void
}

/**
 * Resources acquired by one activation, released exactly once in phase
 * order. A resource added after disposal started is disposed at once, so a
 * slow acquisition that finishes late cannot outlive its activation.
 */
export interface RuntimeScope {
  add(resource: RuntimeResource, phase: RuntimePhase): void
  /** A step run after every producer stopped and before any consumer. */
  addDrain(drain: () => Promise<void>): void
  readonly disposed: boolean
  /**
   * Release everything. Idempotent: later calls return the first call's
   * promise. Every step runs even when an earlier one fails; failures are
   * reported together afterwards as an `AggregateError`.
   */
  dispose(): Promise<void>
}

export function createRuntimeScope(): RuntimeScope {
  const producers: RuntimeResource[] = []
  const consumers: RuntimeResource[] = []
  const drains: Array<() => Promise<void>> = []
  let disposal: Promise<void> | null = null
  const lateDisposals = new Set<Promise<void>>()

  const run = async (
    step: () => Promise<void> | void,
    errors: unknown[],
  ): Promise<void> => {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }

  return {
    add(resource, phase) {
      if (disposal) {
        const late = Promise.resolve()
          .then(() => resource.dispose())
          .catch(() => {
            // The scope already reported its result; a late resource's
            // failure has no caller left to receive it.
          })
        lateDisposals.add(late)
        void late.finally(() => lateDisposals.delete(late))
        return
      }
      ;(phase === 'producer' ? producers : consumers).push(resource)
    },
    addDrain(drain) {
      if (disposal) return
      drains.push(drain)
    },
    get disposed() {
      return disposal !== null
    },
    dispose() {
      if (!disposal) {
        disposal = (async () => {
          const errors: unknown[] = []
          for (const resource of producers.splice(0).reverse()) {
            await run(() => resource.dispose(), errors)
          }
          for (const drain of drains.splice(0)) {
            await run(drain, errors)
          }
          for (const resource of consumers.splice(0).reverse()) {
            await run(() => resource.dispose(), errors)
          }
          await Promise.allSettled([...lateDisposals])
          if (errors.length > 0) {
            throw new AggregateError(errors, 'Location runtime disposal failed')
          }
        })()
      }
      return disposal
    },
  }
}

// Location runtime

/**
 * The live account pool as the runtime's services use it: the background
 * poller's view plus the refresh queue's view. The core `AccountManager`
 * satisfies both.
 */
export type LocationAccountView = PollerAccountView & RefreshQueueAccountView

export interface LocationRuntimeOptions {
  /** The host-owned location directory; never a caller-supplied path. */
  directory: string
  /**
   * Host destination for this location's log records. Without one, records
   * reach only the environment-gated console fallback.
   */
  logSink?: LocationLogSink
  /** The sidebar state file for this location directory. */
  sidebarStateFile: string
  /** Fetches one account's model quota with the location's credentials. */
  fetchAccountQuota: FetchAccountQuota
  /**
   * Refreshes one account's OAuth token. The refresh queue calls it for
   * tokens close to expiry, so requests rarely wait on a refresh.
   */
  refreshToken: RefreshQueueTokenRefresher
  /**
   * Best-effort plan tier lookup. The background poller refreshes quota for
   * all accounts on a timer and also records each account's plan tier for
   * the sidebar.
   */
  loadAccountTier?: (
    account: AccountMetadataV3,
  ) => Promise<{ id: string; paidId?: string; capturedAt: number } | null>
  /**
   * Health score (0–100, how reliably the account has answered recently) per
   * account index, from this location's account rotation. Without one,
   * sidebar snapshots carry no score.
   */
  healthScore?: (index: number) => number
  /**
   * Derives a short hash from an account's refresh token. Each cached quota
   * entry is stamped with it, so a cached reading is dropped when a
   * different account now sits at the same position.
   */
  quotaAccountIdentity?: (refreshToken: string) => string
  /**
   * Table of operator-settings file controllers. Defaults to the one the
   * whole process shares; tests pass an isolated one.
   */
  operatorSettingsRegistry?: OperatorSettingsRegistry
  /**
   * Thinking-signature cache state. Defaults to the one the whole process
   * shares; tests pass an isolated one.
   */
  signatureState?: SignatureProcessState
  /** Clock and randomness for the poller; defaults to the system's. */
  now?: () => number
  random?: () => number
  /** Replaces the poller's lock acquisition so tests are deterministic. */
  acquireLock?: typeof acquireFencedFileLock
}

export interface LocationRuntime {
  readonly directory: string
  readonly logger: LocationLogger
  readonly config: LocationConfig
  readonly debug: LocationDebug
  readonly dump: GeminiDumpState
  readonly operatorSettings: LocationOperatorSettings
  readonly signatures: LocationSignatureCache
  readonly quotaManager: QuotaManager
  /** `null` when the `background_quota_refresh` config option is off. */
  readonly backgroundQuotaRefresh: BackgroundQuotaRefresh | null
  /**
   * The current token refresh queue, or `null` when no account view is
   * bound or the `proactive_token_refresh` config option is off.
   */
  refreshQueue(): ProactiveRefreshQueue | null
  /** The location's current account view, or `null` before one is bound. */
  accounts(): LocationAccountView | null
  /**
   * Replace the location's account view. The previous refresh queue is
   * stopped and awaited before a new one starts for the new view. After
   * disposal the call does nothing.
   */
  replaceAccounts(view: LocationAccountView | null): Promise<void>
  /** Apply the operator-configured log level to this location's logger. */
  applyOperatorSettings(): void
  /**
   * The host binding registers its own resources here, as producers or
   * consumers, so one dispose tears everything down in order.
   */
  readonly scope: RuntimeScope
  dispose(): Promise<void>
}

/**
 * Build one location's runtime. If any step throws, everything acquired so
 * far is released before the error is rethrown, so a failed activation
 * leaves no timer, file handle or shared-controller reference behind.
 */
export async function createLocationRuntime(
  options: LocationRuntimeOptions,
): Promise<LocationRuntime> {
  const scope = createRuntimeScope()
  try {
    return await buildLocationRuntime(options, scope)
  } catch (error) {
    await scope.dispose().catch(() => {
      // The construction error is the one the caller needs; disposal
      // failures during rollback cannot replace it.
    })
    throw error
  }
}

async function buildLocationRuntime(
  options: LocationRuntimeOptions,
  scope: RuntimeScope,
): Promise<LocationRuntime> {
  if (typeof options?.directory !== 'string' || options.directory === '') {
    throw new TypeError('createLocationRuntime requires the location directory')
  }
  if (
    typeof options.sidebarStateFile !== 'string' ||
    options.sidebarStateFile === ''
  ) {
    throw new TypeError('createLocationRuntime requires a sidebar state file')
  }
  if (typeof options.refreshToken !== 'function') {
    throw new TypeError(
      'createLocationRuntime requires a refreshToken function',
    )
  }

  // The logger's host-sink policy reads this location's debug_tui flag,
  // which is known only after the configuration loads with that logger.
  let config: LocationConfig | undefined
  const logger = createLocationLogger({
    sink: options.logSink,
    sinkEnabled: () => config?.config.debug_tui === true,
  })
  const log = logger.createLogger('runtime')
  config = createLocationConfig(options.directory, {
    logger: logger.createLogger('config'),
  })

  const debug = createLocationDebug(config.config)
  scope.add({ dispose: () => debug.close() }, 'consumer')

  const operatorSettings = acquireLocationOperatorSettings({
    projectConfigPath: config.projectConfigPath,
    userConfigPath: config.userConfigPath,
    ...(options.operatorSettingsRegistry
      ? { registry: options.operatorSettingsRegistry }
      : {}),
  })
  scope.add(operatorSettings, 'consumer')
  const applyOperatorSettings = (): void => {
    logger.setLevel(operatorSettings.get().log_level)
  }
  applyOperatorSettings()

  const signatureOptions = {
    keepThinking: config.keepThinking,
    signatureCache: config.config.signature_cache,
  }
  const signatures = options.signatureState
    ? options.signatureState.acquireLocation(signatureOptions)
    : acquireLocationSignatureCache(signatureOptions)
  scope.add(signatures, 'consumer')

  const dump = createGeminiDumpState()

  let accounts: LocationAccountView | null = null
  const identity = options.quotaAccountIdentity
  const sidebarAccounts = (): SidebarQuotaAccount[] | null => {
    const view = accounts
    if (!view) return null
    return view.getAccounts().map((entry) => ({
      index: entry.index,
      label: entry.label,
      enabled: entry.enabled,
      coolingDownUntil: entry.coolingDownUntil,
      cachedQuota: entry.cachedQuota,
      cachedQuotaAccountId: entry.cachedQuotaAccountId,
      ...(identity
        ? { currentQuotaAccountId: identity(entry.parts.refreshToken) }
        : {}),
      tier: toCapturedTier(entry),
    }))
  }

  const quotaManager = createLocationQuotaManager({
    logger: logger.createLogger('quota'),
    fetchAccountQuota: options.fetchAccountQuota,
    sidebar: {
      stateFile: options.sidebarStateFile,
      getAccounts: sidebarAccounts,
      getActiveIndexByFamily: () => accounts?.getActiveIndexByFamily() ?? null,
      ...(options.healthScore ? { healthScore: options.healthScore } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  })
  // Producer: refreshes enqueue sidebar writes, so the manager must stop
  // before the drain asserts the queue is empty.
  scope.add(quotaManager, 'producer')

  let backgroundQuotaRefresh: BackgroundQuotaRefresh | null = null
  if (config.config.background_quota_refresh) {
    backgroundQuotaRefresh = new BackgroundQuotaRefresh({
      intervalMs:
        config.config.background_quota_refresh_interval_minutes * 60_000,
      sidebarStateFile: options.sidebarStateFile,
      getAccountManager: () => accounts,
      quotaManager,
      ...(options.loadAccountTier
        ? { loadAccountTier: options.loadAccountTier }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.acquireLock ? { acquireLock: options.acquireLock } : {}),
      healthScore: options.healthScore ?? null,
      logger: logger.createLogger('background-quota'),
    })
    const poller = backgroundQuotaRefresh
    scope.add({ dispose: () => poller.dispose() }, 'producer')
  }

  // The refresh queue follows the account view. It is registered last among
  // producers, so it stops first: no token refresh can start while the quota
  // manager and poller are shutting down.
  let refreshQueue: ProactiveRefreshQueue | null = null
  let accountChange: Promise<void> = Promise.resolve()
  const stopRefreshQueue = async (): Promise<void> => {
    const queue = refreshQueue
    refreshQueue = null
    await queue?.dispose()
  }
  scope.add(
    {
      dispose: async () => {
        // Let an in-progress account swap finish before stopping its queue.
        await accountChange
        accounts = null
        await stopRefreshQueue()
      },
    },
    'producer',
  )

  scope.addDrain(() => drainSidebarWrites())

  const replaceAccounts = (view: LocationAccountView | null): Promise<void> => {
    const next = accountChange.then(async () => {
      if (scope.disposed) return
      await stopRefreshQueue()
      if (scope.disposed) return
      accounts = view
      if (!view || !config?.config.proactive_token_refresh) return
      const queue = createLocationProactiveRefreshQueue(
        {
          logger: logger.createLogger('refresh-queue'),
          refreshToken: options.refreshToken,
        },
        {
          enabled: true,
          bufferSeconds: config.config.proactive_refresh_buffer_seconds,
          checkIntervalSeconds:
            config.config.proactive_refresh_check_interval_seconds,
        },
      )
      queue.setAccountManager(view)
      refreshQueue = queue
      queue.start()
    })
    accountChange = next.catch((error) => {
      log.warn('account view replacement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return next
  }

  // Timers start only after every acquisition succeeded, so a failed build
  // never leaves a scheduled tick behind.
  backgroundQuotaRefresh?.start()

  const runtimeConfig = config
  return {
    directory: options.directory,
    logger,
    config: runtimeConfig,
    debug,
    dump,
    operatorSettings,
    signatures,
    quotaManager,
    backgroundQuotaRefresh,
    refreshQueue: () => refreshQueue,
    accounts: () => accounts,
    replaceAccounts,
    applyOperatorSettings,
    scope,
    dispose: () => scope.dispose(),
  }
}
