import type { AccountModelFamily as ModelFamily } from '../index.ts'
import type { RequestDebug } from './ports.ts'

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

/**
 * Model family for a request URL. The caller's location debug log, when
 * given, records the decision; this module keeps no debug state of its own.
 */
export function getModelFamilyFromUrl(
  urlString: string,
  debug?: Pick<RequestDebug, 'isDebugEnabled' | 'logModelFamily'>,
): ModelFamily {
  const model = extractModelFromUrl(urlString)
  let family: ModelFamily = 'gemini'
  if (model?.includes('claude')) {
    family = 'claude'
  }
  if (debug?.isDebugEnabled()) {
    debug.logModelFamily(urlString, model, family)
  }
  return family
}
