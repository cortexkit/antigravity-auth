import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  type AccountRepository,
  type CommonAuthCommandsModule,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'

/** The `/antigravity` menu, as the shared core factory builds it. */
type CommandMenu = ReturnType<CommonAuthCommandsModule['createCommandMenu']>

import { cliAccountOf } from '../cli'
import { ANTIGRAVITY_PROVIDER_ID } from '../constants'
import { createAutoUpdateCheckerHook } from '../hooks/auto-update-checker'
import { drainNotifications, pushNotification } from '../rpc/notifications'
import { getRpcDir } from '../rpc/rpc-dir'
import { startRpcServer } from '../rpc/rpc-server'
import {
  drainSidebarWrites,
  getSidebarStateFile,
  isAccountCurrent,
  toCapturedTier,
} from '../sidebar-state'
import {
  createAccountAccessService,
  promptAccountIndexForVerification,
  promptOpenVerificationUrl,
} from './account-access'
import { createAccountCommandOAuthService } from './account-command-oauth'
import { createAuthLoader } from './auth-loader'
import { BackgroundQuotaRefresh } from './background-quota-refresh'
import { initDiskSignatureCache, shutdownDiskSignatureCache } from './cache'
import {
  applyAntigravityProviderCatalog,
  registerAntigravityCommands,
} from './catalog'
import { createStoreAccountLimits } from './command-apply'
import { projectCommandAccountRows } from './command-data'
import {
  createAntigravityCommandExecuteBefore,
  createOpenCodeAntigravityMenu,
  menuInvocation,
} from './commands'
import { initRuntimeConfig, loadConfig } from './config'
import { getUserConfigPath } from './config/loader'
import { closeDebugLog, initializeDebug } from './debug'
import {
  type PluginDependencies,
  type PluginDependencyOverrides,
  resolvePluginDependencies,
} from './dependencies'
import { createEventHandler } from './event-handler'
import { createFetchInterceptor } from './fetch-interceptor'
import { isGeminiDumpEnabled, setGeminiDumpEnabled } from './gemini-dump'
import { createGoogleSearchTool } from './google-search-tool'
import { createPluginLifecycle, type PluginLifecycle } from './lifecycle'
import { createLogger, initLogger, setRuntimeLogLevel } from './logger'
import { createOAuthMethods, openBrowserWithSystem } from './oauth-methods'
import {
  createOperatorSettingsController,
  type OperatorSettingsController,
} from './operator-settings'
import {
  commitLogins,
  persistAccountPool,
  replacePoolLogins,
} from './persist-account-pool'
import {
  createOpenCodeQuotaManager,
  makeTierLoader,
  type QuotaManager,
} from './quota'
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
 * Opaque identity derived from a refresh token. Mirrors
 * `command-data.ts`'s copy (the two callers stay independent because
 * `command-data.ts` ships into the TUI's compiled tree and can't reach
 * across the core barrel boundary). Used by the live quota→sidebar
 * writers to stamp each quota snapshot with the account it belongs to
 * so the sidebar projection can detect a stale cache after an index
 * shift.
 */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

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
  /**
   * Test-only seam: called synchronously after the background poller is
   * constructed, before `start()`. Lets wiring tests capture the instance
   * without reaching into lifecycle internals.
   */
  _onPollerCreated?: (poller: BackgroundQuotaRefresh) => void
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
      // Route quota fetches through the injected transport so e2e and
      // custom-host deployments stay on the loopback/mock server for both
      // the request path and the background poller. Without this the
      // poller always hits the production Antigravity endpoint even when
      // the caller injected a mock transport.
      fetchVia: dependencies.agyTransport,
      // Bind to the live AccountManager so every refresh (manual or
      // background) pushes the freshly-updated quota percentages into the
      // sidebar without an extra RPC. The wrapper reads lazily so the
      // AccountManager reference stays stable across reloads.
      getAccountsForSidebar: () => {
        const manager = lifecycle.getAccountManager()
        if (!manager) return null
        const activeByFamily = manager.getActiveIndexByFamily()
        return manager.getAccounts().map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          current: isAccountCurrent(entry.index, activeByFamily),
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          // Carry the identity stamp so the sidebar projection can
          // detect a stale snapshot that landed on the wrong account
          // after an index shift (see `redactAccountForSidebar`).
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          currentQuotaAccountId: quotaAccountIdentity(entry.parts.refreshToken),
          tier: toCapturedTier(entry),
        }))
      },
      getActiveIndexByFamily: () => {
        const manager = lifecycle.getAccountManager()
        if (!manager) return null
        return manager.getActiveIndexByFamily()
      },
    })
    // Producer phase: the quota manager emits fire-and-forget sidebar
    // writes after every refresh. Its dispose() awaits any in-flight
    // refresh, so disposing it BEFORE the sidebar drain guarantees the
    // final post-refresh write is enqueued before the drain flushes —
    // a consumer-phase registration could let a refresh enqueue a write
    // after drainSidebarWrites() already asserted the queue was empty.
    registerQuotaManagerProducer(lifecycle, quotaManager)

    // Background quota poller: per-loader-instance timer that keeps idle
    // account sidebar bars fresh between real requests. Registered as a
    // producer so it is stopped and awaited BEFORE the sidebar drain,
    // guaranteeing any final poll write lands before the drain flushes.
    if (config.background_quota_refresh) {
      const poller = new BackgroundQuotaRefresh({
        intervalMs: config.background_quota_refresh_interval_minutes * 60_000,
        sidebarStateFile: getSidebarStateFile(),
        getAccountManager: () => lifecycle.getAccountManager(),
        quotaManager,
        // Resolve plan tier for accounts with stale capturedTierAt. Uses
        // the same token-refresh path as the quota manager without a separate
        // network seam -- tier is best-effort metadata, not quota.
        loadAccountTier: makeTierLoader(client, providerId),
        // Thread the injected clock so e2e tests can control startup
        // jitter and timing without needing a real 30-second wait.
        now: dependencies.clock.now,
        random: dependencies.clock.random,
      })
      options._onPollerCreated?.(poller)
      poller.start()
      lifecycle.register({ dispose: () => poller.dispose() }, 'producer')
    }

    // Operator settings controller backs the /antigravity-* slash commands.
    // The controller loads existing persisted settings at first read, mutates
    // runtime config immediately, and serializes through the fenced-lock
    // writer so a crash mid-write cannot corrupt the file.
    const operatorSettings: OperatorSettingsController =
      createOperatorSettingsController({
        projectConfigPath: join(directory, '.opencode', 'antigravity.json'),
        // getUserConfigPath() already returns the full file path including
        // 'antigravity.json' — do NOT join again or the path double-nests
        // into <dir>/antigravity.json/antigravity.json.
        userConfigPath: getUserConfigPath(),
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
    // The `/antigravity` menu is built once per account-store repository,
    // on the same common-auth commands module whose request parser the RPC
    // server uses, so a request is parsed and applied by one module instance.
    const commandsModule = await loadCommonAuthCommands()
    let builtMenu: {
      readonly repository: AccountRepository
      readonly menu: Promise<CommandMenu>
    } | null = null
    const currentMenu = async (): Promise<
      | { kind: 'menu'; menu: CommandMenu }
      | { kind: 'unavailable'; message: string }
    > => {
      const opening = await authLoader.accountStore()
      if (opening.status !== 'ready') {
        return {
          kind: 'unavailable',
          message: authLoader.usesPoolFile(opening)
            ? 'Antigravity accounts are still in the pre-store account file. Stop OpenCode and run `antigravity-auth migrate --offline` to manage them from /antigravity.'
            : opening.status === 'refused'
              ? opening.message
              : 'The Antigravity account store cannot be opened.',
        }
      }
      if (builtMenu?.repository !== opening.repository) {
        builtMenu = {
          repository: opening.repository,
          menu: createOpenCodeAntigravityMenu({
            commands: commandsModule,
            accounts: opening.repository,
            settings: operatorSettings,
            dump: {
              isEnabled: isGeminiDumpEnabled,
              setEnabled: setGeminiDumpEnabled,
            },
            applyLogLevel: setRuntimeLogLevel,
            accountLimits: createStoreAccountLimits({
              repository: opening.repository,
              settings: operatorSettings,
            }),
            signIn: accountOAuth,
          }),
        }
      }
      return { kind: 'menu', menu: await builtMenu.menu }
    }
    const commandExecuteBefore = createAntigravityCommandExecuteBefore({
      client,
      push: pushNotification,
      open: async (sessionId) => {
        const current = await currentMenu()
        if (current.kind === 'unavailable') return current
        return {
          kind: 'menu',
          payload: await current.menu.open(
            menuInvocation(pushNotification, sessionId),
          ),
        }
      },
    })
    const googleSearchTool = createGoogleSearchTool({
      getAuth: async () => (cachedGetAuth ? cachedGetAuth() : null),
      client,
      providerId,
    })
    /**
     * The location's account source for pool-file style callers: the pool
     * file before migration, else the account store's repository. Any other
     * store state stops the caller with the store's message.
     */
    const openPoolFileOrStore = async (): Promise<
      'pool-file' | AccountRepository
    > => {
      const opening = await authLoader.accountStore()
      if (opening.status === 'ready') return opening.repository
      if (authLoader.usesPoolFile(opening)) return 'pool-file'
      throw new Error(
        opening.status === 'refused'
          ? opening.message
          : 'The Antigravity account store cannot be opened',
      )
    }
    const accountAccess = createAccountAccessService({
      client,
      providerId,
      // Before migration these are the pool file's operations. Once the
      // account store is active, logins are admitted by its repository, the
      // accounts are read from it, and pool-file edits are refused: the
      // retired file is never read or written.
      store: {
        load: async () => {
          const opening = await openPoolFileOrStore()
          if (opening === 'pool-file') return loadAccounts()
          const read = await opening.read()
          if (read.status !== 'ready')
            throw new Error(`The account store is ${read.status}`)
          return {
            version: 4,
            activeIndex: Math.max(
              0,
              read.rows.findIndex(
                (row) => row.ref.id === read.routing?.activeRow?.id,
              ),
            ),
            accounts: read.rows.map(cliAccountOf),
          }
        },
        mutate: async (mutate) => {
          const opening = await openPoolFileOrStore()
          if (opening === 'pool-file')
            return mutateAccountStorage(getStoragePath(), mutate)
          throw new Error(
            'Accounts live in the account store; change them from the /antigravity menu',
          )
        },
        clear: async () => {
          const opening = await openPoolFileOrStore()
          if (opening === 'pool-file') return clearAccounts()
          throw new Error(
            'Accounts live in the account store; remove them from the /antigravity menu',
          )
        },
        persistAccountPool: async (results, replaceAll) => {
          const opening = await openPoolFileOrStore()
          if (opening === 'pool-file')
            return persistAccountPool(results, replaceAll)
          if (replaceAll) {
            await replacePoolLogins(opening, results)
            return
          }
          const refused = (await commitLogins(opening, results)).find(
            (entry) => entry.status === 'refused',
          )
          if (refused?.status === 'refused') throw new Error(refused.message)
        },
      },
      openBrowser: openBrowserWithSystem,
      prompt: {
        selectAccount: promptAccountIndexForVerification,
        confirmOpenVerificationUrl: promptOpenVerificationUrl,
      },
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
    const accountOAuth = createAccountCommandOAuthService({
      // Wire the OAuth primitives through the dependency seam (rather
      // than the concrete imports above) so injected overrides from
      // `dependencies.oauth.*` reach this path — the same composition
      // pattern used by every other sub-factory. Without this seam the
      // e2e harness / custom-host deployments would still hit the real
      // Google OAuth endpoints when adding an account.
      authorize: dependencies.oauth.authorize,
      exchange: dependencies.oauth.exchange,
      // Once the account store is active a new login is admitted by the
      // repository the runtime routes with; the retired pool file is never
      // written or read. Before migration the pool file path is unchanged.
      persist: async (result) => {
        const opening = await authLoader.accountStore()
        if (opening.status === 'ready') {
          const [committed] = await commitLogins(opening.repository, [result])
          if (committed?.status === 'refused')
            throw new Error(committed.message)
          return
        }
        if (!authLoader.usesPoolFile(opening)) {
          throw new Error(
            opening.status === 'refused'
              ? opening.message
              : 'The Antigravity account store cannot accept a login',
          )
        }
        await accountAccess.persistAccountPool([result], false)
      },
      listAccounts: async () => {
        const opening = await authLoader.accountStore()
        if (opening.status === 'ready') {
          const read = await opening.repository.read()
          if (read.status !== 'ready') return []
          const activeId = read.routing?.activeRow?.id
          const activeIndex = read.rows.findIndex(
            (row) => row.ref.id === activeId,
          )
          return projectCommandAccountRows({
            activeIndex: activeIndex === -1 ? 0 : activeIndex,
            version: 4,
            accounts: read.rows.map((row) => ({
              refreshToken: row.credential?.refreshToken ?? '',
              enabled: row.enabled,
              addedAt:
                row.metadata.status === 'present'
                  ? row.metadata.metadata.addedAt
                  : 0,
              lastUsed:
                row.metadata.status === 'present'
                  ? row.metadata.metadata.lastUsed
                  : 0,
            })),
          })
        }
        if (!authLoader.usesPoolFile(opening)) return []
        return projectCommandAccountRows(await accountAccess.loadAccounts())
      },
      // After the new account lands on disk, reload the live
      // AccountManager + fetch interceptor so routing sees it
      // immediately — without waiting for an auth reload.
      onAfterPersist: () =>
        authLoader.reload(async () => {
          const auth = cachedGetAuth ? await cachedGetAuth() : undefined
          if (auth) return auth
          throw new Error(
            'No live auth cached for OAuth finish reload — the host has not yet loaded any account.',
          )
        }),
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

    const rpcServer = await startRpcServer({
      dir: getRpcDir(directory),
      parseApplyRequest: commandsModule.parseApplyRequest,
      apply: async (request) => {
        const current = await currentMenu()
        if (current.kind === 'unavailable') throw new Error(current.message)
        return current.menu.apply(
          request,
          menuInvocation(pushNotification, request.sessionId),
        )
      },
      drain: drainNotifications,
    })
    lifecycle.register({ dispose: () => rpcServer.stop() })
    // Flush the debug log stream after the sidebar drain so the last
    // buffered lines land on disk before the process exits. Best-effort.
    lifecycle.register({ dispose: () => closeDebugLog().catch(() => {}) })

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
