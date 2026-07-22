import { describe, expect, it } from 'bun:test'

import {
  addJitter,
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  HealthScoreTracker,
  parseRateLimitReason,
  randomDelay,
  selectHybridAccount,
  sortByLruWithHealth,
  TokenBucketTracker,
} from './rotation.ts'

describe('rotation primitives', () => {
  it('parses rate-limit reasons and calculates deterministic backoff', () => {
    expect(parseRateLimitReason(undefined, 'service overloaded', 503)).toBe(
      'MODEL_CAPACITY_EXHAUSTED',
    )
    expect(
      calculateBackoffMs('MODEL_CAPACITY_EXHAUSTED', 0, null, () => 0.5),
    ).toBe(45_000)
    expect(computeSoftQuotaCacheTtlMs('auto', 3)).toBe(600_000)
  })

  it('injects random values for jitter helpers', () => {
    expect(addJitter(1_000, 0.3, () => 0)).toBe(700)
    expect(randomDelay(100, 500, () => 0.5)).toBe(300)
  })

  it('recovers health and tokens with injected time', () => {
    let now = 0
    const health = new HealthScoreTracker(
      { initial: 70, failurePenalty: -20, recoveryRatePerHour: 10 },
      () => now,
    )
    health.recordFailure(0)
    expect(health.getScore(0)).toBe(50)
    now = 2 * 60 * 60 * 1_000
    expect(health.getScore(0)).toBe(70)

    now = 0
    const tokens = new TokenBucketTracker(
      { initialTokens: 10, maxTokens: 10, regenerationRatePerMinute: 2 },
      () => now,
    )
    tokens.consume(0, 10)
    expect(tokens.getTokens(0)).toBe(0)
    now = 5 * 60 * 1_000
    expect(tokens.getTokens(0)).toBe(10)
  })

  it('sorts LRU candidates and hybrid-selects deterministically', () => {
    const candidates = [
      {
        index: 0,
        lastUsed: 5_000,
        healthScore: 70,
        isRateLimited: false,
        isCoolingDown: false,
      },
      {
        index: 1,
        lastUsed: 1_000,
        healthScore: 80,
        isRateLimited: false,
        isCoolingDown: false,
      },
    ]
    expect(sortByLruWithHealth(candidates).map(({ index }) => index)).toEqual([
      1, 0,
    ])
    const tokens = new TokenBucketTracker({}, () => 10_000)
    expect(
      selectHybridAccount(candidates, tokens, null, 50, () => 10_000),
    ).toBe(1)
  })
})
