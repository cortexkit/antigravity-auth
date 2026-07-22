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
    routing: { cli_first: false, quota_style_fallback: false },
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
        cachedQuota: { claude: { remainingFraction: 0, modelCount: 1 } },
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
        cachedQuota: { claude: { remainingFraction: 0, modelCount: 1 } },
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
        cachedQuota: { claude: { remainingFraction: 0.04, modelCount: 1 } },
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
      routing: { cli_first: false, quota_style_fallback: false },
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
        cachedQuota: { claude: { remainingFraction: 0.2, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW,
      },
      'claude',
      settings,
      { now: NOW },
    )
    expect(decision.allowed).toBe(false)
    expect(decision.thresholdPercent).toBe(50)
  })

  it('uses freshest quota group across the family', () => {
    // gemini-pro at 2%, but gemini-flash at 90% — candidate is allowed
    const decision = evaluateKillswitchForAccount(
      {
        index: 0,
        refreshToken: 'rt',
        cachedQuota: {
          'gemini-pro': { remainingFraction: 0.02, modelCount: 1 },
          'gemini-flash': { remainingFraction: 0.9, modelCount: 1 },
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
})

describe('summarizeKillswitchOutcomes', () => {
  it('returns redacted per-account summaries keyed by hash', () => {
    const summaries = summarizeKillswitchOutcomes(
      [
        {
          index: 0,
          refreshToken: 'secret-token-a',
          cachedQuota: { claude: { remainingFraction: 0.5, modelCount: 1 } },
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
  it('throws AntigravityKillswitchError when every candidate is below threshold', () => {
    const accounts = [
      {
        index: 0,
        refreshToken: 'rt-a',
        cachedQuota: { claude: { remainingFraction: 0.02, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW,
      },
      {
        index: 1,
        refreshToken: 'rt-b',
        cachedQuota: { claude: { remainingFraction: 0.0, modelCount: 1 } },
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
        cachedQuota: { claude: { remainingFraction: 0.02, modelCount: 1 } },
        cachedQuotaUpdatedAt: NOW,
      },
      {
        index: 1,
        refreshToken: 'rt-b',
        cachedQuota: { claude: { remainingFraction: 0.5, modelCount: 1 } },
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
        cachedQuota: { claude: { remainingFraction: 0, modelCount: 1 } },
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
