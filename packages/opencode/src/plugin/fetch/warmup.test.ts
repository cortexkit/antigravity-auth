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

    it('returns false only after success has been recorded', () => {
      // Without success, attempts are not blocked at the per-session level
      // (the legacy semantics gate only on the succeeded set).
      state.trackAttempt('sess-2')
      expect(state.trackAttempt('sess-2')).toBe(true)
      state.markSuccess('sess-2')
      expect(state.trackAttempt('sess-2')).toBe(false)
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
      // No explicit size accessor; behavior is "no throw"
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
      state.dispose()
      expect(state.disposed).toBe(true)
      // After dispose, calls are no-ops but should not throw
      expect(state.trackAttempt('sess-5')).toBe(false)
      expect(state.markSuccess('sess-5')).toBeUndefined()
      expect(state.clearWarmupAttempt('sess-5')).toBeUndefined()
    })
  })
})
