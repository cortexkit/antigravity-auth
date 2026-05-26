import type { CooldownReason } from "../accounts"
import type { QuotaGroupSummary } from "../quota"
import {
  classifyGroupStatus,
  buildCooldownStatus,
  buildWaitStatus,
} from "./quota-status"
import type { QuotaStatusInfo, QuotaLabel } from "./quota-status"

/**
 * Per-account status data for a specific model family.
 * Extracted from AccountManager by the caller; kept simple for testability.
 */
export interface ModelAccountStatus {
  coolingDown: boolean
  cooldownMs: number
  cooldownReason?: CooldownReason
  rateLimited: boolean
  rateLimitWaitMs: number
  quotaGroup?: QuotaGroupSummary
}

/**
 * Priority ranking for quota labels — higher is more available.
 * Used to pick the best (most optimistic) status across accounts.
 */
const STATUS_PRIORITY: Record<QuotaLabel, number> = {
  READY: 4,
  LOW: 3,
  WAIT: 2,
  EXHAUSTED: 1,
  COOLDOWN: 0,
}

/**
 * Determine per-model availability status by aggregating across accounts.
 *
 * Rules:
 *   1. If ANY enabled account can serve the model → READY (or LOW if all
 *      available accounts have low quota).
 *   2. If ALL accounts are blocked:
 *      - All cooling down → COOLDOWN with min cooldown time
 *      - Any rate-limited  → WAIT with min wait time
 *   3. Fail-open: returns READY when no accounts or no quota data exist.
 */
export function getModelStatusFromAccounts(
  accounts: readonly ModelAccountStatus[],
): QuotaStatusInfo {
  if (accounts.length === 0) {
    return { label: "READY" }
  }

  const available: ModelAccountStatus[] = []
  const blocked: ModelAccountStatus[] = []

  for (const account of accounts) {
    if (!account.coolingDown && !account.rateLimited) {
      available.push(account)
    } else {
      blocked.push(account)
    }
  }

  if (available.length > 0) {
    return resolveAvailableStatus(available)
  }

  return resolveBlockedStatus(blocked)
}

/**
 * Among accounts that can serve right now, pick the best quota status.
 * If none have quota data, fail-open to READY.
 */
function resolveAvailableStatus(
  accounts: readonly ModelAccountStatus[],
): QuotaStatusInfo {
  let best: QuotaStatusInfo | null = null

  for (const account of accounts) {
    if (!account.quotaGroup) continue
    const status = classifyGroupStatus(account.quotaGroup)
    if (!best || STATUS_PRIORITY[status.label] > STATUS_PRIORITY[best.label]) {
      best = status
    }
  }

  return best ?? { label: "READY" }
}

/**
 * All accounts are blocked — determine the dominant blocking reason and
 * the soonest time any account becomes available.
 */
function resolveBlockedStatus(
  accounts: readonly ModelAccountStatus[],
): QuotaStatusInfo {
  const allCooling = accounts.every((a) => a.coolingDown)

  if (allCooling) {
    const cooldownTimes = accounts
      .map((a) => a.cooldownMs)
      .filter((ms) => ms > 0)
    const minMs = cooldownTimes.length > 0 ? Math.min(...cooldownTimes) : 0
    const reason = accounts[0]?.cooldownReason
    return buildCooldownStatus(minMs, reason)
  }

  // Mix of cooldown + rate-limited, or all rate-limited → WAIT
  const waitTimes = accounts
    .map((a) => (a.coolingDown ? a.cooldownMs : a.rateLimitWaitMs))
    .filter((ms) => ms > 0)

  const minMs = waitTimes.length > 0 ? Math.min(...waitTimes) : undefined
  return buildWaitStatus(minMs)
}
