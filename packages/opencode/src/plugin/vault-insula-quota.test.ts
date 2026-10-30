import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAntigravityVaultAccountSource,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  readVaultProviderState,
  type VaultConsumerOptions,
  type VaultScopedClient,
} from '@cortexkit/antigravity-auth-core'
import { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh'
import { fetchVaultAccountQuota } from './quota'
import { createVaultAccountPool } from './shared/vault-request-credentials'
import { normalizeVaultInsulaQuota } from './vault-insula-quota'
import type { VaultQuotaOutcome } from './vault-quota-outcome'
import { checkAndPublishVaultQuota } from './vault-quota-refresh'

const NOW = Date.UTC(2026, 9, 21, 12)
const FETCHED = NOW - 90_000
const RESET_5H = '2026-10-21T16:00:00Z'
const RESET_7D = '2026-10-26T12:00:00Z'
type Entry = Parameters<
  NonNullable<VaultConsumerOptions['insula']>['normalize']
>[0]

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    provider: 'antigravity',
    account: 'account-a',
    source: 'vault',
    fetchedAt: new Date(FETCHED).toISOString(),
    usage: {
      extraRateWindows: [
        {
          id: '3p-weekly',
          title: 'not Gemini',
          window: { usedPercent: 85, resetsAt: RESET_7D, windowMinutes: 10080 },
        },
        {
          id: 'gemini-weekly',
          title: 'not third party',
          window: { usedPercent: 40, resetsAt: RESET_7D, windowMinutes: 10080 },
        },
        {
          id: '3p-5h',
          title: 'arbitrary',
          window: { usedPercent: 25, resetsAt: RESET_5H, windowMinutes: 300 },
        },
        {
          id: 'gemini-5h',
          title: 'arbitrary',
          window: { usedPercent: 10, resetsAt: RESET_5H, windowMinutes: 300 },
        },
      ],
    },
    ...overrides,
  }
}

async function fixture(
  result: Entry[] = [entry()],
  options: {
    complete?: boolean
    unreachable?: boolean
    wrongAdmission?: boolean
    refuseAdmission?: boolean
    wrongReadingAccount?: boolean
  } = {},
) {
  let now = NOW
  const dir = await mkdtemp(join(tmpdir(), 'insula-vault-quota-'))
  const claustrum = await loadCommonAuthClaustrum()
  const fs = await loadCommonAuthFs()
  const statePath = join(dir, 'provider-state.json')
  const tokenPath = join(dir, 'enrollment.json')
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  let admissions = 0
  const requests: string[] = []
  const outcomes: VaultQuotaOutcome[] = []
  const skips: unknown[] = []
  let publishes = 0
  const insula = {
    connectionFile: join(dir, 'connection.json'),
    async getUsage() {
      if (options.unreachable) throw new Error('owned unavailable daemon')
      return {
        result,
        completeProviders: options.complete === false ? [] : ['antigravity'],
      }
    },
  }
  const client: VaultScopedClient = {
    insula,
    async listScoped() {
      return {
        view: 'v1',
        rows: [
          {
            id: 'credential-a',
            accountId: 'account-a',
            credentialType: 'oauth',
            categories: ['antigravity-native'],
            serves: [],
            providerIds: [],
            refreshAdapter: 'antigravity',
            state: 'active',
            recordVersion: 7,
            operations: ['read'],
            createdAtMs: null,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      admissions++
      if (options.refuseAdmission) throw new Error('owned admission refusal')
      return {
        material: 'never-send-this-insula-bearer',
        credentialId: 'credential-a',
        accountId: options.wrongAdmission ? 'account-b' : 'account-a',
        recordVersion: 7,
        projectId: 'owned-project',
        expiresAtMs: NOW + 3_600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const source = createAntigravityVaultAccountSource({
    claustrum,
    host: 'opencode',
    rosterPath: join(dir, 'roster.json'),
    tokenPath,
    connect: async () => client,
    isCustodyActive: () => true,
    reporterSource: 'direct',
    state: { path: statePath, fs },
    now: () => now,
    insula: {
      provider: 'antigravity',
      normalize: (entry, context) => {
        const reading = normalizeVaultInsulaQuota(entry, context)
        return reading && options.wrongReadingAccount
          ? { ...reading, accountIdentity: 'account-b' }
          : reading
      },
    },
    logger: {
      debug() {},
      warn: (message, fields) => {
        if (message === 'skipped insula provider poll') skips.push(fields)
      },
    },
  })
  const shared = claustrum.acquireInsulaQuotaSource(insula, tokenPath)
  await source.refresh()
  await shared.source.refresh(now)
  const readState = () => readVaultProviderState(statePath)
  const pool = createVaultAccountPool({
    source,
    durable: { source, readState },
  })
  const transport: NonNullable<
    Parameters<typeof fetchVaultAccountQuota>[0]['transport']
  > = async (url) => {
    requests.push(String(url))
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.33,
              resetTime: RESET_5H,
            },
          ],
        },
      ],
    })
  }
  const poller = new BackgroundVaultQuotaRefresh({
    intervalMs: 300_000,
    sidebarStateFile: join(dir, 'sidebar.json'),
    readAuthority: async () => 'vault',
    currentVaultPool: async () => ({ source, pool }),
    readProviderState: readState,
    publishSidebar: async () => {
      publishes++
    },
    transport,
    logger: { debug() {} },
    now: () => now,
    onOutcome: (_level, outcome) => outcomes.push(outcome),
  })
  return {
    source,
    pool,
    poller,
    requests,
    outcomes,
    skips,
    readState,
    transport,
    advanceTime(ms: number) {
      now += ms
    },
    refreshUsage() {
      return shared.source.refresh(now)
    },
    get admissions() {
      return admissions
    },
    get publishes() {
      return publishes
    },
    async close() {
      await poller.dispose()
      source.close()
      shared.release()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('insula vault quota', () => {
  it('tick stores all four ID-matched windows at fetchedAt without Google', async () => {
    const f = await fixture()
    try {
      await f.poller.tick()
      expect(f.requests).toEqual([])
      const state = (await f.readState()).accounts['account-a']
      const route = f.source.routes()[0]
      if (!route) throw new Error('fixture has no vault route')
      expect(state?.observed).toEqual({
        routeId: route.routeId,
        credentialId: 'credential-a',
        recordVersion: 7,
      })
      expect(state?.quota?.cachedQuotaUpdatedAt).toBe(FETCHED)
      expect(state?.quota?.cachedQuota).toEqual({
        gemini: {
          modelCount: 0,
          remainingFraction: 0.6,
          resetTime: RESET_7D,
          windows: [
            { window: '5h', remainingFraction: 0.9, resetTime: RESET_5H },
            { window: 'weekly', remainingFraction: 0.6, resetTime: RESET_7D },
          ],
        },
        'non-gemini': {
          modelCount: 0,
          remainingFraction: 0.15000000000000002,
          resetTime: RESET_7D,
          windows: [
            { window: '5h', remainingFraction: 0.75, resetTime: RESET_5H },
            {
              window: 'weekly',
              remainingFraction: 0.15000000000000002,
              resetTime: RESET_7D,
            },
          ],
        },
      })
      expect(f.pool.selector.rows[0]?.cachedQuotaUpdatedAt).toBe(FETCHED)
      expect(f.admissions).toBe(2)
      expect(f.publishes).toBe(1)
      expect(f.outcomes).toHaveLength(1)
      expect(f.outcomes[0]?.reason).toBe('recorded')
    } finally {
      await f.close()
    }
  })

  it('oauth echo is a miss and the daily poll runs', async () => {
    const f = await fixture([entry({ source: 'oauth' })])
    try {
      await f.poller.tick()
      expect(f.requests).toHaveLength(1)
      expect(f.requests[0]).toContain(
        'daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      )
      expect(
        (await f.readState()).accounts['account-a']?.quota?.cachedQuota?.gemini
          ?.remainingFraction,
      ).toBe(0.33)
    } finally {
      await f.close()
    }
  })

  it('local_source_unavailable stale entry runs our daily poll', async () => {
    const f = await fixture([
      entry({ stale: { class: 'local_source_unavailable' } }),
    ])
    try {
      await f.poller.tick()
      expect(f.requests).toEqual([
        'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      ])
      const quota = (await f.readState()).accounts['account-a']?.quota
      expect(quota?.cachedQuota?.gemini?.remainingFraction).toBe(0.33)
      expect(quota?.cachedQuotaUpdatedAt).toBe(NOW)
      expect(f.outcomes[0]?.reason).toBe('recorded')
      expect(f.publishes).toBe(1)
      expect(f.skips).toEqual([])
    } finally {
      await f.close()
    }
  })

  it.each([
    ['upstream_failed', { class: 'upstream_failed' }],
    ['unclassified', {}],
  ] as const)('%s stale entry skips our poll, logs once and preserves the stored reading', async (_name, stale) => {
    const entries = [entry()]
    const f = await fixture(entries)
    try {
      await f.poller.tick()
      const before = await f.readState()
      expect(
        before.accounts['account-a']?.quota?.cachedQuota?.gemini
          ?.remainingFraction,
      ).toBe(0.6)
      const admissions = f.admissions
      f.advanceTime(300_000)
      entries[0] = entry({
        stale,
        fetchedAt: new Date(FETCHED + 300_000).toISOString(),
      })
      await f.refreshUsage()
      await f.poller.tick()
      await f.poller.tick()
      expect(f.requests).toEqual([])
      expect(f.skips).toEqual([{ reason: 'upstream-failed' }])
      expect(f.admissions).toBe(admissions)
      expect(await f.readState()).toEqual(before)
      expect(f.publishes).toBe(1)
      expect(f.outcomes.slice(1).map((outcome) => outcome.reasons)).toEqual([
        { 'insula-upstream-failed': 1 },
        { 'insula-upstream-failed': 1 },
      ])
    } finally {
      await f.close()
    }
  })

  it.each([
    ['absent', [], {}],
    ['unreachable', [], { unreachable: true }],
    ['unknown account', [entry({ account: 'another-account' })], {}],
  ] as const)('%s falls back to our daily poll', async (_name, entries, options) => {
    const f = await fixture([...entries], options)
    try {
      await f.poller.tick()
      expect(f.requests).toHaveLength(1)
      expect(
        (await f.readState()).accounts['account-a']?.quota
          ?.cachedQuotaUpdatedAt,
      ).toBe(NOW)
      expect(f.publishes).toBe(1)
    } finally {
      await f.close()
    }
  })

  it.each([
    ['cold', [], { complete: false }],
    ['upstream-failed', [entry({ errorClass: 'upstream_failed' })], {}],
  ] as const)('%s skips Google and storage with one skip log', async (reason, entries, options) => {
    const f = await fixture([...entries], options)
    try {
      await f.poller.tick()
      expect(f.requests).toEqual([])
      expect(f.admissions).toBe(0)
      expect((await f.readState()).accounts).toEqual({})
      expect(f.publishes).toBe(0)
      expect(f.outcomes).toHaveLength(1)
      expect(f.outcomes[0]?.reasons).toEqual({ [`insula-${reason}`]: 1 })
      await f.poller.tick()
      expect(f.skips).toEqual([{ reason }])
    } finally {
      await f.close()
    }
  })

  it('an absent window stays absent, not empty quota', async () => {
    const normalized = normalizeVaultInsulaQuota(
      entry({
        usage: {
          extraRateWindows: [
            {
              id: 'gemini-5h',
              title: 'weekly',
              window: { usedPercent: 20, resetsAt: RESET_5H },
            },
            { id: 'gemini-weekly' },
            { id: 'unknown', window: { usedPercent: 100 } },
          ],
        },
      }),
      { fetchedAt: FETCHED },
    )
    expect(normalized?.quota.groups).toEqual({
      gemini: {
        modelCount: 0,
        remainingFraction: 0.8,
        resetTime: RESET_5H,
        windows: [
          { window: '5h', remainingFraction: 0.8, resetTime: RESET_5H },
        ],
      },
    })
    expect(normalized?.observedAt).toBe(FETCHED)
    expect(
      normalizeVaultInsulaQuota(entry({ usage: {} }), { fetchedAt: FETCHED }),
    ).toBeUndefined()
  })

  it('maps the confirmed argon weekly bucket to its own pool without touching gemini', () => {
    const normalized = normalizeVaultInsulaQuota(
      entry({
        usage: {
          extraRateWindows: [
            {
              id: 'gemini-weekly',
              window: {
                usedPercent: 40,
                resetsAt: RESET_7D,
                windowMinutes: 10080,
              },
            },
            {
              // The exact weekly bucket ID Google reports for paid Pro
              // accounts. No Argon 5-hour bucket has been seen.
              id: 'gemini-argon-wtu-weekly',
              window: {
                usedPercent: 100,
                resetsAt: RESET_7D,
                windowMinutes: 10080,
              },
            },
          ],
        },
      }),
      { fetchedAt: FETCHED },
    )

    expect(normalized?.quota.groups.gemini).toEqual({
      modelCount: 0,
      remainingFraction: 0.6,
      resetTime: RESET_7D,
      windows: [
        { window: 'weekly', remainingFraction: 0.6, resetTime: RESET_7D },
      ],
    })
    expect(normalized?.quota.groups['gemini-argon']).toEqual({
      modelCount: 0,
      remainingFraction: 0,
      resetTime: RESET_7D,
      windows: [
        { window: 'weekly', remainingFraction: 0, resetTime: RESET_7D },
      ],
    })
  })

  it('ignores guessed argon bucket ids', () => {
    // `gemini-argon-weekly` was an early guess the server never sent:
    // matching is by exact bucket ID, with no prefix matching.
    const normalized = normalizeVaultInsulaQuota(
      entry({
        usage: {
          extraRateWindows: [
            {
              id: 'gemini-weekly',
              window: {
                usedPercent: 40,
                resetsAt: RESET_7D,
                windowMinutes: 10080,
              },
            },
            {
              id: 'gemini-argon-weekly',
              window: {
                usedPercent: 100,
                resetsAt: RESET_7D,
                windowMinutes: 10080,
              },
            },
          ],
        },
      }),
      { fetchedAt: FETCHED },
    )

    expect(normalized?.quota.groups.gemini).toEqual({
      modelCount: 0,
      remainingFraction: 0.6,
      resetTime: RESET_7D,
      windows: [
        { window: 'weekly', remainingFraction: 0.6, resetTime: RESET_7D },
      ],
    })
    expect(normalized?.quota.groups['gemini-argon']).toBeUndefined()
  })

  it('an account-mismatched reading is refused before admission', async () => {
    const f = await fixture([entry()], { wrongReadingAccount: true })
    try {
      await f.poller.tick()
      expect(f.requests).toEqual([])
      expect(f.admissions).toBe(0)
      expect((await f.readState()).accounts).toEqual({})
      expect(f.outcomes[0]?.reason).toBe('binding-stale')
    } finally {
      await f.close()
    }
  })

  it('an unreported window remains absent in stored quota', async () => {
    const f = await fixture([
      entry({
        usage: {
          extraRateWindows: [
            {
              id: 'gemini-5h',
              window: { usedPercent: 20, resetsAt: RESET_5H },
            },
            { id: 'gemini-weekly' },
          ],
        },
      }),
    ])
    try {
      await f.poller.tick()
      expect(f.requests).toEqual([])
      const quota = (await f.readState()).accounts['account-a']?.quota
      expect(quota?.cachedQuotaUpdatedAt).toBe(FETCHED)
      expect(quota?.cachedQuota?.gemini?.windows).toEqual([
        { window: '5h', remainingFraction: 0.8, resetTime: RESET_5H },
      ])
      expect(quota?.cachedQuota?.['non-gemini']).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  it('wrong or refused admission stores nothing and never dispatches a bearer', async () => {
    for (const options of [
      { wrongAdmission: true },
      { refuseAdmission: true },
    ]) {
      const f = await fixture([entry()], options)
      try {
        await f.poller.tick()
        expect(f.requests).toEqual([])
        expect((await f.readState()).accounts).toEqual({})
        expect(f.publishes).toBe(0)
        expect(f.outcomes[0]?.checked).toBe(0)
      } finally {
        await f.close()
      }
    }
  })

  it('manual check remains a direct daily poll even with insula cached', async () => {
    const f = await fixture()
    try {
      await f.pool.sync()
      const report = await checkAndPublishVaultQuota(
        {
          pool: f.pool,
          signal: new AbortController().signal,
          now: () => NOW,
          fetchReading: (ref, signal) =>
            fetchVaultAccountQuota({
              source: f.source,
              ref,
              signal,
              transport: f.transport,
              logger: { debug() {} },
            }),
        },
        async () => {},
      )
      expect(report.checked).toBe(1)
      expect(f.requests).toHaveLength(1)
      expect(
        (await f.readState()).accounts['account-a']?.quota
          ?.cachedQuotaUpdatedAt,
      ).toBe(NOW)
    } finally {
      await f.close()
    }
  })
})
