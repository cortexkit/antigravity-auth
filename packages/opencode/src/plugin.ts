import { ANTIGRAVITY_PROVIDER_ID } from './constants'
import { createAutoUpdateCheckerHook } from './hooks/auto-update-checker'
import {
  createAccountAccessService,
  promptAccountIndexForVerification,
  promptOpenVerificationUrl,
} from './plugin/account-access'
import { createAuthLoader } from './plugin/auth-loader'
import {
  initDiskSignatureCache,
  shutdownDiskSignatureCache,
} from './plugin/cache'
import { applyAntigravityProviderCatalog } from './plugin/catalog'
import {
  createCommandExecuteBefore,
  registerAntigravityCommands,
} from './plugin/commands'
import { initRuntimeConfig, loadConfig } from './plugin/config'
import { initializeDebug } from './plugin/debug'
import { createFetchInterceptor } from './plugin/fetch-interceptor'
import { createGoogleSearchTool } from './plugin/google-search-tool'
import { createPluginLifecycle } from './plugin/lifecycle'
import { createLogger, initLogger } from './plugin/logger'
import {
  createOAuthMethods,
  openBrowserWithSystem,
} from './plugin/oauth-methods'
import { persistAccountPool } from './plugin/persist-account-pool'
import { createOpenCodeQuotaManager } from './plugin/quota'
import {
  createSessionRecoveryHook,
  getRecoverySuccessToast,
} from './plugin/recovery'
import { initHealthTracker, initTokenTracker } from './plugin/rotation'
import { AgySessionRegistry } from './plugin/session-context'
import {
  clearAccounts,
  getStoragePath,
  loadAccounts,
  mutateAccountStorage,
} from './plugin/storage'
import type { GetAuth, PluginContext, PluginResult } from './plugin/types'
import { initAntigravityVersion } from './plugin/version'

