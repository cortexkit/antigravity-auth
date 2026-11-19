import { beforeEach, describe, expect, it } from 'bun:test'

import { createWarmupState } from './warmup'

describe('WarmupState', () => {
  let state: ReturnType<typeof createWarmupState>

  beforeEach(() => {
    state = createWarmupState()
  })

  describe('attempt tracking', () => {
    it('records new attempts and lets them proceed', () => {
      expect(state.trackAttempt('sess-1')).toBe(true)
      expect(state.trackAttempt('sess-1')).toBe(true)
      // After marking success, further attempts return false (already succeeded)
      state.markSuccess('sess-1')
      expect(state.trackAttempt('sess-1')).toBe(false)
    })

    it('refuses further attempts after success', () => {
      state.trackAttempt('sess-2')
      state.markSuccess('sess-2')
      expect(state.trackAttempt('sess-2')).toBe(false)
    })

    it('stops a failing warmup after the retry limit', () => {
      // A failed warmup that reached the network keeps its attempt, so
      // repeated failures cannot run a warmup before every request.
      const allowed: boolean[] = []
      for (let i = 0; i < 6; i++) allowed.push(state.trackAttempt('failing'))
      expect(allowed).toEqual([true, true, false, false, false, false])
      expect(state.getAttemptCount('failing')).toBe(2)
    })

    it('refunds an attempt that never reached the network', () => {
      expect(state.trackAttempt('refund')).toBe(true)
      state.refundAttempt('refund')
      expect(state.getAttemptCount('refund')).toBe(0)
      expect(state.trackAttempt('refund')).toBe(true)
      expect(state.trackAttempt('refund')).toBe(true)
      state.refundAttempt('refund')
      expect(state.getAttemptCount('refund')).toBe(1)
    })

    it('reports attempt count for sessions', () => {
      expect(state.getAttemptCount('fresh')).toBe(0)
      state.trackAttempt('fresh')
      // After one track, the count is 1
      expect(state.getAttemptCount('fresh')).toBe(1)
    })
  })

  describe('success marking', () => {
    it('makes future attempts return false (already succeeded)', () => {
      state.markSuccess('sess-3')
      expect(state.trackAttempt('sess-3')).toBe(false)
    })

    it('caps the succeeded set at the warmup session limit', () => {
      // Push the limit; the state should evict the oldest entries silently
      for (let i = 0; i < 1500; i++) {
        state.markSuccess(`sess-${i}`)
      }
      expect(state.trackAttempt('sess-0')).toBe(true)
      expect(state.trackAttempt('sess-1499')).toBe(false)
    })
  })

  describe('clear()', () => {
    it('drops attempt + success bookkeeping', () => {
      state.trackAttempt('sess-4')
      state.markSuccess('sess-4')
      state.clear()
      expect(state.trackAttempt('sess-4')).toBe(true)
      expect(state.getAttemptCount('sess-4')).toBe(1)
    })
  })

  describe('disposal', () => {
    it('marks disposed and clears state', () => {
      state.trackAttempt('sess-5')
      expect(state.getAttemptCount('sess-5')).toBe(1)
      state.dispose()
      expect(state.disposed).toBe(true)
      expect(state.getAttemptCount('sess-5')).toBe(0)
      // After dispose, calls are no-ops but should not throw
      expect(state.trackAttempt('sess-5')).toBe(false)
      expect(state.markSuccess('sess-5')).toBeUndefined()
      expect(state.refundAttempt('sess-5')).toBeUndefined()
    })
  })
})
