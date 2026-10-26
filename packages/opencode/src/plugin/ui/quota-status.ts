import { formatAntigravityQuota } from '@cortexkit/antigravity-auth-core'

import type { CooldownReason } from '../accounts'
import type { QuotaGroupSummary } from '../quota'
import { ANSI } from './ansi'

/**
 * Quota-aware status labels for models and accounts.
 *
 * Labels:
 *   [READY]       — quota available, no rate limits
 *   [WAIT Xm]     — rate-limited, resets in X minutes
 *   [EXHAUSTED]   — quota fully consumed (0%), reset time known
 *   [COOLDOWN]    — account cooling down (auth failure, network error, etc.)
 *   [LOW]         — quota below 20% but still available
 */

export type QuotaLabel = 'READY' | 'WAIT' | 'EXHAUSTED' | 'COOLDOWN' | 'LOW'

export interface QuotaStatusInfo {
  label: QuotaLabel
  waitMs?: number
  cooldownReason?: CooldownReason
}

/**
 * Format a duration in milliseconds to a compact human-readable string.
 * Used for wait/cooldown labels.
 */
export function formatWaitDuration(ms: number): string {
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

/**
 * Classify a quota group's status based on remaining fraction and reset time.
 */
export function classifyGroupStatus(
  group: QuotaGroupSummary | undefined,
): QuotaStatusInfo {
  if (!group) {
    return { label: 'READY' }
  }

  const remaining = group.remainingFraction

  // No remaining fraction data — treat as ready (fail-open)
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    return { label: 'READY' }
  }

  // Exhausted: 0% remaining
  if (remaining <= 0) {
    const waitMs = parseResetTimeToMs(group.resetTime)
    if (waitMs !== null && waitMs > 0) {
      return { label: 'EXHAUSTED', waitMs }
    }
    // resetTime is missing or in the past — quota likely already reset on Google's side.
    // Treat as READY (fail-open) to avoid stale exhaustion display.
    return { label: 'READY' }
  }

  // Low: below 20%
  if (remaining < 0.2) {
    return { label: 'LOW' }
  }

  return { label: 'READY' }
}

/**
 * Parse an ISO reset time string to milliseconds-until-reset.
 * Returns null if the time is invalid or already past.
 */
function parseResetTimeToMs(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) return null
  const ms = timestamp - Date.now()
  return ms > 0 ? ms : null
}

/**
 * Build a cooldown status for an account that is cooling down.
 */
export function buildCooldownStatus(
  cooldownMs: number,
  reason?: CooldownReason,
): QuotaStatusInfo {
  return {
    label: 'COOLDOWN',
    waitMs: cooldownMs > 0 ? cooldownMs : undefined,
    cooldownReason: reason,
  }
}

/**
 * Build a rate-limited (WAIT) status with optional wait time.
 */
export function buildWaitStatus(waitMs?: number): QuotaStatusInfo {
  if (waitMs !== undefined && waitMs > 0) {
    return { label: 'WAIT', waitMs }
  }
  return { label: 'WAIT' }
}

/**
 * Format a QuotaStatusInfo into a colored ANSI badge string.
 *
 * Examples:
 *   [READY]
 *   [WAIT 3m 20s]
 *   [EXHAUSTED resets in 2h 15m]
 *   [COOLDOWN auth-failure]
 *   [LOW]
 */
export function formatQuotaStatusBadge(status: QuotaStatusInfo): string {
  switch (status.label) {
    case 'READY':
      return `${ANSI.green}[READY]${ANSI.reset}`

    case 'LOW':
      return `${ANSI.yellow}[LOW]${ANSI.reset}`

    case 'WAIT': {
      const suffix = status.waitMs
        ? ` ${formatWaitDuration(status.waitMs)}`
        : ''
      return `${ANSI.yellow}[WAIT${suffix}]${ANSI.reset}`
    }

    case 'EXHAUSTED': {
      const suffix = status.waitMs
        ? ` resets in ${formatWaitDuration(status.waitMs)}`
        : ''
      return `${ANSI.red}[EXHAUSTED${suffix}]${ANSI.reset}`
    }

    case 'COOLDOWN': {
      const parts = ['COOLDOWN']
      if (status.cooldownReason) {
        parts.push(status.cooldownReason)
      }
      if (status.waitMs) {
        parts.push(formatWaitDuration(status.waitMs))
      }
      return `${ANSI.red}[${parts.join(' ')}]${ANSI.reset}`
    }
  }
}

