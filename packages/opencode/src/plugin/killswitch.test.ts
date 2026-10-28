import { describe, expect, it } from 'bun:test'
import { AntigravityKillswitchError } from './errors'
import {
  accountKeyForRefreshToken,
  evaluateKillswitchForAccount,
  summarizeKillswitchOutcomes,
  throwIfAllKilled,
} from './killswitch'
import {
  emptyOperatorSettings,
  type OperatorSettings,
} from './operator-settings'

const NOW = 1_700_000_000_000

function disabled(): OperatorSettings {
  return emptyOperatorSettings()
}

function enabledWith(threshold: number): OperatorSettings {
  return {
    killswitch: { enabled: true, minimum_remaining_percent: threshold },
    log_level: 'info',
  }
}

describe('accountKeyForRefreshToken', () => {
  it('returns sha256(refreshToken).slice(0,12) — a stable 12-char account key', () => {
    const key = accountKeyForRefreshToken('rt-test')
    expect(key).toHaveLength(12)
    expect(key).toMatch(/^[a-f0-9]{12}$/)
    expect(accountKeyForRefreshToken('rt-test')).toBe(key)
  })
})

describe('evaluateKillswitchForAccount', () => {
  it('always allows when the killswitch is disabled', () => {
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: { 'non-gemini': { remainingFraction: 0, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW,
      },
      'claude',
      disabled(),
      { now: NOW },
    )
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('killswitch-disabled')
  })

  it('fails open when cached quota is missing', () => {
    const decision = evaluateKillswitchForAccount(
      { index: 0, refreshToken: 'rt' },
      'claude',
      enabledWith(20),
      { now: NOW },
    )
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('quota-missing-or-stale')
  })

  it('fails open when cached quota is older than the TTL', () => {
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: { 'non-gemini': { remainingFraction: 0, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW - 10 * 60 * 1000,
      },
      'claude',
      enabledWith(20),
      { now: NOW, cacheTtlMs: 5 * 60 * 1000 },
    )
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('quota-missing-or-stale')
  })

  it('excludes accounts below the global threshold', () => {
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.04, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      'claude',
      enabledWith(5),
      { now: NOW },
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('below-threshold')
    expect(decision.remainingPercent).toBe(4)
    expect(decision.thresholdPercent).toBe(5)
  })

  it('honours a per-account override that is stricter than the global threshold', () => {
    const settings: OperatorSettings = {
      killswitch: {
        enabled: true,
        minimum_remaining_percent: 5,
        accounts: { [accountKeyForRefreshToken('rt')]: 50 },
      },
      log_level: 'info',
    }
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.2, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      'claude',
      settings,
      { now: NOW },
    )
    expect(decision.allowed).toBe(false)
    expect(decision.thresholdPercent).toBe(50)
  })

  it('uses freshest quota group across the family when no model is provided', () => {
    // Without a model, the family-max behavior is preserved — pick the
    // highest remaining pool across gemini + non-gemini. The 90%
    // non-gemini pool must outweigh the 2% gemini pool so the family
    // is allowed. The model-scoped tests below pin the regression:
    // if a future change accidentally collapses both branches to
    // family-max, those assertions fail because they expect the gemini
    // pool alone to drive the deny decision.
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          gemini: { remainingFraction: 0.02, modelCount: 1 },
          'non-gemini': { remainingFraction: 0.9, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      'gemini',
      enabledWith(5),
      { now: NOW },
    )
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('ok')
    expect(decision.remainingPercent).toBe(90)
  })

  it.each([
    'gemini-3-pro',
    'gemini-3-flash',
    'gemini-3-unknown-variant',
  ])('scopes evaluation to gemini alone for %s', (model) => {
    // gemini pool is at 2% — must be DENIED because below 5% threshold.
    // The non-gemini pool sits at 90% so a regression that ignored
    // `model` (and fell back to family-max) would let this through.
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          gemini: { remainingFraction: 0.02, modelCount: 1 },
          'non-gemini': { remainingFraction: 0.9, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      'gemini',
      enabledWith(5),
      { now: NOW, model },
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('below-threshold')
    expect(decision.remainingPercent).toBe(2)
  })

  it('scopes an argon request to the argon pool on accounts that report it', () => {
    // The Argon weekly allowance is exhausted while the ordinary Gemini
    // pool is fresh: the Argon request is denied, the Gemini request is
    // allowed. A regression that ignored the account's Argon pool (and
    // read Gemini for both) would allow the Argon request.
    const pro = {
      index: 0,
      refreshToken: 'rt',
      cachedQuota: {
        gemini: { remainingFraction: 0.9, modelCount: 2 },
        'gemini-argon': { remainingFraction: 0, modelCount: 1 },
      },
      cachedQuotaUpdatedAt: NOW,
    }
    const argon = evaluateKillswitchForAccount(pro, 'gemini', enabledWith(5), {
      now: NOW,
      model: 'gemini-4-argon-medium',
    })
    expect(argon.allowed).toBe(false)
    expect(argon.reason).toBe('below-threshold')
    expect(argon.remainingPercent).toBe(0)
    const gemini = evaluateKillswitchForAccount(pro, 'gemini', enabledWith(5), {
      now: NOW,
      model: 'gemini-3-flash',
    })
    expect(gemini.allowed).toBe(true)
    expect(gemini.remainingPercent).toBe(90)
  })

  it('counts argon against the gemini pool on accounts without the argon bucket', () => {
    // Ultra-shaped account: no Argon bucket, exhausted Gemini pool. The
    // Argon request is judged on the ordinary Gemini pool, exactly as
    // before the Argon pool existed.
    const ultra = {
      index: 0,
      refreshToken: 'rt',
      cachedQuota: {
        gemini: { remainingFraction: 0, modelCount: 2 },
      },
      cachedQuotaUpdatedAt: NOW,
    }
    const denied = evaluateKillswitchForAccount(
      ultra,
      'gemini',
      enabledWith(5),
      { now: NOW, model: 'gemini-4-argon-medium' },
    )
    expect(denied.allowed).toBe(false)
    expect(denied.remainingPercent).toBe(0)
    const fresh = evaluateKillswitchForAccount(
      {
        ...ultra,
        cachedQuota: { gemini: { remainingFraction: 0.9, modelCount: 2 } },
      },
      'gemini',
      enabledWith(5),
      { now: NOW, model: 'antigravity-gemini-4-argon' },
    )
    expect(fresh.allowed).toBe(true)
    expect(fresh.remainingPercent).toBe(90)
  })

  it('falls back to family-max when the model is unknown', () => {
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          gemini: { remainingFraction: 0.02, modelCount: 1 },
          'non-gemini': { remainingFraction: 0.9, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      'gemini',
      enabledWith(5),
      { now: NOW, model: 'unrecognized-model' },
    )
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('ok')
    expect(decision.remainingPercent).toBe(90)
  })
})

