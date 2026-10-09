import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  formatResetIn,
  formatWait,
  type ProjectionAccount,
  projectAccount,
  projectSidebar,
  remainingTone,
} from './sidebar-projection'

const NOW = 1_800_000_000_000

function account(
  overrides: Partial<ProjectionAccount> = {},
): ProjectionAccount {
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 87.6,
    current: true,
    quota: {
      gemini: { remainingPercent: 72, resetAt: NOW + 90 * 60_000 },
      'non-gemini': {
        remainingPercent: 8,
        windows: [
          { window: '5h', remainingPercent: 40, resetAt: NOW + 30 * 60_000 },
          {
            window: 'weekly',
            remainingPercent: 8,
            resetAt: NOW + 3 * 86_400_000,
          },
        ],
      },
    },
    ...overrides,
  }
}

describe('projectAccount', () => {
  it('projects pools in a fixed order with per-window rows', () => {
    const projected = projectAccount(account(), NOW)
    expect(projected.label).toBe('Account 1')
    expect(projected.status).toBe('active')
    expect(projected.statusTone).toBe('ok')
    expect(projected.quota).toEqual([
      { label: 'Gm', remaining: 72, tone: 'ok', reset: '1h30m' },
      { label: 'NG 5h', remaining: 40, tone: 'ok', reset: '30m' },
      { label: 'NG wk', remaining: 8, tone: 'err', reset: '3d' },
    ])
    expect(projected.health).toBe('health 88')
  })

  it('shows a missing reading as unknown, not as empty or full', () => {
    const projected = projectAccount(account({ quota: {} }), NOW)
    expect(projected.quota).toEqual([
      { label: 'Gm', remaining: null, tone: 'muted', reset: '' },
      { label: 'NG', remaining: null, tone: 'muted', reset: '' },
    ])
  })

  it('status words: off beats cooling beats active beats idle', () => {
    expect(
      projectAccount(
        account({ enabled: false, cooldownUntil: NOW + 5_000 }),
        NOW,
      ).status,
    ).toBe('off')
    const cooling = projectAccount(
      account({ cooldownUntil: NOW + 65_000 }),
      NOW,
    )
    expect(cooling.status).toBe('cooling')
    expect(cooling.statusTone).toBe('warn')
    expect(cooling.health).toBe('health 88 · cooling 1m 5s')
    expect(
      projectAccount(account({ cooldownUntil: NOW - 1 }), NOW).status,
    ).toBe('active')
    expect(projectAccount(account({ current: false }), NOW).status).toBe('idle')
  })

  it('clamps out-of-range percentages', () => {
    const projected = projectAccount(
      account({ health: 140, quota: { gemini: { remainingPercent: -5 } } }),
      NOW,
    )
    expect(projected.health).toBe('health 100')
    expect(projected.quota[0]?.remaining).toBe(0)
  })
})

describe('projectSidebar', () => {
  it('names the route by the account label and lists degraded states', () => {
    const projected = projectSidebar({
      accounts: [account()],
      route: {
        accountId: 'acct-0',
        modelFamily: 'claude',
        headerStyle: 'antigravity',
        strategy: 'sticky',
      },
      status: { checkedAt: null, quotaBackoffUntil: NOW + 30_000 },
      now: NOW,
    })
    expect(projected.route).toBe('Account 1 · claude · antigravity')
    expect(projected.notices).toEqual([
      'quota checks paused 30s',
      'quota not checked yet',
    ])
  })

  it('says so when there are no accounts', () => {
    const projected = projectSidebar({
      accounts: [],
      route: null,
      status: { checkedAt: NOW, quotaBackoffUntil: null },
      now: NOW,
    })
    expect(projected.route).toBeNull()
    expect(projected.notices).toEqual(['no accounts'])
  })

  it('never copies fields it does not know into its output', () => {
    const leaky = {
      ...account(),
      email: 'someone@example.com',
      refreshToken: 'r',
    }
    const projected = projectSidebar({
      accounts: [leaky],
      route: null,
      status: { checkedAt: NOW, quotaBackoffUntil: null },
      now: NOW,
    })
    const text = JSON.stringify(projected)
    expect(text).not.toContain('someone@example.com')
    expect(text).not.toContain('refreshToken')
  })
})

describe('formatting helpers', () => {
  it('formatResetIn', () => {
    expect(formatResetIn(undefined, NOW)).toBe('')
    expect(formatResetIn(NOW - 1, NOW)).toBe('now')
    expect(formatResetIn(NOW + 59 * 60_000, NOW)).toBe('59m')
    expect(formatResetIn(NOW + 2 * 3_600_000, NOW)).toBe('2h')
    expect(formatResetIn(NOW + 26 * 3_600_000, NOW)).toBe('1d2h')
  })

  it('formatWait and remainingTone', () => {
    expect(formatWait(1_000)).toBe('1s')
    expect(formatWait(120_000)).toBe('2m')
    expect(remainingTone(null)).toBe('muted')
    expect(remainingTone(10)).toBe('err')
    expect(remainingTone(30)).toBe('warn')
    expect(remainingTone(31)).toBe('ok')
  })
})

describe('sidebar-projection module graph', () => {
  it('imports nothing, so neither host build can reach credentials through it', () => {
    const source = readFileSync(
      new URL('./sidebar-projection.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(|\bimport\(/)
  })
})
