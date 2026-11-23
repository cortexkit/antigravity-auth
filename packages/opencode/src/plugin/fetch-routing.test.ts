import { describe, expect, it } from 'bun:test'

import {
  extractModelFromUrl,
  getCapacityBackoffDelay,
  getModelFamilyFromUrl,
  isCapacityRetryBudgetExhausted,
  toUrlString,
  toWarmupStreamUrl,
} from '@cortexkit/antigravity-auth-core/engine'

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent'

describe('fetch URL routing', () => {
  it('normalizes string, URL, and Request inputs', () => {
    expect(toUrlString(GEMINI_URL)).toBe(GEMINI_URL)
    expect(toUrlString(new URL(GEMINI_URL) as unknown as RequestInfo)).toBe(
      GEMINI_URL,
    )
    expect(toUrlString(new Request(GEMINI_URL))).toBe(GEMINI_URL)
  })

  it('converts warmup requests to streaming SSE URLs', () => {
    expect(toWarmupStreamUrl(GEMINI_URL)).toBe(
      `${GEMINI_URL.replace(':generateContent', ':streamGenerateContent')}?alt=sse`,
    )
  })

  it('extracts models and classifies model families', () => {
    expect(extractModelFromUrl(GEMINI_URL)).toBe('gemini-3-flash')
    expect(getModelFamilyFromUrl(GEMINI_URL)).toBe('gemini')
    expect(
      getModelFamilyFromUrl(
        GEMINI_URL.replace('gemini-3-flash', 'claude-sonnet-4-6'),
      ),
    ).toBe('claude')
  })
})

describe('capacity retry backoff', () => {
  it('uses bounded backoff tiers', () => {
    expect([0, 1, 2, 3, 4, 99].map(getCapacityBackoffDelay)).toEqual([
      5000, 10000, 20000, 30000, 60000, 60000,
    ])
  })

  it('exhausts the total retry budget at four attempts', () => {
    expect(isCapacityRetryBudgetExhausted(3)).toBe(false)
    expect(isCapacityRetryBudgetExhausted(4)).toBe(true)
  })
})
