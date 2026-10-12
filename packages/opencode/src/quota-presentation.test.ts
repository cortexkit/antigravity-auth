import { describe, expect, it } from 'bun:test'
import {
  formatQuota,
  quotaTextParts,
} from './common-auth-embedded/quota/index.js'
import {
  formatQuotaReading,
  NO_QUOTA_READING,
  quotaReadingParts,
} from './quota-presentation'

const now = 1_800_000_000_000

describe('client quota presentation', () => {
  it('uses the same full text and bar pieces as the public formatter', () => {
    const reading = {
      window: 'weekly' as const,
      remainingPercent: 58,
      checkedAt: now - 20 * 60_000,
      resetAt: now + 2 * 3_600_000,
    }
    const quota = {
      scope: 'all',
      checkedAt: reading.checkedAt,
      limits: [
        {
          scope: 'all',
          label: 'Gemini',
          kind: 'reading' as const,
          checkedAt: reading.checkedAt,
          windowMinutes: 7 * 24 * 60,
          remainingPercent: 58,
          resetsAt: new Date(reading.resetAt).toISOString(),
        },
      ],
    }
    expect(formatQuotaReading('Gemini', reading, now)).toBe(
      formatQuota(quota, { now }),
    )
    const pieces = quotaReadingParts('Gemini', reading, now)
    expect(pieces.name).toBe('7d')
    expect(pieces.figure).toBe('58% left')
    expect(pieces.remaining).toBe(58)
    expect(pieces.detail).toBe(
      quotaTextParts(quota, { now })[0]!.split(', ')[1] +
        ' · ' +
        quotaTextParts(quota, { now })[1],
    )
    expect(pieces.detail).toContain('checked 20m ago')
  })

  it('does not manufacture a reading age or a figure for undated quota', () => {
    for (const checkedAt of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
    ]) {
      const reading = { remainingPercent: 58, checkedAt, resetAt: now + 1000 }
      expect(formatQuotaReading('Gemini', reading, now)).toBe(NO_QUOTA_READING)
      expect(quotaReadingParts('Gemini', reading, now)).toEqual({
        name: 'Gemini',
        figure: NO_QUOTA_READING,
        detail: '',
        remaining: null,
      })
    }
  })

  it('uses a model label without inventing an unreported window or reset', () => {
    const reading = { remainingPercent: 25, checkedAt: now }
    expect(formatQuotaReading('Claude', reading, now)).toBe('Claude 25% left')
    expect(quotaReadingParts('Claude', reading, now)).toEqual({
      name: 'Claude',
      figure: '25% left',
      detail: '',
      remaining: 25,
    })
  })
})
