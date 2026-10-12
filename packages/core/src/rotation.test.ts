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

describe('tracker reindexing', () => {
  it('moves health and token state to new indexes and drops accounts that left', () => {
    const now = () => 1_000_000
    const health = new HealthScoreTracker({}, now)
    const tokens = new TokenBucketTracker({}, now)
    health.recordFailure(0)
    health.recordFailure(0)
    health.recordRateLimit(2)
    tokens.consume(0, 10)
    tokens.consume(2, 3)
    const failedScore = health.getScore(0)
    const limitedScore = health.getScore(2)
    const fresh = new HealthScoreTracker({}, now).getScore(9)
    // Account 0 moved to 1, account 2 left, account 1 (untracked) to 0.
    const mapping = new Map([
      [0, 1],
      [1, 0],
    ])
    health.reindex(mapping)
    tokens.reindex(mapping)
    expect(health.getScore(1)).toBe(failedScore)
    expect(health.getConsecutiveFailures(1)).toBe(2)
    expect(health.getScore(0)).toBe(fresh)
    expect(health.getScore(2)).toBe(fresh)
    expect(limitedScore).not.toBe(fresh)
    const initialTokens = new TokenBucketTracker({}, now).getTokens(9)
    expect(tokens.getTokens(1)).toBe(initialTokens - 10)
    expect(tokens.getTokens(2)).toBe(initialTokens)
    expect(tokens.getTokens(0)).toBe(initialTokens)
  })
})
