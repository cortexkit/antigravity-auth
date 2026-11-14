/**
 * The shared vault request pieces: selection rows built from vault routes,
 * their identity across roster re-reads, and the engine's vault credential
 * domain over an owned stand-in for the core vault account source.
 */

import { describe, expect, it } from 'bun:test'
import type {
  VaultAccountState,
  VaultProviderStateFile,
  VaultStateAttribution,
} from '@cortexkit/antigravity-auth-core'
import { AccountSelector } from '@cortexkit/antigravity-auth-core'

import {
  checkVaultQuota,
  createVaultAccountPool,
  createVaultRequestCredentials,
  createVaultSelectionState,
  refreshVaultAccountRow,
  VAULT_REFRESH_STALL_MS,
  type VaultAccountPoolOptions,
  type VaultRequestSource,
  vaultAccountRowKey,
  vaultAccountRows,
} from './vault-request-credentials.ts'

describe('createVaultRequestCredentials', () => {
  it('asks the source for a fresh receipt per send and reports 401 against that receipt', async () => {
    const route = {
      routeId: 'route-1',
      credentialId: 'credential-1',
      accountIdentity: 'identity-1',
      label: 'Work',
    }
    const issued: { recordVersion: number; accessToken: string }[] = []
    const reported: unknown[] = []
    const source = {
      admit: async (ref: typeof route, signal?: AbortSignal) => {
        expect(ref).toBe(route)
        expect(signal).toBeUndefined()
        const admission = {
          routeId: ref.routeId,
          credentialId: ref.credentialId,
          accountIdentity: ref.accountIdentity,
          recordVersion: issued.length + 1,
          projectId: `project-${issued.length + 1}`,
          accessToken: `token-${issued.length + 1}`,
          expiresAtMs: null,
        }
        issued.push(admission)
        return admission
      },
      reportServedStatus: async (admission: unknown, status: number) => {
        reported.push({ admission, status })
        return status === 401
      },
    }
    const credentials = createVaultRequestCredentials(source)
    const [account] = vaultAccountRows([route])
    if (!account) throw new Error('missing row')
    const first = await credentials.admit({ account, signal: undefined })
    const second = await credentials.admit({ account, signal: undefined })
    // The token is readable for the send but never copied by a spread or
    // serialization of the grant.
    expect(JSON.stringify(first)).not.toContain('token-1')
    expect('accessToken' in { ...first }).toBe(false)
    expect([first.accessToken, second.accessToken]).toEqual([
      'token-1',
      'token-2',
    ])
    expect([first.projectId, second.projectId]).toEqual([
      'project-1',
      'project-2',
    ])
    expect(first.recordVersion).toBe(1)
    await first.report401(401)
    expect(reported).toEqual([{ admission: issued[0], status: 401 }])
  })
})

describe('vault account rows', () => {
  const route = (credentialId: string, accountIdentity = 'identity-a') => ({
    routeId: 'route-a',
    credentialId,
    accountIdentity,
    label: 'Work',
  })

  it("keeps a route's selection state only while its credential and account stay the same", () => {
    const selector = new AccountSelector({ now: () => 1_000 })
    selector.resetAccounts(vaultAccountRows([route('credential-1')]))
    const [first] = selector.getAccounts()
    if (!first) throw new Error('missing row')
    selector.markAccountCoolingDown(first, 60_000, 'auth-failure')

    selector.replaceAccounts(vaultAccountRows([route('credential-1')]), {
      keyOf: vaultAccountRowKey,
      refresh: refreshVaultAccountRow,
    })
    expect(selector.getAccounts()[0]?.coolingDownUntil).toBe(61_000)

    selector.replaceAccounts(vaultAccountRows([route('credential-2')]), {
      keyOf: vaultAccountRowKey,
      refresh: refreshVaultAccountRow,
    })
    expect(selector.getAccounts()[0]?.coolingDownUntil).toBeUndefined()
    // Rows carry the route and selection metadata only.
    expect(Object.keys(selector.getAccounts()[0] ?? {}).sort()).toEqual([
      'enabled',
      'index',
      'lastUsed',
      'rateLimitResetTimes',
      'route',
      'touchedForQuota',
    ])
  })
})

