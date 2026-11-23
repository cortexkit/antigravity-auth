/**
 * A vault quota reading that ends late must not replace a newer one. A manual
 * "Check quota now" runs outside the poller's lock, so the older of two
 * readings can commit last. The local account store refuses an older dated
 * reading under its write lock; the vault provider-state path keeps the same
 * rule, both in the state file and on the live pool row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultStateAttribution } from '@cortexkit/antigravity-auth-core'
import {
  commitVaultProviderState,
  loadCommonAuthFs,
  readVaultProviderState,
} from '@cortexkit/antigravity-auth-core'

import {
  checkVaultQuota,
  createVaultAccountPool,
  type VaultAccountPool,
  type VaultAccountPoolOptions,
  type VaultRequestSource,
} from './vault-request-credentials.ts'

const OLDER = 1_000
const NEWER = 2_000
const NOW = 3_000

async function fixture() {
  const fs = await loadCommonAuthFs()
  const dir = await mkdtemp(join(tmpdir(), 'agy-vault-newer-reading-'))
  const statePath = join(dir, 'state.json')
  const by: VaultStateAttribution = {
    routeId: 'vault:a',
    credentialId: 'credential-a',
    accountIdentity: 'account-a',
    recordVersion: 1,
  }
  const route = () => ({
    routeId: by.routeId,
    credentialId: by.credentialId,
    accountIdentity: by.accountIdentity,
    label: 'Work',
  })
  const source: VaultRequestSource = {
    refresh: async () => undefined,
    routes: () => [route()],
    admit: async () => ({
      ...by,
      accessToken: 'fixture-access',
      projectId: 'fixture-project',
      expiresAtMs: null,
    }),
    reportServedStatus: async () => false,
  }
  const readState = () => readVaultProviderState(statePath)
  const durable: NonNullable<VaultAccountPoolOptions['durable']> = {
    stateFile: statePath,
    readState,
    source: {
      attribution: () => by,
      commitState: (attribution, update) =>
        commitVaultProviderState({
          claustrum: {
            isDeclined: () => false,
            async mutateVaultRoster(_path, change) {
              const outcome = await change(
                {
                  version: 1,
                  complete: true,
                  declined: [],
                  rows: [
                    {
                      ...route(),
                      credentialType: 'oauth',
                      state: 'active',
                      enabled: true,
                      addedAt: 1,
                    },
                  ],
                },
                { assertOwned: async () => undefined },
              )
              return outcome.result
            },
          },
          fs,
          rosterPath: join(dir, 'roster.json'),
          statePath,
          attribution,
          verify: async () => undefined,
          update,
        }),
    },
  }
  return {
    by,
    read: async () => (await readState()).accounts[by.accountIdentity],
    close: () => rm(dir, { recursive: true, force: true }),
    async open() {
      const pool = createVaultAccountPool({
        source,
        durable,
        now: () => NOW,
      })
      await pool.sync()
      const [row] = pool.selector.rows
      if (!row) throw new Error('missing vault row')
      await pool.credentials.admit({ account: row, signal: undefined })
      return { pool, row }
    },
    /** One quota check whose reading was observed at `observedAt`. */
    check(
      pool: VaultAccountPool,
      observedAt: number,
      remainingFraction: number,
    ) {
      return checkVaultQuota({
        pool,
        fetchReading: async () => ({
          quota: {
            groups: { gemini: { remainingFraction, modelCount: 1 } },
            modelCount: 1,
          },
          quotaAttribution: by,
          observedAt,
        }),
        signal: new AbortController().signal,
        now: () => NOW,
      })
    },
  }
}

describe('vault quota keeps the newer reading', () => {
  let f: Awaited<ReturnType<typeof fixture>>

  beforeEach(async () => {
    f = await fixture()
  })

  afterEach(async () => {
    await f?.close()
  })

  it('keeps the newer stored reading when an older check commits last', async () => {
    const poller = await f.open()
    const manual = await f.open()
    // The poller commits R2; the manual check took R1 earlier and ends last.
    expect(await f.check(poller.pool, NEWER, 0.5)).toEqual({
      checked: 1,
      notChecked: 0,
    })
    expect(await f.check(poller.pool, OLDER, 0.9)).toEqual({
      checked: 1,
      notChecked: 0,
    })
    expect(await f.check(manual.pool, OLDER, 0.9)).toEqual({
      checked: 1,
      notChecked: 0,
    })

    const stored = await f.read()
    expect(stored?.quota?.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(stored?.quota?.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
    expect(poller.row.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(poller.row.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
    expect(manual.row.cachedQuotaUpdatedAt).not.toBe(OLDER)

    // Another pool still adopts the newer stored reading on sync.
    await manual.pool.sync()
    expect(manual.row.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(manual.row.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
  })

  it('lets a newer reading replace an older one', async () => {
    const { pool, row } = await f.open()
    await f.check(pool, OLDER, 0.9)
    expect((await f.read())?.quota?.cachedQuotaUpdatedAt).toBe(OLDER)
    expect(row.cachedQuotaUpdatedAt).toBe(OLDER)

    expect(await f.check(pool, NEWER, 0.5)).toEqual({
      checked: 1,
      notChecked: 0,
    })
    const stored = await f.read()
    expect(stored?.quota?.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(stored?.quota?.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
    expect(row.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(row.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
  })

  it('keeps a newer reading on the live row when the file has none', async () => {
    const { pool, row } = await f.open()
    // The row holds a newer reading in memory only.
    row.cachedQuota = { gemini: { remainingFraction: 0.5, modelCount: 1 } }
    row.cachedQuotaUpdatedAt = NEWER

    expect(await f.check(pool, OLDER, 0.9)).toEqual({
      checked: 1,
      notChecked: 0,
    })
    expect(row.cachedQuotaUpdatedAt).toBe(NEWER)
    expect(row.cachedQuota?.gemini?.remainingFraction).toBe(0.5)
  })

  it('accepts an undated reading over a dated one, as the local store does', async () => {
    const { pool } = await f.open()
    await f.check(pool, NEWER, 0.5)
    const result = await pool.state?.recordQuota(f.by, {
      schemaVersion: 1,
      cachedQuota: { gemini: { remainingFraction: 0.9, modelCount: 1 } },
    })
    expect(result?.status).toBe('written')
    const stored = await f.read()
    expect(stored?.quota?.cachedQuota?.gemini?.remainingFraction).toBe(0.9)
  })
})
