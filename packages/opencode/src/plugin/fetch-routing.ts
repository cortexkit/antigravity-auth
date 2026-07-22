import type { HeaderStyle } from '../constants'
import type { ModelFamily } from './accounts'
import type { AntigravityConfig } from './config'
import { isDebugEnabled, logModelFamily } from './debug'
import { resolveModelWithTier } from './transform/model-resolver'

export const MAX_TOTAL_CAPACITY_RETRIES = 4
export const CAPACITY_BACKOFF_TIERS_MS = [5000, 10000, 20000, 30000, 60000]

export function isCapacityRetryBudgetExhausted(
  totalCapacityRetries: number,
): boolean {
  return totalCapacityRetries >= MAX_TOTAL_CAPACITY_RETRIES
}

export function getCapacityBackoffDelay(consecutiveFailures: number): number {
  const index = Math.min(
    consecutiveFailures,
    CAPACITY_BACKOFF_TIERS_MS.length - 1,
  )
  return CAPACITY_BACKOFF_TIERS_MS[Math.max(0, index)] ?? 5000
}

export function toUrlString(value: RequestInfo): string {
  if (typeof value === 'string') {
    return value
  }
  const candidate = (value as Request).url
  if (candidate) {
    return candidate
  }
  return value.toString()
}

export function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value)
  try {
    const url = new URL(urlString)
    if (!url.pathname.includes(':streamGenerateContent')) {
      url.pathname = url.pathname.replace(
        ':generateContent',
        ':streamGenerateContent',
      )
    }
    url.searchParams.set('alt', 'sse')
    return url.toString()
  } catch {
    return urlString
  }
}

export function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:/?]+)(?::\w+)?/)
  return match?.[1] ?? null
}

function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:/?]+)/)
  return match?.[1] ?? null
}

export function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString)
  let family: ModelFamily = 'gemini'
  if (model && model.includes('claude')) {
    family = 'claude'
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family)
  }
  return family
}

export function resolveQuotaFallbackHeaderStyle(input: {
  family: ModelFamily
  headerStyle: HeaderStyle
  alternateStyle: HeaderStyle | null
}): HeaderStyle | null {
  if (input.family !== 'gemini') {
    return null
  }
  if (!input.alternateStyle || input.alternateStyle === input.headerStyle) {
    return null
  }
  return input.alternateStyle
}

export type HeaderRoutingDecision = {
  cliFirst: boolean
  preferredHeaderStyle: HeaderStyle
  explicitQuota: boolean
  allowQuotaFallback: boolean
}

export function resolveHeaderRoutingDecision(
  urlString: string,
  family: ModelFamily,
  config: Partial<AntigravityConfig>,
): HeaderRoutingDecision {
  const cliFirst = getCliFirst(config)
  const preferredHeaderStyle = getHeaderStyleFromUrl(
    urlString,
    family,
    cliFirst,
  )
  const explicitQuota = isExplicitQuotaFromUrl(urlString)
  return {
    cliFirst,
    preferredHeaderStyle,
    explicitQuota,
    allowQuotaFallback:
      family === 'gemini' && !!(config.quota_style_fallback ?? false),
  }
}

function getCliFirst(config: Partial<AntigravityConfig>): boolean {
  return config.cli_first ?? false
}

export function getHeaderStyleFromUrl(
  urlString: string,
  family: ModelFamily,
  cliFirst: boolean = false,
): HeaderStyle {
  if (family === 'claude') {
    return 'antigravity'
  }
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString)
  if (!modelWithSuffix) {
    return cliFirst ? 'gemini-cli' : 'antigravity'
  }
  const { quotaPreference } = resolveModelWithTier(modelWithSuffix, {
    cli_first: cliFirst,
  })
  return quotaPreference ?? 'antigravity'
}

export function isExplicitQuotaFromUrl(urlString: string): boolean {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString)
  if (!modelWithSuffix) {
    return false
  }
  const { explicitQuota } = resolveModelWithTier(modelWithSuffix)
  return explicitQuota ?? false
}