const log = createLogger('plugin')

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin =
  (providerId: string) =>
  async ({ client, directory }: PluginContext): Promise<PluginResult> => {
    // Load configuration from files and environment variables
    const config = loadConfig(directory)
    initRuntimeConfig(config)
    const agySessionRegistry = new AgySessionRegistry(directory)
    let cachedGetAuth: GetAuth | null = null
    const quotaManager = createOpenCodeQuotaManager(client, providerId)
    const lifecycle = createPluginLifecycle({
      sessionRegistry: agySessionRegistry,
      shutdownDiskSignatureCache,
      clearFetchState: () => {
        cachedGetAuth = null
      },
    })
    lifecycle.register({
      dispose: () => {
        quotaManager.dispose()
      },
    })

    // Initialize debug with config
    initializeDebug(config)

    // Initialize structured logger for TUI integration
    initLogger(client)

    // Fetch latest Antigravity version from remote API (non-blocking, falls back to hardcoded)
    await initAntigravityVersion()

    // Initialize health tracker for hybrid strategy
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

    // Initialize token tracker for hybrid strategy
    if (config.token_bucket) {
      initTokenTracker({
        maxTokens: config.token_bucket.max_tokens,
        regenerationRatePerMinute:
          config.token_bucket.regeneration_rate_per_minute,
        initialTokens: config.token_bucket.initial_tokens,
      })
    }

    // Initialize disk signature cache if keep_thinking is enabled
    // This integrates with the in-memory cacheSignature/getCachedSignature functions
    if (config.keep_thinking) {
      initDiskSignatureCache(config.signature_cache)
    }

    // Initialize session recovery hook with full context
    const sessionRecovery = createSessionRecoveryHook(
      { client, directory },
      config,
    )

    const updateChecker = createAutoUpdateCheckerHook(client, directory, {
      showStartupToast: true,
      autoUpdate: config.auto_update,
    })

    // Event handler for session recovery and updates
    const eventHandler = async (input: {
      event: { type: string; properties?: unknown }
    }) => {
      // Forward to update checker
      await updateChecker.event(input)

      if (input.event.type === 'session.created') {
        const props = input.event.properties as
          | {
              info?: { id?: string; parentID?: string }
            }
          | undefined
        const sessionId = props?.info?.id
        const parentSessionId = props?.info?.parentID ?? null
        if (sessionId) {
          agySessionRegistry.register(sessionId, parentSessionId)
        }

        if (parentSessionId) {
          log.debug('child-session-detected', {
            sessionId,
            parentID: parentSessionId,
          })
        } else {
          const prevSummary = lifecycle.getAccountManager()?.getSessionSummary()
          if (
            prevSummary &&
            (prevSummary.totalClaude > 0 || prevSummary.totalGemini > 0)
          ) {
            log.debug('prev-session-quota-summary', {
              durationMinutes: prevSummary.durationMinutes,
              totalClaude: prevSummary.totalClaude,
              totalGemini: prevSummary.totalGemini,
              requestsPerHour: prevSummary.requestsPerHour,
              accountsUsed: prevSummary.accountsUsed,
            })
          }
          log.debug('root-session-detected', { sessionId })
        }
      }

      if (input.event.type === 'session.deleted') {
        const props = input.event.properties as
          | {
              sessionID?: string
              info?: { id?: string }
            }
          | undefined
        const sessionId = props?.sessionID ?? props?.info?.id
        if (sessionId) {
          agySessionRegistry.delete(sessionId)
          lifecycle.getAccountManager()?.deleteSessionState(sessionId)
        }
      }

      // Handle session recovery
      if (sessionRecovery && input.event.type === 'session.error') {
        const props = input.event.properties as
          | Record<string, unknown>
          | undefined
        const sessionID = props?.sessionID as string | undefined
        const messageID = props?.messageID as string | undefined
        const error = props?.error

        if (sessionRecovery.isRecoverableError(error)) {
          const messageInfo = {
            id: messageID,
            role: 'assistant' as const,
            sessionID,
            error,
          }

          // handleSessionRecovery now does the actual fix (injects tool_result, etc.)
          const recovered =
            await sessionRecovery.handleSessionRecovery(messageInfo)

          // Only send "continue" AFTER successful tool_result_missing recovery
          // (thinking recoveries already resume inside handleSessionRecovery)
          if (recovered && sessionID && config.auto_resume) {
            // For tool_result_missing, we need to send continue after injecting tool_results
            await client.session
              .prompt({
                path: { id: sessionID },
                body: { parts: [{ type: 'text', text: config.resume_text }] },
                query: { directory },
              })
              .catch(() => {})

            // Show success toast (respects toast_scope for child sessions)
            const successToast = getRecoverySuccessToast()
            const isChildRecovery =
              agySessionRegistry.getParentSessionId(sessionID) !== null
            log.debug('recovery-toast', {
              ...successToast,
              isChildSession: isChildRecovery,
              toastScope: config.toast_scope,
            })
            if (!(config.toast_scope === 'root_only' && isChildRecovery)) {
              await client.tui
                .showToast({
                  body: {
                    title: successToast.title,
                    message: successToast.message,
                    variant: 'success',
                  },
                })
                .catch(() => {})
            }
          }
        }
      }
    }

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

    return {
      dispose: () => lifecycle.dispose(),
      config: async (opencodeConfig: Record<string, unknown>) => {
        applyAntigravityProviderCatalog(opencodeConfig, providerId)
        registerAntigravityCommands(opencodeConfig)
      },
      'command.execute.before': createCommandExecuteBefore(client),
      event: eventHandler,
      tool: {
        google_search: googleSearchTool,
      },
      auth: {
        provider: providerId,
        loader: createAuthLoader({
          client,
          providerId,
          config,
          lifecycle,
          onGetAuth: (getAuth) => {
            cachedGetAuth = getAuth
          },
          createFetch: ({ accountManager, getAuth: loaderGetAuth }) => {
            const interceptor = createFetchInterceptor({
              client,
              directory,
              providerId,
              config,
              accountManager,
              quotaManager,
              getAuth: loaderGetAuth,
              agySessionRegistry,
            })
            return interceptor
          },
        }),
        methods: createOAuthMethods({
          client,
          providerId,
          config,
          lifecycle,
          accountAccess,
          quotaManager,
          getAuth: async () => (cachedGetAuth ? cachedGetAuth() : undefined),
        }),
      },
    }
  }

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(
  ANTIGRAVITY_PROVIDER_ID,
)
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin

export {
  buildAccountAccessProbeRequest,
  extractAccountAccessErrorDetails,
  interpretAccountAccessProbeResponse,
} from './plugin/account-access'
