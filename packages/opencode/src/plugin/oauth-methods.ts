import { exec } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import {
  authorizeAntigravity as defaultAuthorizeAntigravity,
  exchangeAntigravity as defaultExchangeAntigravity,
} from '../antigravity/oauth'
import type { AccountAccessService } from './account-access'
import {
  clearStoredAccountAccessBlocks,
  markStoredAccountIneligible,
  markStoredAccountVerificationRequired,
} from './account-access'
import { formatRefreshParts, parseRefreshParts } from './auth'
import { createAuthDoctorReport, formatAuthDoctorReport } from './auth-doctor'
import {
  promptAddAnotherAccount as defaultPromptAddAnotherAccount,
  promptLoginMode as defaultPromptLoginMode,
  promptProjectId as defaultPromptProjectId,
} from './cli'
import type { AntigravityConfig } from './config'
import type { PluginLifecycle } from './lifecycle'
import { createLogger } from './logger'
import { clearProvisionFailedKeys } from './project'
import { createOpenCodeQuotaManager, type QuotaManager } from './quota'
import {
  startOAuthListener as defaultStartOAuthListener,
  type OAuthListener,
} from './server'
import type { AccountMetadataV3 } from './storage'
import type { AuthDetails, AuthMethod, PluginClient } from './types'
import {
  classifyGroupStatus,
  formatCachedQuotaWithStatus,
  formatQuotaStatusBadge,
} from './ui/quota-status'
import { getAntigravityVersionResolution } from './version'

const MAX_OAUTH_ACCOUNTS = 10
const log = createLogger('oauth-methods')

export interface OAuthMethodDependencies {
  authorize: typeof defaultAuthorizeAntigravity
  exchange: typeof defaultExchangeAntigravity
  startListener: typeof defaultStartOAuthListener
  promptProjectId: typeof defaultPromptProjectId
  promptAddAnotherAccount: typeof defaultPromptAddAnotherAccount
  promptLoginMode: typeof defaultPromptLoginMode
  promptCallback(message: string): Promise<string>
  openBrowser(url: string): Promise<boolean>
  shouldSkipLocalServer(): boolean
  isHeadless(): boolean
  confirmOpenVerificationUrl(): Promise<boolean>
}

interface CreateOAuthMethodsOptions {
  client: PluginClient
  providerId: string
  config: AntigravityConfig
  lifecycle: PluginLifecycle
  accountAccess: AccountAccessService
  quotaManager?: QuotaManager
  getAuth?: (() => Promise<AuthDetails | undefined>) | null
  dependencies?: Partial<OAuthMethodDependencies>
}

type OAuthCallbackParams = { code: string; state: string }

function isWSL(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const release = readFileSync('/proc/version', 'utf8').toLowerCase()
    return release.includes('microsoft') || release.includes('wsl')
  } catch {
    return false
  }
}

function isWSL2(): boolean {
  if (!isWSL()) return false
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase()
    return version.includes('wsl2') || version.includes('microsoft-standard')
  } catch {
    return false
  }
}

