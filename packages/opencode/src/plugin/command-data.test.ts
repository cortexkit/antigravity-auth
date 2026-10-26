import { describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  type CommandAccountRow,
  type CommandDataAccountStorage,
  projectCommandAccountRows,
} from './command-data'

interface QuotaGroupFixture {
  gemini?: { remainingFraction?: number; resetTime?: string }
  'non-gemini'?: { remainingFraction?: number; resetTime?: string }
  'gemini-argon'?: { remainingFraction?: number; resetTime?: string }
}

interface AccountFixture {
  email: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled: boolean
  label?: string
  cachedQuota?: QuotaGroupFixture
  cachedQuotaUpdatedAt?: number
  cachedQuotaAccountId?: string
  accountIneligible?: boolean
  coolingDownUntil?: number
  healthScore?: number
  capturedTierId?: string
  capturedTierAt?: number
}

function makeAccountFixture(
  overrides: Partial<AccountFixture> & { refreshToken: string },
): AccountFixture {
  return {
    email: `${overrides.refreshToken}@example.test`,
    addedAt: 0,
    lastUsed: 0,
    enabled: true,
    ...overrides,
  }
}

function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

function makeProjectionFixture(options: { accounts: AccountFixture[] }) {
  const storage: CommandDataAccountStorage = {
    version: 4,
    activeIndex: 0,
    accounts: options.accounts.map((entry) => ({
      ...entry,
      cachedQuota:
        entry.cachedQuota as CommandDataAccountStorage['accounts'][number]['cachedQuota'],
    })),
  }
  return storage
}

describe('projectCommandAccountRows', () => {
  it('returns privacy-safe rows with ordinal labels, both quota groups, percentages and reset times', () => {
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Primary',
          cachedQuota: {
            'non-gemini': {
              remainingFraction: 0.4,
              resetTime: new Date(0).toISOString(),
            },
            gemini: { remainingFraction: 0.7 },
          },
        }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Backup',
          enabled: false,
          cachedQuota: {
            gemini: { remainingFraction: 0.15 },
          },
        }),
      ],
    })

    const rows = projectCommandAccountRows(storage)
    expect(rows).toHaveLength(2)

    // Privacy: no email or stored profile label in any row.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('refresh-a@example.test')
    expect(serialized).not.toContain('refresh-b@example.test')
    expect(serialized).not.toContain('Primary')
    expect(serialized).not.toContain('Backup')
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('email')
    }

    expect(rows[0]).toMatchObject({
      id: 'acct-0',
      index: 0,
      label: 'Account 1',
      enabled: true,
      current: true,
    })
    expect(rows[0]?.quota).toEqual([
      {
        key: 'gemini',
        label: 'Gemini',
        remainingPercent: 70,
        resetAt: undefined,
      },
      {
        key: 'non-gemini',
        label: 'Non-Gemini',
        remainingPercent: 40,
        resetAt: 0,
      },
    ])
    expect(rows[1]).toMatchObject({
      id: 'acct-1',
      index: 1,
      label: 'Account 2',
      enabled: false,
      current: false,
    })
  })

  it('is a pure cache read — opening performs zero fetch calls', () => {
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'A',
          cachedQuota: {
            'non-gemini': { remainingFraction: 0.5 },
          },
        }),
      ],
    })

    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(),
    )
    try {
      // Reopening an account view must project its cache without network I/O.
      for (let i = 0; i < 3; i += 1) {
        const rows = projectCommandAccountRows(storage)
        expect(rows).toHaveLength(1)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('drops a quota snapshot when the identity stamp does not match the current account', () => {
    // Account B has a cached quota stamped under account A's identity.
    // The projection must drop the stale cache rather than rendering
    // the wrong account's quota percentages.
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Account B',
          cachedQuota: { gemini: { remainingFraction: 0.5 } },
          cachedQuotaAccountId: quotaAccountIdentity('refresh-a'),
        }),
      ],
    })

    const rows = projectCommandAccountRows(storage)

    expect(rows).toHaveLength(1)
    // Identity mismatch — cached quota dropped; row must render empty quota.
    expect(rows[0]?.quota).toEqual([])
  })

  it('renders an unstamped legacy snapshot (fail open — no stamp means no mismatch)', () => {
    // A cached quota without any identity stamp was written by an older
    // version of the code. The projection must fail OPEN: no stamp means
    // the quota is treated as belonging to whichever account it sits on.
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Account A',
          cachedQuota: { gemini: { remainingFraction: 0.5 } },
          // Deliberately omit cachedQuotaAccountId — legacy snapshot.
        }),
      ],
    })

    const rows = projectCommandAccountRows(storage)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.quota).toContainEqual({
      key: 'gemini',
      label: 'Gemini',
      remainingPercent: 50,
      resetAt: undefined,
    })
  })

  it('normalizes legacy quota keys and silently skips truly unknown keys', () => {
    // Legacy keys (claude → non-gemini, gpt-oss → non-gemini,
    // gemini-pro/gemini-flash → gemini) are now NORMALIZED at read time,
    // not silently dropped. Truly unknown keys (e.g. 'gpt-4') are still
    // dropped. The canonical 'gemini' key carries through unchanged.
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Account A',
          cachedQuota: {
            // Legacy key: maps to non-gemini with MIN fraction.
            claude: { remainingFraction: 0.9 },
            // Truly unknown key: must be dropped (no mapping).
            'gpt-4': { remainingFraction: 0.8 },
            // Canonical key: must render as-is.
            gemini: { remainingFraction: 0.5 },
          } as unknown as QuotaGroupFixture,
        }),
      ],
    })

    const rows = projectCommandAccountRows(storage)

    expect(rows).toHaveLength(1)
    // Both canonical and normalized-from-legacy keys must render.
    const quota = rows[0]?.quota
    expect(quota?.find((q) => q.key === 'gemini')?.remainingPercent).toBe(50)
    expect(quota?.find((q) => q.key === 'non-gemini')?.remainingPercent).toBe(
      90,
    )
    // The truly unknown 'gpt-4' key must not appear in the output.
    expect(quota?.find((q) => q.key === ('gpt-4' as never))).toBeUndefined()
  })

  it('projects the argon pool for accounts that report it and omits it elsewhere', () => {
    const storage = makeProjectionFixture({
      accounts: [
        makeAccountFixture({
          refreshToken: 'refresh-a',
          label: 'Account A',
          cachedQuota: {
            gemini: { remainingFraction: 0.5 },
            'gemini-argon': { remainingFraction: 0.4 },
          },
        }),
        makeAccountFixture({
          refreshToken: 'refresh-b',
          label: 'Account B',
          cachedQuota: { gemini: { remainingFraction: 0.7 } },
        }),
      ],
    })

    const rows = projectCommandAccountRows(storage)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.quota).toContainEqual({
      key: 'gemini-argon',
      label: 'Argon',
      remainingPercent: 40,
      resetAt: undefined,
    })
    // The account without the Argon bucket renders exactly as before.
    expect(rows[1]?.quota.map((q) => q.key)).toEqual(['gemini'])
  })
})

export type { CommandAccountRow }