describe('summarizeKillswitchOutcomes', () => {
  it('returns redacted per-account summaries keyed by hash', () => {
    const summaries = summarizeKillswitchOutcomes(
      [
        {
          index: 0,
          refreshToken: 'secret-token-a',
          cachedQuota: {
            'non-gemini': { remainingFraction: 0.5, modelCount: 1 },
          },
          cachedQuotaUpdatedAt: NOW,
        },
        { index: 1, refreshToken: 'secret-token-b' },
      ],
      'claude',
      enabledWith(20),
      { now: NOW },
    )
    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.accountKey).toBe(
      accountKeyForRefreshToken('secret-token-a'),
    )
    expect(summaries[0]?.accountKey).not.toContain('secret-token-a')
    expect(summaries[1]?.remainingPercent).toBeNull()
  })
})

describe('throwIfAllKilled', () => {
  it('names the current Limits menu in killswitch guidance', () => {
    const error = new AntigravityKillswitchError({
      family: 'gemini',
      model: 'gemini-3-flash',
      thresholdPercent: 5,
      summaries: [
        { accountKey: 'redacted', remainingPercent: 2, thresholdPercent: 5 },
      ],
    })
    expect(error.message).toBe(
      'Antigravity killswitch: all 1 account(s) under 5% quota for gemini. Refresh quota or adjust the quota floor in /antigravity → Limits.',
    )
    expect(error.message).not.toMatch(/429|500|502|503|504|524/)
  })

  it('throws AntigravityKillswitchError when every candidate is below threshold', () => {
    const accounts = [
      {
        index: 0,
        refreshToken: 'rt-a',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.02, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      {
        index: 1,
        refreshToken: 'rt-b',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.0, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
    ]
    expect(() =>
      throwIfAllKilled({
        family: 'claude',
        model: 'claude-test',
        accounts,
        settings: enabledWith(5),
        now: NOW,
      }),
    ).toThrow(AntigravityKillswitchError)
  })

  it('is a no-op when at least one candidate is healthy', () => {
    const accounts = [
      {
        index: 0,
        refreshToken: 'rt-a',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.02, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
      {
        index: 1,
        refreshToken: 'rt-b',
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.5, modelCount: 1 },
        },
        cachedQuotaUpdatedAt: NOW,
      },
    ]
    expect(() =>
      throwIfAllKilled({
        family: 'claude',
        model: 'claude-test',
        accounts,
        settings: enabledWith(5),
        now: NOW,
      }),
    ).not.toThrow()
  })

  it('is a no-op when the killswitch is disabled', () => {
    const accounts = [
      {
        index: 0,
        refreshToken: 'rt-a',
        cachedQuota: { 'non-gemini': { remainingFraction: 0, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW,
      },
    ]
    expect(() =>
      throwIfAllKilled({
        family: 'claude',
        model: 'claude-test',
        accounts,
        settings: disabled(),
        now: NOW,
      }),
    ).not.toThrow()
  })
})
