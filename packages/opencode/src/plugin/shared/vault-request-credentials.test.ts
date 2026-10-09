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
