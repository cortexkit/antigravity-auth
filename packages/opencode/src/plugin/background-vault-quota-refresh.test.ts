import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  VaultAccountState,
  VaultProviderStateFile,
  VaultSendAdmission,
} from '@cortexkit/antigravity-auth-core'

import {
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_QUOTA_ENDPOINT,
} from '../constants'
import { readSidebarState, setSidebarMachineState } from '../sidebar-state'
import { BackgroundQuotaRefresh } from './background-quota-refresh'
import { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh'
import {
  fetchVaultAccountQuota,
  type VaultQuotaCheckOptions,
  type VaultQuotaSource,
} from './quota'
import { createVaultAccountMenuSections } from './shared/vault-menu'
import { createVaultAccountPool } from './shared/vault-request-credentials'
import { checkAndPublishVaultQuota } from './vault-quota-refresh'
import { buildVaultSidebarProjection } from './vault-sidebar-projection'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(quotaSummary?: { groups: unknown[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-poller-'))
  const stateFile = join(dir, 'sidebar-state.json')
  let authority: 'vault' | 'local' | 'unreadable' = 'vault'
  let now = 1_800_000_000_000
  let physical = 0
  let issued = 0
  let writes = 0
  let publishes = 0
  let dailyFailure: number | null | undefined
  const requests: string[] = []
  const outcomes: unknown[] = []
  const entered = deferred()
  let wait: Promise<void> | undefined
  const accounts: Record<string, VaultAccountState> = {}
  const stored: VaultProviderStateFile = { schemaVersion: 1, accounts }
  const routes = [0, 1].map((index) => ({
    routeId: `route-${index}`,
    credentialId: `credential-${index}`,
    accountIdentity: `identity-${index}`,
    label: `Vault ${index}`,
    ...(index === 0 ? { email: 'known@example.test' } : {}),
  }))
  const source: VaultQuotaSource = {
    send: async (ref, dispatch, options) => {
      const admission: VaultSendAdmission = {
        ...ref,
        recordVersion: ++issued,
        projectId: 'vault-project',
        accessToken: `served-${issued}`,
        expiresAtMs: null,
      }
      return dispatch(admission, options.signal)
    },
    attribution: (admission) => ({
      routeId: admission.routeId,
      credentialId: admission.credentialId,
      accountIdentity: admission.accountIdentity,
      recordVersion: admission.recordVersion,
    }),
  }
  let refused = false
  let commitFailure:
    | 'write-uncertain'
    | 'binding-stale'
    | 'version-changed'
    | 'state-lock'
    | undefined
  const pool = createVaultAccountPool({
    source: {
      refresh: async () => undefined,
      routes: () => routes,
      admit: async () => {
        throw new Error('unused')
      },
      reportServedStatus: async () => false,
    },
    durable: {
      source: {
        attribution: source.attribution,
        commitState: async (by, update) => {
          if (commitFailure === 'write-uncertain')
            return {
              status: 'uncertain',
              error: new Error(
                'served-secret vault-project known@example.test',
              ),
            }
          if (commitFailure === 'binding-stale')
            throw {
              kind: 'binding-stale',
              message: 'route-0 credential-0 identity-0',
            }
          if (commitFailure === 'version-changed')
            throw {
              kind: 'state-unavailable',
              reason: 'version-changed',
              message: 'served-secret',
            }
          if (commitFailure === 'state-lock')
            throw {
              name: 'LockContentionError',
              details: { target: 'secret-path' },
            }
          if (refused) return { status: 'unchanged' }
          const next = update(stored.accounts[by.accountIdentity])
          const state = {
            observed: {
              routeId: by.routeId,
              credentialId: by.credentialId,
              recordVersion: by.recordVersion,
            },
            ...next,
          }
          accounts[by.accountIdentity] = state
          writes++
          return { status: 'written', state }
        },
      },
      readState: async () => stored,
    },
  })
  let badAnswer = false
  const transport: NonNullable<VaultQuotaCheckOptions['transport']> = async (
    url,
    init,
    extra,
  ) => {
    const signal = extra.signal ?? init.signal
    physical++
    requests.push(String(url))
    entered.resolve()
    if (wait) {
      await Promise.race([
        wait,
        new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ])
      signal?.throwIfAborted()
    }
    if (String(url).startsWith(ANTIGRAVITY_ENDPOINT_PROD)) {
      if (String(url).includes('fetchAvailableModels')) {
        return new Response(
          JSON.stringify({
            models: {
              'gemini-2.5-pro': {
                quotaInfo: { remainingFraction: 0.91 },
              },
            },
          }),
        )
      }
      return new Response(
        JSON.stringify({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  displayName: 'Weekly',
                  window: 'weekly',
                  remainingFraction: 0.91,
                },
              ],
            },
          ],
        }),
      )
    }
    if (dailyFailure === null) throw new Error('daily unavailable')
    if (typeof dailyFailure === 'number')
      return new Response('daily unavailable', { status: dailyFailure })
    return new Response(
      JSON.stringify(
        String(url).includes('retrieveUserQuotaSummary')
          ? badAnswer
            ? {}
            : (quotaSummary ?? {
                groups: [
                  {
                    displayName: 'Gemini Models',
                    buckets: [
                      {
                        bucketId: 'gemini-weekly',
                        displayName: 'Weekly',
                        window: 'weekly',
                        remainingFraction: 0.512345,
                      },
                    ],
                  },
                ],
              })
          : { buckets: [] },
      ),
      { status: 200 },
    )
  }
  const options = {
    intervalMs: 300_000,
    sidebarStateFile: stateFile,
    readAuthority: async () => authority,
    currentVaultPool: async () => ({ source, pool }),
    readProviderState: async () => stored,
    transport,
    logger: { debug: () => {} },
    onOutcome: (_level: string, summary: unknown) => {
      outcomes.push(summary)
    },
    now: () => now,
    random: () => 0,
    publishSidebar: async () => {
      publishes++
      now += 1_000
      await setSidebarMachineState(
        buildVaultSidebarProjection(pool, stored, now),
        { stateFile },
      )
    },
  }
  const poller = new BackgroundVaultQuotaRefresh(options)
  return {
    options,
    poller,
    pool,
    entered,
    stateFile,
    stored,
    accounts,
    outcomes,
    requests,
    clearRoutes: () => {
      routes.length = 0
    },
    get physical() {
      return physical
    },
    get issued() {
      return issued
    },
    get writes() {
      return writes
    },
    get publishes() {
      return publishes
    },
    get now() {
      return now
    },
    authority: (value: typeof authority) => {
      authority = value
    },
    advance: (ms: number) => {
      now += ms
    },
    seedReadings: (checkedAt: number) => {
      for (const route of routes) {
        accounts[route.accountIdentity] = {
          observed: {
            routeId: route.routeId,
            credentialId: route.credentialId,
            recordVersion: 42,
          },
          quota: {
            schemaVersion: 1,
            cachedQuota: {
              gemini: { modelCount: 1, remainingFraction: 0.812345 },
            },
            cachedQuotaUpdatedAt: checkedAt,
          },
        }
      }
    },
    pause: (promise: Promise<void>) => {
      wait = promise
    },
    refuse: () => {
      refused = true
    },
    failCommit: (failure: NonNullable<typeof commitFailure>) => {
      commitFailure = failure
    },
    failDaily: (status: number | null) => {
      dailyFailure = status
    },
    badAnswer: () => {
      badAnswer = true
    },
    cleanup: async () => {
      await poller.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('BackgroundVaultQuotaRefresh', () => {
  for (const mode of [
    'recorded',
    'fresh',
    'no-rows',
    'fetch-failed',
    'commit-unchanged',
    'write-uncertain',
    'binding-stale',
    'version-changed',
    'state-lock',
  ] as const) {
    it(`summarizes ${mode} exactly once without credential data`, async () => {
      const f = fixture()
      try {
        if (mode === 'fresh') f.seedReadings(f.now)
        if (mode === 'no-rows') {
          f.clearRoutes()
        }
        if (mode === 'fetch-failed') f.badAnswer()
        if (mode === 'commit-unchanged') f.refuse()
        if (
          mode === 'write-uncertain' ||
          mode === 'binding-stale' ||
          mode === 'version-changed' ||
          mode === 'state-lock'
        )
          f.failCommit(mode)
        await f.poller.tick()
        expect(f.outcomes).toHaveLength(1)
        expect(f.outcomes[0]).toMatchObject({ reason: mode })
        if (mode !== 'recorded' && mode !== 'fresh' && mode !== 'no-rows') {
          expect(f.writes).toBe(0)
          expect(f.outcomes[0]).toMatchObject({
            checked: 0,
            notChecked: 2,
            reasons: { [mode]: 2 },
          })
        }
        for (const secret of [
          'served-',
          'vault-project',
          'known@example.test',
          'route-0',
          'credential-0',
          'identity-0',
        ])
          expect(JSON.stringify(f.outcomes)).not.toContain(secret)
      } finally {
        await f.cleanup()
      }
    })
  }

  it('tick records a reading at the fetch time and republishes the sidebar', async () => {
    const f = fixture()
    try {
      await f.poller.tick()
      expect(f.writes).toBe(2)
      expect(f.physical).toBe(2)
      expect(f.issued).toBe(f.physical)
      expect(f.publishes).toBe(1)
      expect(f.stored.accounts['identity-0']?.quota?.cachedQuotaUpdatedAt).toBe(
        f.now - 1_000,
      )
      const state = readSidebarState(f.stateFile)
      expect(state.checkedAt).toBe(f.now)
      expect(state.accounts[0]?.email).toBe('known@example.test')
      expect(state.accounts[1]).not.toHaveProperty('email')
      expect(state.accounts[0]?.quota.gemini).toMatchObject({
        checkedAt: f.now - 1_000,
        remainingFraction: 0.512345,
      })
      expect(state.accounts[0]?.quota.gemini?.windows?.[0]?.checkedAt).toBe(
        f.now - 1_000,
      )
    } finally {
      await f.cleanup()
    }
  })

  it('leaves stale vault readings untouched when the daily host fails', async () => {
    for (const failure of [429, 503, null] as const) {
      const f = fixture()
      try {
        f.seedReadings(f.now - 1_000_000)
        f.failDaily(failure)
        await f.poller.tick()

        expect(f.requests.length).toBeGreaterThan(0)
        expect(
          f.requests.some((url) => url.includes('fetchAvailableModels')),
        ).toBe(true)
        expect(
          f.requests.every((url) => url.startsWith(ANTIGRAVITY_QUOTA_ENDPOINT)),
        ).toBe(true)
        expect(f.writes).toBe(0)
        expect(
          f.stored.accounts['identity-0']?.quota?.cachedQuota?.gemini
            ?.remainingFraction,
        ).toBe(0.812345)
        expect(
          f.stored.accounts['identity-0']?.quota?.cachedQuotaUpdatedAt,
        ).toBe(f.now - 1_000_000)
        expect(JSON.stringify(f.stored)).not.toContain('0.91')
      } finally {
        await f.cleanup()
      }
    }
  })
})

describe('vault poller fences and lifecycle', () => {
  it('retains the fence until a started commit acknowledges cancellation', async () => {
    const f = fixture()
    const entered = deferred()
    const resume = deferred()
    let commitSignal: AbortSignal | undefined
    if (!f.pool.state) throw new Error('missing durable pool')
    f.pool.state.recordQuota = async (_attribution, _quota, signal) => {
      commitSignal = signal
      entered.resolve()
      await resume.promise
      signal?.throwIfAborted()
      throw new Error('commit must receive the tick signal')
    }
    try {
      let settled = false
      const tick = f.poller.tick().then(() => {
        settled = true
      })
      await entered.promise
      f.poller.abortTick()
      expect(commitSignal?.aborted).toBe(true)
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(existsSync(`${f.stateFile}.bg-vault-quota-poll.lock`)).toBe(true)
      resume.resolve()
      await tick
      expect(existsSync(`${f.stateFile}.bg-vault-quota-poll.lock`)).toBe(false)
      expect(f.writes).toBe(0)
      expect(f.publishes).toBe(0)
    } finally {
      resume.resolve()
      await f.cleanup()
    }
  })

  for (const mode of ['local', 'unreadable'] as const) {
    it(`${mode} authority performs zero vault and zero local fetches`, async () => {
      const f = fixture()
      f.authority(mode)
      let localFetches = 0
      const local = new BackgroundQuotaRefresh({
        intervalMs: 300_000,
        sidebarStateFile: f.stateFile,
        mayRun: async () => false,
        getAccountManager: () => {
          localFetches++
          throw new Error('local manager must not open')
        },
        quotaManager: {
          refreshAccounts: async () => {
            localFetches++
            return []
          },
        } as unknown as import('./quota').QuotaManager,
        now: () => f.now,
        random: () => 0,
      })
      try {
        await f.poller.tick()
        await (local as unknown as { runTick(): Promise<void> }).runTick()
        expect(f.physical).toBe(0)
        expect(f.issued).toBe(0)
        expect(localFetches).toBe(0)
      } finally {
        await local.dispose()
        await f.cleanup()
      }
    })
  }

  it('the local poller remains dormant in vault mode', async () => {
    const f = fixture()
    let localFetches = 0
    const local = new BackgroundQuotaRefresh({
      intervalMs: 300_000,
      sidebarStateFile: f.stateFile,
      mayRun: async () => (await f.options.readAuthority()) === 'local',
      getAccountManager: () => {
        localFetches++
        throw new Error('local manager must not open')
      },
      quotaManager: {
        refreshAccounts: async () => {
          localFetches++
          return []
        },
      } as unknown as import('./quota').QuotaManager,
    })
    try {
      await (local as unknown as { runTick(): Promise<void> }).runTick()
      expect(localFetches).toBe(0)
      expect(f.physical).toBe(0)
    } finally {
      await local.dispose()
      await f.cleanup()
    }
  })

  it('a second process instance contending for the lock performs no fetch', async () => {
    const f = fixture()
    const resume = deferred()
    f.pause(resume.promise)
    let secondFetches = 0
    const second = new BackgroundVaultQuotaRefresh({
      ...f.options,
      transport: async (url, init, extra) => {
        secondFetches++
        return f.options.transport(url, init, extra)
      },
    })
    try {
      const firstTick = f.poller.tick()
      await f.entered.promise
      await second.tick()
      expect(secondFetches).toBe(0)
      expect(f.writes).toBe(0)
      resume.resolve()
      await firstTick
      expect(f.writes).toBe(2)
    } finally {
      resume.resolve()
      await second.dispose()
      await f.cleanup()
    }
  })

  it('fresh durable readings written by another process skip after lock acquisition', async () => {
    const f = fixture()
    const { acquireFencedFileLock } = await import(
      '@cortexkit/antigravity-auth-core/file-lock'
    )
    const poller = new BackgroundVaultQuotaRefresh({
      ...f.options,
      acquireLock: async (options) => {
        const lock = await acquireFencedFileLock(options)
        f.seedReadings(f.now - 239_999)
        return lock
      },
    })
    try {
      await poller.tick()
      expect(f.physical).toBe(0)
      expect(f.publishes).toBe(0)
    } finally {
      await poller.dispose()
      await f.cleanup()
    }
  })

  it('frequent sidebar publications do not postpone old durable readings', async () => {
    const f = fixture()
    try {
      f.seedReadings(f.now - 300_000)
      for (let i = 0; i < 3; i++) {
        f.advance(10_000)
        await setSidebarMachineState(
          { checkedAt: f.now, accounts: [] },
          { stateFile: f.stateFile },
        )
      }
      await f.poller.tick()
      expect(f.physical).toBe(2)
      expect(f.writes).toBe(2)
      expect(f.publishes).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it('a row with no durable reading fetches despite a fresh publication and another fresh row', async () => {
    const f = fixture()
    try {
      f.seedReadings(f.now)
      delete f.accounts['identity-1']
      await setSidebarMachineState(
        { checkedAt: f.now, accounts: [] },
        { stateFile: f.stateFile },
      )
      await f.poller.tick()
      expect(f.physical).toBe(2)
      expect(f.writes).toBe(2)
    } finally {
      await f.cleanup()
    }
  })

  for (const cause of [
    'undated',
    'missing quota',
    'different route',
    'different credential',
    'one stale row',
  ] as const) {
    it(`${cause} makes the tick due while the other row is fresh`, async () => {
      const f = fixture()
      try {
        f.seedReadings(f.now)
        const prior = f.accounts['identity-1']!
        switch (cause) {
          case 'undated':
            f.accounts['identity-1'] = {
              ...prior,
              quota: { ...prior.quota!, cachedQuotaUpdatedAt: undefined },
            }
            break
          case 'missing quota':
            f.accounts['identity-1'] = { ...prior, quota: undefined }
            break
          case 'different route':
            f.accounts['identity-1'] = {
              ...prior,
              observed: { ...prior.observed, routeId: 'foreign-route' },
            }
            break
          case 'different credential':
            f.accounts['identity-1'] = {
              ...prior,
              observed: {
                ...prior.observed,
                credentialId: 'foreign-credential',
              },
            }
            break
          case 'one stale row':
            f.accounts['identity-1'] = {
              ...prior,
              quota: { ...prior.quota!, cachedQuotaUpdatedAt: f.now - 240_000 },
            }
            break
        }
        await setSidebarMachineState(
          { checkedAt: f.now, accounts: [] },
          { stateFile: f.stateFile },
        )
        await f.poller.tick()
        expect(f.physical).toBe(2)
        expect(f.writes).toBe(2)
      } finally {
        await f.cleanup()
      }
    })
  }

  it('lock errors fail closed without fetching', async () => {
    const f = fixture()
    const poller = new BackgroundVaultQuotaRefresh({
      ...f.options,
      acquireLock: async () => {
        throw new Error('I/O error')
      },
    })
    try {
      await poller.tick()
      expect(f.physical).toBe(0)
    } finally {
      await poller.dispose()
      await f.cleanup()
    }
  })

  it('disposal aborts in-flight transport and stops further requests before drain', async () => {
    const f = fixture()
    f.pause(deferred().promise)
    const { createPluginLifecycle } = await import('./lifecycle')
    let drained = false
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState() {},
      drainSidebarWrites: async () => {
        drained = true
        expect(f.writes).toBe(0)
      },
    })
    lifecycle.register(f.poller, 'producer')
    try {
      const tick = f.poller.tick()
      await f.entered.promise
      const physical = f.physical
      await lifecycle.dispose()
      await tick
      expect(drained).toBe(true)
      await f.poller.tick()
      expect(f.physical).toBe(physical)
      expect(f.publishes).toBe(0)
    } finally {
      await lifecycle.dispose()
      await f.cleanup()
    }
  })

  it('an authority change during a reading prevents fallback and later account requests', async () => {
    const f = fixture()
    const requests: string[] = []
    const poller = new BackgroundVaultQuotaRefresh({
      ...f.options,
      transport: async (url) => {
        requests.push(String(url))
        f.authority('local')
        return new Response('{}', { status: 500 })
      },
    })
    try {
      await poller.tick()
      expect(requests).toEqual([
        'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      ])
      expect(f.writes).toBe(0)
      expect(f.publishes).toBe(0)
      await poller.tick()
      expect(requests).toHaveLength(1)
      expect(f.writes).toBe(0)
      expect(f.publishes).toBe(0)
    } finally {
      await poller.dispose()
      await f.cleanup()
    }
  })

  for (const failure of ['refused', 'failed', 'unattributed'] as const) {
    it(`${failure} readings neither publish nor advance observation time`, async () => {
      const f = fixture()
      try {
        await f.poller.tick()
        const before = readSidebarState(f.stateFile)
        f.advance(300_000)
        if (failure === 'refused') f.refuse()
        if (failure === 'failed') f.badAnswer()
        const poller =
          failure === 'unattributed'
            ? new BackgroundVaultQuotaRefresh({
                ...f.options,
                currentVaultPool: async () => {
                  const current = await f.options.currentVaultPool()
                  return {
                    ...current,
                    source: {
                      ...current.source,
                      attribution: () => {
                        throw new Error('unattributed')
                      },
                    },
                  }
                },
              })
            : f.poller
        try {
          await poller.tick()
        } finally {
          if (poller !== f.poller) await poller.dispose()
        }
        expect(f.publishes).toBe(1)
        expect(f.writes).toBe(2)
        expect(readSidebarState(f.stateFile)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }
})

describe('vault manual quota and durable sidebar projection', () => {
  it('manual Quota menu check republishes recorded quota with its observation time', async () => {
    const f = fixture()
    try {
      await f.pool.sync()
      const fetchAt = f.now
      const { source, pool } = await f.options.currentVaultPool()
      const sections = createVaultAccountMenuSections(
        pool,
        () => 'opaque-choice',
        (signal) =>
          checkAndPublishVaultQuota(
            {
              pool,
              signal,
              now: f.options.now,
              fetchReading: (ref, check) =>
                fetchVaultAccountQuota({
                  source,
                  ref,
                  signal: check,
                  logger: f.options.logger,
                  transport: f.options.transport,
                }),
            },
            f.options.publishSidebar,
          ),
      )
      const quota = await sections.quota.build({ notify() {} })
      const action = quota.actions?.find((entry) => entry.id === 'refresh')
      expect(action).toBeDefined()
      await action!.run({ values: {}, invocation: { notify() {} } })
      expect(f.writes).toBe(2)
      expect(f.publishes).toBe(1)
      const sidebar = readSidebarState(f.stateFile)
      expect(sidebar.accounts[0]?.quota.gemini?.checkedAt).toBe(fetchAt)
      expect(sidebar.accounts[0]?.quota.gemini?.remainingFraction).toBe(
        0.512345,
      )
      expect(sidebar.checkedAt).toBe(fetchAt + 1_000)
    } finally {
      await f.cleanup()
    }
  })

  it('manual Quota menu check keeps Gemini Models when Argon follows it', async () => {
    const f = fixture({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: '5h',
              window: '5h',
              remainingFraction: 0.4,
              resetTime: '2030-01-01T05:00:00Z',
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly',
              window: 'weekly',
              remainingFraction: 0,
              resetTime: '2030-01-08T00:00:00Z',
            },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          // Assumed Pro Argon bucket ID: `gemini-argon-weekly` (not confirmed).
          buckets: [
            {
              bucketId: 'gemini-argon-weekly',
              displayName: 'Argon Weekly',
              window: 'weekly',
              remainingFraction: 1,
              resetTime: '2030-01-15T00:00:00Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly',
              window: 'weekly',
              remainingFraction: 0.8,
              resetTime: '2030-01-08T00:00:00Z',
            },
          ],
        },
      ],
    })
    try {
      await f.pool.sync()
      const fetchAt = f.now
      const { source, pool } = await f.options.currentVaultPool()
      const sections = createVaultAccountMenuSections(
        pool,
        () => 'opaque-choice',
        (signal) =>
          checkAndPublishVaultQuota(
            {
              pool,
              signal,
              now: f.options.now,
              fetchReading: (ref, check) =>
                fetchVaultAccountQuota({
                  source,
                  ref,
                  signal: check,
                  logger: f.options.logger,
                  transport: f.options.transport,
                }),
            },
            f.options.publishSidebar,
          ),
      )
      const quota = await sections.quota.build({ notify() {} })
      const action = quota.actions?.find((entry) => entry.id === 'refresh')
      expect(action).toBeDefined()
      await action!.run({ values: {}, invocation: { notify() {} } })
      expect(f.writes).toBe(2)
      expect(f.publishes).toBe(1)
      const storedGemini = f.accounts['identity-0']?.quota?.cachedQuota?.gemini
      expect(storedGemini?.remainingFraction).toBe(0)
      expect(storedGemini?.resetTime).toBe('2030-01-08T00:00:00Z')
      const sidebar = readSidebarState(f.stateFile)
      expect(sidebar.accounts[0]?.quota.gemini?.checkedAt).toBe(fetchAt)
      expect(sidebar.accounts[0]?.quota.gemini?.remainingFraction).toBe(0)
      expect(sidebar.checkedAt).toBe(fetchAt + 1_000)
    } finally {
      await f.cleanup()
    }
  })

  it('projects newer durable quota for an already-kept selector row without rehydrating selection state', async () => {
    const f = fixture()
    try {
      await f.pool.sync()
      const row = f.pool.selector.rows[0]!
      row.cachedQuota = { gemini: { remainingFraction: 0.1, modelCount: 1 } }
      row.cachedQuotaUpdatedAt = 10
      f.accounts['identity-0'] = {
        observed: {
          routeId: row.route.routeId,
          credentialId: row.route.credentialId,
          recordVersion: 12,
        },
        quota: {
          schemaVersion: 1,
          cachedQuota: {
            gemini: { remainingFraction: 0.812345, modelCount: 1 },
          },
          cachedQuotaUpdatedAt: 200,
        },
      }
      await f.pool.sync()
      expect(row.cachedQuotaUpdatedAt).toBe(10)
      const projection = buildVaultSidebarProjection(f.pool, f.stored, 300)
      expect(projection.accounts[0]?.quota.gemini).toMatchObject({
        remainingFraction: 0.812345,
        checkedAt: 200,
      })
      expect(projection.checkedAt).toBe(300)
      f.accounts['identity-0'] = {
        ...f.accounts['identity-0']!,
        observed: {
          ...f.accounts['identity-0']!.observed,
          credentialId: 'different-credential',
        },
      }
      expect(
        buildVaultSidebarProjection(f.pool, f.stored, 400).accounts[0]?.quota,
      ).toEqual({})
    } finally {
      await f.cleanup()
    }
  })
})