describe('createVaultSelectionState', () => {
  const route = (credentialId: string, accountIdentity = 'identity-a') => ({
    routeId: 'route-a',
    credentialId,
    accountIdentity,
    label: 'Work',
  })
  const attribution = (recordVersion: number): VaultStateAttribution => ({
    routeId: 'route-a',
    credentialId: 'credential-1',
    accountIdentity: 'identity-a',
    recordVersion,
  })

  /** An owned stand-in for the source's fenced commit over one file. */
  function stateFile(initial: Record<string, VaultAccountState> = {}) {
    const accounts: Record<string, VaultAccountState> = { ...initial }
    const commits: VaultStateAttribution[] = []
    let refuse: Error | undefined
    return {
      accounts,
      commits,
      refuseNext(error: Error) {
        refuse = error
      },
      read: async (): Promise<VaultProviderStateFile> => ({
        schemaVersion: 1,
        accounts: { ...accounts },
      }),
      commitState: async (
        by: VaultStateAttribution,
        update: (
          current: VaultAccountState | undefined,
        ) => Omit<VaultAccountState, 'observed'> | null | undefined,
      ) => {
        commits.push(by)
        if (refuse) {
          const error = refuse
          refuse = undefined
          throw error
        }
        const next = update(accounts[by.accountIdentity])
        if (next === undefined || next === null)
          return { status: 'unchanged' as const }
        const state: VaultAccountState = {
          ...next,
          observed: {
            routeId: by.routeId,
            credentialId: by.credentialId,
            recordVersion: by.recordVersion,
          },
        }
        accounts[by.accountIdentity] = state
        return { status: 'written' as const, state }
      },
    }
  }

  it('restores state only onto the route and credential it was written for', async () => {
    const file = stateFile({
      'identity-a': {
        observed: {
          routeId: 'route-a',
          credentialId: 'credential-1',
          recordVersion: 2,
        },
        metadata: {
          addedAt: 1,
          lastUsed: 50,
          coolingDownUntil: 9_000,
          cooldownReason: 'auth-failure',
          rateLimitResetTimes: { claude: 7_000 },
        },
        quota: {
          schemaVersion: 1,
          cachedQuota: { gemini: { remainingFraction: 0.4, modelCount: 2 } },
          cachedQuotaUpdatedAt: 40,
        },
      },
    })
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
    })
    const [same] = vaultAccountRows([route('credential-1')])
    const [replaced] = vaultAccountRows([route('credential-2')])
    const [other] = vaultAccountRows([route('credential-1', 'identity-b')])
    if (!same || !replaced || !other) throw new Error('missing rows')
    await state.hydrate([same, replaced, other])
    expect(same).toMatchObject({
      lastUsed: 50,
      coolingDownUntil: 9_000,
      cooldownReason: 'auth-failure',
      rateLimitResetTimes: { claude: 7_000 },
      cachedQuota: { gemini: { remainingFraction: 0.4, modelCount: 2 } },
      cachedQuotaUpdatedAt: 40,
    })
    expect(replaced.coolingDownUntil).toBeUndefined()
    expect(replaced.lastUsed).toBe(0)
    expect(other.coolingDownUntil).toBeUndefined()
  })

  it('issue69 kept older insula evidence cannot clear a fresh vault mark, but newer quota can', async () => {
    let now = 10_000
    const file = stateFile()
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
      now: () => now,
    })
    const selector = new AccountSelector({ sink: state.sink, now: () => now })
    selector.resetAccounts(vaultAccountRows([route('credential-1')]))
    const row = selector.getAccounts()[0]!
    state.admitted(row, attribution(1))
    const key = 'gemini:gemini-3.8-flash'
    selector.markRateLimited(
      row,
      65 * 60 * 60 * 1000,
      'gemini',
      'gemini-3.8-flash',
    )
    await state.flush()
    const reading = (at: number) => ({
      schemaVersion: 1 as const,
      cachedQuotaUpdatedAt: at,
      cachedQuota: { gemini: { remainingFraction: 0.9, modelCount: 1 } },
    })
    // A kept reading retains the producer's old checkedAt, not the poll time.
    await state.recordQuota(attribution(1), reading(now - 1))
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitResetTimes?.[key],
    ).toBe(now + 65 * 60 * 60 * 1000)
    now += 1
    await state.recordQuota(attribution(1), reading(now))
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitResetTimes?.[key],
    ).toBeUndefined()
    // A stale queued selection snapshot must not resurrect the cleared mark.
    state.sink.lastUsed?.(row, now)
    await state.flush()
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitResetTimes?.[key],
    ).toBeUndefined()
  })

  it('issue69 vault clear rechecks the current mark inside the commit callback', async () => {
    const key = 'gemini:gemini-3.8-flash'
    const file = stateFile({
      'identity-a': {
        observed: {
          routeId: 'route-a',
          credentialId: 'credential-1',
          recordVersion: 1,
        },
        metadata: {
          addedAt: 1,
          lastUsed: 0,
          rateLimitResetTimes: { [key]: 99_000 },
          rateLimitWrittenAt: { [key]: 100 },
        },
      },
    })
    const state = createVaultSelectionState({
      source: {
        commitState: async (by, update) => {
          const current = file.accounts['identity-a']!
          current.metadata = {
            ...current.metadata!,
            rateLimitResetTimes: { [key]: 199_000 },
            rateLimitWrittenAt: { [key]: 300 },
          }
          return file.commitState(by, update)
        },
      },
      readState: file.read,
      now: () => 400,
    })
    await state.recordQuota(attribution(1), {
      schemaVersion: 1,
      cachedQuotaUpdatedAt: 200,
      cachedQuota: { gemini: { remainingFraction: 1, modelCount: 1 } },
    })
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitResetTimes?.[key],
    ).toBe(199_000)
  })

  it('issue69 legacy vault marks are stamped on load and clear after a newer poll', async () => {
    const key = 'gemini:gemini-3.8-flash'
    const file = stateFile({
      'identity-a': {
        observed: {
          routeId: 'route-a',
          credentialId: 'credential-1',
          recordVersion: 1,
        },
        metadata: {
          addedAt: 1,
          lastUsed: 0,
          rateLimitResetTimes: { [key]: 99_000_000 },
        },
      },
    })
    let now = 1_000
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
      now: () => now,
    })
    await state.hydrate(vaultAccountRows([route('credential-1')]))
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitWrittenAt?.[key],
    ).toBe(1_000)
    now += 1
    await state.recordQuota(attribution(1), {
      schemaVersion: 1,
      cachedQuotaUpdatedAt: now,
      cachedQuota: { gemini: { remainingFraction: 1, modelCount: 1 } },
    })
    expect(
      file.accounts['identity-a']?.metadata?.rateLimitResetTimes?.[key],
    ).toBeUndefined()
  })

  it('saves selector transitions attributed to the receipt that last served the row', async () => {
    const file = stateFile()
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
      now: () => 100,
    })
    const selector = new AccountSelector({ sink: state.sink, now: () => 1_000 })
    selector.resetAccounts(vaultAccountRows([route('credential-1')]))
    const [row] = selector.getAccounts()
    if (!row) throw new Error('missing row')

    // Not yet served in this process: nothing to attribute the write to.
    selector.markAccountCoolingDown(row, 60_000, 'auth-failure')
    await state.flush()
    expect(file.commits).toEqual([])

    state.admitted(row, attribution(5))
    await state.flush()
    expect(file.commits).toEqual([attribution(5)])
    expect(file.accounts['identity-a']).toMatchObject({
      observed: { credentialId: 'credential-1', recordVersion: 5 },
      metadata: {
        addedAt: 100,
        coolingDownUntil: 61_000,
        cooldownReason: 'auth-failure',
      },
    })
  })

  it('drops a change the source refuses instead of re-attributing it', async () => {
    const file = stateFile()
    const errors: unknown[] = []
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
      onError: (error) => errors.push(error),
    })
    const selector = new AccountSelector({ sink: state.sink, now: () => 1_000 })
    selector.resetAccounts(vaultAccountRows([route('credential-1')]))
    const [row] = selector.getAccounts()
    if (!row) throw new Error('missing row')
    state.admitted(row, attribution(5))
    selector.markAccountCoolingDown(row, 60_000, 'auth-failure')
    file.refuseNext(new Error('binding-stale'))
    await state.flush()
    expect(errors).toHaveLength(1)
    await state.flush()
    expect(file.commits).toHaveLength(1)
    expect(file.accounts['identity-a']).toBeUndefined()
  })

  it('records a quota reading without touching the stored selection state', async () => {
    const file = stateFile({
      'identity-a': {
        observed: {
          routeId: 'route-a',
          credentialId: 'credential-1',
          recordVersion: 5,
        },
        metadata: { addedAt: 1, lastUsed: 2, lastSwitchReason: 'rotation' },
      },
    })
    const state = createVaultSelectionState({
      source: file,
      readState: file.read,
    })
    const quota = {
      schemaVersion: 1 as const,
      cachedQuota: { gemini: { remainingFraction: 0.8, modelCount: 3 } },
      cachedQuotaUpdatedAt: 77,
    }
    const result = await state.recordQuota(attribution(5), quota)
    expect(result.status).toBe('written')
    expect(file.accounts['identity-a']).toMatchObject({
      metadata: { addedAt: 1, lastUsed: 2, lastSwitchReason: 'rotation' },
      quota,
    })
  })
})

