/**
 * Harness-agnostic account storage types.
 *
 * Persisted pool metadata and selection/quota policy. Distinct from
 * `auth-types.ts` (live credential/refresh/project transport contracts):
 * account types are the on-disk schema for the multi-account pool.
 */

import type { Fingerprint, FingerprintVersion } from './fingerprint.ts'

export type { HeaderStyle } from './constants.ts'

/**
 * Coarse routing key for the on-disk account pool. Distinct from the
 * transform-level `ModelFamily` (which carries 'claude' | 'gemini-flash' |
 * 'gemini-pro' for tiered routing): here we only need 'claude' vs 'gemini'
 * to track per-family active indices. Named distinctly to avoid the
 * shadow collision with `transform/types.ts` on re-export.
 */
export type AccountModelFamily = 'claude' | 'gemini'

export interface RateLimitStateV3 {
  claude?: number
  'gemini-antigravity'?: number
  'gemini-cli'?: number
  [key: string]: number | undefined
}

export type AccountSelectionStrategy = 'sticky' | 'round-robin' | 'hybrid'

export type CooldownReason =
  | 'auth-failure'
  | 'network-error'
  | 'project-error'
  | 'validation-required'

export interface AccountMetadataV3 {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled?: boolean
  lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
  rateLimitResetTimes?: RateLimitStateV3
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  /**
   * Non-PII display label for the sidebar/telemetry. Sourced from the
   * OAuth userinfo `name` field. Falls back to the legacy PII email
   * only when absent so previously-stored accounts retain a label.
   */
  label?: string
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: Fingerprint
  fingerprintHistory?: FingerprintVersion[]
  /** Set when Google asks the user to verify this account before requests can continue. */
  verificationRequired?: boolean
  verificationRequiredAt?: number
  verificationRequiredReason?: string
  verificationUrl?: string
  /** Set when the API explicitly returns ACCOUNT_INELIGIBLE. */
  accountIneligible?: boolean
  accountIneligibleAt?: number
  accountIneligibleReason?: string
  eligibilityStateUpdatedAt?: number
  /** Cached soft quota data (group-level aggregation) */
  cachedQuota?: Record<
    string,
    { remainingFraction?: number; resetTime?: string; modelCount: number }
  >
  /** Cached per-model quota data (individual model granularity) */
  cachedPerModelQuota?: {
    modelId: string
    displayName?: string
    group: string | null
    remainingFraction: number
    resetTime?: string
  }[]
  cachedQuotaUpdatedAt?: number
  /** Daily request counts per model family, resets when date changes */
  dailyRequestCounts?: {
    date: string
    claude: number
    gemini: number
  }
}

export interface AccountStorageV4 {
  version: 4
  accounts: AccountMetadataV3[]
  activeIndex: number
  activeIndexByFamily?: {
    claude?: number
    gemini?: number
  }
}

export interface AccountMetadataV1 {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  isRateLimited?: boolean
  rateLimitResetTime?: number
  lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
}

export interface AccountStorageV1 {
  version: 1
  accounts: AccountMetadataV1[]
  activeIndex: number
}

export interface RateLimitStateV2 {
  claude?: number
  gemini?: number
}

export interface AccountMetadataV2 {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
  rateLimitResetTimes?: RateLimitStateV2
}

export interface AccountStorageV2 {
  version: 2
  accounts: AccountMetadataV2[]
  activeIndex: number
}

export interface AccountStorageV3 {
  version: 3
  accounts: AccountMetadataV3[]
  activeIndex: number
  activeIndexByFamily?: {
    claude?: number
    gemini?: number
  }
}

/**
 * Discriminated union of every persisted account-storage version on disk.
 * Used by `loadAccountStorage` to migrate older payloads to v4.
 */
export type AnyAccountStorage =
  | AccountStorageV1
  | AccountStorageV2
  | AccountStorageV3
  | AccountStorageV4
