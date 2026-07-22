import { fetchWithActiveTimeout } from '@cortexkit/antigravity-auth-core'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  buildGeminiCliUserAgent,
} from '../constants'
import { fetchWithAgyCliTransport } from './agy-transport'
import {
  accessTokenExpired,
  formatRefreshParts,
  parseRefreshParts,
} from './auth'
import { logQuotaFetch, logQuotaStatus } from './debug'
import { buildAntigravityHarnessUserAgent } from './fingerprint'
import { getQuotaGroupForModel } from './model-registry'
import { ensureProjectContext } from './project'
import type { AccountMetadataV3 } from './storage'
import { refreshAccessToken } from './token'
import { getModelFamily } from './transform/model-resolver'
import type { OAuthAuthDetails, PluginClient } from './types'

const FETCH_TIMEOUT_MS = 10000

export type QuotaGroup = 'claude' | 'gemini-pro' | 'gemini-flash' | 'gpt-oss'

export interface QuotaGroupSummary {
  remainingFraction?: number
  resetTime?: string
  modelCount: number
}

export interface PerModelQuotaEntry {
  modelId: string
  displayName?: string
  group: QuotaGroup | null
  remainingFraction: number
  resetTime?: string
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>
  perModel?: PerModelQuotaEntry[]
  modelCount: number
  error?: string
}
// Gemini CLI quota types
export interface GeminiCliQuotaModel {
  modelId: string
  remainingFraction: number
  resetTime?: string
}

export interface GeminiCliQuotaSummary {
  models: GeminiCliQuotaModel[]
  error?: string
}

interface RetrieveUserQuotaResponse {
  buckets?: {
    remainingAmount?: string
    remainingFraction?: number
    resetTime?: string
    tokenType?: string
    modelId?: string
  }[]
}

export type AccountQuotaStatus = 'ok' | 'disabled' | 'error'

export interface AccountQuotaResult {
  index: number
  email?: string
  status: AccountQuotaStatus
  error?: string
  disabled?: boolean
  quota?: QuotaSummary
  geminiCliQuota?: GeminiCliQuotaSummary
  updatedAccount?: AccountMetadataV3
}

interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>
}

interface FetchAvailableModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
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

function normalizeRemainingFraction(value: unknown): number {
  // If value is missing or invalid, treat as exhausted (0%)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) {
    return null
  }
  return timestamp
}

export function classifyQuotaGroup(
  modelName: string,
  displayName?: string,
): QuotaGroup | null {
  const registryGroup = getQuotaGroupForModel(modelName)
  if (registryGroup) {
    return registryGroup
  }

  const combined = `${modelName} ${displayName ?? ''}`.toLowerCase()
  if (combined.includes('claude')) {
    return 'claude'
  }
  const isGemini3 =
    combined.includes('gemini-3') || combined.includes('gemini 3')
  if (!isGemini3) {
    return null
  }
  const family = getModelFamily(modelName)
  return family === 'gemini-flash' ? 'gemini-flash' : 'gemini-pro'
}