describe('createVaultAccountPool', () => {
  it('owns one selector whose new rows get stored state and whose kept rows keep theirs', async () => {
    let routes = [
      {
        routeId: 'route-a',
        credentialId: 'credential-1',
        accountIdentity: 'identity-a',
        label: 'A',
      },
    ]
    let refreshes = 0
    let failNext = true
    const stored: VaultProviderStateFile = {
      schemaVersion: 1,
      accounts: {
        'identity-b': {
          observed: {
            routeId: 'route-b',
            credentialId: 'credential-b',
            recordVersion: 1,
          },
          metadata: { addedAt: 1, lastUsed: 77 },
        },
      },
    }
    const pool = createVaultAccountPool({
      source: {
        refresh: async () => {
          refreshes += 1
          if (failNext) {
            failNext = false
            throw new Error('vault unavailable')
          }
          return undefined
        },
        routes: () => routes,
        admit: async () => {
          throw new Error('no send in this test')
        },
        reportServedStatus: async () => false,
      },
      durable: {
        source: {
          attribution: () => {
            throw new Error('no admission in this test')
          },
          commitState: async () => ({ status: 'unchanged' }),
        },
        readState: async () => stored,
      },
      now: () => 1_000,
    })
    // A failed first roster read is retried by the next sync.
    await expect(pool.sync()).rejects.toThrow('vault unavailable')
    await pool.sync()
    expect(refreshes).toBe(2)
    const [a] = pool.selector.getAccounts()
    if (!a) throw new Error('missing row')
    pool.selector.markAccountCoolingDown(a, 60_000, 'auth-failure')

    routes = [
      ...routes,
      {
        routeId: 'route-b',
        credentialId: 'credential-b',
        accountIdentity: 'identity-b',
        label: 'B',
      },
    ]
    await pool.sync()
    const [keptA, addedB] = pool.selector.getAccounts()
    expect(keptA?.coolingDownUntil).toBe(61_000)
    expect(addedB?.lastUsed).toBe(77)
    expect(refreshes).toBe(2)
  })
})

