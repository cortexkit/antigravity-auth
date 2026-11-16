import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAntigravityVaultAccountSource,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  loadCommonAuthStore,
  readVaultProviderState,
  type VaultScopedClient,
  type VaultStateAttribution,
} from '@cortexkit/antigravity-auth-core'
import { createVaultAccountPool } from './vault-request-credentials.ts'

const NOW = 2_000_000_000_000
const ORIGINAL: VaultStateAttribution = {
  accountIdentity: 'account-a',
  routeId: 'vault:a',
  credentialId: 'credential-a',
  recordVersion: 1,
}
const QUOTA = {
  schemaVersion: 1 as const,
  cachedQuota: {
    gemini: {
      remainingFraction: 0,
      modelCount: 2,
      resetTime: new Date(NOW + 60_000).toISOString(),
    },
  },
  cachedQuotaUpdatedAt: NOW - 1_000,
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vault-quota-provenance-'))
  const claustrum = await loadCommonAuthClaustrum()
  const fs = await loadCommonAuthFs()
  const rosterPath = join(dir, 'roster.json')
  const statePath = join(dir, 'provider-state.json')
  const tokenPath = join(dir, 'enrollment.json')
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  let served = ORIGINAL
  const client: VaultScopedClient = {
    async listScoped() {
      return {
        view: JSON.stringify(served),
        rows: [
          {
            id: served.credentialId,
            accountId: served.accountIdentity,
            credentialType: 'oauth',
            categories: ['antigravity-native'],
            serves: [],
            providerIds: [],
            refreshAdapter: 'antigravity',
            state: 'active',
            recordVersion: served.recordVersion,
            operations: ['read'],
            createdAtMs: null,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      return {
        material: 'owned-vault-access',
        credentialId: served.credentialId,
        accountId: served.accountIdentity,
        recordVersion: served.recordVersion,
        projectId: 'owned-project',
        expiresAtMs: NOW + 3_600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const sources: ReturnType<typeof createAntigravityVaultAccountSource>[] = []
  const readState = () => readVaultProviderState(statePath)
  async function open(by: VaultStateAttribution) {
    served = by
    await claustrum.mutateVaultRoster(rosterPath, () => ({
      next: {
        version: 1,
        complete: true,
        rows: [
          {
            routeId: by.routeId,
            credentialId: by.credentialId,
            accountIdentity: by.accountIdentity,
            credentialType: 'oauth',
            state: 'active',
            label: 'Work',
            enabled: true,
            addedAt: 1,
          },
        ],
        declined: [],
      },
      result: undefined,
    }))
    const source = createAntigravityVaultAccountSource({
      claustrum,
      host: 'opencode',
      rosterPath,
      tokenPath,
      connect: async () => client,
      isCustodyActive: () => true,
      reporterSource: 'direct',
      state: { path: statePath, fs },
      now: () => NOW,
      logger: { debug() {}, warn() {} },
    })
    sources.push(source)
    const pool = createVaultAccountPool({
      source,
      durable: { source, readState, onError: (error) => errors.push(error) },
      now: () => NOW,
    })
    await pool.sync()
    const [row] = pool.selector.getAccounts()
    if (!row) throw new Error('fixture has no vault row')
    expect(row.route).toMatchObject({
      routeId: by.routeId,
      credentialId: by.credentialId,
      accountIdentity: by.accountIdentity,
    })
    return { source, pool, row }
  }
  const errors: unknown[] = []
  return {
    open,
    readState,
    errors,
    async close() {
      for (const source of sources) source.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('disk-backed vault quota provenance', () => {
  for (const [replacement, changed, keepsQuota] of [
    ['route only', { routeId: 'vault:b' }, false],
    ['credential only', { credentialId: 'credential-b' }, false],
    [
      'route and credential',
      { routeId: 'vault:b', credentialId: 'credential-b' },
      false,
    ],
    ['record version only', { recordVersion: 2 }, true],
    ['account identity', { accountIdentity: 'account-b' }, false],
  ] as const) {
    it(`save and reload after replacing ${replacement}`, async () => {
      const local = spyOn(
        await loadCommonAuthStore(),
        'openPoolStore',
      ).mockImplementation(() => {
        throw new Error('vault quota must not open local account storage')
      })
      const f = await fixture()
      try {
        const initial = await f.open(ORIGINAL)
        const admission = await initial.source.admit(initial.row.route)
        const result = await initial.pool.state!.recordQuota(
          initial.source.attribution(admission),
          QUOTA,
        )
        expect(result.status).toBe('written')
        expect((await f.readState()).accounts['account-a']?.quota).toEqual(
          QUOTA,
        )
        initial.source.close()

        const by = { ...ORIGINAL, ...changed }
        const next = await f.open(by)
        expect(next.row.cachedQuota).toEqual(
          keepsQuota ? QUOTA.cachedQuota : undefined,
        )
        expect(next.row.cachedQuotaUpdatedAt).toBe(
          keepsQuota ? QUOTA.cachedQuotaUpdatedAt : undefined,
        )
        await next.pool.credentials.admit({
          account: next.row,
          signal: undefined,
        })
        next.pool.selector.markAccountCoolingDown(
          next.row,
          60_000,
          'auth-failure',
        )
        await next.pool.flush()
        expect(f.errors).toEqual([])
        const file = await f.readState()
        const entry = file.accounts[by.accountIdentity]
        expect(entry?.observed).toEqual({
          routeId: by.routeId,
          credentialId: by.credentialId,
          recordVersion: by.recordVersion,
        })
        expect(entry?.metadata?.coolingDownUntil).toBe(NOW + 60_000)
        if (by.accountIdentity !== ORIGINAL.accountIdentity)
          expect(file.accounts[ORIGINAL.accountIdentity]?.quota).toEqual(QUOTA)
        next.source.close()

        const reloaded = await f.open(by)
        expect(reloaded.row.coolingDownUntil).toBe(NOW + 60_000)
        expect({
          cachedQuota: reloaded.row.cachedQuota,
          cachedQuotaUpdatedAt: reloaded.row.cachedQuotaUpdatedAt,
        }).toEqual({
          cachedQuota: keepsQuota ? QUOTA.cachedQuota : undefined,
          cachedQuotaUpdatedAt: keepsQuota
            ? QUOTA.cachedQuotaUpdatedAt
            : undefined,
        })
        expect(entry?.quota).toEqual(keepsQuota ? QUOTA : undefined)
        expect(local).not.toHaveBeenCalled()
      } finally {
        await f.close()
        local.mockRestore()
      }
    })
  }

  for (const [replacement, changed] of [
    ['route', { routeId: 'vault:b' }],
    ['credential', { credentialId: 'credential-b' }],
    [
      'route and credential',
      { routeId: 'vault:b', credentialId: 'credential-b' },
    ],
  ] as const) {
    it(`clearLimits after a ${replacement} relabel does not resurrect quota`, async () => {
      const f = await fixture()
      try {
        const initial = await f.open(ORIGINAL)
        const admission = await initial.source.admit(initial.row.route)
        expect(
          (
            await initial.pool.state!.recordQuota(
              initial.source.attribution(admission),
              QUOTA,
            )
          ).status,
        ).toBe('written')
        initial.source.close()
        const by = { ...ORIGINAL, ...changed }
        const next = await f.open(by)
        await next.pool.clearLimits(next.row)
        next.source.close()
        const reloaded = await f.open(by)
        expect(reloaded.row.cachedQuota).toBeUndefined()
        expect(reloaded.row.cachedQuotaUpdatedAt).toBeUndefined()
        expect(
          (await f.readState()).accounts[by.accountIdentity]?.quota,
        ).toBeUndefined()
        expect(f.errors).toEqual([])
      } finally {
        await f.close()
      }
    })
  }
})
