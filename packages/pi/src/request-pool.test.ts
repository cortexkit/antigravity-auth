import { expect, spyOn, test } from 'bun:test'
import { createPiRequestPool, type PiRequestRow } from './request-pool.ts'

test('Pi resets the confirmed quota backoff ladder after the configured failure TTL', () => {
  for (const [ttl, expectedWait] of [
    [60_000, 60_000],
    [120_000, 300_000],
  ] as const) {
    let now = 1_000_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const row: PiRequestRow = { index: 0, rateLimitResetTimes: {} }
      const pool = createPiRequestPool(row)
      pool.markRateLimitedWithReason(row, 'gemini', null, 'QUOTA_EXHAUSTED')
      now += 75_000
      pool.markRateLimitedWithReason(row, 'gemini', null, 'UNKNOWN', 5_000)
      now += 5_000
      pool.markRateLimitedWithReason(
        row,
        'gemini',
        null,
        'QUOTA_EXHAUSTED',
        undefined,
        ttl,
      )
      expect(pool.getMinWaitTimeForFamily('gemini')).toBe(expectedWait)
    } finally {
      clock.mockRestore()
    }
  }
})