function isRemoteEnvironment(): boolean {
  if (
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION
  ) {
    return true
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true
  return (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY &&
    !isWSL()
  )
}

function defaultShouldSkipLocalServer(): boolean {
  return isWSL2() || isRemoteEnvironment()
}

export async function openBrowserWithSystem(url: string): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      exec(`open "${url}"`)
      return true
    }
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`)
      return true
    }
    if (isWSL()) {
      exec(`wslview "${url}"`)
      return true
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false
    exec(`xdg-open "${url}"`)
    return true
  } catch {
    return false
  }
}

async function defaultPromptCallback(message: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question(message)).trim()
  } finally {
    rl.close()
  }
}

function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get('state') ?? ''
  } catch {
    return ''
  }
}

function extractOAuthCallbackParams(
  url: URL,
  expectedState: string,
): OAuthCallbackParams | { error: string } {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return { error: 'Missing code or state in callback URL' }
  if (expectedState && state !== expectedState) {
    return { error: 'OAuth state mismatch' }
  }
  return { code, state }
}

export function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim()
  if (!trimmed) return { error: 'Missing authorization code' }

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? fallbackState
    if (!code) return { error: 'Missing code in callback URL' }
    if (!state) return { error: 'Missing state in callback URL' }
    if (fallbackState && state !== fallbackState) {
      return { error: 'OAuth state mismatch' }
    }
    return { code, state }
  } catch {
    if (!fallbackState) {
      return {
        error:
          'Missing state. Paste the full redirect URL instead of only the code.',
      }
    }
    return { code: trimmed, state: fallbackState }
  }
}

function buildAuthSuccessFromStoredAccount(account: {
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  email?: string
}): Extract<AntigravityTokenExchangeResult, { type: 'success' }> {
  return {
    type: 'success',
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: '',
    expires: 0,
    email: account.email,
    projectId: account.projectId ?? '',
  }
}

function formatCachedQuotaSummary(account: {
  cachedQuota?: Record<
    string,
    { remainingFraction?: number; resetTime?: string }
  >
}): string | undefined {
  return account.cachedQuota
    ? formatCachedQuotaWithStatus(account.cachedQuota)
    : undefined
}

function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export function createOAuthMethods({
  client,
  providerId,
  config: _config,
  lifecycle,
  accountAccess,
  quotaManager: injectedQuotaManager,
  getAuth = null,
  dependencies,
}: CreateOAuthMethodsOptions): AuthMethod[] {
  const deps: OAuthMethodDependencies = {
    authorize: dependencies?.authorize ?? defaultAuthorizeAntigravity,
    exchange: dependencies?.exchange ?? defaultExchangeAntigravity,
    startListener: dependencies?.startListener ?? defaultStartOAuthListener,
    promptProjectId: dependencies?.promptProjectId ?? defaultPromptProjectId,
    promptAddAnotherAccount:
      dependencies?.promptAddAnotherAccount ?? defaultPromptAddAnotherAccount,
    promptLoginMode: dependencies?.promptLoginMode ?? defaultPromptLoginMode,
    promptCallback: dependencies?.promptCallback ?? defaultPromptCallback,
    openBrowser: dependencies?.openBrowser ?? openBrowserWithSystem,
    shouldSkipLocalServer:
      dependencies?.shouldSkipLocalServer ?? defaultShouldSkipLocalServer,
    isHeadless:
      dependencies?.isHeadless ??
      (() =>
        Boolean(
          process.env.SSH_CONNECTION ||
            process.env.SSH_CLIENT ||
            process.env.SSH_TTY ||
            process.env.OPENCODE_HEADLESS,
        )),
    confirmOpenVerificationUrl:
      dependencies?.confirmOpenVerificationUrl ??
      (async () => {
        const answer = (
          await defaultPromptCallback(
            'Open verification URL in your browser now? [Y/n]: ',
          )
        )
          .trim()
          .toLowerCase()
        return answer === '' || answer === 'y' || answer === 'yes'
      }),
  }
  const quotaManager =
    injectedQuotaManager ?? createOpenCodeQuotaManager(client, providerId)
  if (!injectedQuotaManager) {
    lifecycle.register({ dispose: () => quotaManager.dispose() })
  }
  const cachedGetAuth = getAuth
  const loadAccounts = () => accountAccess.loadAccounts()
  const clearAccounts = () => accountAccess.clearAccounts()
  const persistAccountPool =
    accountAccess.persistAccountPool.bind(accountAccess)
  const mutateAccountByRefreshToken = async (
    refreshToken: string,
    mutate: (account: AccountMetadataV3) => boolean,
  ): Promise<boolean> => {
    let changed = false
    await accountAccess.mutateAccounts((current) => {
      const account = current.accounts.find(
        (candidate) => candidate.refreshToken === refreshToken,
      )
      if (account) changed = mutate(account)
      return current
    })
    return changed
  }
  const verifyAccountAccess = accountAccess.verifyAccount.bind(accountAccess)
  const promptAccountIndexForVerification =
    accountAccess.selectAccount.bind(accountAccess)
  const promptOpenVerificationUrl = deps.confirmOpenVerificationUrl
  const openBrowser = deps.openBrowser
  const shouldSkipLocalServer = deps.shouldSkipLocalServer
  const startOAuthListener = deps.startListener
  const promptOAuthCallbackValue = deps.promptCallback
  const promptManualOAuthInput = async (
    fallbackState: string,
  ): Promise<AntigravityTokenExchangeResult> => {
    console.log(
      '1. Open the URL above in your browser and complete Google sign-in.',
    )
    console.log(
      '2. After approving, copy the full redirected localhost URL from the address bar.',
    )
    console.log('3. Paste it back here.\n')
    const callbackInput = await promptOAuthCallbackValue(
      'Paste the redirect URL (or just the code) here: ',
    )
    const params = parseOAuthCallbackInput(callbackInput, fallbackState)
    if ('error' in params) return { type: 'failed', error: params.error }
    return deps.exchange(params.code, params.state)
  }
  const authorizeAntigravity = deps.authorize
  const exchangeAntigravity = deps.exchange
  const promptProjectId = deps.promptProjectId
  const promptAddAnotherAccount = deps.promptAddAnotherAccount
  const promptLoginMode = deps.promptLoginMode

  return [
    {
      label: 'OAuth with Google (Antigravity)',
      type: 'oauth',
      authorize: async (inputs?: Record<string, string>) => {
        const isHeadless = deps.isHeadless()

        // CLI flow (`opencode auth login`) passes an inputs object.
        if (inputs) {
          const accounts: Array<
            Extract<AntigravityTokenExchangeResult, { type: 'success' }>
          > = []
          const noBrowser =
            inputs.noBrowser === 'true' || inputs['no-browser'] === 'true'
          const useManualMode = noBrowser || shouldSkipLocalServer()

          // Check for existing accounts and prompt user for login mode
          let startFresh = true
          let refreshAccountIndex: number | undefined
          const existingStorage = await loadAccounts()
          if (existingStorage && existingStorage.accounts.length > 0) {
            let menuResult: Awaited<ReturnType<typeof promptLoginMode>>
            while (true) {
              const now = Date.now()
              const existingAccounts = existingStorage.accounts.map(
                (acc, idx) => {
                  let status:
                    | 'active'
                    | 'rate-limited'
                    | 'expired'
                    | 'verification-required'
                    | 'ineligible'
                    | 'unknown' = 'unknown'

                  if (acc.accountIneligible) {
                    status = 'ineligible'
                  } else if (acc.verificationRequired) {
                    status = 'verification-required'
                  } else {
                    const rateLimits = acc.rateLimitResetTimes
                    if (rateLimits) {
                      const isRateLimited = Object.values(rateLimits).some(
                        (resetTime) =>
                          typeof resetTime === 'number' && resetTime > now,
                      )
                      if (isRateLimited) {
                        status = 'rate-limited'
                      } else {
                        status = 'active'
                      }
                    } else {
                      status = 'active'
                    }

                    if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                      status = 'rate-limited'
                    }
                  }

                  const cooldownMs =
                    acc.coolingDownUntil && acc.coolingDownUntil > now
                      ? acc.coolingDownUntil - now
                      : undefined

                  // Age-gate quota data: ignore cached quota older than 60 minutes
                  // to prevent stale exhaustion data from persisting in the UI.
                  // AccountManager applies the same protection during account selection.
                  const DISPLAY_QUOTA_MAX_AGE_MS = 60 * 60 * 1000
                  const quotaIsStale =
                    acc.cachedQuotaUpdatedAt == null ||
                    now - acc.cachedQuotaUpdatedAt > DISPLAY_QUOTA_MAX_AGE_MS
                  const displayQuota = quotaIsStale
                    ? undefined
                    : acc.cachedQuota
                  const displayPerModelQuota = quotaIsStale
                    ? undefined
                    : acc.cachedPerModelQuota

                  if (status === 'active' && displayQuota) {
                    const groups = Object.values(displayQuota)
                    const allExhausted =
                      groups.length > 0 &&
                      groups.every(
                        (group) =>
                          typeof group.remainingFraction === 'number' &&
                          group.remainingFraction <= 0,
                      )
                    if (allExhausted) {
                      status = 'rate-limited'
                    }
                  }

                  return {
                    email: acc.email,
                    index: idx,
                    addedAt: acc.addedAt,
                    lastUsed: acc.lastUsed,
                    status,
                    isCurrentAccount:
                      idx === (existingStorage.activeIndex ?? 0),
                    enabled: acc.enabled !== false,
                    quotaSummary: quotaIsStale
                      ? undefined
                      : formatCachedQuotaSummary(acc),
                    cooldownMs,
                    cooldownReason: cooldownMs ? acc.cooldownReason : undefined,
                    cachedQuota: displayQuota,
                    cachedPerModelQuota: displayPerModelQuota,
                    fingerprintHistory: acc.fingerprintHistory,
                  }
                },
              )

              menuResult = await promptLoginMode(existingAccounts)

              if (menuResult.mode === 'check') {
                console.log('\n📊 Checking quotas for all accounts...\n')
                clearProvisionFailedKeys()
                // Manual quota dialog must always bypass backoff so the
                // user sees fresh numbers even if a background refresh
                // recently failed.
                const results = await quotaManager.refreshAccounts(
                  existingStorage.accounts,
                  {
                    indexFor: (account) =>
                      existingStorage.accounts.indexOf(account),
                    force: true,
                  },
                )
                // Collect quota cache updates keyed by refresh token so a
                // concurrent add cannot shift our index and let us
                // overwrite the wrong account's quota cache.
                const quotaUpdates = new Map<
                  string,
                  {
                    quota?: AccountMetadataV3['cachedQuota']
                    perModel?: AccountMetadataV3['cachedPerModelQuota']
                    updatedAccount?: AccountMetadataV3
                    updatedAt: number
                  }
                >()

                for (const res of results) {
                  const label = res.email || `Account ${res.index + 1}`
                  const disabledStr = res.disabled ? ' (disabled)' : ''
                  console.log(
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                  )
                  console.log(`  ${label}${disabledStr}`)
                  console.log(
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                  )

                  if (res.status === 'error') {
                    console.log(`  ❌ Error: ${res.error}\n`)
                    continue
                  }

                  // ANSI color codes
                  const colors = {
                    red: '\x1b[31m',
                    orange: '\x1b[33m', // Yellow/orange
                    green: '\x1b[32m',
                    reset: '\x1b[0m',
                  }

                  // Get color based on remaining percentage
                  const getColor = (remaining?: number): string => {
                    if (typeof remaining !== 'number') return colors.reset
                    if (remaining < 0.2) return colors.red
                    if (remaining < 0.6) return colors.orange
                    return colors.green
                  }

                  // Helper to create colored progress bar
                  const createProgressBar = (
                    remaining?: number,
                    width: number = 20,
                  ): string => {
                    if (typeof remaining !== 'number')
                      return '░'.repeat(width) + ' ???'
                    const filled = Math.round(remaining * width)
                    const empty = width - filled
                    const color = getColor(remaining)
                    const bar = `${color}${'█'.repeat(filled)}${colors.reset}${'░'.repeat(empty)}`
                    const pct =
                      `${color}${Math.round(remaining * 100)}%${colors.reset}`.padStart(
                        4 + color.length + colors.reset.length,
                      )
                    return `${bar} ${pct}`
                  }

                  // Helper to format reset time with days support
                  const formatReset = (
                    resetTime?: string,
                    remainingFraction?: number,
                  ): string => {
                    if (!resetTime) return ''
                    const ms = Date.parse(resetTime) - Date.now()
                    if (ms <= 0) {
                      // If quota is 0% and reset time is in the past, the model is
                      // likely paywalled / permanently unavailable on this quota pool
                      return remainingFraction !== undefined &&
                        remainingFraction <= 0
                        ? ' (paid only)'
                        : ' (resetting...)'
                    }
                    const hours = ms / (1000 * 60 * 60)
                    if (hours >= 24) {
                      const days = Math.floor(hours / 24)
                      const remainingHours = Math.floor(hours % 24)
                      if (remainingHours > 0) {
                        return ` (resets in ${days}d ${remainingHours}h)`
                      }
                      return ` (resets in ${days}d)`
                    }
                    return ` (resets in ${formatWaitTime(ms)})`
                  }

                  // Display Gemini CLI Quota first (as requested - swap order)
                  const hasGeminiCli =
                    res.geminiCliQuota && res.geminiCliQuota.models.length > 0
                  console.log(`\n  ┌─ Gemini CLI Quota`)
                  if (!hasGeminiCli) {
                    const errorMsg =
                      res.geminiCliQuota?.error ||
                      'No Gemini CLI quota available'
                    console.log(`  │  └─ ${errorMsg}`)
                  } else {
                    const models = res.geminiCliQuota!.models
                    models.forEach((model, idx) => {
                      const isLast = idx === models.length - 1
                      const connector = isLast ? '└─' : '├─'
                      const bar = createProgressBar(model.remainingFraction)
                      const reset = formatReset(
                        model.resetTime,
                        model.remainingFraction,
                      )
                      const status = classifyGroupStatus({
                        remainingFraction: model.remainingFraction,
                        resetTime: model.resetTime,
                        modelCount: 1,
                      })
                      const badge = formatQuotaStatusBadge(status)
                      const modelName = model.modelId.padEnd(29)
                      console.log(
                        `  │  ${connector} ${modelName} ${bar} ${badge}${reset}`,
                      )
                    })
                  }

                  // Display Antigravity Quota second
                  const hasAntigravity =
                    res.quota && Object.keys(res.quota.groups).length > 0
                  console.log(`  │`)
                  console.log(`  └─ Antigravity Quota`)
                  if (!hasAntigravity) {
                    const errorMsg =
                      res.quota?.error || 'No quota information available'
                    console.log(`     └─ ${errorMsg}`)
                  } else {
                    const groups = res.quota!.groups
                    const groupEntries = [
                      { name: 'Claude', data: groups.claude },
                      {
                        name: 'Gemini 3 Pro',
                        data: groups['gemini-pro'],
                      },
                      {
                        name: 'Gemini 3 Flash',
                        data: groups['gemini-flash'],
                      },
                      { name: 'GPT-OSS', data: groups['gpt-oss'] },
                    ].filter((g) => g.data)

                    groupEntries.forEach((g, idx) => {
                      const isLast = idx === groupEntries.length - 1
                      const connector = isLast ? '└─' : '├─'
                      const bar = createProgressBar(g.data!.remainingFraction)
                      const reset = formatReset(
                        g.data!.resetTime,
                        g.data!.remainingFraction,
                      )
                      const status = classifyGroupStatus(g.data!)
                      const badge = formatQuotaStatusBadge(status)
                      const modelName = g.name.padEnd(29)
                      console.log(
                        `     ${connector} ${modelName} ${bar} ${badge}${reset}`,
                      )
                    })
                  }
                  console.log('')

                  // Cache quota data for soft quota protection
                  const targetRefreshToken =
                    existingStorage.accounts[res.index]?.refreshToken
                  if (!targetRefreshToken) continue
                  const updatedAt = Date.now()
                  const existing = quotaUpdates.get(targetRefreshToken)
                  quotaUpdates.set(targetRefreshToken, {
                    quota: res.quota?.groups,
                    perModel: res.quota?.perModel,
                    updatedAccount: res.updatedAccount,
                    updatedAt:
                      existing && existing.updatedAt > updatedAt
                        ? existing.updatedAt
                        : updatedAt,
                  })
                }
                if (quotaUpdates.size > 0) {
                  await accountAccess.mutateAccounts((current) => {
                    let changed = false
                    for (const [refreshToken, update] of quotaUpdates) {
                      const idx = current.accounts.findIndex(
                        (acc) => acc.refreshToken === refreshToken,
                      )
                      if (idx === -1) continue
                      const target = current.accounts[idx]
                      if (!target) continue
                      current.accounts[idx] = {
                        ...target,
                        ...(update.updatedAccount ?? {}),
                        cachedQuota: update.quota,
                        cachedPerModelQuota: update.perModel,
                        cachedQuotaUpdatedAt: update.updatedAt,
                      }
                      changed = true
                    }
                    return changed ? current : current
                  })
                }
                console.log('')
                continue
              }

              if (menuResult.mode === 'doctor') {
                const auth = cachedGetAuth
                  ? await cachedGetAuth().catch(() => undefined)
                  : undefined
                const versionResolution = getAntigravityVersionResolution()
                const report = createAuthDoctorReport({
                  auth,
                  storage: existingStorage,
                  runtime: {
                    antigravityVersion: versionResolution.version,
                    antigravityVersionSource: versionResolution.source,
                  },
                })
                console.log(`\n${formatAuthDoctorReport(report)}\n`)
                continue
              }

              if (menuResult.mode === 'manage') {
                if (menuResult.toggleAccountIndex !== undefined) {
                  const acc =
                    existingStorage.accounts[menuResult.toggleAccountIndex]
                  if (acc) {
                    const shouldEnable = acc.enabled === false
                    if (shouldEnable && acc.accountIneligible) {
                      console.log(
                        `\n${acc.email || `Account ${menuResult.toggleAccountIndex + 1}`} remains disabled. ` +
                          'Use Verify accounts to recheck eligibility.\n',
                      )
                      continue
                    }
                    if (acc.refreshToken) {
                      await mutateAccountByRefreshToken(
                        acc.refreshToken,
                        (target) => {
                          target.enabled = shouldEnable
                          return true
                        },
                      )
                    }
                    lifecycle
                      .getAccountManager()
                      ?.setAccountEnabled(
                        menuResult.toggleAccountIndex,
                        shouldEnable,
                      )
                    console.log(
                      `\nAccount ${acc.email || menuResult.toggleAccountIndex + 1} ${shouldEnable ? 'enabled' : 'disabled'}.\n`,
                    )
                  }
                }
                continue
              }

              if (
                menuResult.mode === 'verify' ||
                menuResult.mode === 'verify-all'
              ) {
                const verifyAll =
                  menuResult.mode === 'verify-all' ||
                  menuResult.verifyAll === true

                if (verifyAll) {
                  if (existingStorage.accounts.length === 0) {
                    console.log('\nNo accounts available to verify.\n')
                    continue
                  }

                  console.log(
                    `\nChecking verification status for ${existingStorage.accounts.length} account(s)...\n`,
                  )

                  let okCount = 0
                  let blockedCount = 0
                  let ineligibleCount = 0
                  let errorCount = 0

                  const blockedResults: Array<{
                    label: string
                    message: string
                    verifyUrl?: string
                  }> = []

                  for (let i = 0; i < existingStorage.accounts.length; i++) {
                    const account = existingStorage.accounts[i]
                    if (!account) continue

                    const label = account.email || `Account ${i + 1}`
                    process.stdout.write(
                      `- [${i + 1}/${existingStorage.accounts.length}] ${label} ... `,
                    )

                    const verification = await verifyAccountAccess(account)
                    if (verification.status === 'ok') {
                      const wasAccessBlocked =
                        account.verificationRequired === true ||
                        account.accountIneligible === true
                      if (account.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account.refreshToken,
                          (acc) =>
                            clearStoredAccountAccessBlocks(acc, true).changed,
                        )
                      }
                      lifecycle
                        .getAccountManager()
                        ?.clearAccountAccessBlocks(i, wasAccessBlocked)
                      okCount += 1
                      console.log('ok')
                      continue
                    }

                    if (verification.status === 'verification-required') {
                      if (account.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account.refreshToken,
                          (acc) =>
                            markStoredAccountVerificationRequired(
                              acc,
                              verification.message,
                              verification.verifyUrl,
                            ),
                        )
                      }
                      lifecycle
                        .getAccountManager()
                        ?.markAccountVerificationRequired(
                          i,
                          verification.message,
                          verification.verifyUrl,
                        )

                      blockedCount += 1
                      console.log('needs verification')
                      const verifyUrl =
                        verification.verifyUrl ?? account.verificationUrl
                      blockedResults.push({
                        label,
                        message: verification.message,
                        verifyUrl,
                      })
                      continue
                    }

                    if (verification.status === 'ineligible') {
                      if (account.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account.refreshToken,
                          (acc) =>
                            markStoredAccountIneligible(
                              acc,
                              verification.message,
                            ),
                        )
                      }
                      lifecycle
                        .getAccountManager()
                        ?.markAccountIneligible(i, verification.message)
                      ineligibleCount += 1
                      console.log('ineligible')
                      continue
                    }

                    errorCount += 1
                    console.log(`error (${verification.message})`)
                  }

                  console.log(
                    `\nVerification summary: ${okCount} ready, ${blockedCount} need verification, ` +
                      `${ineligibleCount} ineligible, ${errorCount} errors.`,
                  )

                  if (blockedResults.length > 0) {
                    console.log('\nAccounts needing verification:')
                    for (const result of blockedResults) {
                      console.log(`\n- ${result.label}`)
                      console.log(`  ${result.message}`)
                      if (result.verifyUrl) {
                        console.log(`  URL: ${result.verifyUrl}`)
                      } else {
                        console.log('  URL: not provided by API response')
                      }
                    }
                    console.log('')
                  } else {
                    console.log('')
                  }

                  continue
                }

                let verifyAccountIndex = menuResult.verifyAccountIndex
                if (verifyAccountIndex === undefined) {
                  verifyAccountIndex =
                    await promptAccountIndexForVerification(existingAccounts)
                }

                if (verifyAccountIndex === undefined) {
                  console.log('\nVerification cancelled.\n')
                  continue
                }

                const account = existingStorage.accounts[verifyAccountIndex]
                if (!account) {
                  console.log(
                    `\nAccount ${verifyAccountIndex + 1} not found.\n`,
                  )
                  continue
                }

                const label =
                  account.email || `Account ${verifyAccountIndex + 1}`
                console.log(`\nChecking verification status for ${label}...\n`)

                const verification = await verifyAccountAccess(account)

                if (verification.status === 'ok') {
                  const wasAccessBlocked =
                    account.verificationRequired === true ||
                    account.accountIneligible === true
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) =>
                        clearStoredAccountAccessBlocks(acc, true).changed,
                    )
                  }
                  lifecycle
                    .getAccountManager()
                    ?.clearAccountAccessBlocks(
                      verifyAccountIndex,
                      wasAccessBlocked,
                    )

                  if (wasAccessBlocked) {
                    console.log(
                      `✓ ${label} is ready for requests and has been re-enabled.\n`,
                    )
                  } else {
                    console.log(`✓ ${label} is ready for requests.\n`)
                  }
                  continue
                }

                if (verification.status === 'verification-required') {
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) =>
                        markStoredAccountVerificationRequired(
                          acc,
                          verification.message,
                          verification.verifyUrl,
                        ),
                    )
                  }
                  lifecycle
                    .getAccountManager()
                    ?.markAccountVerificationRequired(
                      verifyAccountIndex,
                      verification.message,
                      verification.verifyUrl,
                    )

                  const verifyUrl =
                    verification.verifyUrl ?? account.verificationUrl
                  console.log(
                    `⚠ ${label} needs Google verification before it can be used.`,
                  )
                  if (verification.message) {
                    console.log(verification.message)
                  }
                  console.log(
                    `${label} has been disabled until verification is completed.`,
                  )
                  if (verifyUrl) {
                    console.log(`\nVerification URL:\n${verifyUrl}\n`)
                    if (await promptOpenVerificationUrl()) {
                      const opened = await openBrowser(verifyUrl)
                      if (opened) {
                        console.log(
                          'Opened verification URL in your browser.\n',
                        )
                      } else {
                        console.log(
                          'Could not open browser automatically. Please open the URL manually.\n',
                        )
                      }
                    }
                  } else {
                    console.log(
                      'No verification URL was returned. Try re-authenticating this account.\n',
                    )
                  }
                  continue
                }

                if (verification.status === 'ineligible') {
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) =>
                        markStoredAccountIneligible(acc, verification.message),
                    )
                  }
                  lifecycle
                    .getAccountManager()
                    ?.markAccountIneligible(
                      verifyAccountIndex,
                      verification.message,
                    )
                  console.log(
                    `⚠ ${label} is not eligible for Antigravity and has been disabled.`,
                  )
                  console.log(`${verification.message}\n`)
                  continue
                }

                console.log(`✗ ${label}: ${verification.message}\n`)
                continue
              }

              break
            }

            if (menuResult.mode === 'cancel') {
              return {
                url: '',
                instructions: 'Authentication cancelled',
                method: 'auto',
                callback: async () => ({
                  type: 'failed',
                  error: 'Authentication cancelled',
                }),
              }
            }

            if (menuResult.deleteAccountIndex !== undefined) {
              // Locate the to-be-deleted account by refresh token so a
              // concurrent add cannot shift our index and let us
              // remove the wrong account.
              const targetRefreshToken =
                existingStorage.accounts[menuResult.deleteAccountIndex]
                  ?.refreshToken
              const nextStorage = await accountAccess.mutateAccounts(
                (current) => ({
                  ...current,
                  accounts: targetRefreshToken
                    ? current.accounts.filter(
                        (account) =>
                          account.refreshToken !== targetRefreshToken,
                      )
                    : current.accounts.filter(
                        (_, index) => index !== menuResult.deleteAccountIndex,
                      ),
                  activeIndex: 0,
                  activeIndexByFamily: { claude: 0, gemini: 0 },
                }),
              )
              const updatedAccounts = nextStorage.accounts
              // Sync in-memory state so deleted account stops being used immediately
              lifecycle
                .getAccountManager()
                ?.removeAccountByIndex(menuResult.deleteAccountIndex)
              console.log('\nAccount deleted.\n')

              if (updatedAccounts.length > 0) {
                const fallbackAccount = updatedAccounts[0]
                if (fallbackAccount?.refreshToken) {
                  const fallbackResult =
                    buildAuthSuccessFromStoredAccount(fallbackAccount)
                  try {
                    await client.auth.set({
                      path: { id: providerId },
                      body: {
                        type: 'oauth',
                        refresh: fallbackResult.refresh,
                        access: '',
                        expires: 0,
                      },
                    })
                  } catch (storeError) {
                    log.error(
                      'Failed to update stored Antigravity OAuth credentials',
                      { error: String(storeError) },
                    )
                  }

                  const label = fallbackAccount.email || `Account ${1}`
                  return {
                    url: '',
                    instructions: `Account deleted. Using ${label} for future requests.`,
                    method: 'auto',
                    callback: async () => fallbackResult,
                  }
                }
              }

              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: {
                    type: 'oauth',
                    refresh: '',
                    access: '',
                    expires: 0,
                  },
                })
              } catch (storeError) {
                log.error(
                  'Failed to clear stored Antigravity OAuth credentials',
                  { error: String(storeError) },
                )
              }

              return {
                url: '',
                instructions:
                  'All accounts deleted. Run `opencode auth login` to reauthenticate.',
                method: 'auto',
                callback: async () => ({
                  type: 'failed',
                  error: 'All accounts deleted. Reauthentication required.',
                }),
              }
            }

            if (menuResult.refreshAccountIndex !== undefined) {
              refreshAccountIndex = menuResult.refreshAccountIndex
              const refreshEmail =
                existingStorage.accounts[refreshAccountIndex]?.email
              console.log(
                `\nRe-authenticating ${refreshEmail || 'account'}...\n`,
              )
              startFresh = false
            }

            if (menuResult.deleteAll) {
              await clearAccounts()
              console.log('\nAll accounts deleted.\n')
              startFresh = true
              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: {
                    type: 'oauth',
                    refresh: '',
                    access: '',
                    expires: 0,
                  },
                })
              } catch (storeError) {
                log.error(
                  'Failed to clear stored Antigravity OAuth credentials',
                  { error: String(storeError) },
                )
              }
            } else {
              startFresh = menuResult.mode === 'fresh'
            }

            if (startFresh && !menuResult.deleteAll) {
              console.log(
                '\nStarting fresh - existing accounts will be replaced.\n',
              )
            } else if (!startFresh) {
              console.log('\nAdding to existing accounts.\n')
            }
          }

          while (accounts.length < MAX_OAUTH_ACCOUNTS) {
            console.log(
              `\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`,
            )

            const projectId = await promptProjectId()

            const result =
              await (async (): Promise<AntigravityTokenExchangeResult> => {
                const authorization = await authorizeAntigravity(projectId)
                const fallbackState = getStateFromAuthorizationUrl(
                  authorization.url,
                )

                console.log('\nOAuth URL:\n' + authorization.url + '\n')

                if (useManualMode) {
                  const browserOpened = await openBrowser(authorization.url)
                  if (!browserOpened) {
                    console.log('Could not open browser automatically.')
                    console.log(
                      'Please open the URL above manually in your local browser.\n',
                    )
                  }
                  return promptManualOAuthInput(fallbackState)
                }

                let listener: OAuthListener | null = null
                if (!isHeadless) {
                  try {
                    listener = await startOAuthListener()
                  } catch {
                    listener = null
                  }
                }

                if (!isHeadless) {
                  await openBrowser(authorization.url)
                }

                if (listener) {
                  try {
                    const SOFT_TIMEOUT_MS = 30000
                    const callbackPromise = listener.waitForCallback()
                    const timeoutPromise = new Promise<never>((_, reject) =>
                      setTimeout(
                        () => reject(new Error('SOFT_TIMEOUT')),
                        SOFT_TIMEOUT_MS,
                      ),
                    )

                    let callbackUrl: URL
                    try {
                      callbackUrl = await Promise.race([
                        callbackPromise,
                        timeoutPromise,
                      ])
                    } catch (err) {
                      if (
                        err instanceof Error &&
                        err.message === 'SOFT_TIMEOUT'
                      ) {
                        console.log(
                          '\n⏳ Automatic callback not received after 30 seconds.',
                        )
                        console.log(
                          'You can paste the redirect URL manually.\n',
                        )
                        console.log('OAuth URL (in case you need it again):')
                        console.log(authorization.url + '\n')

                        try {
                          await listener.close()
                        } catch {}

                        return promptManualOAuthInput(fallbackState)
                      }
                      throw err
                    }

                    const params = extractOAuthCallbackParams(
                      callbackUrl,
                      fallbackState,
                    )
                    if ('error' in params) {
                      return {
                        type: 'failed',
                        error: params.error,
                      }
                    }

                    return exchangeAntigravity(params.code, params.state)
                  } catch (error) {
                    if (
                      error instanceof Error &&
                      error.message !== 'SOFT_TIMEOUT'
                    ) {
                      return {
                        type: 'failed',
                        error: error.message,
                      }
                    }
                    return {
                      type: 'failed',
                      error:
                        error instanceof Error
                          ? error.message
                          : 'Unknown error',
                    }
                  } finally {
                    try {
                      await listener.close()
                    } catch {}
                  }
                }

                return promptManualOAuthInput(fallbackState)
              })()

            if (result.type === 'failed') {
              if (accounts.length === 0) {
                return {
                  url: '',
                  instructions: `Authentication failed: ${result.error}`,
                  method: 'auto',
                  callback: async () => result,
                }
              }

              console.warn(
                `[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`,
              )
              break
            }

            accounts.push(result)

            try {
              await client.tui.showToast({
                body: {
                  message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ''}`,
                  variant: 'success',
                },
              })
            } catch {}

            try {
              if (refreshAccountIndex !== undefined) {
                const currentStorage = await loadAccounts()
                if (currentStorage) {
                  const targetRefreshToken =
                    currentStorage.accounts[refreshAccountIndex]?.refreshToken
                  const parts = parseRefreshParts(result.refresh)
                  if (targetRefreshToken && parts.refreshToken) {
                    // Build the replacement INSIDE the locked
                    // callback from the freshest stored account.
                    // A pre-lock snapshot would clobber any
                    // concurrent quota/verification/fingerprint
                    // update that landed between loadAccounts
                    // and the mutate call.
                    await accountAccess.mutateAccounts((current) => {
                      const idx = current.accounts.findIndex(
                        (acc) => acc.refreshToken === targetRefreshToken,
                      )
                      if (idx === -1) return current
                      const target = current.accounts[idx]
                      if (!target) return current
                      current.accounts[idx] = {
                        ...target,
                        email: result.email ?? target.email,
                        refreshToken: parts.refreshToken,
                        projectId: parts.projectId ?? target.projectId,
                        managedProjectId:
                          parts.managedProjectId ?? target.managedProjectId,
                        addedAt: target.addedAt ?? Date.now(),
                        lastUsed: Date.now(),
                      }
                      return current
                    })
                  }
                }
              } else {
                const isFirstAccount = accounts.length === 1
                await persistAccountPool([result], isFirstAccount && startFresh)
              }
            } catch {}

            if (refreshAccountIndex !== undefined) {
              break
            }

            if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
              break
            }

            // Get the actual deduplicated account count from storage for the prompt
            let currentAccountCount = accounts.length
            try {
              const currentStorage = await loadAccounts()
              if (currentStorage) {
                currentAccountCount = currentStorage.accounts.length
              }
            } catch {
              // Fall back to accounts.length if we can't read storage
            }

            const addAnother =
              await promptAddAnotherAccount(currentAccountCount)
            if (!addAnother) {
              break
            }
          }

          const primary = accounts[0]
          if (!primary) {
            return {
              url: '',
              instructions: 'Authentication cancelled',
              method: 'auto',
              callback: async () => ({
                type: 'failed',
                error: 'Authentication cancelled',
              }),
            }
          }

          let actualAccountCount = accounts.length
          try {
            const finalStorage = await loadAccounts()
            if (finalStorage) {
              actualAccountCount = finalStorage.accounts.length
            }
          } catch {}

          const successMessage =
            refreshAccountIndex !== undefined
              ? `Token refreshed successfully.`
              : `Multi-account setup complete (${actualAccountCount} account(s)).`

          return {
            url: '',
            instructions: successMessage,
            method: 'auto',
            callback: async (): Promise<AntigravityTokenExchangeResult> =>
              primary,
          }
        }

        // TUI flow (`/connect`) does not support per-account prompts.
        // Default to adding new accounts (non-destructive).
        // Users can run `opencode auth logout` first if they want a fresh start.
        const projectId = ''

        // Check existing accounts count for toast message
        const existingStorage = await loadAccounts()
        const existingCount = existingStorage?.accounts.length ?? 0

        const useManualFlow = isHeadless || shouldSkipLocalServer()

        let listener: OAuthListener | null = null
        if (!useManualFlow) {
          try {
            listener = await startOAuthListener()
          } catch {
            listener = null
          }
        }

        const authorization = await authorizeAntigravity(projectId)
        const fallbackState = getStateFromAuthorizationUrl(authorization.url)

        if (!useManualFlow) {
          const browserOpened = await openBrowser(authorization.url)
          if (!browserOpened) {
            listener?.close().catch(() => {})
            listener = null
          }
        }

        if (listener) {
          return {
            url: authorization.url,
            instructions:
              "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
            method: 'auto',
            callback: async (): Promise<AntigravityTokenExchangeResult> => {
              const CALLBACK_TIMEOUT_MS = 30000
              try {
                const callbackPromise = listener.waitForCallback()
                const timeoutPromise = new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error('CALLBACK_TIMEOUT')),
                    CALLBACK_TIMEOUT_MS,
                  ),
                )

                let callbackUrl: URL
                try {
                  callbackUrl = await Promise.race([
                    callbackPromise,
                    timeoutPromise,
                  ])
                } catch (err) {
                  if (
                    err instanceof Error &&
                    err.message === 'CALLBACK_TIMEOUT'
                  ) {
                    return {
                      type: 'failed',
                      error:
                        'Callback timeout - please use CLI with --no-browser flag for manual input',
                    }
                  }
                  throw err
                }

                const params = extractOAuthCallbackParams(
                  callbackUrl,
                  fallbackState,
                )
                if ('error' in params) {
                  return {
                    type: 'failed',
                    error: params.error,
                  }
                }

                const result = await exchangeAntigravity(
                  params.code,
                  params.state,
                )
                if (result.type === 'success') {
                  try {
                    await persistAccountPool([result], false)
                  } catch {}

                  const newTotal = existingCount + 1
                  const toastMessage =
                    existingCount > 0
                      ? `Added account${result.email ? ` (${result.email})` : ''} - ${newTotal} total`
                      : `Authenticated${result.email ? ` (${result.email})` : ''}`

                  try {
                    await client.tui.showToast({
                      body: {
                        message: toastMessage,
                        variant: 'success',
                      },
                    })
                  } catch {}
                }

                return result
              } catch (error) {
                return {
                  type: 'failed',
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                }
              } finally {
                try {
                  await listener.close()
                } catch {}
              }
            },
          }
        }

        return {
          url: authorization.url,
          instructions:
            'Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.',
          method: 'code',
          callback: async (
            codeInput: string,
          ): Promise<AntigravityTokenExchangeResult> => {
            const params = parseOAuthCallbackInput(codeInput, fallbackState)
            if ('error' in params) {
              return { type: 'failed', error: params.error }
            }

            const result = await exchangeAntigravity(params.code, params.state)
            if (result.type === 'success') {
              try {
                // TUI flow adds to existing accounts (non-destructive)
                await persistAccountPool([result], false)
              } catch {
                // ignore
              }

              // Show appropriate toast message
              const newTotal = existingCount + 1
              const toastMessage =
                existingCount > 0
                  ? `Added account${result.email ? ` (${result.email})` : ''} - ${newTotal} total`
                  : `Authenticated${result.email ? ` (${result.email})` : ''}`

              try {
                await client.tui.showToast({
                  body: {
                    message: toastMessage,
                    variant: 'success',
                  },
                })
              } catch {
                // TUI may not be available
              }
            }

            return result
          },
        }
      },
    },
    {
      label: 'Manually enter API Key',
      type: 'api',
    },
  ]
}
