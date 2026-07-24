import { join } from 'node:path'
import { authorizeAntigravity, exchangeAntigravity } from '../antigravity/oauth'
import { ANTIGRAVITY_PROVIDER_ID } from '../constants'
import { createAutoUpdateCheckerHook } from '../hooks/auto-update-checker'
import { drainNotifications, pushNotification } from '../rpc/notifications'
import { getRpcDir } from '../rpc/rpc-dir'
import { startRpcServer } from '../rpc/rpc-server'
import { drainSidebarWrites, getSidebarStateFile } from '../sidebar-state'
import {
  createAccountAccessService,
  promptAccountIndexForVerification,
  promptOpenVerificationUrl,
} from './account-access'
import { createAccountCommandOAuthService } from './account-command-oauth'
import { createAuthLoader } from './auth-loader'
import { initDiskSignatureCache, shutdownDiskSignatureCache } from './cache'
import {
  applyAntigravityProviderCatalog,
  registerAntigravityCommands,
} from './catalog'
import {
  type CommandDataService,
  createCommandDataService,
  projectCommandAccountRows,
} from './command-data'
import {
  applyCommand,
  createCommandExecuteBefore,
  createSidebarRefresher,
} from './commands'
import { initRuntimeConfig, loadConfig } from './config'
import { getUserConfigPath as getUserConfigDir } from './config/loader'
import { initializeDebug } from './debug'
import {
  type PluginDependencies,
  type PluginDependencyOverrides,
  resolvePluginDependencies,
} from './dependencies'
import { createEventHandler } from './event-handler'
import { createFetchInterceptor } from './fetch-interceptor'
import { createGoogleSearchTool } from './google-search-tool'
import { createPluginLifecycle, type PluginLifecycle } from './lifecycle'
import { createLogger, initLogger, setRuntimeLogLevel } from './logger'
import { createOAuthMethods, openBrowserWithSystem } from './oauth-methods'
import {
  createOperatorSettingsController,
  type OperatorSettingsController,
} from './operator-settings'
import { persistAccountPool } from './persist-account-pool'
import { createOpenCodeQuotaManager, type QuotaManager } from './quota'
import { createSessionRecoveryHook } from './recovery'
import { initHealthTracker, initTokenTracker } from './rotation'
import { AgySessionRegistry } from './session-context'
import {
  clearAccounts,
  getStoragePath,
  loadAccounts,
  mutateAccountStorage,
} from './storage'
import type { GetAuth, PluginContext, PluginInput, PluginResult } from './types'

export type { PluginResult } from './types'

import { initAntigravityVersion } from './version'

const logger = createLogger('plugin')

/**
 * High-level options for the plugin factory. Production callers omit it
 * entirely; the e2e workspace injects overrides so the same factory can
 * build against a mock Antigravity server bound to 127.0.0.1.
 */
export interface CreateAntigravityPluginOptions {
  /**
   * Dependency overrides for the composition seam — fetch implementation,
   * Antigravity transport, OAuth primitives, filesystem roots, clock, and
   * randomness. Defaults to production implementations.
   */
  dependencies?: PluginDependencyOverrides
}

export function registerQuotaManagerProducer(
  lifecycle: PluginLifecycle,
  quotaManager: QuotaManager,
): void {
  lifecycle.register({ dispose: () => quotaManager.dispose() }, 'producer')
}