function aggregateQuota(
  models?: Record<string, FetchAvailableModelEntry>,
): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {}
  const perModel: PerModelQuotaEntry[] = []
  if (!models) {
    return { groups, perModel, modelCount: 0 }
  }

  let totalCount = 0
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(
      modelName,
      entry.displayName ?? entry.modelName,
    )
    const quotaInfo = entry.quotaInfo
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined
    const resetTime = quotaInfo?.resetTime
    const resetTimestamp = parseResetTime(resetTime)

    totalCount += 1

    // Always preserve per-model data regardless of group classification
    perModel.push({
      modelId: modelName,
      displayName: entry.displayName ?? entry.modelName,
      group,
      remainingFraction: remainingFraction ?? 0,
      resetTime,
    })

    if (!group) {
      continue
    }

    const existing = groups[group]
    const nextCount = (existing?.modelCount ?? 0) + 1
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction)

    let nextResetTime = existing?.resetTime
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime)
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    }
  }

  // Sort per-model entries by model ID for consistent display
  perModel.sort((a, b) => a.modelId.localeCompare(b.modelId))

  return { groups, perModel, modelCount: totalCount }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetchWithActiveTimeout(url, options, { timeoutMs })
}

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<FetchAvailableModelsResponse> {
  const quotaUserAgent = buildAntigravityHarnessUserAgent()
  const errors: string[] = []

  for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    const body = projectId ? { project: projectId } : {}
    try {
      const response = await fetchWithAgyCliTransport(
        `${endpoint}/v1internal:fetchAvailableModels`,
        {
          method: 'POST',
          headers: {
            'User-Agent': quotaUserAgent,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip',
          },
          body: JSON.stringify(body),
        },
        { timeoutMs: FETCH_TIMEOUT_MS },
      )

      if (response.ok) {
        return (await response.json()) as FetchAvailableModelsResponse
      }

      const status = response.status

      // 403: retry once without project (like AntigravityManager)
      if (status === 403 && projectId) {
        try {
          const retryResponse = await fetchWithAgyCliTransport(
            `${endpoint}/v1internal:fetchAvailableModels`,
            {
              method: 'POST',
              headers: {
                'User-Agent': quotaUserAgent,
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip',
              },
              body: JSON.stringify({}),
            },
            { timeoutMs: FETCH_TIMEOUT_MS },
          )
          if (retryResponse.ok) {
            return (await retryResponse.json()) as FetchAvailableModelsResponse
          }
        } catch {
          // Fall through to next endpoint
        }
      }

      // 429/5xx: fall through to next endpoint
      if (status === 429 || status >= 500) {
        const message = await response.text().catch(() => '')
        const snippet = message.trim().slice(0, 200)
        errors.push(
          `fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`,
        )
        continue
      }

      // Other errors (4xx): don't retry on different endpoint
      const message = await response.text().catch(() => '')
      const snippet = message.trim().slice(0, 200)
      errors.push(
        `fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`,
      )
      break
    } catch (error) {
      // Network error or timeout: fall through to next endpoint
      errors.push(
        `fetchAvailableModels network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  throw new Error(errors.join('; ') || 'fetchAvailableModels failed')
}

async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse> {
  // Use Gemini CLI user-agent to get CLI quota buckets (not Antigravity buckets)
  const geminiCliUserAgent = buildGeminiCliUserAgent()

  for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    const body = projectId ? { project: projectId } : {}
    try {
      const response = await fetchWithTimeout(
        `${endpoint}/v1internal:retrieveUserQuota`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': geminiCliUserAgent,
          },
          body: JSON.stringify(body),
        },
      )

      if (response.ok) {
        return (await response.json()) as RetrieveUserQuotaResponse
      }

      const status = response.status

      // 429/5xx: fall through to next endpoint
      if (status === 429 || status >= 500) {
        continue
      }

      // Other errors: don't retry on different endpoint
      return { buckets: [] }
    } catch {}
  }

  // All endpoints failed
  return { buckets: [] }
}

function aggregateGeminiCliQuota(
  response: RetrieveUserQuotaResponse,
): GeminiCliQuotaSummary {
  const models: GeminiCliQuotaModel[] = []

  if (!response.buckets || response.buckets.length === 0) {
    return { models }
  }

  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue
    }

    // Filter to relevant Gemini CLI quota models (premium tier)
    const modelId = bucket.modelId
    const isRelevantModel =
      modelId.startsWith('gemini-3-') ||
      modelId.startsWith('gemini-3.') ||
      modelId.startsWith('gemini-2.5-')
    if (!isRelevantModel) {
      continue
    }

    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime,
    })
  }

  // Sort by model ID for consistent display
  models.sort((a, b) => a.modelId.localeCompare(b.modelId))

  return { models }
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

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  const results: AccountQuotaResult[] = []

  logQuotaFetch('start', accounts.length)

  for (const [index, account] of accounts.entries()) {
    const disabled = account.enabled === false

    let auth = buildAuthFromAccount(account)

    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(auth, client, providerId)
        if (!refreshed) {
          throw new Error('Token refresh failed')
        }
        auth = refreshed
      }

      const projectContext = await ensureProjectContext(auth)
      auth = projectContext.auth
      const updatedAccount = applyAccountUpdates(account, auth)

      let quotaResult: QuotaSummary
      let geminiCliQuotaResult: GeminiCliQuotaSummary

      // Fetch both Antigravity and Gemini CLI quotas in parallel
      const [antigravityResponse, geminiCliResponse] = await Promise.all([
        fetchAvailableModels(
          auth.access ?? '',
          projectContext.effectiveProjectId,
        ).catch(
          (error): FetchAvailableModelsResponse => ({ models: undefined }),
        ),
        fetchGeminiCliQuota(
          auth.access ?? '',
          projectContext.effectiveProjectId,
        ),
      ])

      // Process Antigravity quota
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: 'Failed to fetch Antigravity quota',
        }
      } else {
        quotaResult = aggregateQuota(antigravityResponse.models)
      }

      // Process Gemini CLI quota
      geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse)
      if (
        geminiCliResponse.buckets === undefined ||
        geminiCliResponse.buckets.length === 0
      ) {
        geminiCliQuotaResult.error =
          geminiCliQuotaResult.models.length === 0
            ? 'No Gemini CLI quota available'
            : undefined
      }

      results.push({
        index,
        email: account.email,
        status: 'ok',
        disabled,
        quota: quotaResult,
        geminiCliQuota: geminiCliQuotaResult,
        updatedAccount,
      })

      // Log quota status for each family
      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100
        logQuotaStatus(account.email, index, remainingPercent, family)
      }
    } catch (error) {
      results.push({
        index,
        email: account.email,
        status: 'error',
        disabled,
        error: error instanceof Error ? error.message : String(error),
      })
      logQuotaFetch(
        'error',
        undefined,
        `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  logQuotaFetch(
    'complete',
    accounts.length,
    `ok=${results.filter((r) => r.status === 'ok').length} errors=${results.filter((r) => r.status === 'error').length}`,
  )
  return results
}