/**
 * Format a plain-text (no ANSI) quota status label.
 * Suitable for hints and non-colored contexts.
 */
export function formatQuotaStatusPlain(status: QuotaStatusInfo): string {
  switch (status.label) {
    case 'READY':
      return 'READY'

    case 'LOW':
      return 'LOW'

    case 'WAIT': {
      const suffix = status.waitMs
        ? ` ${formatWaitDuration(status.waitMs)}`
        : ''
      return `WAIT${suffix}`
    }

    case 'EXHAUSTED': {
      const suffix = status.waitMs
        ? ` resets in ${formatWaitDuration(status.waitMs)}`
        : ''
      return `EXHAUSTED${suffix}`
    }

    case 'COOLDOWN': {
      const parts = ['COOLDOWN']
      if (status.cooldownReason) {
        parts.push(status.cooldownReason)
      }
      if (status.waitMs) {
        parts.push(formatWaitDuration(status.waitMs))
      }
      return parts.join(' ')
    }
  }
}

/**
 * Classify the overall quota health of an account across all model groups.
 * Returns "exhausted" when ALL groups with data are at 0%, "partial" when
 * some but not all are exhausted, or "available" when none are exhausted.
 */
export function classifyOverallQuotaHealth(
  cachedQuota:
    | Partial<
        Record<string, { remainingFraction?: number; resetTime?: string }>
      >
    | undefined,
): {
  health: 'available' | 'partial' | 'exhausted' | 'unknown'
  maxResetMs?: number
} {
  if (!cachedQuota) {
    return { health: 'unknown' }
  }

  const QUOTA_KEYS = ['gemini', 'non-gemini', 'gemini-argon']
  let groupsWithData = 0
  let exhaustedCount = 0
  let maxResetMs: number | undefined

  for (const key of QUOTA_KEYS) {
    const value = cachedQuota[key]?.remainingFraction
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    groupsWithData++
    if (value <= 0) {
      // Skip stale exhaustion: if resetTime is missing or in the past,
      // Google has likely already reset the quota — don't count as exhausted
      const resetMs = parseResetTimeToMs(cachedQuota[key]?.resetTime)
      if (resetMs !== null && resetMs > 0) {
        exhaustedCount++
        if (maxResetMs === undefined || resetMs > maxResetMs) {
          maxResetMs = resetMs
        }
      }
    }
  }

  if (groupsWithData === 0) return { health: 'unknown' }
  if (exhaustedCount === groupsWithData)
    return { health: 'exhausted', maxResetMs }
  if (exhaustedCount > 0) return { health: 'partial', maxResetMs }
  return { health: 'available' }
}

export function formatCachedQuotaWithStatus(
  cachedQuota:
    | Partial<
        Record<string, { remainingFraction?: number; resetTime?: string }>
      >
    | undefined,
  checkedAt?: number,
  now = Date.now(),
): string | undefined {
  if (!cachedQuota) return undefined
  const groups = Object.fromEntries(
    Object.entries(cachedQuota).filter(
      (
        entry,
      ): entry is [
        string,
        { remainingFraction?: number; resetTime?: string },
      ] =>
        (entry[0] === 'gemini' ||
          entry[0] === 'non-gemini' ||
          entry[0] === 'gemini-argon') &&
        entry[1] !== undefined,
    ),
  )
  return formatAntigravityQuota(
    { cachedQuota: groups, cachedQuotaUpdatedAt: checkedAt },
    { now },
  )
}

/**
 * Format a per-group quota status badge for the "Check quotas" output.
 * Combines the progress bar with a status label.
 */
export function formatGroupQuotaBadge(
  remaining?: number,
  resetTime?: string,
): string {
  const group: QuotaGroupSummary = {
    remainingFraction: remaining,
    resetTime,
    modelCount: 1,
  }
  const status = classifyGroupStatus(group)
  return formatQuotaStatusBadge(status)
}