describe('checkVaultQuota', () => {
  const routeOf = (n: number) => ({
    routeId: `route-${n}`,
    credentialId: `credential-${n}`,
    accountIdentity: `identity-${n}`,
    label: `Account ${n}`,
  })
  const attributionOf = (n: number, recordVersion = 1) => ({
    routeId: `route-${n}`,
    credentialId: `credential-${n}`,
    accountIdentity: `identity-${n}`,
    recordVersion,
  })
  const summary = (fraction: number) => ({
    groups: { gemini: { remainingFraction: fraction, modelCount: 2 } },
    modelCount: 2,
  })

  it('counts a row as checked only when its attributed reading was written', async () => {
    const written: { by: VaultStateAttribution; quota: unknown }[] = []
    const errors: unknown[] = []
    const routes = [routeOf(1), routeOf(2), routeOf(3), routeOf(4), routeOf(5)]
    const pool = createVaultAccountPool({
      source: {
        refresh: async () => undefined,
        routes: () => routes,
        admit: async () => {
          throw new Error('no send in this test')
        },
        reportServedStatus: async () => false,
      },
      durable: {
        source: {
          attribution: () => {
            throw new Error('no admission in this test')
          },
          commitState: async (by, update) => {
            if (by.accountIdentity === 'identity-3')
              throw new Error('binding-stale')
            // A write that may or may not have landed is not a reading.
            if (by.accountIdentity === 'identity-5')
              return { status: 'uncertain', error: new Error('torn write') }
            const next = update(undefined)
            written.push({ by, quota: next?.quota })
            return {
              status: 'written',
              state: {
                observed: {
                  routeId: by.routeId,
                  credentialId: by.credentialId,
                  recordVersion: by.recordVersion,
                },
                ...(next?.quota ? { quota: next.quota } : {}),
              },
            }
          },
        },
        readState: async () => ({ schemaVersion: 1, accounts: {} }),
      },
    })
    await pool.sync()
    const report = await checkVaultQuota({
      pool,
      fetchReading: async (ref) => {
        switch (ref.routeId) {
          case 'route-1':
            return { quota: summary(0.5), quotaAttribution: attributionOf(1) }
          case 'route-2':
            // No admission answered: nothing to attribute the reading to.
            return { quota: summary(0.9) }
          case 'route-3':
            return { quota: summary(0.1), quotaAttribution: attributionOf(3) }
          case 'route-5':
            return { quota: summary(0.7), quotaAttribution: attributionOf(5) }
          default:
            return {
              quota: { groups: {}, modelCount: 0, error: 'unavailable' },
              quotaAttribution: attributionOf(4),
            }
        }
      },
      signal: new AbortController().signal,
      now: () => 500,
      onError: (error) => errors.push(error),
    })
    expect(report).toEqual({ checked: 1, notChecked: 4 })
    expect(written).toEqual([
      {
        by: attributionOf(1),
        quota: {
          schemaVersion: 1,
          cachedQuota: { gemini: { remainingFraction: 0.5, modelCount: 2 } },
          cachedQuotaUpdatedAt: 500,
        },
      },
    ])
    expect(errors).toHaveLength(1)
    const [one, two] = pool.selector.getAccounts()
    expect(one?.cachedQuota).toEqual({
      gemini: { remainingFraction: 0.5, modelCount: 2 },
    })
    expect(two?.cachedQuota).toBeUndefined()
  })

  it('checks nothing without durable state or after the signal aborts', async () => {
    let fetched = 0
    const pool = createVaultAccountPool({
      source: {
        refresh: async () => undefined,
        routes: () => [routeOf(1)],
        admit: async () => {
          throw new Error('no send in this test')
        },
        reportServedStatus: async () => false,
      },
    })
    await pool.sync()
    const report = await checkVaultQuota({
      pool,
      fetchReading: async () => {
        fetched += 1
        return { quota: summary(1), quotaAttribution: attributionOf(1) }
      },
      signal: new AbortController().signal,
    })
    expect(report).toEqual({ checked: 0, notChecked: 1 })
    expect(fetched).toBe(0)
  })
})

