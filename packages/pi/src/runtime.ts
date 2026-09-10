import {
  AccountManager,
  type AccountMetadataV3,
  type AccountModelFamily,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  type AntigravityTokenExchangeResult,
  accessTokenExpired,
  aggregateQuota,
  aggregateQuotaSummary,
  computeSoftQuotaCacheTtlMs,
  createQuotaManager,
  defaultAccountStorageStore,
  defaultKeyOf,
  ensureProjectContext,
  extractRateLimitBodyInfo,
  type FetchQuotaSummaryOptions,
  fetchAvailableModels,
  fetchQuotaSummary,
  fetchWithActiveTimeout,
  formatRefreshParts,
  getHealthTracker,
  getTokenTracker,
  loadAccountStorage,
  type ManagedAccount,
  mutateAccountStorage,
  type OAuthAuthDetails,
  parseRateLimitReason,
  parseRefreshParts,
  persistAccountPoolAtPath,
  refreshAntigravityToken,
  resolveQuotaGroup,
  retryAfterMsFromResponse,
} from '@cortexkit/antigravity-auth-core'
import type { OAuthCredentials } from '@earendil-works/pi-ai'
import { getPiAntigravityAuthFile } from './paths.ts'
import { readSettings } from './settings.ts'

const QUOTA_REFRESH_MS = 30 * 60_000
const QUOTA_TTL_MS = computeSoftQuotaCacheTtlMs('auto', 30)
type LoginResult = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

class AccountUnavailable extends Error {}
class CredentialRefreshFailed extends Error {}

function attemptKey(account: ManagedAccount): string {
  return defaultKeyOf({
    ...account.parts,
    email: account.email?.trim().toLowerCase(),
    addedAt: account.addedAt,
    lastUsed: account.lastUsed,
  })
}

export interface PiRuntimeOptions {
  path?: string
  pid?: number
  refreshToken?: typeof refreshAntigravityToken
}

/** Host wiring only: selection/scoring, quota aggregation, cooldowns and all
 * durable writes remain owned by core. No provider request runs under a lock.
 * Token refresh does, so a rotated token cannot be overwritten by a stale peer.
 */
export class PiAccountRuntime {
  readonly path: string
  readonly settingsPath: string
  private manager?: AccountManager
  private readonly credentials = new Map<string, OAuthAuthDetails>()
  private readonly refreshToken: typeof refreshAntigravityToken
  private readonly pid: number
  private selected?: string
  private legacy?: OAuthCredentials
  private readonly quota

  constructor(options: PiRuntimeOptions = {}) {
    this.path = options.path ?? getPiAntigravityAuthFile()
    this.settingsPath = `${this.path}.config.json`
    this.pid = options.pid ?? process.pid
    this.refreshToken = options.refreshToken ?? refreshAntigravityToken
    this.quota = createQuotaManager({
      keyOf: defaultKeyOf,
      fetchAccountQuota: async (account, signal) => {
        try {
          const auth = await this.credentialFor(account.refreshToken)
          signal.throwIfAborted()
          const context = await ensureProjectContext(auth)
          signal.throwIfAborted()
          const parts = parseRefreshParts(context.auth.refresh)
          const fetchVia: NonNullable<FetchQuotaSummaryOptions['fetchVia']> = (
            url,
            init,
            extra,
          ) =>
            fetchWithActiveTimeout(
              url,
              {
                ...init,
                signal: extra.signal
                  ? AbortSignal.any([signal, extra.signal])
                  : signal,
              },
              { timeoutMs: extra.timeoutMs },
            )
          const common = {
            accessToken: context.auth.access ?? '',
            projectId: context.effectiveProjectId,
            managedProjectId: parts.managedProjectId,
            endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
            fetchVia,
          }
          let quota: ReturnType<typeof aggregateQuota>
          try {
            quota = aggregateQuotaSummary(
              (await fetchQuotaSummary(common)).summary,
            )
          } catch (error) {
            if (signal.aborted) throw error
            quota = aggregateQuota((await fetchAvailableModels(common)).models)
          }
          signal.throwIfAborted()
          const applied = await this.patch(
            { ...account, refreshToken: parts.refreshToken },
            (current) => {
              current.projectId = parts.projectId ?? current.projectId
              current.managedProjectId =
                parts.managedProjectId ?? current.managedProjectId
              current.cachedQuota = quota.groups
              current.cachedQuotaUpdatedAt = Date.now()
            },
          )
          if (!applied) throw new AccountUnavailable('Quota account changed')
          return { index: 0, status: 'ok', quota }
        } catch {
          // Provider bodies can contain credentials. Never relay them to quota
          // manager diagnostics or operator output.
          return {
            index: 0,
            status: 'error',
            error: 'Quota refresh failed; cached quota retained',
          }
        }
      },
    })
  }

