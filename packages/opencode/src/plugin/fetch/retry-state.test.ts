import { beforeEach, describe, expect, it } from 'bun:test'

import { createRetryState } from './retry-state'

describe('RetryState', () => {
  let state: ReturnType<typeof createRetryState>

  beforeEach(() => {
    state = createRetryState()
  })

  describe('rate limit backoff', () => {
    it('returns attempt 1 on first 429 within the reset window', () => {
      const result = state.getRateLimitBackoff(0, 'gemini-antigravity', null)
      expect(result.attempt).toBe(1)
      expect(result.isDuplicate).toBe(false)
      expect(result.delayMs).toBeGreaterThanOrEqual(1000)
    })

    it('treats concurrent 429s within the dedup window as one event', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      const dup = state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      expect(dup.isDuplicate).toBe(true)
      expect(dup.attempt).toBe(1)
    })

    it('separates accounts and quota keys', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      const otherAccount = state.getRateLimitBackoff(
        1,
        'gemini-antigravity',
        1000,
      )
      const otherQuota = state.getRateLimitBackoff(0, 'gemini-cli', 1000)
      expect(otherAccount.isDuplicate).toBe(false)
      expect(otherQuota.isDuplicate).toBe(false)
    })

    it('caps backoff growth at the provided max (base server hint still wins)', () => {
      const result = state.getRateLimitBackoff(0, 'claude', 1_000, 5_000)
      expect(result.delayMs).toBeGreaterThanOrEqual(1_000)
      expect(result.delayMs).toBeLessThanOrEqual(5_000)
    })

    it('resets a single quota key', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      state.resetRateLimitState(0, 'gemini-antigravity')
      const after = state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      expect(after.isDuplicate).toBe(false)
      expect(after.attempt).toBe(1)
    })

    it('resets all quotas for an account', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      state.getRateLimitBackoff(0, 'gemini-cli', 1000)
      state.resetAllRateLimitStateForAccount(0)
      const afterAg = state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      expect(afterAg.isDuplicate).toBe(false)
    })

    it('maps header style + family to a quota key', () => {
      expect(state.headerStyleToQuotaKey('antigravity', 'gemini')).toBe(
        'gemini-antigravity',
      )
      expect(state.headerStyleToQuotaKey('gemini-cli', 'gemini')).toBe(
        'gemini-cli',
      )
      expect(state.headerStyleToQuotaKey('antigravity', 'claude')).toBe(
        'claude',
      )
    })
  })

  describe('account failure cooldown', () => {
    it('starts at 1 failure with no cooldown', () => {
      const result = state.trackAccountFailure(0)
      expect(result.failures).toBe(1)
      expect(result.shouldCooldown).toBe(false)
      expect(result.cooldownMs).toBe(0)
    })

    it('cools down after max consecutive failures', () => {
      let cooldown = false
      for (let i = 0; i < 6; i++) {
        const result = state.trackAccountFailure(0)
        cooldown = result.shouldCooldown
        if (cooldown) {
          expect(result.cooldownMs).toBeGreaterThan(0)
          break
        }
      }
      expect(cooldown).toBe(true)
    })

    it('resets a single account', () => {
      state.trackAccountFailure(0)
      state.trackAccountFailure(0)
      state.resetAccountFailureState(0)
      const after = state.trackAccountFailure(0)
      expect(after.failures).toBe(1)
    })

    it('treats unrelated accounts independently', () => {
      state.trackAccountFailure(0)
      state.trackAccountFailure(0)
      const other = state.trackAccountFailure(1)
      expect(other.failures).toBe(1)
    })
  })

  describe('rate limit toast dedup', () => {
    it('suppresses the same template within the cooldown window', () => {
      expect(state.shouldShowRateLimitToast('429 for 60s')).toBe(true)
      expect(state.shouldShowRateLimitToast('429 for 60s')).toBe(false)
    })

    it('treats messages with different prose as distinct keys', () => {
      expect(state.shouldShowRateLimitToast('429 for 60s')).toBe(true)
      expect(state.shouldShowRateLimitToast('overloaded for 90s')).toBe(true)
    })

    it('clears cooldown cache on clear()', () => {
      state.shouldShowRateLimitToast('429 for 60s')
      state.clear()
      expect(state.shouldShowRateLimitToast('429 for 60s')).toBe(true)
    })
  })

  describe('toast spam guards', () => {
    it('gates soft-quota and rate-limit toasts until reset', () => {
      state.markSoftQuotaToastShown()
      state.markRateLimitToastShown()
      expect(state.softQuotaToastShown()).toBe(true)
      expect(state.rateLimitToastShown()).toBe(true)
      state.resetAllAccountsBlockedToasts()
      expect(state.softQuotaToastShown()).toBe(false)
      expect(state.rateLimitToastShown()).toBe(false)
    })
  })

  describe('empty response attempts', () => {
    it('tracks per session+model key', () => {
      expect(state.recordEmptyResponseAttempt('sess:model')).toBe(1)
      expect(state.recordEmptyResponseAttempt('sess:model')).toBe(2)
      expect(state.recordEmptyResponseAttempt('sess:other')).toBe(1)
    })

    it('clears the attempt counter', () => {
      state.recordEmptyResponseAttempt('sess:model')
      state.clearEmptyResponseAttempts()
      expect(state.recordEmptyResponseAttempt('sess:model')).toBe(1)
    })
  })

  describe('clear()', () => {
    it('resets every map/flag', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      state.trackAccountFailure(0)
      state.shouldShowRateLimitToast('429 for 60s')
      state.recordEmptyResponseAttempt('sess:model')

      state.clear()

      expect(
        state.getRateLimitBackoff(0, 'gemini-antigravity', 1000).attempt,
      ).toBe(1)
      expect(state.trackAccountFailure(0).failures).toBe(1)
      expect(state.shouldShowRateLimitToast('429 for 60s')).toBe(true)
      expect(state.recordEmptyResponseAttempt('sess:model')).toBe(1)
    })
  })

  describe('disposed flag', () => {
    it('marks the instance as disposed after dispose()', () => {
      expect(state.disposed).toBe(false)
      state.dispose()
      expect(state.disposed).toBe(true)
    })

    it('makes every mutating method a no-op after dispose()', () => {
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      state.trackAccountFailure(0)
      state.shouldShowRateLimitToast('429 for 60s')
      state.recordEmptyResponseAttempt('sess:model')
      state.markSoftQuotaToastShown()
      state.markRateLimitToastShown()

      const before = state.sizes()
      state.dispose()
      expect(state.disposed).toBe(true)

      // Mutating methods must NOT grow any map after dispose.
      state.getRateLimitBackoff(0, 'gemini-antigravity', 1000)
      state.trackAccountFailure(0)
      state.shouldShowRateLimitToast('429 for 60s')
      state.recordEmptyResponseAttempt('sess:model')
      state.markSoftQuotaToastShown()
      state.markRateLimitToastShown()
      state.resetRateLimitState(0, 'gemini-antigravity')
      state.resetAllRateLimitStateForAccount(0)
      state.resetAccountFailureState(0)
      state.clearEmptyResponseAttempts()
      state.resetAllAccountsBlockedToasts()
      state.clear()

      expect(state.sizes()).toEqual({
        rateLimitState: 0,
        accountFailure: 0,
        rateLimitToast: 0,
        emptyResponse: 0,
      })
      expect(before).toEqual({
        rateLimitState: 1,
        accountFailure: 1,
        rateLimitToast: 1,
        emptyResponse: 1,
      })
    })

    it('returns identity values from mutating getters after dispose()', () => {
      state.dispose()
      expect(state.getRateLimitBackoff(0, 'gemini', 1000)).toEqual({
        attempt: 1,
        delayMs: 1000,
        isDuplicate: false,
      })
      expect(state.trackAccountFailure(0)).toEqual({
        failures: 0,
        shouldCooldown: false,
        cooldownMs: 0,
      })
      expect(state.shouldShowRateLimitToast('any message')).toBe(false)
      expect(state.recordEmptyResponseAttempt('k')).toBe(0)
      expect(state.softQuotaToastShown()).toBe(false)
      expect(state.rateLimitToastShown()).toBe(false)
    })
  })

  describe('map size caps', () => {
    it('evicts the oldest entry when the rate-limit backoff map is full', () => {
      const MAX = 100
      for (let i = 0; i < MAX; i++) {
        state.getRateLimitBackoff(0, `quota-${i}`, 1000)
      }
      expect(state.sizes().rateLimitState).toBe(MAX)
      state.getRateLimitBackoff(0, 'quota-overflow', 1000)
      expect(state.sizes().rateLimitState).toBe(MAX)
      // The oldest insertion (quota-0) must have been evicted; the new entry is present.
      expect(
        state.getRateLimitBackoff(0, 'quota-overflow', 1000).isDuplicate,
      ).toBe(true)
    })

    it('evicts the oldest entry when the account-failure map is full', () => {
      const MAX = 100
      for (let i = 0; i < MAX; i++) {
        state.trackAccountFailure(i)
      }
      expect(state.sizes().accountFailure).toBe(MAX)
      state.trackAccountFailure(9999)
      expect(state.sizes().accountFailure).toBe(MAX)
    })

    it('evicts the oldest entry when the empty-response map is full', () => {
      const MAX = 100
      for (let i = 0; i < MAX; i++) {
        state.recordEmptyResponseAttempt(`key-${i}`)
      }
      expect(state.sizes().emptyResponse).toBe(MAX)
      state.recordEmptyResponseAttempt('key-overflow')
      expect(state.sizes().emptyResponse).toBe(MAX)
    })
  })
})
