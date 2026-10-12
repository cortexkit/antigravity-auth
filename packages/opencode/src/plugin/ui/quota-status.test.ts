import { describe, expect, it } from 'bun:test'
import type { QuotaGroupSummary } from '../quota.ts'
import { ANSI } from './ansi.ts'
import {
  buildCooldownStatus,
  buildWaitStatus,
  classifyGroupStatus,
  classifyOverallQuotaHealth,
  formatCachedQuotaWithStatus,
  formatGroupQuotaBadge,
  formatQuotaStatusBadge,
  formatQuotaStatusPlain,
  formatWaitDuration,
} from './quota-status.ts'

describe('formatWaitDuration', () => {
  it('formats milliseconds', () => {
    expect(formatWaitDuration(500)).toBe('500ms')
    expect(formatWaitDuration(0)).toBe('0ms')
    expect(formatWaitDuration(999)).toBe('999ms')
  })

  it('formats seconds', () => {
    expect(formatWaitDuration(1000)).toBe('1s')
    expect(formatWaitDuration(30000)).toBe('30s')
    expect(formatWaitDuration(59000)).toBe('59s')
  })

  it('formats minutes', () => {
    expect(formatWaitDuration(60000)).toBe('1m')
    expect(formatWaitDuration(90000)).toBe('1m 30s')
    expect(formatWaitDuration(3600000 - 1000)).toBe('59m 59s')
  })

  it('formats hours', () => {
    expect(formatWaitDuration(3600000)).toBe('1h')
    expect(formatWaitDuration(5400000)).toBe('1h 30m')
    expect(formatWaitDuration(7200000)).toBe('2h')
  })
})

describe('classifyGroupStatus', () => {
  it('returns READY for undefined group', () => {
    expect(classifyGroupStatus(undefined)).toEqual({ label: 'READY' })
  })

  it('returns READY for undefined remaining fraction', () => {
    const group: QuotaGroupSummary = { modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })

  it('returns READY for high remaining fraction', () => {
    const group: QuotaGroupSummary = { remainingFraction: 0.8, modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })

  it('returns READY for 20% remaining (boundary)', () => {
    const group: QuotaGroupSummary = { remainingFraction: 0.2, modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })

  it('returns LOW for remaining below 20%', () => {
    const group: QuotaGroupSummary = { remainingFraction: 0.19, modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'LOW' })
  })

  it('returns LOW for 1% remaining', () => {
    const group: QuotaGroupSummary = { remainingFraction: 0.01, modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'LOW' })
  })

  it('returns EXHAUSTED for 0% remaining with future reset time', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const group: QuotaGroupSummary = {
      remainingFraction: 0,
      resetTime: futureTime,
      modelCount: 1,
    }
    const result = classifyGroupStatus(group)
    expect(result.label).toBe('EXHAUSTED')
    expect(result.waitMs).toBeGreaterThan(0)
  })

  it('returns READY for 0% remaining without reset time (stale cache)', () => {
    const group: QuotaGroupSummary = { remainingFraction: 0, modelCount: 1 }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })

  it('returns EXHAUSTED with waitMs when reset time is in the future', () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString()
    const group: QuotaGroupSummary = {
      remainingFraction: 0,
      resetTime: futureTime,
      modelCount: 1,
    }
    const result = classifyGroupStatus(group)
    expect(result.label).toBe('EXHAUSTED')
    expect(result.waitMs).toBeGreaterThan(0)
    expect(result.waitMs).toBeLessThanOrEqual(3600000)
  })

  it('returns READY when reset time is in the past (stale cache — quota already reset)', () => {
    const pastTime = new Date(Date.now() - 60000).toISOString()
    const group: QuotaGroupSummary = {
      remainingFraction: 0,
      resetTime: pastTime,
      modelCount: 1,
    }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })

  it('returns READY for NaN remaining fraction', () => {
    const group: QuotaGroupSummary = {
      remainingFraction: NaN,
      modelCount: 1,
    }
    expect(classifyGroupStatus(group)).toEqual({ label: 'READY' })
  })
})

describe('buildCooldownStatus', () => {
  it('builds cooldown with reason and wait time', () => {
    expect(buildCooldownStatus(5000, 'auth-failure')).toEqual({
      label: 'COOLDOWN',
      waitMs: 5000,
      cooldownReason: 'auth-failure',
    })
  })

  it('builds cooldown without reason', () => {
    expect(buildCooldownStatus(3000)).toEqual({
      label: 'COOLDOWN',
      waitMs: 3000,
      cooldownReason: undefined,
    })
  })

  it('omits waitMs when zero', () => {
    expect(buildCooldownStatus(0, 'network-error')).toEqual({
      label: 'COOLDOWN',
      waitMs: undefined,
      cooldownReason: 'network-error',
    })
  })
})

