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
  it('returns undefined for undefined quota', () => {
    expect(formatCachedQuotaWithStatus(undefined)).toBeUndefined()
  })

  it('returns undefined for empty quota', () => {
    expect(formatCachedQuotaWithStatus({})).toBeUndefined()
  })

  it('ignores unknown / legacy quota keys while keeping the supported ones', () => {
    // Older snapshots may carry `claude`, `gemini-antigravity`, or
    // `gemini-cli` keys left over from the 3/4-key model. The collapsed
    // two-pool projection must drop those (not crash, not surface them
    // as extra groups) and render only the supported pools.
    const result = formatCachedQuotaWithStatus({
      claude: { remainingFraction: 0.5 },
      'gemini-antigravity': { remainingFraction: 0.5 },
      'gemini-cli': { remainingFraction: 0.5 },
      'non-gemini': { remainingFraction: 0.8 },
    } as never)
    expect(result).toBe('Non-Gemini 80%')
  })

  it('formats READY groups without status label', () => {
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: 0.8 },
    })
    expect(result).toBe('Non-Gemini 80%')
  })

  it('formats LOW groups with LOW label', () => {
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: 0.15 },
    })
    expect(result).toBe('Non-Gemini low 15%')
  })

  it('formats EXHAUSTED groups without trailing 0%', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const result = formatCachedQuotaWithStatus({
      gemini: { remainingFraction: 0, resetTime: futureTime },
    })
    // Single exhausted group — all groups exhausted, so formatCachedQuotaWithStatus
    // returns condensed reset info (undefined when no reset time)
    expect(result).toBeUndefined()
  })

  it('treats stale 0% without reset time as READY (not exhausted)', () => {
    const result = formatCachedQuotaWithStatus({
      gemini: { remainingFraction: 0 },
    })
    // Stale cache: no resetTime means quota likely already reset — treated as READY
    // READY at 0% still shows percentage (not hidden since pct < 100)
    expect(result).toBe('Gemini 0%')
  })

  it('formats multiple groups with mixed status', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: 0.8 },
      gemini: { remainingFraction: 0, resetTime: futureTime },
    })
    // Not all exhausted, so per-model breakdown shown; EXHAUSTED includes reset time
    expect(result).toMatch(/^Gemini exhausted resets in \dh, Non-Gemini 80%/)
  })

  it('includes non-Gemini quota in account health and summaries', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const quota = {
      gemini: { remainingFraction: 1 },
      'non-gemini': { remainingFraction: 0, resetTime: futureTime },
    }

    expect(classifyOverallQuotaHealth(quota).health).toBe('partial')
    expect(formatCachedQuotaWithStatus(quota)).toMatch(
      /^Non-Gemini exhausted resets in \dh/,
    )
  })

  it('hides groups at 100% READY', () => {
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: 1.0 },
      gemini: { remainingFraction: 0.5 },
    })
    expect(result).toBe('Gemini 50%')
  })

  it('returns undefined when all groups are 100% READY', () => {
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: 1.0 },
      gemini: { remainingFraction: 1.0 },
    })
    expect(result).toBeUndefined()
  })

  it('skips groups with non-numeric remaining fraction', () => {
    const result = formatCachedQuotaWithStatus({
      'non-gemini': { remainingFraction: undefined },
      gemini: { remainingFraction: 0.5 },
    })
    expect(result).toBe('Gemini 50%')
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
