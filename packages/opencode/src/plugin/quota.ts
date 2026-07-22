/**
 * OpenCode adapter for the harness-agnostic quota manager.
 *
 * Re-exports the core `QuotaManager` types and helpers so call sites in
 * `plugin.ts` and other modules don't need to switch imports. Also wires up
 * the host-specific fetch callback that handles:
 *   1. Token refresh via the existing `refreshAccessToken` path.
 *   2. Persisting rotated refresh tokens via `client.auth.set` (matching
 *      legacy behavior).
 *   3. Resolving project context via `ensureProjectContext`.
 *
 * The legacy `checkAccountsQuota(accounts, client, providerId)` export is
 * retained as a compatibility wrapper that creates a short-lived manager
 * with `force: true` — manual quota screens must always refresh, even if
 * the background manager has backed off.
 */

import {
  type AccountMetadataV3,
  type AccountQuotaResult,
  type FetchAccountQuota,
  type FetchAvailableModelsResponse,
  type GeminiCliQuotaSummary,
  type QuotaManager,
  type QuotaSummary,
  aggregateGeminiCliQuota,
  aggregateQuota,
  createQuotaManager,
  defaultKeyOf,
  fetchAvailableModels,
  fetchGeminiCliQuota,
} from '@cortexkit/antigravity-auth-core'

import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  buildGeminiCliUserAgent,
} from '../constants'
import {
  accessTokenExpired,
  formatRefreshParts,
  parseRefreshParts,
} from './auth'
import { logQuotaFetch, logQuotaStatus } from './debug'
import { buildAntigravityHarnessUserAgent } from './fingerprint'
import { ensureProjectContext } from './project'
import { refreshAccessToken } from './token'
import type { OAuthAuthDetails, PluginClient } from './types'

// Re-export the public surface so existing imports from `./quota` keep working.
export type {
  AccountQuotaResult,
  AccountQuotaStatus,
  GeminiCliQuotaModel,
  GeminiCliQuotaSummary,
  PerModelQuotaEntry,
  QuotaGroup,
  QuotaGroupSummary,
  QuotaManager,
  QuotaManagerOptions,
  QuotaSummary,
} from '@cortexkit/antigravity-auth-core'
export {
  classifyQuotaGroup,
  createQuotaManager,
  defaultKeyOf,
} from '@cortexkit/antigravity-auth-core'

export interface CreateOpenCodeQuotaManagerOptions {
  /** Override the default key derivation (email → refresh-token hash). */
  keyOf?: (account: AccountMetadataV3) => string
  baseBackoffMs?: number
  maxBackoffMs?: number
  fetchTimeoutMs?: number
}

/**
 * Build an OpenCode-wired quota manager.
 *
 * The returned manager owns its cache, in-flight dedupe, and backoff state.
 * Register its `dispose()` with `PluginLifecycle` so refreshes abort on plugin
 * shutdown.
 */
export function createOpenCodeQuotaManager(
  client: PluginClient,
  providerId: string = ANTIGRAVITY_PROVIDER_ID,
  options: CreateOpenCodeQuotaManagerOptions = {},
): QuotaManager {
  const fetchAccountQuota = makeFetchAccountQuota(client, providerId)
  return createQuotaManager({
    fetchAccountQuota,
    keyOf: options.keyOf ?? defaultKeyOf,
    baseBackoffMs: options.baseBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
  })
}

/**
 * Compatibility wrapper used by code paths that want a one-shot check across
 * the full account pool with no shared cache.
 *
 * Equivalent to spinning up a short-lived manager with `force: true` so
 * manual quota dialogs always reflect the latest data even if the background
 * manager has backed off.
 */
export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId: string = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  const manager = createOpenCodeQuotaManager(client, providerId)
  try {
    return await manager.refreshAccounts(accounts, {
      indexFor: (account) => accounts.indexOf(account),
      force: true,
    })
  } finally {
    manager.dispose()
  }
}

function makeFetchAccountQuota(
  client: PluginClient,
  providerId: string,
): FetchAccountQuota {
  return async (account, signal) => {
    const index = 0
    const disabled = account.enabled === false
    if (disabled) {
      return {
        index,
        email: account.email,
        status: 'disabled',
        disabled: true,
      }
    }

    if (signal.aborted) {
      return {
        index,
        email: account.email,
        status: 'error',
        error:
          signal.reason instanceof Error ? signal.reason.message : 'aborted',
      }
    }

    let auth = buildAuthFromAccount(account)
    let rotatedRefresh: string | undefined

    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(auth, client, providerId)
        if (!refreshed) {
          throw new Error('Token refresh failed')
        }
        if (refreshed.refresh !== auth.refresh) {
          rotatedRefresh = refreshed.refresh
        }
        auth = refreshed
      }

      const projectContext = await ensureProjectContext(auth)
      auth = projectContext.auth
      const updatedAccount = applyAccountUpdates(account, auth)

      if (rotatedRefresh) {
        await persistRotatedRefresh(client, providerId, auth).catch(() => {
          // Quota fetch must succeed even if persist fails — the next quota
          // check will re-read from the in-memory cached auth.
        })
      }

      const [antigravityResponse, geminiCliResponse] = await Promise.all([
        fetchAvailableModels({
          accessToken: auth.access ?? '',
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildAntigravityHarnessUserAgent(),
          timeoutMs: 10_000,
        }).catch((): FetchAvailableModelsResponse => ({ models: undefined })),
        fetchGeminiCliQuota({
          accessToken: auth.access ?? '',
          projectId: projectContext.effectiveProjectId,
          endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
          userAgent: buildGeminiCliUserAgent(),
          timeoutMs: 10_000,
        }),
      ])

      let quotaResult: QuotaSummary
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: 'Failed to fetch Antigravity quota',
        }
      } else {
        quotaResult = aggregateQuota(antigravityResponse.models)
      }

      const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse)
      const annotated: GeminiCliQuotaSummary =
        geminiCliResponse.buckets === undefined ||
        geminiCliResponse.buckets.length === 0
          ? {
              ...geminiCliQuotaResult,
              error:
                geminiCliQuotaResult.models.length === 0
                  ? 'No Gemini CLI quota available'
                  : undefined,
            }
          : geminiCliQuotaResult

      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100
        logQuotaStatus(account.email, index, remainingPercent, family)
      }

      logQuotaFetch('complete', 1, 'ok=1 errors=0')

      return {
        index,
        email: account.email,
        status: 'ok',
        disabled: false,
        quota: quotaResult,
        geminiCliQuota: annotated,
        updatedAccount,
      }
    } catch (error) {
      logQuotaFetch(
        'error',
        undefined,
        `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        index,
        email: account.email,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        disabled: false,
      }
    }
  }
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: 'oauth',
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  }
}

function applyAccountUpdates(
  account: AccountMetadataV3,
  auth: OAuthAuthDetails,
): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh)
  if (!parts.refreshToken) {
    return undefined
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  }

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId

  return changed ? updated : undefined
}

async function persistRotatedRefresh(
  client: PluginClient,
  providerId: string,
  auth: OAuthAuthDetails,
): Promise<void> {
  await client.auth.set({
    path: { id: providerId },
    body: {
      type: 'oauth',
      refresh: auth.refresh,
      access: auth.access ?? '',
      expires: auth.expires ?? 0,
    },
  })
}