describe('buildWaitStatus', () => {
  it('builds wait with duration', () => {
    expect(buildWaitStatus(30000)).toEqual({ label: 'WAIT', waitMs: 30000 })
  })

  it('builds wait without duration', () => {
    expect(buildWaitStatus()).toEqual({ label: 'WAIT' })
  })

  it('builds wait without duration for zero ms', () => {
    expect(buildWaitStatus(0)).toEqual({ label: 'WAIT' })
  })
})

describe('formatQuotaStatusBadge', () => {
  it('formats READY badge in green', () => {
    const badge = formatQuotaStatusBadge({ label: 'READY' })
    expect(badge).toContain('[READY]')
    expect(badge).toContain(ANSI.green)
    expect(badge).toContain(ANSI.reset)
  })

  it('formats LOW badge in yellow', () => {
    const badge = formatQuotaStatusBadge({ label: 'LOW' })
    expect(badge).toContain('[LOW]')
    expect(badge).toContain(ANSI.yellow)
  })

  it('formats WAIT badge with duration', () => {
    const badge = formatQuotaStatusBadge({ label: 'WAIT', waitMs: 90000 })
    expect(badge).toContain('[WAIT 1m 30s]')
    expect(badge).toContain(ANSI.yellow)
  })

  it('formats WAIT badge without duration', () => {
    const badge = formatQuotaStatusBadge({ label: 'WAIT' })
    expect(badge).toContain('[WAIT]')
  })

  it('formats EXHAUSTED badge with reset time', () => {
    const badge = formatQuotaStatusBadge({
      label: 'EXHAUSTED',
      waitMs: 7200000,
    })
    expect(badge).toContain('[EXHAUSTED resets in 2h]')
    expect(badge).toContain(ANSI.red)
  })

  it('formats EXHAUSTED badge without reset time', () => {
    const badge = formatQuotaStatusBadge({ label: 'EXHAUSTED' })
    expect(badge).toContain('[EXHAUSTED]')
    expect(badge).not.toContain('resets in')
  })

  it('formats COOLDOWN badge with reason and wait', () => {
    const badge = formatQuotaStatusBadge({
      label: 'COOLDOWN',
      cooldownReason: 'auth-failure',
      waitMs: 5000,
    })
    expect(badge).toContain('[COOLDOWN auth-failure 5s]')
    expect(badge).toContain(ANSI.red)
  })

  it('formats COOLDOWN badge with reason only', () => {
    const badge = formatQuotaStatusBadge({
      label: 'COOLDOWN',
      cooldownReason: 'network-error',
    })
    expect(badge).toContain('[COOLDOWN network-error]')
  })

  it('formats COOLDOWN badge with no extras', () => {
    const badge = formatQuotaStatusBadge({ label: 'COOLDOWN' })
    expect(badge).toContain('[COOLDOWN]')
  })
})

describe('formatQuotaStatusPlain', () => {
  it('formats READY', () => {
    expect(formatQuotaStatusPlain({ label: 'READY' })).toBe('READY')
  })

  it('formats LOW', () => {
    expect(formatQuotaStatusPlain({ label: 'LOW' })).toBe('LOW')
  })

  it('formats WAIT with duration', () => {
    expect(formatQuotaStatusPlain({ label: 'WAIT', waitMs: 60000 })).toBe(
      'WAIT 1m',
    )
  })

  it('formats EXHAUSTED with reset', () => {
    expect(
      formatQuotaStatusPlain({ label: 'EXHAUSTED', waitMs: 3600000 }),
    ).toBe('EXHAUSTED resets in 1h')
  })

  it('formats COOLDOWN with reason', () => {
    expect(
      formatQuotaStatusPlain({
        label: 'COOLDOWN',
        cooldownReason: 'project-error',
        waitMs: 10000,
      }),
    ).toBe('COOLDOWN project-error 10s')
  })
})