export const createAntigravityPlugin =
  (providerId: string, options: CreateAntigravityPluginOptions = {}) =>
  async (input: PluginInput): Promise<PluginResult> => {
    const dependencies: PluginDependencies = resolvePluginDependencies(
      options.dependencies,
    )
    const { client, directory } = input as PluginContext
    const config = loadConfig(directory)
    initRuntimeConfig(config)
    initializeDebug(config)
    initLogger(client)
    await initAntigravityVersion()

    if (config.health_score) {
      initHealthTracker({
        initial: config.health_score.initial,
        successReward: config.health_score.success_reward,
        rateLimitPenalty: config.health_score.rate_limit_penalty,
        failurePenalty: config.health_score.failure_penalty,
        recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
        minUsable: config.health_score.min_usable,
        maxScore: config.health_score.max_score,
      })
    }

    if (config.token_bucket) {
      initTokenTracker({
        maxTokens: config.token_bucket.max_tokens,
        regenerationRatePerMinute:
          config.token_bucket.regeneration_rate_per_minute,
        initialTokens: config.token_bucket.initial_tokens,
      })
    }

    if (config.keep_thinking) {
      initDiskSignatureCache(config.signature_cache)
    }

    const sessionRegistry = new AgySessionRegistry(directory)
    let cachedGetAuth: GetAuth | null = null
    const lifecycle = createPluginLifecycle({
      sessionRegistry,
      shutdownDiskSignatureCache,
      clearFetchState: () => {
        cachedGetAuth = null
      },
      // Drain pending sidebar writes BEFORE tearing down the RPC server
      // and file logger — a fetch-interceptor routing upsert enqueued at
      // shutdown must land before the host closes the terminal.
      drainSidebarWrites,
    })
    const quotaManager = createOpenCodeQuotaManager(client, providerId, {
      // Bind to the live AccountManager so every refresh (manual or
      // background) pushes the freshly-updated quota percentages into the
      // sidebar without an extra RPC. The wrapper reads lazily so the
      // AccountManager reference stays stable across reloads.
      getAccountsForSidebar: () => {
        const manager = lifecycle.getAccountManager()
        if (!manager) return null
        return manager.getAccounts().map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
        }))
      },
    })
    // Producer phase: the quota manager emits fire-and-forget sidebar
    // writes after every refresh. Its dispose() awaits any in-flight
    // refresh, so disposing it BEFORE the sidebar drain guarantees the
    // final post-refresh write is enqueued before the drain flushes —
    // a consumer-phase registration could let a refresh enqueue a write
    // after drainSidebarWrites() already asserted the queue was empty.
    registerQuotaManagerProducer(lifecycle, quotaManager)

    // Operator settings controller backs the /antigravity-* slash commands.
    // The controller loads existing persisted settings at first read, mutates
    // runtime config immediately, and serializes through the fenced-lock
    // writer so a crash mid-write cannot corrupt the file.
    const operatorSettings: OperatorSettingsController =
      createOperatorSettingsController({
        projectConfigPath: join(directory, '.opencode', 'antigravity.json'),
        userConfigPath: join(getUserConfigDir(), 'antigravity.json'),
      })
    setRuntimeLogLevel(operatorSettings.get().log_level)
    lifecycle.register({ dispose: () => operatorSettings.dispose() })

    const sessionRecovery = createSessionRecoveryHook(
      { client, directory },
      config,
    )
    const updateChecker = createAutoUpdateCheckerHook(client, directory, {
      showStartupToast: true,
      autoUpdate: config.auto_update,
    })
    const event = createEventHandler({
      client,
      config,
      directory,
      lifecycle,
      sessionRegistry,
      sessionRecovery,
      updateChecker,
      logger,
    })
    // This service intentionally closes over lifecycle getters, so both OPEN
    // notifications and RPC apply actions observe the current account manager.
    const commandData: CommandDataService = createCommandDataService({
      accountManagerView: {
        getAccounts: () => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return []
          const current =
            manager.getCurrentAccountForFamily('claude')?.index ?? 0
          return manager.getAccounts().map((entry, index) => ({
            index,
            refreshToken: entry.parts.refreshToken,
            label: entry.label,
            enabled: entry.enabled !== false,
            active: index === current,
            cachedQuota: entry.cachedQuota,
            cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
            cachedQuotaAccountId: entry.cachedQuotaAccountId,
            accountIneligible: entry.accountIneligible,
          }))
        },
        getAccountsForQuotaCheck: () => {
          const manager = lifecycle.getAccountManager()
          return manager ? manager.getAccountsForQuotaCheck() : []
        },
        updateQuotaCache: (index, groups, expectedRefreshToken) => {
          lifecycle
            .getAccountManager()
            ?.updateQuotaCache(index, groups, expectedRefreshToken)
        },
        requestSaveToDisk: () => {
          lifecycle.getAccountManager()?.requestSaveToDisk()
        },
        flushSaveToDisk: async () => {
          await lifecycle.getAccountManager()?.flushSaveToDisk()
        },
        activeIndex: () => {
          const manager = lifecycle.getAccountManager()
          return manager
            ? (manager.getCurrentAccountForFamily('claude')?.index ?? 0)
            : 0
        },
        setAccountEnabled: (index, enabled) => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return false
          return manager.setAccountEnabled(index, enabled)
        },
        setAccountCurrent: (index) => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return false
          const account = manager.getAccounts()[index]
          if (!account) return false
          manager.markSwitched(account, 'initial', 'claude')
          manager.markSwitched(account, 'initial', 'gemini')
          return true
        },
        removeAccountByIndex: (index) => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return false
          return manager.removeAccountByIndex(index)
        },
        getRefreshTokenAt: (index) => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return undefined
          return manager.getAccounts()[index]?.parts.refreshToken
        },
      },
      quotaManager,
      sidebarStateFile: getSidebarStateFile(),
      storage: {
        mutate: (mutator) => mutateAccountStorage(getStoragePath(), mutator),
      },
    })
    const commandExecuteBefore = createCommandExecuteBefore(
      client,
      operatorSettings,
      pushNotification,
      commandData,
    )
    const googleSearchTool = createGoogleSearchTool({
      getAuth: async () => (cachedGetAuth ? cachedGetAuth() : null),
      client,
      providerId,
    })
    const accountAccess = createAccountAccessService({
      client,
      providerId,
      store: {
        load: loadAccounts,
        mutate: (mutate) => mutateAccountStorage(getStoragePath(), mutate),
        clear: clearAccounts,
        persistAccountPool,
      },
      openBrowser: openBrowserWithSystem,
      prompt: {
        selectAccount: promptAccountIndexForVerification,
        confirmOpenVerificationUrl: promptOpenVerificationUrl,
      },
    })
    const accountOAuth = createAccountCommandOAuthService({
      authorize: () => authorizeAntigravity(),
      exchange: exchangeAntigravity,
      persist: (result) => accountAccess.persistAccountPool([result], false),
      listAccounts: async () =>
        projectCommandAccountRows(await accountAccess.loadAccounts()),
    })
    lifecycle.register({ dispose: () => accountOAuth.dispose() })
    const oauthMethods = createOAuthMethods({
      client,
      providerId,
      config,
      lifecycle,
      accountAccess,
      quotaManager,
      getAuth: async () => (cachedGetAuth ? cachedGetAuth() : undefined),
    })
    const authLoader = createAuthLoader({
      client,
      providerId,
      config,
      lifecycle,
      onGetAuth: (getAuth) => {
        cachedGetAuth = getAuth
      },
      createFetch: ({ accountManager, getAuth }) =>
        createFetchInterceptor({
          client,
          directory,
          providerId,
          config,
          accountManager,
          quotaManager,
          getAuth,
          agySessionRegistry: sessionRegistry,
          operatorSettings,
          agyTransport: dependencies.agyTransport,
          fetchImpl: dependencies.fetchImpl,
        }),
    })

    const rpcServer = await startRpcServer({
      dir: getRpcDir(directory),
      apply: async (request) => {
        // Sidebar refresher is bound to the live account manager so every
        // /antigravity-* mutation bumps `checkedAt` for the next TUI poll.
        // The refresher is best-effort and never breaks the apply response.
        const refreshSidebar = createSidebarRefresher(() => {
          const manager = lifecycle.getAccountManager()
          if (!manager) return null
          return manager.getAccounts().map((entry) => ({
            index: entry.index,
            label: entry.label,
            enabled: entry.enabled,
            coolingDownUntil: entry.coolingDownUntil,
            cachedQuota: entry.cachedQuota,
          }))
        })
        const result = await applyCommand(request, {
          client,
          sessionID: request.sessionId ?? '',
          settings: operatorSettings,
          onApplied: refreshSidebar,
          commandData,
          accountOAuth,
        })
        // /antigravity-logging mutates the log level — propagate
        // immediately so subsequent log calls in this session respect it.
        setRuntimeLogLevel(operatorSettings.get().log_level)
        return result
      },
      drain: drainNotifications,
    })
    lifecycle.register({ dispose: () => rpcServer.stop() })

    return {
      dispose: async () => {
        await lifecycle.dispose()
      },
      config: async (opencodeConfig) => {
        applyAntigravityProviderCatalog(
          opencodeConfig as unknown as Record<string, unknown>,
          providerId,
        )
        registerAntigravityCommands(
          opencodeConfig as unknown as Record<string, unknown>,
        )
      },
      'command.execute.before': commandExecuteBefore,
      event,
      tool: { google_search: googleSearchTool },
      auth: {
        provider: providerId,
        loader: authLoader as PluginResult['auth']['loader'],
        methods: oauthMethods,
      },
    }
  }

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(
  ANTIGRAVITY_PROVIDER_ID,
)
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin
