import { describe, expect, it } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  exportLegacyAccountStorage,
  parseLegacyAccountStorage,
  resolveAccountStorePaths,
} from './account-migration.ts'
import type { JsonObject } from './account-repository-types.ts'

function parse(value: unknown, now = 100) {
  return parseLegacyAccountStorage(JSON.stringify(value), now)
}

describe('offline lossless account parser', () => {
  it('derives D only beside the explicitly approved normalized absolute L', () => {
    const legacyPath = join(
      resolve('disposable-source-fixture'),
      'custom-accounts.json',
    )
    const paths = resolveAccountStorePaths(legacyPath)
    expect(paths.legacyPath).toBe(legacyPath)
    expect(paths.storeDir).toBe(`${legacyPath}.store`)
    expect(paths.configPath).toBe(join(`${legacyPath}.store`, 'config.json'))
    expect(paths.statePath).toBe(join(`${legacyPath}.store`, 'state.json'))
    expect(paths.migrationPath).toBe(
      join(`${legacyPath}.store`, 'migration.json'),
    )
    expect(() => resolveAccountStorePaths('relative.json')).toThrow()
  })
  it('roundtrips every v4 field, nested extension and absence/null distinction', () => {
    const fingerprint = {
      deviceId: 'device',
      sessionToken: 'session',
      userAgent: 'agent',
      apiClient: 'client',
      createdAt: 12,
      clientMetadata: {
        ideType: 'ide',
        platform: 'platform',
        pluginType: 'plugin',
        extra: null,
      },
      future: [null, { present: false }],
    }
    const source: JsonObject = {
      version: 4,
      activeIndex: null,
      activeIndexByFamily: { claude: null, gemini: 7, future: [] },
      future: { nested: ['unknown', null] },
      accounts: [
        {
          refreshToken: 'synthetic-refresh',
          addedAt: 4,
          lastUsed: 9,
          email: null,
          projectId: '',
          managedProjectId: null,
          enabled: null,
          lastSwitchReason: 'rotation',
          rateLimitResetTimes: { claude: null, dynamic: 17 },
          coolingDownUntil: null,
          cooldownReason: 'network-error',
          label: '',
          fingerprint,
          fingerprintHistory: [0, 1, 2, 3, 4, 5].map((index) => ({
            fingerprint,
            timestamp: index + 11,
            reason: 'restored',
            extra: { index },
          })),
          verificationRequired: false,
          verificationRequiredAt: null,
          verificationRequiredReason: '',
          verificationUrl: null,
          accountIneligible: null,
          accountIneligibleAt: 5,
          accountIneligibleReason: '',
          eligibilityStateUpdatedAt: 6,
          capturedTierId: null,
          capturedPaidTierId: '',
          capturedTierAt: 7,
          capturedTierSchemaVersion: 1,
          dailyRequestCounts: {
            date: '2000-01-01',
            claude: 2,
            gemini: 3,
            extra: null,
          },
          cachedQuotaAccountId: null,
          cachedQuota: {
            dynamic: {
              remainingFraction: null,
              resetTime: '',
              modelCount: 1,
              windows: [
                {
                  window: '5h',
                  remainingFraction: 0.123456,
                  resetTime: 'raw',
                  extra: [],
                },
              ],
              extra: {},
            },
          },
          cachedPerModelQuota: [
            {
              modelId: 'id',
              group: null,
              remainingFraction: 0.98765,
              displayName: null,
              extra: true,
            },
          ],
          cachedQuotaUpdatedAt: null,
          future: { values: [null, false] },
        },
        { refreshToken: 'synthetic-second', addedAt: 5, lastUsed: 10 },
      ],
    }
    const manifest = parse(source)
    expect(
      exportLegacyAccountStorage(manifest.accounts, manifest.routing),
    ).toEqual(source)
    expect(Object.hasOwn(manifest.accounts[1]!.metadata, 'email')).toBe(false)
    expect(Object.hasOwn(manifest.accounts[0]!.metadata, 'email')).toBe(true)
  })

  it('normalizes v1 at a captured clock and preserves nonlegacy extension fields', () => {
    const manifest = parse({
      version: 1,
      activeIndex: 9,
      accounts: [
        {
          refreshToken: 'synthetic-a',
          addedAt: 1,
          lastUsed: 2,
          isRateLimited: true,
          rateLimitResetTime: 101,
          future: [null],
        },
      ],
    })
    expect(manifest.normalizationClock).toBe(100)
    expect(manifest.effectiveActiveIndex).toBe(0)
    expect(manifest.routing.activeIndex).toBe(9)
    expect(manifest.accounts[0]!.metadata.rateLimitResetTimes).toEqual({
      claude: 101,
      'gemini-antigravity': 101,
    })
    expect(manifest.accounts[0]!.metadata.extensions).toEqual({
      future: [null],
    })
    const expired = parse({
      version: 1,
      accounts: [
        {
          refreshToken: 'synthetic-b',
          addedAt: 1,
          lastUsed: 2,
          isRateLimited: true,
          rateLimitResetTime: 100,
        },
      ],
    })
    expect(
      Object.hasOwn(expired.accounts[0]!.metadata, 'rateLimitResetTimes'),
    ).toBe(false)
  })

  it('retains unknown legacy top-level keys even when they collide with successor routing names', () => {
    const source = {
      version: 4,
      accounts: [],
      schemaVersion: 99,
      activeRow: { opaque: null },
      activeRowByFamily: false,
      legacySourceFields: 'original extension',
    }
    const manifest = parse(source)
    expect(
      exportLegacyAccountStorage(manifest.accounts, manifest.routing),
    ).toEqual(source)
    expect(manifest.routing.schemaVersion).toBe(1)
    expect(manifest.routing.activeRow).toBeUndefined()
  })

  it('normalizes v2 reset keys once and v3 invalidates fingerprints without dropping other fields', () => {
    const v2 = parse({
      version: 2,
      accounts: [
        {
          refreshToken: 'synthetic-a',
          addedAt: 1,
          lastUsed: 2,
          rateLimitResetTimes: { claude: 100, gemini: 101, dynamic: null },
          label: null,
        },
      ],
    })
    expect(v2.accounts[0]!.metadata.rateLimitResetTimes).toEqual({
      'gemini-antigravity': 101,
      dynamic: null,
    })
    const capturedV4 = exportLegacyAccountStorage(v2.accounts, v2.routing)
    expect(
      parse(capturedV4, 1000).accounts[0]!.metadata.rateLimitResetTimes,
    ).toEqual({ 'gemini-antigravity': 101, dynamic: null })
    const v3 = parse({
      version: 3,
      accounts: [
        {
          refreshToken: 'synthetic-a',
          addedAt: 1,
          lastUsed: 2,
          fingerprint: null,
          fingerprintHistory: [],
          enabled: false,
          label: null,
        },
      ],
    })
    expect(Object.hasOwn(v3.accounts[0]!.metadata, 'fingerprint')).toBe(false)
    expect(Object.hasOwn(v3.accounts[0]!.metadata, 'fingerprintHistory')).toBe(
      false,
    )
    expect(v3.accounts[0]!.metadata.enabled).toBe(false)
    expect(v3.accounts[0]!.metadata.label).toBeNull()
  })

  it('retains extended v1 maps and v2 null/empty maps while refusing conflicting encodings without merging', () => {
    const row = { refreshToken: 'synthetic', addedAt: 1, lastUsed: 2 }
    expect(
      parse({
        version: 1,
        accounts: [{ ...row, rateLimitResetTimes: { dynamic: null } }],
      }).accounts[0]!.metadata.rateLimitResetTimes,
    ).toEqual({ dynamic: null })
    expect(
      parse({
        version: 2,
        accounts: [
          { ...row, rateLimitResetTimes: { claude: null, gemini: null } },
        ],
      }).accounts[0]!.metadata.rateLimitResetTimes,
    ).toEqual({ claude: null, 'gemini-antigravity': null })
    expect(
      parse({ version: 2, accounts: [{ ...row, rateLimitResetTimes: {} }] })
        .accounts[0]!.metadata.rateLimitResetTimes,
    ).toEqual({})
    expect(() =>
      parse({
        version: 1,
        accounts: [
          {
            ...row,
            isRateLimited: true,
            rateLimitResetTime: 101,
            rateLimitResetTimes: { claude: 102 },
          },
        ],
      }),
    ).toThrow('conflicting rate-limit encodings')
  })

  it('uses exact-email newest winner positions and first-on-tie without deduping no-email rows', () => {
    const accounts = [
      { email: 'A', refreshToken: 'old', addedAt: 1, lastUsed: 2 },
      { refreshToken: 'no-email', addedAt: 1, lastUsed: 2 },
      { email: 'a', refreshToken: 'case-sensitive', addedAt: 1, lastUsed: 2 },
      { email: 'A', refreshToken: 'winner', addedAt: 2, lastUsed: 2 },
      { email: 'A', refreshToken: 'tie', addedAt: 2, lastUsed: 2 },
      { email: null, refreshToken: 'null-email', addedAt: 1, lastUsed: 2 },
    ]
    expect(
      parse({ version: 4, accounts }).accounts.map((row) => row.ordinal),
    ).toEqual([1, 2, 3, 5])
  })

  it('rejects normalized duplicate secrets with ordinal-only diagnostics', () => {
    expect(() =>
      parse({
        version: 4,
        accounts: [
          {
            email: 'a',
            refreshToken: 'NEVER-IN-ERROR',
            addedAt: 1,
            lastUsed: 2,
          },
          {
            email: 'b',
            refreshToken: 'NEVER-IN-ERROR',
            addedAt: 1,
            lastUsed: 2,
          },
        ],
      }),
    ).toThrow('duplicate refresh secret at ordinals 0, 1')
  })

  it('rejects malformed versions, records, nested types and unsafe keys without filtering', () => {
    for (const source of [
      null,
      [],
      { version: 5, accounts: [] },
      { version: 4, accounts: [null] },
      { version: 4, accounts: [{ refreshToken: '', addedAt: 1, lastUsed: 2 }] },
      {
        version: 4,
        accounts: [{ refreshToken: ' \t\n', addedAt: 1, lastUsed: 2 }],
      },
      {
        version: 4,
        accounts: [
          {
            refreshToken: 'a',
            addedAt: 1,
            lastUsed: 2,
            dailyRequestCounts: { date: 'x', claude: -1, gemini: 0 },
          },
        ],
      },
      {
        version: 3,
        accounts: [
          {
            refreshToken: 'a',
            addedAt: 1,
            lastUsed: 2,
            fingerprintHistory: [null],
          },
        ],
      },
      { version: 4, accounts: [], activeIndexByFamily: { claude: 'wrong' } },
    ])
      expect(() => parse(source)).toThrow()
    expect(() => parseLegacyAccountStorage('{', 100)).toThrow(
      'malformed source JSON',
    )
    expect(() =>
      parseLegacyAccountStorage(
        '{"version":4,"accounts":[],"__proto__":{}}',
        100,
      ),
    ).toThrow()
    expect(() =>
      parseLegacyAccountStorage('{"version":4,"accounts":[]}', Number.NaN),
    ).toThrow()
    expect(() =>
      parseLegacyAccountStorage('{"version":4,"accounts":[],"future":-0}', 100),
    ).toThrow('cannot retain losslessly')
  })
  it('preserves valid token bytes without trimming surrounding whitespace', () => {
    const source = {
      version: 4,
      accounts: [
        { refreshToken: ' synthetic-valid-token ', addedAt: 1, lastUsed: 2 },
      ],
    }
    expect(parse(source).accounts[0]!.refreshToken).toBe(
      ' synthetic-valid-token ',
    )
  })
})
