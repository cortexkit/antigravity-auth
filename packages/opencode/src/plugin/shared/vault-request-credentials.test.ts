/**
 * The shared vault request pieces: selection rows built from vault routes,
 * their identity across roster re-reads, and the engine's vault credential
 * domain over an owned stand-in for the core vault account source.
 */

import { describe, expect, it } from 'bun:test'
import { AccountSelector } from '@cortexkit/antigravity-auth-core'

import {
  createVaultRequestCredentials,
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
