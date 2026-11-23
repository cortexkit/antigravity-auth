import {
  calculateBackoffMs,
  getQuotaKey,
  quotaRetryAfter,
} from '@cortexkit/antigravity-auth-core'
import type {
  RequestAccountPool,
  RequestAccountRow,
} from '@cortexkit/antigravity-auth-core/engine'

export interface PiRequestRow extends RequestAccountRow {
  accountIneligible?: boolean
  verificationRequired?: boolean
  coolingDownUntil?: number
  lastFailureTime?: number
  rateLimitResetTimes: Record<string, number>
}

const no = () => false
const noop = () => {}

/** Serve one bound account without choosing among accounts or persisting state. */
export function createPiRequestPool(
  row: PiRequestRow,
): RequestAccountPool<PiRequestRow> {
  let lastToast = -Infinity
  const cooling = () => (row.coolingDownUntil ?? 0) > Date.now()
  const enabled = () => !row.accountIneligible && !row.verificationRequired
  const markRateLimited: RequestAccountPool<PiRequestRow>['markRateLimited'] = (
    account,
    wait,
    family,
    model,
  ) => {
    const key = getQuotaKey(family, model)
    account.rateLimitResetTimes[key] = Math.max(
      account.rateLimitResetTimes[key] ?? 0,
      Date.now() + wait,
    )
  }
  const remaining: RequestAccountPool<PiRequestRow>['getMinWaitTimeForFamily'] =
    (family, model) =>
      Math.max(
        0,
        (row.coolingDownUntil ?? 0) - Date.now(),
        (row.rateLimitResetTimes[getQuotaKey(family, model)] ?? 0) - Date.now(),
      )
  return {
    getAccountCount: () => 1,
    getAccounts: () => [row],
    getAccountsSnapshot: () => [row],
    getEnabledAccounts: () => (enabled() ? [row] : []),
    getCurrentAccountForFamily: () => (enabled() && !cooling() ? row : null),
    getCurrentOrNextForFamily: (
      family,
      model,
      _strategy,
      _offset,
      _soft,
      _ttl,
      _session,
      excluded,
    ) =>
      enabled() && !excluded?.has(row.index) && remaining(family, model) === 0
        ? row
        : null,
    getRoutedAccountForFamily: () => null,
    useRoutedAccount: () => null,
    isAccountCoolingDown: cooling,
    isAccountOverSoftQuota: no,
    areAllAccountsOverSoftQuota: no,
    getMinWaitTimeForSoftQuota: () => null,
    getMinWaitTimeForFamily: remaining,
    getMinSelectableWaitTimeForFamily: (family, _soft, _ttl, model) =>
      remaining(family, model) || null,
    isRateLimited: (account, family, model) =>
      (account.rateLimitResetTimes[getQuotaKey(family, model)] ?? 0) >
      Date.now(),
    markRateLimited,
    markRateLimitedWithReason: (
      account,
      family,
      model,
      reason,
      delay,
      failureTtlMs = 3_600_000,
    ) => {
      // A refusal without a structured reason cools the model briefly but
      // must not advance the confirmed quota failure ladder.
      if (reason === 'UNKNOWN') {
        const wait = calculateBackoffMs(reason, 0, delay)
        markRateLimited(account, wait, family, model)
        return wait
      }

      const now = Date.now()
      const failures =
        account.lastFailureTime !== undefined &&
        now - account.lastFailureTime > failureTtlMs
          ? 0
          : (account.consecutiveFailures ?? 0)
      account.lastFailureTime = now
      account.consecutiveFailures = failures + 1
      const wait = calculateBackoffMs(
        reason,
        failures,
        quotaRetryAfter(account, family, model, reason, delay, now),
      )
      account.rateLimitResetTimes[getQuotaKey(family, model)] = now + wait
      return wait
    },
    markAccountCoolingDown: (account, wait) => {
      account.coolingDownUntil = Math.max(
        account.coolingDownUntil ?? 0,
        Date.now() + wait,
      )
    },
    markAccountIneligible: () => (row.accountIneligible = true),
    markAccountVerificationRequired: () => (row.verificationRequired = true),
    shouldShowAccountToast: (_index, interval = 0) =>
      Date.now() - lastToast >= interval,
    markToastShown: () => {
      lastToast = Date.now()
    },
    markAccountUsed: noop,
    recordRequest: noop,
    recordSessionUsage: noop,
    requestSaveToDisk: noop,
    getDailyRequestCounts: () => null,
    getTotalDailyRequests: () => 0,
    getSessionSummary: () => ({
      durationMinutes: 0,
      totalClaude: 0,
      totalGemini: 0,
      requestsPerHour: 0,
      accountsUsed: 0,
      perAccount: [],
    }),
    proactivelyRotateForFamily: () => null,
    shouldProactivelyRotate: no,
    regenerateAccountFingerprint: () => null,
    wasUsedInSession: no,
  }
}
