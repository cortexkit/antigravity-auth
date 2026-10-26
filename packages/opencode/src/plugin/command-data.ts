/** Privacy-safe cached account rows for OpenCode's account OAuth replies. */

import { createHash } from 'node:crypto'

import { normalizeLegacyCachedQuota, toCapturedTier } from '../sidebar-state'

/** Pool-file fields needed to project cached account rows without importing core's barrel into renderer source. */
type CommandDataAccountMetadata = {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled?: boolean
  label?: string
  cachedQuota?: Partial<
    Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
  >
  cachedQuotaUpdatedAt?: number
  cachedQuotaAccountId?: string
  accountIneligible?: boolean
}

type CommandDataQuotaGroup = 'gemini' | 'non-gemini' | 'gemini-argon'

type CommandDataQuotaGroupSummary = {
  remainingFraction?: number
  resetTime?: string
  modelCount: number
  windows?: Array<{
    window: 'weekly' | '5h'
    remainingFraction: number
    resetTime: string
  }>
}

export interface CommandDataAccountStorage {
  version: 4
  activeIndex: number
  activeIndexByFamily?: { claude?: number; gemini?: number }
  accounts: CommandDataAccountMetadata[]
}

/**
 * Privacy-safe per-account row shown in `/antigravity-*` data-first
 * dialogs. Carries the cached quota percentages and the labels the
 * dialog needs, but NEVER the email — the email stays in private
 * account storage and is invisible to the sidebar and the dialog.
 *
 * `index` is the position in the live account array at the time of
 * projection. It is informational only and is NOT a stable identity
 * across refreshes — concurrent OAuth can renumber the array between
 * the dialog opening and a refresh.
 */
export interface CommandAccountRow {
  /** Stable identity for dialog keying (`acct-<index>`). */
  id: string
  /** Position in the live account array at projection time. */
  index: number
  /** Privacy-safe ordinal display label (for example, `Account 1`). */
  label: string
  enabled: boolean
  /** `true` when this row matches the harness-active account. */
  current: boolean
  /**
   * Absolute timestamp (ms) until which this account is rate-limited.
   * Carried on the row so the sidebar refresher can match cooldowns
   * without relying on unstable numeric indices.
   */
  coolingDownUntil?: number
  /** Health score in [0, 100], forwarded from the live tracker. */
  healthScore?: number
  cachedQuotaUpdatedAt?: number
  quota: Array<{
    key: 'gemini' | 'non-gemini' | 'gemini-argon'
    label: string
    remainingPercent: number | null
    resetAt?: number
    windows?: Array<{
      window: 'weekly' | '5h'
      remainingPercent: number
      resetAt?: number
    }>
  }>
  /** Captured plan tier. Absent when unknown; never defaulted. */
  tier?: { id: string; capturedAt: number }
}

/**
 * Quota display label for each supported quota group. Kept here so the
 * dialog and the quota manager agree on the same vocabulary.
 */
const QUOTA_GROUP_LABELS: Record<
  CommandAccountRow['quota'][number]['key'],
  string
> = {
  gemini: 'Gemini',
  'non-gemini': 'Non-Gemini',
  'gemini-argon': 'Argon',
}

const SUPPORTED_QUOTA_KEYS = [
  'gemini',
  'non-gemini',
  'gemini-argon',
] as const satisfies readonly CommandAccountRow['quota'][number]['key'][]

interface LiveAccountSnapshot {
  email?: string
  index: number
  refreshToken: string
  label?: string
  enabled: boolean
  active: boolean
  cachedQuota?: Partial<
    Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
  >
  cachedQuotaUpdatedAt?: number
  cachedQuotaAccountId?: string
  accountIneligible?: boolean
  coolingDownUntil?: number
  healthScore?: number
  /** Captured plan tier from the most recent loadCodeAssist response. */
  capturedTierId?: string
  /** Captured paid-tier ID from the most recent loadCodeAssist response. */
  capturedPaidTierId?: string
  /** Epoch ms when capturedTierId was last recorded. */
  capturedTierAt?: number
}

function toCommandAccountRow(entry: LiveAccountSnapshot): CommandAccountRow {
  // Stamp mismatch: the cached quota was captured for a different account
  // (the refresh token changed, or an index shift placed another account's
  // snapshot at this position). Drop the stale cache rather than rendering
  // the wrong account's quota percentages.
  const rawCached =
    entry.cachedQuotaAccountId &&
    entry.cachedQuotaAccountId !== quotaAccountIdentity(entry.refreshToken)
      ? undefined
      : entry.cachedQuota
  // Normalize legacy pool keys (gemini-pro, gemini-flash, claude, gpt-oss)
  // to canonical keys before the SUPPORTED_QUOTA_KEYS loop. Without this
  // a legacy snapshot produces empty quota rows until a real quota refresh
  // rewrites the on-disk snapshot.
  const cached = normalizeLegacyCachedQuota(
    rawCached as Parameters<typeof normalizeLegacyCachedQuota>[0],
  )
  const quota: CommandAccountRow['quota'] = []
  for (const key of SUPPORTED_QUOTA_KEYS) {
    const cachedEntry = cached?.[key]
    if (!cachedEntry) continue
    const fraction = cachedEntry.remainingFraction
    const remainingPercent =
      typeof fraction === 'number' && Number.isFinite(fraction)
        ? Math.round(fraction * 100)
        : null
    let resetAt: number | undefined
    if (
      typeof cachedEntry.resetTime === 'string' &&
      cachedEntry.resetTime.length > 0
    ) {
      const parsed = Date.parse(cachedEntry.resetTime)
      if (Number.isFinite(parsed)) resetAt = parsed
    }
    // Carry per-window breakdown when the cache was populated from the
    // windowed RUQS path — the sidebar writer projects through here.
    const windows = cachedEntry.windows?.length
      ? cachedEntry.windows.map((w) => ({
          window: w.window,
          remainingPercent: Math.round(w.remainingFraction * 100),
          resetAt:
            typeof w.resetTime === 'string' && w.resetTime.length > 0
              ? (() => {
                  const parsed = Date.parse(w.resetTime)
                  return Number.isFinite(parsed) ? parsed : undefined
                })()
              : undefined,
        }))
      : undefined
    quota.push({
      key,
      label: QUOTA_GROUP_LABELS[key],
      remainingPercent,
      resetAt,
      windows,
    })
  }
  const label = `Account ${entry.index + 1}`
  return {
    id: `acct-${entry.index}`,
    index: entry.index,
    label,
    enabled: entry.enabled,
    current: entry.active,
    coolingDownUntil: entry.coolingDownUntil,
    healthScore: entry.healthScore,
    cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
    quota,
    tier: toCapturedTier(entry),
  }
}

/**
 * Opaque identity derived from a refresh token. Antigravity refresh tokens
 * are stable (they do not rotate), so this hash is a durable, prunable
 * identity to detect a stale cached quota after an account-index shift.
 */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

export function projectCommandAccountRows(
  storage: CommandDataAccountStorage | null | undefined,
): CommandAccountRow[] {
  if (!storage) return []
  const activeIndex = storage.activeIndexByFamily?.claude ?? storage.activeIndex
  return storage.accounts.map((entry, index) =>
    toCommandAccountRow({
      index,
      refreshToken: entry.refreshToken,
      label: entry.label,
      enabled: entry.enabled !== false,
      active: index === activeIndex,
      cachedQuota: entry.cachedQuota,
      cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
      cachedQuotaAccountId: entry.cachedQuotaAccountId,
    }),
  )
}
