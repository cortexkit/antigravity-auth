/**
 * Harness-agnostic quota types.
 *
 * Quota group / per-model / CLI summary shapes shared between the core
 * quota helpers and any harness that wants to display quota status. Kept
 * separate from `account-types.ts` so quota evolution does not force a
 * migration on the persisted account pool.
 */

import type { AccountMetadataV3 } from './account-types.ts'

export type QuotaGroup = 'gemini' | 'non-gemini'

export type QuotaWindow = 'weekly' | '5h'

export interface QuotaWindowEntry {
  window: QuotaWindow
  remainingFraction: number
  resetTime: string
}

export interface QuotaGroupSummary {
  /** Most-constrained window's remainingFraction (derived from `windows`). */
  remainingFraction?: number
  /** Most-constrained window's resetTime (derived from `windows`). */
  resetTime?: string
  modelCount: number
  /**
   * Per-window breakdown from the retrieveUserQuotaSummary response.
   * shortest-first (5h before weekly, etc.). Omitted in legacy cached shapes —
   * consumers treat a single remainingFraction as one unlabeled window.
   */
  windows?: QuotaWindowEntry[]
}

/**
 * Migrate pre-pool quota keys while loading persisted account data. Current
 * keys pass through unchanged, making this safe for every storage read.
 */
export function normalizeLegacyCachedQuota(
  raw: AccountMetadataV3['cachedQuota'],
): Partial<Record<QuotaGroup, QuotaGroupSummary>> | undefined {
  if (!raw) return raw

  const hasLegacy =
    'gemini-pro' in raw ||
    'gemini-flash' in raw ||
    'claude' in raw ||
    'gpt-oss' in raw
  if (!hasLegacy) return raw

  const earlierResetTime = (
    a: string | undefined,
    b: string | undefined,
  ): string | undefined => {
    if (!a) return b
    if (!b) return a
    return a < b ? a : b
  }

  const minFraction = (
    a: QuotaGroupSummary | undefined,
    b: QuotaGroupSummary | undefined,
  ): QuotaGroupSummary | undefined => {
    if (!a) return b
    if (!b) return a
    const fa = a.remainingFraction ?? 1
    const fb = b.remainingFraction ?? 1
    const winner = fa <= fb ? a : b
    const loser = fa <= fb ? b : a
    return {
      ...winner,
      resetTime: earlierResetTime(winner.resetTime, loser.resetTime),
    }
  }

  const gemini = minFraction(
    raw.gemini as QuotaGroupSummary | undefined,
    minFraction(
      raw['gemini-pro'] as QuotaGroupSummary | undefined,
      raw['gemini-flash'] as QuotaGroupSummary | undefined,
    ),
  )
  const nonGemini = minFraction(
    raw['non-gemini'] as QuotaGroupSummary | undefined,
    minFraction(
      raw.claude as QuotaGroupSummary | undefined,
      raw['gpt-oss'] as QuotaGroupSummary | undefined,
    ),
  )

  return {
    ...(gemini !== undefined ? { gemini } : {}),
    ...(nonGemini !== undefined ? { 'non-gemini': nonGemini } : {}),
  }
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

export interface GeminiCliQuotaModel {
  modelId: string
  remainingFraction: number
  resetTime?: string
}

export interface GeminiCliQuotaSummary {
  models: GeminiCliQuotaModel[]
  error?: string
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