  remember(credentials: OAuthCredentials): void {
    this.legacy = credentials
    this.credentials.set(parseRefreshParts(credentials.refresh).refreshToken, {
      type: 'oauth',
      ...credentials,
    })
  }

  async login(result: LoginResult): Promise<void> {
    if (this.legacy) await this.migrate(this.legacy)
    await persistAccountPoolAtPath(this.path, [result])
    this.remember({
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      email: result.email,
    })
  }

  /** Import the host credential only into a missing/empty pool. An existing
   * pool is authoritative: a stale auth.json must not re-add rotated accounts.
   */
  async migrate(credentials: OAuthCredentials): Promise<void> {
    this.remember(credentials)
    const parts = parseRefreshParts(credentials.refresh)
    if (!parts.refreshToken) return
    const stored = await loadAccountStorage(this.path)
    if (stored?.accounts.length) return
    await mutateAccountStorage(this.path, (current) => {
      if (current.accounts.length) return current
      current.accounts.push({
        ...parts,
        email:
          typeof credentials.email === 'string' ? credentials.email : undefined,
        addedAt: Date.now(),
        lastUsed: 0,
        enabled: true,
      })
      return current
    })
  }

  private async reload(): Promise<AccountManager> {
    const stored = (await loadAccountStorage(this.path)) ?? {
      version: 4 as const,
      accounts: [],
      activeIndex: 0,
    }
    const tokens = new Set(
      stored.accounts.map((account) => account.refreshToken),
    )
    for (const token of this.credentials.keys()) {
      if (!tokens.has(token)) this.credentials.delete(token)
    }
    if (this.manager) this.manager.reconcileStorage(stored)
    else
      this.manager = new AccountManager(undefined, stored, {
        store: defaultAccountStorageStore,
        storagePath: this.path,
        pid: this.pid,
        persistFingerprintUpdates: false,
      })
    return this.manager
  }

  private async patch(
    target: { email?: string; refreshToken: string },
    update: (account: AccountMetadataV3) => void,
  ): Promise<boolean> {
    let applied = false
    await mutateAccountStorage(this.path, (current) => {
      const email = target.email?.trim().toLowerCase()
      const matches = current.accounts.filter((entry) =>
        email
          ? entry.email?.trim().toLowerCase() === email
          : entry.refreshToken === target.refreshToken,
      )
      if (matches.length === 1 && matches[0]) {
        update(matches[0])
        applied = true
      }
      return current
    })
    return applied
  }

  private async credentialFor(
    token: string,
    signal?: AbortSignal,
  ): Promise<OAuthAuthDetails> {
    signal?.throwIfAborted()
    let auth: OAuthAuthDetails | undefined
    await mutateAccountStorage(this.path, async (current) => {
      signal?.throwIfAborted()
      const account = current.accounts.find(
        (entry) => entry.refreshToken === token,
      )
      if (
        !account ||
        account.enabled === false ||
        account.accountIneligible ||
        account.verificationRequired
      ) {
        throw new AccountUnavailable('Account changed or is disabled')
      }
      const cached = this.credentials.get(token)
      if (cached && !accessTokenExpired(cached)) {
        auth = { ...cached, refresh: formatRefreshParts(account) }
        return current
      }
      let refreshed: Awaited<ReturnType<typeof refreshAntigravityToken>>
      try {
        refreshed = await this.refreshToken(token, signal)
        signal?.throwIfAborted()
        if (
          !refreshed.access ||
          !refreshed.refresh ||
          !Number.isFinite(refreshed.expires)
        ) {
          throw new Error('Invalid refresh result')
        }
      } catch (error) {
        if (signal?.aborted) throw error
        throw new CredentialRefreshFailed(
          'Antigravity token refresh failed; re-authenticate the account',
        )
      }
      account.refreshToken = refreshed.refresh
      auth = {
        type: 'oauth',
        access: refreshed.access,
        expires: refreshed.expires,
        refresh: formatRefreshParts({
          ...account,
          refreshToken: refreshed.refresh,
        }),
      }
      return current
    })
    if (!auth) throw new AccountUnavailable('Account is unavailable')
    this.credentials.set(parseRefreshParts(auth.refresh).refreshToken, auth)
    return auth
  }