async function flushRosterWork(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function rosterClock() {
  let now = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      const timer = { at: now + delayMs, callback }
      timers.add(timer)
      return () => {
        timers.delete(timer)
      }
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const end = now + ms
      while (true) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0]
        if (!next || next.at > end) break
        now = next.at
        timers.delete(next)
        next.callback()
        await flushRosterWork()
      }
      now = end
      await flushRosterWork()
    },
  }
}

function rosterSource() {
  const reads: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const refreshArgs: unknown[][] = []
  const source: VaultRequestSource = {
    refresh: async (...args: unknown[]) => {
      refreshArgs.push(args)
      const read = Promise.withResolvers<void>()
      reads.push(read)
      await read.promise
    },
    routes: () => [
      {
        routeId: 'route',
        credentialId: 'credential',
        accountIdentity: 'identity',
        label: 'Work',
      },
    ],
    admit: async () => {
      throw new Error('no send')
    },
    reportServedStatus: async () => false,
  }
  return { source, reads, refreshArgs }
}

describe('display vault roster wait', () => {
  it('renders accounts from a quick first read without a second refresh', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const committedRoutes = source.routes
    source.routes = () => []
    const pool = createVaultAccountPool({ source, ...clock })
    const display = pool.syncForDisplay()
    await clock.advance(100)
    source.routes = committedRoutes
    reads[0]!.resolve()
    await display
    expect(pool.selector.rows).toHaveLength(1)
    expect(reads).toHaveLength(1)
    expect(clock.now()).toBe(100)
    expect(clock.pending()).toBe(0)
    await pool.syncForDisplay()
    expect(reads).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('returns committed routes at two seconds while discovery stays pending and shared', async () => {
    const clock = rosterClock()
    const { source, reads, refreshArgs } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    let displayed = false
    const display = pool.syncForDisplay().then(() => {
      displayed = true
    })
    let requested = false
    const request = pool.sync().then(() => {
      requested = true
    })
    await clock.advance(1_999)
    expect(displayed).toBe(false)
    expect(requested).toBe(false)
    await clock.advance(1)
    await display
    expect(pool.selector.rows).toHaveLength(1)
    expect(clock.now()).toBe(2_000)
    expect(requested).toBe(false)
    expect(reads).toHaveLength(1)
    expect(refreshArgs).toEqual([[]])
    expect(clock.pending()).toBe(1)

    // Further sections must not add another short wait to the same menu.
    const section = pool.syncForDisplay()
    await clock.advance(0)
    await section
    expect(clock.now()).toBe(2_000)
    expect(requested).toBe(false)
    expect(reads).toHaveLength(1)
    await clock.advance(1_000)
    source.routes = () => []
    reads[0]!.resolve()
    await request
    expect(pool.selector.rows).toHaveLength(0)
    expect(reads).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('renders committed routes without throwing on a read error', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    const display = pool.syncForDisplay()
    reads[0]!.reject(new Error('vault unavailable'))
    await display
    expect(pool.selector.rows).toHaveLength(1)
    expect(clock.now()).toBe(0)
    expect(clock.pending()).toBe(0)
    const request = pool.sync()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve()
    await request
  })

  it('returns immediately on abort without throwing or cancelling shared discovery', async () => {
    const clock = rosterClock()
    const { source, reads, refreshArgs } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    const controller = new AbortController()
    const display = pool.syncForDisplay(controller.signal)
    await clock.advance(100)
    controller.abort(new DOMException('Menu closed', 'AbortError'))
    await display
    expect(pool.selector.rows).toHaveLength(1)
    expect(clock.now()).toBe(100)
    expect(clock.pending()).toBe(0)
    const request = pool.sync()
    expect(reads).toHaveLength(1)
    expect(refreshArgs).toEqual([[]])
    reads[0]!.resolve()
    await request
    expect(clock.pending()).toBe(0)
  })

  it('renders committed routes for an already aborted display without starting discovery', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    await pool.syncForDisplay(AbortSignal.abort())
    expect(pool.selector.rows).toHaveLength(1)
    expect(reads).toHaveLength(0)
    expect(clock.now()).toBe(0)
    expect(clock.pending()).toBe(0)
  })
})

describe('first vault roster wait', () => {
  it('accepts a first roster settling at 3 seconds', async () => {
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({
      source,
      now: () => performance.now(),
    })
    const pending = pool.sync()
    const timer = setTimeout(() => reads[0]?.resolve(), 3_000)
    try {
      await pending
      expect(pool.selector.rows).toHaveLength(1)
      expect(reads).toHaveLength(1)
    } finally {
      clearTimeout(timer)
      reads[0]?.resolve()
    }
  })

  it('shares discovery between concurrent first requests and clears their timers', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    const first = pool.sync()
    const second = pool.sync()
    await clock.advance(3_000)
    expect(reads).toHaveLength(1)
    reads[0]!.resolve()
    await Promise.all([first, second])
    expect(pool.selector.rows).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('renders cached routes without starting or waiting on discovery', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    await pool.syncCached()
    expect(pool.selector.rows).toHaveLength(1)
    expect(reads).toHaveLength(0)
    const pending = pool.sync()
    await pool.syncCached()
    expect(reads).toHaveLength(1)
    expect(clock.now()).toBe(0)
    reads[0]!.resolve()
    await pending
    expect(clock.pending()).toBe(0)
  })

  it('gives a caller joining at 25 seconds only the remaining 5 seconds before retry', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    const first = pool.sync()
    await clock.advance(25_000)
    const late = pool.sync()
    await clock.advance(4_999)
    expect(reads).toHaveLength(1)
    await clock.advance(1)
    expect(reads).toHaveLength(2)
    reads[1]!.resolve()
    await Promise.all([first, late])
    expect(clock.now()).toBe(30_000)
    expect(pool.selector.rows).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  for (const method of ['sync', 'refresh'] as const) {
    it(`${method} does not start a read for an already cancelled caller`, async () => {
      const clock = rosterClock()
      const { source, reads } = rosterSource()
      const pool = createVaultAccountPool({ source, ...clock })
      const controller = new AbortController()
      controller.abort()
      await expect(pool[method](controller.signal)).rejects.toBe(
        controller.signal.reason,
      )
      expect(reads).toHaveLength(0)
      expect(clock.pending()).toBe(0)
    })

    it(`${method} retries a stalled first read once and accepts the fresh read`, async () => {
      const clock = rosterClock()
      const { source, reads } = rosterSource()
      const pool = createVaultAccountPool({ source, ...clock })
      const pending = pool[method]()
      await clock.advance(VAULT_REFRESH_STALL_MS)
      expect(reads).toHaveLength(2)
      reads[1]!.resolve()
      await pending
      expect(pool.selector.rows).toHaveLength(1)
      // An abandoned read settling later must not reset the fresh roster.
      source.routes = () => []
      reads[0]!.resolve()
      await flushRosterWork()
      expect(pool.selector.rows).toHaveLength(1)
      expect(reads).toHaveLength(2)
      expect(clock.pending()).toBe(0)
    })

    it(`${method} refuses after two stalled reads without starting a third`, async () => {
      const clock = rosterClock()
      const { source, reads } = rosterSource()
      const pool = createVaultAccountPool({ source, ...clock })
      const outcome = pool[method]().catch((error: unknown) => error)
      await clock.advance(VAULT_REFRESH_STALL_MS)
      expect(reads).toHaveLength(2)
      await clock.advance(VAULT_REFRESH_STALL_MS)
      expect(await outcome).toMatchObject({
        message:
          'The vault roster is not available yet. Check vault access and try the request again.',
      })
      await clock.advance(VAULT_REFRESH_STALL_MS)
      expect(reads).toHaveLength(2)
      expect(clock.pending()).toBe(0)
    })

    it(`${method} cancels only the caller wait and preserves discovery for a later request`, async () => {
      const clock = rosterClock()
      const { source, reads, refreshArgs } = rosterSource()
      const pool = createVaultAccountPool({ source, ...clock })
      const controller = new AbortController()
      const reason = new DOMException('Request cancelled', 'AbortError')
      const outcome = pool[method](controller.signal).catch(
        (error: unknown) => error,
      )
      await clock.advance(3_000)
      controller.abort(reason)
      expect(await outcome).toBe(reason)
      expect(clock.now()).toBe(3_000)
      expect(clock.pending()).toBe(0)
      expect(refreshArgs).toEqual([[]])
      reads[0]!.resolve()
      await pool.sync()
      expect(pool.selector.rows).toHaveLength(1)
      expect(reads).toHaveLength(1)
      expect(clock.pending()).toBe(0)
    })
  }

  it('cancels a later explicit refresh without cancelling its shared source read', async () => {
    const clock = rosterClock()
    const { source, reads, refreshArgs } = rosterSource()
    const pool = createVaultAccountPool({ source, ...clock })
    const first = pool.sync()
    reads[0]!.resolve()
    await first
    const controller = new AbortController()
    const reason = new DOMException('Request cancelled', 'AbortError')
    const outcome = pool
      .refresh(controller.signal)
      .catch((error: unknown) => error)
    await flushRosterWork()
    expect(reads).toHaveLength(2)
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(refreshArgs).toEqual([[], []])
    reads[1]!.resolve()
    await pool.sync()
    expect(clock.pending()).toBe(0)
  })

  it('preserves a read error or refusal immediately without waiting for a timer', async () => {
    for (const failure of [
      new Error('vault unavailable'),
      new Error('vault refused'),
    ]) {
      const clock = rosterClock()
      const { source, reads } = rosterSource()
      const pool = createVaultAccountPool({ source, ...clock })
      const outcome = pool.sync().catch((error: unknown) => error)
      reads[0]!.reject(failure)
      expect(await outcome).toBe(failure)
      expect(clock.now()).toBe(0)
      expect(reads).toHaveLength(1)
      expect(clock.pending()).toBe(0)
    }
  })

  it('returns an empty roster immediately so the engine can report its own refusal', async () => {
    const clock = rosterClock()
    const { source, reads } = rosterSource()
    source.routes = () => []
    const pool = createVaultAccountPool({
      source,
      ...clock,
      emptyRosterRefusal: () => 'No usable vault account',
    } satisfies VaultAccountPoolOptions)
    const pending = pool.sync()
    reads[0]!.resolve()
    await pending
    expect(pool.selector.rows).toHaveLength(0)
    expect(pool.credentials.emptyRosterRefusal?.()).toBe(
      'No usable vault account',
    )
    expect(clock.now()).toBe(0)
    expect(clock.pending()).toBe(0)
  })
})
