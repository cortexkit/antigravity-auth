import { describe, expect, it } from 'bun:test'
import type { QuotaGroupSummary } from '../quota.ts'
import type { ModelAccountStatus } from './model-status.ts'
import { getModelStatusFromAccounts } from './model-status.ts'

function makeAccount(
  overrides: Partial<ModelAccountStatus> = {},
): ModelAccountStatus {
  return {
    coolingDown: false,
    cooldownMs: 0,
    rateLimited: false,
    rateLimitWaitMs: 0,
    ...overrides,
  }
}

function makeQuotaGroup(
  remaining: number,
  resetTime?: string,
): QuotaGroupSummary {
  return { remainingFraction: remaining, resetTime, modelCount: 1 }
}

describe('getModelStatusFromAccounts', () => {
  it('returns READY for empty accounts list', () => {
    expect(getModelStatusFromAccounts([])).toEqual({ label: 'READY' })
  })

  it('returns READY when one account is available with no quota data', () => {
    const accounts = [makeAccount()]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('returns READY when one account has high remaining quota', () => {
    const accounts = [makeAccount({ quotaGroup: makeQuotaGroup(0.8) })]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('returns LOW when all available accounts have low quota', () => {
    const accounts = [
      makeAccount({ quotaGroup: makeQuotaGroup(0.15) }),
      makeAccount({ quotaGroup: makeQuotaGroup(0.1) }),
    ]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'LOW' })
  })

  it('returns READY when at least one available account has high quota', () => {
    const accounts = [
      makeAccount({ quotaGroup: makeQuotaGroup(0.1) }),
      makeAccount({ quotaGroup: makeQuotaGroup(0.8) }),
    ]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('returns READY when some accounts are blocked but one is available', () => {
    const accounts = [
      makeAccount({ rateLimited: true, rateLimitWaitMs: 30000 }),
      makeAccount({ quotaGroup: makeQuotaGroup(0.5) }),
    ]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('returns WAIT when all accounts are rate-limited', () => {
    const accounts = [
      makeAccount({ rateLimited: true, rateLimitWaitMs: 30000 }),
      makeAccount({ rateLimited: true, rateLimitWaitMs: 60000 }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('WAIT')
    expect(result.waitMs).toBe(30000)
  })

  it('returns WAIT without duration when rate-limited with zero wait', () => {
    const accounts = [makeAccount({ rateLimited: true, rateLimitWaitMs: 0 })]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('WAIT')
    expect(result.waitMs).toBeUndefined()
  })

  it('returns COOLDOWN when all accounts are cooling down', () => {
    const accounts = [
      makeAccount({
        coolingDown: true,
        cooldownMs: 5000,
        cooldownReason: 'auth-failure',
      }),
      makeAccount({
        coolingDown: true,
        cooldownMs: 10000,
        cooldownReason: 'network-error',
      }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('COOLDOWN')
    expect(result.waitMs).toBe(5000)
    expect(result.cooldownReason).toBe('auth-failure')
  })

  it('returns COOLDOWN without waitMs when cooldownMs is zero', () => {
    const accounts = [
      makeAccount({
        coolingDown: true,
        cooldownMs: 0,
        cooldownReason: 'network-error',
      }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('COOLDOWN')
    expect(result.waitMs).toBeUndefined()
    expect(result.cooldownReason).toBe('network-error')
  })

  it('returns WAIT when mix of cooldown and rate-limited', () => {
    const accounts = [
      makeAccount({
        coolingDown: true,
        cooldownMs: 5000,
        cooldownReason: 'auth-failure',
      }),
      makeAccount({ rateLimited: true, rateLimitWaitMs: 30000 }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('WAIT')
    expect(result.waitMs).toBe(5000)
  })

  it('picks READY over LOW when accounts have mixed quota', () => {
    const accounts = [
      makeAccount({ quotaGroup: makeQuotaGroup(0.05) }),
      makeAccount({ quotaGroup: makeQuotaGroup(0.5) }),
    ]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('picks best status across available accounts with quota data', () => {
    const futureTime = new Date(Date.now() + 7200000).toISOString()
    const accounts = [
      makeAccount({ quotaGroup: makeQuotaGroup(0, futureTime) }),
      makeAccount({ quotaGroup: makeQuotaGroup(0.15) }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('LOW')
  })

  it('falls back to READY when available accounts have no quota data', () => {
    const accounts = [
      makeAccount({ rateLimited: true, rateLimitWaitMs: 5000 }),
      makeAccount(),
      makeAccount(),
    ]
    expect(getModelStatusFromAccounts(accounts)).toEqual({ label: 'READY' })
  })

  it('handles single cooling-down account', () => {
    const accounts = [
      makeAccount({
        coolingDown: true,
        cooldownMs: 15000,
        cooldownReason: 'project-error',
      }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('COOLDOWN')
    expect(result.waitMs).toBe(15000)
    expect(result.cooldownReason).toBe('project-error')
  })

  it('handles single rate-limited account', () => {
    const accounts = [
      makeAccount({ rateLimited: true, rateLimitWaitMs: 45000 }),
    ]
    const result = getModelStatusFromAccounts(accounts)
    expect(result.label).toBe('WAIT')
    expect(result.waitMs).toBe(45000)
  })
})