  /** Pi refreshes its host credential before stream dispatch. A failed last
   * login must not prevent a healthy pool member from reaching the runtime.
   */
  async refreshHost(
    credentials: OAuthCredentials,
    signal?: AbortSignal,
  ): Promise<OAuthCredentials> {
    signal?.throwIfAborted()
    await this.migrate(credentials)
    signal?.throwIfAborted()
    const manager = await this.reload()
    for (const account of manager.getEnabledAccounts()) {
      signal?.throwIfAborted()
      try {
        const auth = await this.credentialFor(
          account.parts.refreshToken,
          signal,
        )
        return {
          refresh: auth.refresh,
          access: auth.access ?? '',
          expires: auth.expires ?? 0,
        }
      } catch (error) {
        if (
          !(
            error instanceof CredentialRefreshFailed ||
            error instanceof AccountUnavailable
          )
        )
          throw error
        if (error instanceof CredentialRefreshFailed)
          await this.authFailure(account)
      }
    }
    throw new Error(
      'No usable Antigravity credentials; /login google-antigravity to re-authenticate',
    )
  }

  private async authFailure(account: ManagedAccount): Promise<void> {
    const current = this.currentAccount(account)
    if (current) getHealthTracker().recordFailure(current.index)
    this.manager?.markAccountCoolingDown(account, 60_000, 'auth-failure')
    const applied = await this.patch(
      { ...account.parts, email: account.email },
      (current) => {
        current.coolingDownUntil = Math.max(
          current.coolingDownUntil ?? 0,
          account.coolingDownUntil ?? 0,
        )
        current.cooldownReason = 'auth-failure'
      },
    )
    if (!applied)
      throw new AccountUnavailable('Account changed; cooldown not recorded')
  }

  async refreshQuota(force = false): Promise<number> {
    const accounts = (await loadAccountStorage(this.path))?.accounts ?? []
    const results = await this.quota.refreshAccounts(
      accounts.filter(
        (account) =>
          force ||
          account.cachedQuotaUpdatedAt == null ||
          Date.now() - account.cachedQuotaUpdatedAt >= QUOTA_REFRESH_MS,
      ),
      { force, indexFor: (account) => accounts.indexOf(account) },
    )
    return results.filter((result) => result.status === 'error').length
  }

  async dispatch(
    model: string,
    send: (
      auth: OAuthAuthDetails,
      account: ManagedAccount,
    ) => Promise<Response>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; account: ManagedAccount }> {
    signal?.throwIfAborted()
    if (this.legacy) await this.migrate(this.legacy)
    await this.refreshQuota()
    const config = await readSettings(this.settingsPath)
    const attempted = new Set<string>()
    // One extra selection tolerates a peer rotating a token between reload and
    // credential acquisition. Stable attempted identities still bound sends.
    const budget = (await this.reload()).getTotalAccountCount() + 1
    let lastError =
      'All Antigravity accounts are disabled, cooling down, or over cached quota'
    const family: AccountModelFamily =
      resolveQuotaGroup('gemini', model) === 'non-gemini' ? 'claude' : 'gemini'
    for (let attempt = 0; attempt < budget; attempt++) {
      signal?.throwIfAborted()
      const manager = await this.reload()
      const excluded = new Set(
        manager
          .getAccounts()
          .filter(
            (a) =>
              attempted.has(attemptKey(a)) ||
              a.verificationRequired ||
              a.accountIneligible,
          )
          .map((a) => a.index),
      )
      const account = manager.getCurrentOrNextForFamily(
        family,
        model,
        config.account_selection_strategy,
        'antigravity',
        config.pid_offset_enabled,
        80,
        QUOTA_TTL_MS,
        undefined,
        excluded,
      )
      if (!account) break
      let auth: OAuthAuthDetails
      try {
        auth = await this.credentialFor(account.parts.refreshToken)
      } catch (error) {
        if (
          !(
            error instanceof CredentialRefreshFailed ||
            error instanceof AccountUnavailable
          )
        )
          throw error
        lastError = error.message
        if (error instanceof CredentialRefreshFailed) {
          attempted.add(attemptKey(account))
          await this.authFailure(account)
        }
        continue
      }
      manager.updateFromAuth(account, auth)
      const token = account.parts.refreshToken
      attempted.add(attemptKey(account))
      const target = { ...account.parts, email: account.email }
      signal?.throwIfAborted()
      manager.markAccountUsed(account.index)
      const located = await this.patch(target, (current) => {
        current.lastUsed = Math.max(current.lastUsed, account.lastUsed)
        current.fingerprint ??= account.fingerprint
      })
      if (!located)
        throw new AccountUnavailable('Account changed before dispatch')
      const consumed = getTokenTracker().consume(account.index)
      let response: Response
      try {
        response = await send(auth, account)
      } catch (error) {
        const current = this.currentAccount(account)
        if (current) {
          if (consumed) getTokenTracker().refund(current.index)
          if (!signal?.aborted) getHealthTracker().recordFailure(current.index)
        }
        // Unknown transport failures may occur after upstream accepted work.
        // Surface them without replaying a potentially billable request.
        throw error
      }
      if (response.ok) {
        this.selected = token
        return { response, account }
      }
      const current = this.currentAccount(account)
      if (consumed && current) getTokenTracker().refund(current.index)
      if (![429, 503, 529, 500].includes(response.status))
        return { response, account }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      const info = extractRateLimitBodyInfo(body)
      manager.markRateLimitedWithReason(
        account,
        family,
        'antigravity',
        model,
        parseRateLimitReason(info.reason, info.message, response.status),
        info.retryDelayMs ?? retryAfterMsFromResponse(response),
      )
      const rateLimited = this.currentAccount(account)
      if (rateLimited) getHealthTracker().recordRateLimit(rateLimited.index)
      const applied = await this.patch(target, (current) => {
        for (const [key, until] of Object.entries(
          account.rateLimitResetTimes,
        )) {
          current.rateLimitResetTimes ??= {}
          current.rateLimitResetTimes[key] = Math.max(
            current.rateLimitResetTimes[key] ?? 0,
            until ?? 0,
          )
        }
      })
      if (!applied)
        throw new AccountUnavailable(
          `Antigravity HTTP ${response.status}; account changed; cooldown not recorded`,
        )
      lastError = `Antigravity HTTP ${response.status}; no eligible account remains (cooldown recorded)`
    }
    throw new Error(lastError)
  }

