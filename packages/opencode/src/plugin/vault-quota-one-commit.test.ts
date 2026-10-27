import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AntigravityVaultStateFs,
  createAntigravityVaultAccountSource,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  readVaultProviderState,
  type VaultClaustrumPort,
  type VaultScopedClient,
} from '@cortexkit/antigravity-auth-core'
import { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh'
import type { VaultQuotaCheckOptions } from './quota'
import { createVaultAccountPool } from './shared/vault-request-credentials'
import type { VaultQuotaOutcome } from './vault-quota-outcome'

const NOW = Date.UTC(2026, 9, 21, 12)
const ACCOUNTS = 5
const SERVED_VERSION = 7

/** Declines the route of account `index` through the library's roster writer. */
type Decline = (index: number) => Promise<void>

/**
 * The real vault source, provider-state commit and background producer over
 * five vault accounts. The common-auth roster and file functions the source
 * is given are wrapped to count roster write locks, provider-state locks and
 * provider-state atomic writes (each ends in one rename when it succeeds).
 *
 * - `stale` names accounts whose vault record is replaced right after their
 *   quota is read, so the proof taken before the write sees a newer record
 *   version and that reading must be dropped.
 * - `beforeRosterRead` runs once, just before the commit's first (unlocked)
 *   roster read, after every reading has been fetched and proven by its
 *   admission.
 * - `beforeRosterLock` runs once, after that unlocked read and just before
 *   the commit asks for the roster write lock.
 * Both hooks receive `decline`, which declines an account's route through the
 *   library's own roster writer, as another process would.
 */
async function fixture(
  options: {
    stale?: ReadonlySet<number>
    beforeRosterRead?: (decline: Decline) => Promise<void>
    beforeRosterLock?: (decline: Decline) => Promise<void>
  } = {},
) {
  const stale = options.stale ?? new Set<number>()
  const dir = await mkdtemp(join(tmpdir(), 'vault-quota-one-commit-'))
  const claustrum = await loadCommonAuthClaustrum()
  const realFs = await loadCommonAuthFs()
  const rosterPath = join(dir, 'roster.json')
  const statePath = join(dir, 'provider-state.json')
  const tokenPath = join(dir, 'enrollment.json')
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const counts = { rosterLocks: 0, stateLocks: 0, stateWrites: 0 }
  let routeIds: string[] = []
  const decline: Decline = async (index) => {
    const routeId = routeIds[index]
    if (routeId === undefined) throw new Error(`no route ${index}`)
    await claustrum.declineVaultRoute(rosterPath, routeId)
  }
  // Armed once setup is done, so only the quota check's commit runs them.
  let beforeRosterRead: typeof options.beforeRosterRead
  let beforeRosterLock: typeof options.beforeRosterLock
  const port: VaultClaustrumPort = {
    ...claustrum,
    readVaultRoster: (async (
      ...args: Parameters<typeof claustrum.readVaultRoster>
    ) => {
      const hook = beforeRosterRead
      beforeRosterRead = undefined
      await hook?.(decline)
      return claustrum.readVaultRoster(...args)
    }) as typeof claustrum.readVaultRoster,
    mutateVaultRoster: (async (
      ...args: Parameters<typeof claustrum.mutateVaultRoster>
    ) => {
      const hook = beforeRosterLock
      beforeRosterLock = undefined
      await hook?.(decline)
      counts.rosterLocks++
      return claustrum.mutateVaultRoster(...args)
    }) as typeof claustrum.mutateVaultRoster,
  }
  const fs: AntigravityVaultStateFs = {
    withLock: ((...args: Parameters<typeof realFs.withLock>) => {
      if (args[0] === statePath) counts.stateLocks++
      return realFs.withLock(...args)
    }) as typeof realFs.withLock,
    writeJsonAtomic: ((...args: Parameters<typeof realFs.writeJsonAtomic>) => {
      if (args[0] === statePath) counts.stateWrites++
      return realFs.writeJsonAtomic(...args)
    }) as typeof realFs.writeJsonAtomic,
  }
  const receipts = new Map<string, number>()
  const client: VaultScopedClient = {
    async listScoped() {
      return {
        view: 'v1',
        rows: Array.from({ length: ACCOUNTS }, (_, index) => ({
          id: `credential-${index}`,
          accountId: `account-${index}`,
          credentialType: 'oauth' as const,
          categories: ['antigravity-native'],
          serves: [],
          providerIds: [],
          refreshAdapter: 'antigravity',
          state: 'active' as const,
          recordVersion: SERVED_VERSION,
          operations: ['read'],
          createdAtMs: null,
        })),
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      const served = (receipts.get(credentialId) ?? 0) + 1
      receipts.set(credentialId, served)
      const index = Number(credentialId.slice('credential-'.length))
      return {
        material: `vault-bearer-${index}`,
        credentialId,
        accountId: `account-${index}`,
        // The first receipt serves the quota read; later ones prove the write.
        recordVersion:
          stale.has(index) && served > 1 ? SERVED_VERSION + 1 : SERVED_VERSION,
        projectId: 'owned-project',
        expiresAtMs: NOW + 3_600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const source = createAntigravityVaultAccountSource({
    claustrum: port,
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
  await source.refresh()
  const routes = source.routes()
  routeIds = Array.from(
    { length: ACCOUNTS },
    (_, index) =>
      routes.find((route) => route.credentialId === `credential-${index}`)
        ?.routeId ?? '',
  )
  const readState = () => readVaultProviderState(statePath)
  const pool = createVaultAccountPool({
    source,
    durable: { source, readState },
  })
  const requests: string[] = []
  const transport: NonNullable<VaultQuotaCheckOptions['transport']> = async (
    url,
  ) => {
    requests.push(String(url))
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.25,
              resetTime: '2026-10-26T12:00:00Z',
            },
          ],
        },
      ],
    })
  }
  const outcomes: VaultQuotaOutcome[] = []
  let publishes = 0
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
    now: () => NOW,
    random: () => 0,
    onOutcome: (_level, outcome) => outcomes.push(outcome),
  })
  // Only the quota check is counted, not the roster discovery above.
  counts.rosterLocks = 0
  counts.stateLocks = 0
  counts.stateWrites = 0
  beforeRosterRead = options.beforeRosterRead
  beforeRosterLock = options.beforeRosterLock
  return {
    counts,
    outcomes,
    requests,
    poller,
    statePath,
    readState,
    /** Receipts served for account `index`: one for its quota read, one per proof. */
    receiptsFor: (index: number) => receipts.get(`credential-${index}`) ?? 0,
    get publishes() {
      return publishes
    },
    async close() {
      await poller.dispose()
      source.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const ALL = Array.from({ length: ACCOUNTS }, (_, index) => index)

describe('vault quota check commits provider state once', () => {
  it('records five accounts with one roster lock, one state lock and one rename', async () => {
    const f = await fixture()
    try {
      await f.poller.tick()
      expect(f.requests).toHaveLength(ACCOUNTS)
      expect(f.outcomes).toHaveLength(1)
      expect(f.outcomes[0]).toMatchObject({
        reason: 'recorded',
        checked: ACCOUNTS,
        notChecked: 0,
      })
      expect(f.counts).toEqual({
        rosterLocks: 1,
        stateLocks: 1,
        stateWrites: 1,
      })
      const accounts = (await f.readState()).accounts
      expect(Object.keys(accounts).sort()).toEqual(
        ALL.map((index) => `account-${index}`),
      )
      for (const state of Object.values(accounts)) {
        expect(state.observed.recordVersion).toBe(SERVED_VERSION)
        expect(state.quota?.cachedQuotaUpdatedAt).toBe(NOW)
        expect(state.quota?.cachedQuota?.gemini?.remainingFraction).toBe(0.25)
      }
      expect(f.publishes).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('drops only the reading whose record version changed and commits the other four once', async () => {
    const f = await fixture({ stale: new Set([3]) })
    try {
      await f.poller.tick()
      expect(f.outcomes[0]).toMatchObject({
        reason: 'recorded',
        checked: ACCOUNTS - 1,
        notChecked: 1,
      })
      expect(f.counts).toEqual({
        rosterLocks: 1,
        stateLocks: 1,
        stateWrites: 1,
      })
      const accounts = (await f.readState()).accounts
      expect(Object.keys(accounts).sort()).toEqual([
        'account-0',
        'account-1',
        'account-2',
        'account-4',
      ])
      expect(f.publishes).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('takes no lock and writes nothing when the roster no longer routes any reading', async () => {
    const f = await fixture({
      beforeRosterRead: async (decline) => {
        for (const index of ALL) await decline(index)
      },
    })
    try {
      await f.poller.tick()
      expect(f.requests).toHaveLength(ACCOUNTS)
      expect(f.outcomes[0]).toMatchObject({
        checked: 0,
        notChecked: ACCOUNTS,
        reasons: { 'binding-stale': ACCOUNTS },
      })
      expect(f.counts).toEqual({
        rosterLocks: 0,
        stateLocks: 0,
        stateWrites: 0,
      })
      // Refused before any proof: each account served only its quota read.
      for (const index of ALL) expect(f.receiptsFor(index)).toBe(1)
      expect(existsSync(f.statePath)).toBe(false)
      expect(f.publishes).toBe(0)
    } finally {
      await f.close()
    }
  })

  it('writes nothing when every proof under the locks shows a newer record version', async () => {
    const f = await fixture({ stale: new Set(ALL) })
    try {
      await f.poller.tick()
      expect(f.requests).toHaveLength(ACCOUNTS)
      expect(f.outcomes[0]).toMatchObject({ checked: 0, notChecked: ACCOUNTS })
      expect(f.counts).toEqual({
        rosterLocks: 1,
        stateLocks: 1,
        stateWrites: 0,
      })
      expect(existsSync(f.statePath)).toBe(false)
      expect(f.publishes).toBe(0)
    } finally {
      await f.close()
    }
  })

  it('refuses a reading whose route the roster stops routing after its proof of admission and before the commit', async () => {
    const f = await fixture({
      // The unlocked read has passed every reading; the roster then changes
      // before the commit holds the roster lock.
      beforeRosterLock: (decline) => decline(2),
    })
    try {
      await f.poller.tick()
      expect(f.outcomes[0]).toMatchObject({
        reason: 'recorded',
        checked: ACCOUNTS - 1,
        notChecked: 1,
        reasons: { recorded: ACCOUNTS - 1, 'binding-stale': 1 },
      })
      expect(f.counts).toEqual({
        rosterLocks: 1,
        stateLocks: 1,
        stateWrites: 1,
      })
      const accounts = (await f.readState()).accounts
      expect(Object.keys(accounts).sort()).toEqual([
        'account-0',
        'account-1',
        'account-3',
        'account-4',
      ])
      // The check under the roster lock refused it before its vault proof.
      expect(f.receiptsFor(2)).toBe(1)
      expect(f.receiptsFor(0)).toBe(2)
    } finally {
      await f.close()
    }
  })
})
