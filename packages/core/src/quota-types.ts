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
