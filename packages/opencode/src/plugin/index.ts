import { ANTIGRAVITY_PROVIDER_ID } from '../constants'
import { createAutoUpdateCheckerHook } from '../hooks/auto-update-checker'
import {
  createAccountAccessService,
  promptAccountIndexForVerification,
  promptOpenVerificationUrl,
} from './account-access'
import { createAuthLoader } from './auth-loader'
import { initDiskSignatureCache, shutdownDiskSignatureCache } from './cache'
import { applyAntigravityProviderCatalog } from './catalog'
import {
  createCommandExecuteBefore,
  registerAntigravityCommands,
} from './commands'
import { initRuntimeConfig, loadConfig } from './config'
import { initializeDebug } from './debug'
import { createEventHandler } from './event-handler'
import { createFetchInterceptor } from './fetch-interceptor'
import { createGoogleSearchTool } from './google-search-tool'
import { createPluginLifecycle } from './lifecycle'
import { createLogger, initLogger } from './logger'
import { createOAuthMethods, openBrowserWithSystem } from './oauth-methods'
import { persistAccountPool } from './persist-account-pool'
import { createOpenCodeQuotaManager } from './quota'
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
import { initAntigravityVersion } from './version'

const logger = createLogger('plugin')

export const createAntigravityPlugin =
  (providerId: string) =>
  async (input: PluginInput): Promise<PluginResult> => {
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
    })
    const quotaManager = createOpenCodeQuotaManager(client, providerId)
    lifecycle.register({ dispose: () => quotaManager.dispose() })

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
    const commandExecuteBefore = createCommandExecuteBefore(client)
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
        }),
    })

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
