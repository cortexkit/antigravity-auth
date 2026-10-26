import { describe, expect, it } from 'bun:test'
import type { QuotaState } from './account-repository-types.ts'
import {
  formatAntigravityQuota,
  projectAntigravityQuota,
} from './quota-presentation.ts'

const NOW = Date.UTC(2026, 9, 10, 18)
function reading(checkedAt: number | undefined = NOW): QuotaState {
  return {
    schemaVersion: 1,
    cachedQuotaUpdatedAt: checkedAt,
    cachedQuota: {
      'gemini-flash': {
        modelCount: 1,
        remainingFraction: 0.1,
        windows: [
          {
            window: '5h',
            remainingFraction: 0.25,
            resetTime: new Date(NOW + 2 * 60 * 60_000).toISOString(),
          },
          {
            window: 'weekly',
            remainingFraction: 0.8,
            resetTime: new Date(NOW + 24 * 60 * 60_000).toISOString(),
          },
        ],
      },
    },
  }
}

describe('Antigravity quota presentation', () => {
  it('uses shared percent-left, window duration and relative reset wording without adding a pooled duplicate', () => {
    const text = formatAntigravityQuota(reading(), { now: NOW })
    expect(text).toContain('Gemini Flash 5h 25% left, resets 2h')
    expect(text).toContain('Gemini Flash 7d 80% left')
    expect(text).not.toContain('10%')
    expect(text).not.toContain('primary')
    expect(text).not.toContain('secondary')
    expect(text).not.toContain('checked')
  })

  it('dates every projected window by the actual reading, not the display time', () => {
    const checkedAt = NOW - 30 * 60_000
    const projected = projectAntigravityQuota(reading(checkedAt))
    expect(projected?.limits.map((limit) => limit.checkedAt)).toEqual([
      checkedAt,
      checkedAt,
    ])
    expect(formatAntigravityQuota(reading(checkedAt), { now: NOW })).toContain(
      'checked 30m ago',
    )
  })

  it('omits percentages whose reading age is unknown', () => {
    const undated = reading()
    delete undated.cachedQuotaUpdatedAt
    expect(projectAntigravityQuota(undated)).toBeUndefined()
    expect(formatAntigravityQuota(undated, { now: NOW })).toBe(
      'no quota reading yet',
    )
  })

  it('omits unreported windows and uses model labels for pooled readings', () => {
    const quota: QuotaState = {
      schemaVersion: 1,
      cachedQuotaUpdatedAt: NOW,
      cachedQuota: { claude: { modelCount: 2, remainingFraction: 0.6 } },
    }
    expect(formatAntigravityQuota(quota, { now: NOW })).toBe('Claude 60% left')
    expect(formatAntigravityQuota(undefined, { now: NOW })).toBe(
      'no quota reading yet',
    )
  })
})

it('projects the argon pool with an Ar narrow form for accounts that report it', () => {
  const now = 1_800_000_000_000
  const reset = new Date(now + 2 * 60 * 60_000).toISOString()
  const quota: QuotaState = {
    schemaVersion: 1 as const,
    cachedQuotaUpdatedAt: now,
    cachedQuota: {
      gemini: {
        remainingFraction: 0.9,
        modelCount: 2,
        windows: [
          { window: 'weekly', remainingFraction: 0.9, resetTime: reset },
        ],
      },
      'gemini-argon': {
        remainingFraction: 0.4,
        modelCount: 1,
        windows: [
          { window: 'weekly', remainingFraction: 0.4, resetTime: reset },
        ],
      },
    },
  }
  expect(formatAntigravityQuota(quota, { now })).toBe(
    'Gemini 7d 90% left, resets 2h · Argon 7d 40% left, resets 2h',
  )
  expect(projectAntigravityQuota(quota)?.groups).toEqual([
    { scope: 'gemini', label: 'Gemini' },
    { scope: 'non-gemini', label: 'Other models' },
    { scope: 'gemini-argon', label: 'Argon' },
  ])
  expect(formatAntigravityQuota(quota, { now, form: 'narrow' })).toBe(
    'Ge 7d 90% · Ar 7d 40% left',
  )
})

it('renders byte-identical output for a reading without the argon bucket', () => {
  const now = 1_800_000_000_000
  const quota: QuotaState = {
    schemaVersion: 1 as const,
    cachedQuotaUpdatedAt: now,
    cachedQuota: {
      gemini: { remainingFraction: 0.58, modelCount: 3 },
      'non-gemini': { remainingFraction: 0.25, modelCount: 2 },
    },
  }
  expect(formatAntigravityQuota(quota, { now })).toBe(
    'Gemini 58% left · Claude / GPT-OSS 25% left',
  )
  expect(projectAntigravityQuota(quota)?.groups).toEqual([
    { scope: 'gemini', label: 'Gemini' },
    { scope: 'non-gemini', label: 'Other models' },
  ])
  expect(formatAntigravityQuota(quota, { now, form: 'narrow' })).toBe(
    'Ge 58% · Ot 25% left',
  )
})

it('formats the current Antigravity pool keys with named models and genuine cache age', () => {
  const now = 1_800_000_000_000
  const quota = {
    schemaVersion: 1 as const,
    cachedQuotaUpdatedAt: now,
    cachedQuota: {
      gemini: { remainingFraction: 0.58, modelCount: 3 },
      'non-gemini': { remainingFraction: 0.25, modelCount: 2 },
    },
  }
  expect(formatAntigravityQuota(quota, { now })).toBe(
    'Gemini 58% left · Claude / GPT-OSS 25% left',
  )
  expect(projectAntigravityQuota(quota)?.groups).toEqual([
    { scope: 'gemini', label: 'Gemini' },
    { scope: 'non-gemini', label: 'Other models' },
  ])
  expect(formatAntigravityQuota(quota, { now, form: 'narrow' })).toBe(
    'Ge 58% · Ot 25% left',
  )
})