describe('formatCachedQuotaWithStatus', () => {
  const now = 1_800_000_000_000
  const futureTime = new Date(now + 7_200_000).toISOString()

  it('returns undefined for undefined quota', () => {
    expect(formatCachedQuotaWithStatus(undefined, now, now)).toBeUndefined()
  })

  it('shows the shared missing-reading message for empty quota', () => {
    expect(formatCachedQuotaWithStatus({}, now, now)).toBe(
      'no quota reading yet',
    )
  })

  it('ignores unknown / legacy quota keys while keeping the supported ones', () => {
    const result = formatCachedQuotaWithStatus(
      {
        claude: { remainingFraction: 0.5 },
        'gemini-antigravity': { remainingFraction: 0.5 },
        'gemini-cli': { remainingFraction: 0.5 },
        'non-gemini': { remainingFraction: 0.8 },
      },
      now,
      now,
    )
    expect(result).toBe('Claude / GPT-OSS 80% left')
  })

  it('formats READY groups without a redundant status label', () => {
    expect(
      formatCachedQuotaWithStatus(
        { 'non-gemini': { remainingFraction: 0.8 } },
        now,
        now,
      ),
    ).toBe('Claude / GPT-OSS 80% left')
  })

  it('formats LOW groups using the same remaining figure as other views', () => {
    expect(
      formatCachedQuotaWithStatus(
        { 'non-gemini': { remainingFraction: 0.15 } },
        now,
        now,
      ),
    ).toBe('Claude / GPT-OSS 15% left')
  })

  it('formats EXHAUSTED groups with their reported zero and reset', () => {
    expect(
      formatCachedQuotaWithStatus(
        { gemini: { remainingFraction: 0, resetTime: futureTime } },
        now,
        now,
      ),
    ).toBe('Gemini 0% left, resets 2h')
  })

  it('does not infer a reset or READY label from an absent reset time', () => {
    expect(
      formatCachedQuotaWithStatus(
        { gemini: { remainingFraction: 0 } },
        now,
        now,
      ),
    ).toBe('Gemini 0% left')
  })

  it('formats multiple groups with mixed status', () => {
    expect(
      formatCachedQuotaWithStatus(
        {
          'non-gemini': { remainingFraction: 0.8 },
          gemini: { remainingFraction: 0, resetTime: futureTime },
        },
        now,
        now,
      ),
    ).toBe('Gemini 0% left, resets 2h · Claude / GPT-OSS 80% left')
  })

  it('includes non-Gemini quota in account health and summaries', () => {
    const quota = {
      gemini: { remainingFraction: 1 },
      'non-gemini': { remainingFraction: 0, resetTime: futureTime },
    }
    expect(classifyOverallQuotaHealth(quota).health).toBe('partial')
    expect(formatCachedQuotaWithStatus(quota, now, now)).toBe(
      'Gemini 100% left · Claude / GPT-OSS 0% left, resets 2h',
    )
  })

  it('keeps reported groups at 100% rather than hiding their windows', () => {
    expect(
      formatCachedQuotaWithStatus(
        {
          'non-gemini': { remainingFraction: 1 },
          gemini: { remainingFraction: 0.5 },
        },
        now,
        now,
      ),
    ).toBe('Gemini 50% left · Claude / GPT-OSS 100% left')
  })

  it('keeps all reported groups when all are at 100%', () => {
    expect(
      formatCachedQuotaWithStatus(
        {
          'non-gemini': { remainingFraction: 1 },
          gemini: { remainingFraction: 1 },
        },
        now,
        now,
      ),
    ).toBe('Gemini 100% left · Claude / GPT-OSS 100% left')
  })

  it('skips groups with non-numeric remaining fraction', () => {
    expect(
      formatCachedQuotaWithStatus(
        {
          'non-gemini': { remainingFraction: undefined },
          gemini: { remainingFraction: 0.5 },
        },
        now,
        now,
      ),
    ).toBe('Gemini 50% left')
  })

  it('does not fabricate an age for an undated cached figure', () => {
    expect(
      formatCachedQuotaWithStatus(
        { gemini: { remainingFraction: 0.5 } },
        undefined,
        now,
      ),
    ).toBe('no quota reading yet')
    expect(
      formatCachedQuotaWithStatus(
        { gemini: { remainingFraction: 0.5 } },
        now - 20 * 60_000,
        now,
      ),
    ).toBe('Gemini 50% left · checked 20m ago')
  })
})

describe('formatGroupQuotaBadge', () => {
  it('returns READY badge for high remaining', () => {
    const badge = formatGroupQuotaBadge(0.8)
    expect(badge).toContain('[READY]')
  })

  it('returns LOW badge for low remaining', () => {
    const badge = formatGroupQuotaBadge(0.1)
    expect(badge).toContain('[LOW]')
  })

  it('returns EXHAUSTED badge for zero remaining with future reset', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const badge = formatGroupQuotaBadge(0, futureTime)
    expect(badge).toContain('[EXHAUSTED')
  })

  it('returns READY badge for zero remaining without reset time (stale)', () => {
    const badge = formatGroupQuotaBadge(0)
    expect(badge).toContain('[READY]')
  })

  it('returns READY badge for undefined remaining', () => {
    const badge = formatGroupQuotaBadge(undefined)
    expect(badge).toContain('[READY]')
  })
})