  private currentAccount(account: ManagedAccount): ManagedAccount | undefined {
    const matches =
      this.manager
        ?.getAccounts()
        .filter((entry) => attemptKey(entry) === attemptKey(account)) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }

  complete(account: ManagedAccount, success: boolean): void {
    const current = this.currentAccount(account)
    if (!current) return
    if (success) {
      this.manager?.markRequestSuccess(current)
      getHealthTracker().recordSuccess(current.index)
    } else getHealthTracker().recordFailure(current.index)
  }

  async setEnabled(index: number, enabled: boolean): Promise<void> {
    await mutateAccountStorage(this.path, (current) => {
      const account = current.accounts[index]
      if (!account) throw new Error('Unknown account; use /agy-accounts')
      if (
        enabled &&
        (account.accountIneligible || account.verificationRequired)
      ) {
        throw new Error(
          'Resolve upstream account eligibility or verification before enabling',
        )
      }
      account.enabled = enabled
      return current
    })
  }

  async describe(): Promise<string> {
    const manager = await this.reload()
    return (
      manager
        .getAccounts()
        .map((account) => {
          const email = account.email?.match(/^(.)([^@]*)@(.+)$/)
          const label = email
            ? `${email[1]}***@${email[3]}`
            : '(email unavailable)'
          const until = Math.max(
            account.coolingDownUntil ?? 0,
            ...Object.values(account.rateLimitResetTimes).map((n) => n ?? 0),
          )
          const quota =
            Object.entries(account.cachedQuota ?? {})
              .map(
                ([group, value]) =>
                  `${group}=${value.remainingFraction == null ? '?' : `${Math.round(value.remainingFraction * 100)}%`} remaining`,
              )
              .join(', ') || 'quota unknown'
          const age =
            account.cachedQuotaUpdatedAt == null
              ? ''
              : ` (${Date.now() - account.cachedQuotaUpdatedAt > QUOTA_TTL_MS ? 'stale' : 'cached'})`
          return `agy${account.index + 1} ${label} ${account.enabled ? 'enabled' : 'disabled'} health=${getHealthTracker().getScore(account.index)}${this.selected === account.parts.refreshToken ? ' selected' : ''} ${until > Date.now() ? `cooldown=${Math.ceil((until - Date.now()) / 1000)}s` : 'ready'} ${quota}${age}`
        })
        .join('\n') || 'No Antigravity accounts. Use /login google-antigravity.'
    )
  }

  async dispose(): Promise<void> {
    await this.quota.dispose()
    await this.manager?.dispose()
    this.credentials.clear()
  }
}
