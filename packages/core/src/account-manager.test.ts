import { describe, expect, it } from 'bun:test'
import {
  AccountManager,
  AccountManagerPersistError,
} from './account-manager.ts'
import type {
  AccountFlushReport,
  AccountRefreshOutcome,
  AccountRepository,
  AccountRepositoryRead,
  AccountRow,
  FingerprintObservation,
  MetadataMutator,
  ProviderMetadata,
  RoutingSettings,
  RowRef,
} from './account-repository-types.ts'
import type { AccountStorageStore } from './account-storage.ts'
import type { AccountStorageV4 } from './account-types.ts'
import { HealthScoreTracker, TokenBucketTracker } from './rotation.ts'

function createStore(initial: AccountStorageV4 | null = null) {
  let state = initial
  let mergedSaves = 0
  let mutations = 0
  const store: AccountStorageStore = {
    load: async () => state,
    saveMerged: async (_path, next) => {
      mergedSaves++
      state = next
      return next
    },
    mutate: async (_path, fn) => {
      mutations++
      const current = state ?? { version: 4, accounts: [], activeIndex: 0 }
      state = (await fn(current)) ?? current
      return state
    },
    clear: async () => {
      state = null
    },
  }
  return {
    store,
    state: () => state,
    mergedSaves: () => mergedSaves,
    mutations: () => mutations,
  }
}

const stored: AccountStorageV4 = {
  version: 4,
  accounts: [
    { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
    { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
  ],
  activeIndex: 0,
}

describe('core AccountManager', () => {
  it('constructs from stored and fallback auth', () => {
    const memory = createStore(stored)
    const manager = new AccountManager(
      { type: 'oauth', refresh: 'r3|p3' },
      stored,
      { store: memory.store },
    )
    expect(
      manager.getAccounts().map((account) => account.parts.refreshToken),
    ).toEqual(['r1', 'r2', 'r3'])
  })

  it('normalizes persisted legacy quota keys for soft-quota and proactive-rotation reads', () => {
    const now = 1_700_000_000_000
    const legacy: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: 'legacy-token',
          addedAt: 1,
          lastUsed: 0,
          cachedQuota: {
            claude: { remainingFraction: 0.4, modelCount: 1 },
          },
          cachedQuotaUpdatedAt: now,
        },
        {
          refreshToken: 'other-token',
          addedAt: 1,
          lastUsed: 0,
        },
      ],
      activeIndex: 0,
    }
    const memory = createStore(legacy)
    const manager = new AccountManager(undefined, legacy, {
      store: memory.store,
      now: () => now,
    })
    const account = manager.getAccounts()[0]!

    expect(
      manager.isAccountOverSoftQuota(
        account,
        'claude',
        50,
        60_000,
        'claude-sonnet',
      ),
    ).toBe(true)
    expect(
      manager.shouldProactivelyRotate('claude', 'claude-sonnet', 50, 60_000),
    ).toBe(true)
  })

  it.each([
    'sticky',
    'round-robin',
    'hybrid',
  ] as const)('selects an account with %s strategy', (strategy) => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
      now: () => 10_000,
    })
    expect(
      manager.getCurrentOrNextForFamily('gemini', 'gemini-3-pro', strategy),
    ).not.toBeNull()
  })

  it('hybrid skips the active Gemini account limited on the antigravity header style', () => {
    const now = 1_700_000_000_000
    const hybridStored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r4', projectId: 'p4', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 1,
      activeIndexByFamily: { gemini: 1 },
    }
    const memory = createStore(hybridStored)
    const manager = new AccountManager(undefined, hybridStored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    const limited = manager.getAccounts()[1]!
    manager.markRateLimitedWithReason(
      limited,
      'gemini',
      'antigravity',
      'antigravity-gemini-3.6-flash',
      'RATE_LIMIT_EXCEEDED',
    )

    const selected = manager.getCurrentOrNextForFamily(
      'gemini',
      'antigravity-gemini-3.6-flash',
      'hybrid',
      'antigravity',
    )

    expect(selected?.index).toBe(0)
  })

  it('hybrid returns null when every Gemini account is limited on the antigravity header style', () => {
    const now = 1_700_000_000_000
    const hybridStored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r3', projectId: 'p3', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r4', projectId: 'p4', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 1,
      activeIndexByFamily: { gemini: 1 },
    }
    const memory = createStore(hybridStored)
    const manager = new AccountManager(undefined, hybridStored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    for (const account of manager.getAccounts()) {
      manager.markRateLimitedWithReason(
        account,
        'gemini',
        'antigravity',
        'antigravity-gemini-3.6-flash',
        'RATE_LIMIT_EXCEEDED',
      )
    }

    const selected = manager.getCurrentOrNextForFamily(
      'gemini',
      'antigravity-gemini-3.6-flash',
      'hybrid',
      'antigravity',
    )

    expect(selected).toBeNull()
  })

  it('tracks model-specific limits independently', () => {
    let now = 1_000
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
      now: () => now,
      random: () => 0.5,
    })
    const first = manager.getAccounts()[0]!
    manager.markRateLimitedWithReason(
      first,
      'gemini',
      'antigravity',
      'gemini-3-pro',
      'RATE_LIMIT_EXCEEDED',
    )
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-pro',
      ),
    ).toBe(true)
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-flash',
      ),
    ).toBe(false)
    now += 30_001
    expect(
      manager.isRateLimitedForHeaderStyle(
        first,
        'gemini',
        'antigravity',
        'gemini-3-pro',
      ),
    ).toBe(false)
  })

  it('isolates child selection from its exact parent', () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    const select = (id: string, parentId?: string) =>
      manager.getCurrentOrNextForFamily(
        'gemini',
        null,
        'round-robin',
        'antigravity',
        false,
        100,
        600_000,
        { id, parentId },
      )?.index
    expect(select('root')).toBe(0)
    expect(select('child', 'root')).toBe(1)
  })

  it('uses destructive store mutation for replacement saves', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    manager.removeAccountByIndex(0)
    await manager.saveToDiskReplace()
    expect(memory.mutations()).toBe(1)
    expect(memory.state()?.accounts).toHaveLength(1)
  })

  it('persists and restores the cachedQuotaAccountId stamp across save→loadFromDisk', async () => {
    const seeded: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
      now: () => 1_700_000_000_000,
    })
    // Seed a cached quota for the first account — this also stamps it with
    // the opaque identity derived from `r1`.
    manager.updateQuotaCache(0, {
      gemini: { remainingFraction: 0.42, modelCount: 1 },
    })
    expect(manager.getAccounts()[0]?.cachedQuotaAccountId).toMatch(
      /^[a-f0-9]{16}$/,
    )
    const expectedStamp = manager.getAccounts()[0]?.cachedQuotaAccountId

    await manager.saveToDiskReplace()

    const persisted = memory.state()
    expect(persisted?.accounts[0]?.cachedQuota).toEqual({
      gemini: { remainingFraction: 0.42, modelCount: 1 },
    })
    expect(persisted?.accounts[0]?.cachedQuotaAccountId).toBe(expectedStamp)

    // Roundtrip: a fresh manager built from the persisted snapshot must
    // surface the same stamp on the same account (same refresh token).
    const reloaded = new AccountManager(undefined, persisted ?? undefined, {
      store: memory.store,
      now: () => 1_700_000_001_000,
    })
    expect(reloaded.getAccounts()[0]?.cachedQuotaAccountId).toBe(expectedStamp)
    // Stamp mismatch path: a roundtripped account whose stored stamp no
    // longer matches its current refresh token is dropped at projection
    // time (no quota rendered) — see `toCommandAccountRow` /
    // `updateQuotaCache`. Here we just confirm the in-memory stamp is
    // present so the projection can decide.
    const tampered: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: 'r1',
          addedAt: 1,
          lastUsed: 0,
          // Stale stamp captured for a different refresh token.
          cachedQuotaAccountId: 'deadbeefcafebabe',
          cachedQuota: { gemini: { remainingFraction: 0.42, modelCount: 1 } },
        },
      ],
      activeIndex: 0,
    }
    const tamperedMemory = createStore(tampered)
    const tamperedManager = new AccountManager(undefined, tampered, {
      store: tamperedMemory.store,
    })
    expect(tamperedManager.getAccounts()[0]?.cachedQuotaAccountId).toBe(
      'deadbeefcafebabe',
    )
    // The next legitimate update rewrites the stamp from the current
    // refresh token, so a write to the same account cannot persist the
    // stale stamp forward.
    tamperedManager.updateQuotaCache(0, {
      gemini: { remainingFraction: 0.5, modelCount: 1 },
    })
    expect(tamperedManager.getAccounts()[0]?.cachedQuotaAccountId).not.toBe(
      'deadbeefcafebabe',
    )
  })

  it('persists and restores the captured tier schema marker across save→loadFromDisk', async () => {
    const seeded = {
      version: 4,
      accounts: [
        {
          refreshToken: 'r1',
          projectId: 'p1',
          addedAt: 1,
          lastUsed: 0,
          capturedTierId: 'free-tier',
          capturedTierAt: 1_700_000_000_000,
          capturedTierSchemaVersion: 1,
        },
      ],
      activeIndex: 0,
    } as AccountStorageV4 & {
      accounts: Array<{ capturedTierSchemaVersion?: number }>
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
    })

    await manager.saveToDiskReplace()

    expect(memory.state()?.accounts[0]).toMatchObject({
      capturedTierSchemaVersion: 1,
    })
    const reloaded = new AccountManager(
      undefined,
      memory.state() ?? undefined,
      { store: memory.store },
    )
    expect(
      (reloaded.getAccounts()[0] as { capturedTierSchemaVersion?: number })
        ?.capturedTierSchemaVersion,
    ).toBe(1)
  })

  it('drops the quota write when the refresh token captured at refresh time is gone (remove-during-refresh race)', () => {
    // Race: an async quota refresh is in flight for account A while the
    // user removes account A from the pool. When the refresh resolves,
    // index 0 now points at a different account (B). Without the
    // identity check the quota would be written onto B's slot — exactly
    // the cross-account misattribution P1#3 fixes.
    const seeded: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: 'r1', projectId: 'p1', addedAt: 1, lastUsed: 0 },
        { refreshToken: 'r2', projectId: 'p2', addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }
    const memory = createStore(seeded)
    const manager = new AccountManager(undefined, seeded, {
      store: memory.store,
    })

    // Capture the refresh token BEFORE the (simulated) async refresh
    // resolves. The caller is expected to pass this as
    // `expectedRefreshToken` so the write is bound to the right account.
    const refreshTokenForA = manager.getAccounts()[0]?.parts.refreshToken
    expect(refreshTokenForA).toBe('r1')

    // Concurrent user action: remove account A. Account B (r2) now sits
    // at index 0.
    expect(manager.removeAccountByIndex(0)).toBe(true)
    expect(manager.getAccounts()[0]?.parts.refreshToken).toBe('r2')

    // The async refresh finally resolves. The caller re-resolves the
    // live index for `r1` (which is now `-1`) and the quota write is
    // then attempted via `updateQuotaCache` at index 0 with the
    // captured `expectedRefreshToken`. The guard MUST drop the write
    // because the captured token no longer matches the account at
    // index 0 — B would otherwise receive A's quota percentages.
    const liveIndex = manager
      .getAccounts()
      .findIndex((entry) => entry.parts.refreshToken === refreshTokenForA)
    expect(liveIndex).toBe(-1)
    manager.updateQuotaCache(
      0,
      { gemini: { remainingFraction: 0.42, modelCount: 1 } },
      refreshTokenForA,
    )
    // No quota should have landed on whichever account shifted into
    // index 0.
    expect(manager.getAccounts()[0]?.cachedQuota).toBeUndefined()
    expect(manager.getAccounts()[0]?.cachedQuotaAccountId).toBeUndefined()
  })

  it('coalesces requested saves and dispose flushes immediately', async () => {
    const memory = createStore(stored)
    const manager = new AccountManager(undefined, stored, {
      store: memory.store,
    })
    manager.requestSaveToDisk()
    manager.requestSaveToDisk()
    await manager.dispose()
    expect(memory.mergedSaves()).toBe(1)
  })
})

describe('AccountManager instance dependencies', () => {
  it('keeps injected clocks isolated between manager instances', () => {
    const firstMemory = createStore(stored)
    const secondMemory = createStore(stored)
    const first = new AccountManager(undefined, stored, {
      store: firstMemory.store,
      now: () => 1_000,
    })
    const second = new AccountManager(undefined, stored, {
      store: secondMemory.store,
      now: () => 9_000,
    })

    first.markAccountCoolingDown(first.getAccounts()[0]!, 500, 'auth-failure')
    second.markAccountCoolingDown(second.getAccounts()[0]!, 500, 'auth-failure')

    expect(first.getAccounts()[0]?.coolingDownUntil).toBe(1_500)
    expect(second.getAccounts()[0]?.coolingDownUntil).toBe(9_500)
  })
})

describe('managedProjectId projection', () => {
  it('getAccountsForQuotaCheck falls back to record managedProjectId when parts lack it', () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: 'test@example.com',
          refreshToken: 'bare-refresh-token',
          projectId: 'my-project',
          managedProjectId: 'my-managed-project',
          addedAt: 1_000,
          lastUsed: 2_000,
        },
      ],
      activeIndex: 0,
    }
    const manager = new AccountManager(undefined, stored, {
      store: createStore(stored).store,
      now: () => 1_000,
    })
    // Simulate a bare-token rotation that strips managedProjectId from
    // parts — the record-level field is the only remaining source.
    const allAccounts = manager.getAccounts()
    allAccounts[0]!.parts.managedProjectId = undefined

    const accounts = manager.getAccountsForQuotaCheck()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.projectId).toBe('my-project')
    expect(accounts[0]!.managedProjectId).toBe('my-managed-project')
  })

  it('save→reload round-trip preserves managedProjectId from the record', async () => {
    const { store, state } = createStore(null)
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: 'test@example.com',
          refreshToken: 'bare-refresh-token',
          projectId: 'my-project',
          managedProjectId: 'my-managed-project',
          addedAt: 1_000,
          lastUsed: 2_000,
        },
      ],
      activeIndex: 0,
    }
    const manager = new AccountManager(undefined, stored, {
      store,
      now: () => 1_000,
    })
    // Trigger a save — dispose clears the debounce and forces it immediately.
    manager.requestSaveToDisk()
    await manager.dispose()
    const saved = state()
    expect(saved?.accounts[0]?.managedProjectId).toBe('my-managed-project')

    // Reload and verify getAccountsForQuotaCheck still returns it.
    const manager2 = new AccountManager(undefined, saved, {
      store,
      now: () => 1_000,
    })
    const accounts = manager2.getAccountsForQuotaCheck()
    expect(accounts[0]!.managedProjectId).toBe('my-managed-project')
  })
})

// ---------------------------------------------------------------------------
// Repository-backed manager
//
// These check which attributed repository operation each manager change
// becomes. The repository below only records calls; the repository's own
// behaviour on the real store is covered by account-repository.test.ts.
// ---------------------------------------------------------------------------

type RecordedCall = { method: string; args: readonly unknown[] }

function recordingRepository(rows: AccountRow[], routing?: RoutingSettings) {
  const calls: RecordedCall[] = []
  const metadataWrites: Array<{ ref: RowRef; mutator: MetadataMutator }> = []
  const fingerprintWrites: Array<{
    ref: RowRef
    observation: FingerprintObservation
  }> = []
  let flushReport: AccountFlushReport = { completed: 0, failures: [] }
  let refreshOutcome: AccountRefreshOutcome | undefined
  let currentRows = rows
  const notUsed = (method: string) => async (): Promise<never> => {
    throw new Error(`the manager does not call ${method} in these tests`)
  }
  const repository: AccountRepository = {
    read: async () => ({
      status: 'ready',
      rows: currentRows,
      ...(routing !== undefined ? { routing } : {}),
    }),
    settled: async () => {},
    login: notUsed('login'),
    replaceCredential: notUsed('replaceCredential'),
    refresh: async (ref, options) => {
      calls.push({ method: 'refresh', args: [ref, options] })
      if (refreshOutcome === undefined)
        throw new Error('no refresh outcome set')
      return refreshOutcome
    },
    recordIdentity: notUsed('recordIdentity'),
    setEnabled: async (ref, input) => {
      calls.push({ method: 'setEnabled', args: [ref, input] })
      return { ref }
    },
    recordAccessVerdict: async (ref, verdict) => {
      calls.push({ method: 'recordAccessVerdict', args: [ref, verdict] })
      return { ref }
    },
    updateMetadata: async (ref, mutator) => {
      calls.push({ method: 'updateMetadata', args: [ref] })
      metadataWrites.push({ ref, mutator })
      return { ref, outcome: 'updated' }
    },
    recordProject: async (ref, observation) => {
      calls.push({ method: 'recordProject', args: [ref, observation] })
      return { ref, outcome: 'updated' }
    },
    recordFingerprint: async (ref, observation) => {
      calls.push({ method: 'recordFingerprint', args: [ref] })
      fingerprintWrites.push({ ref, observation })
      return { ref, outcome: 'updated' }
    },
    recordTier: notUsed('recordTier'),
    recordCooldown: notUsed('recordCooldown'),
    recordRateLimits: notUsed('recordRateLimits'),
    recordSwitch: notUsed('recordSwitch'),
    recordUsage: async (ref, observation) => {
      calls.push({ method: 'recordUsage', args: [ref, observation] })
      return {
        ref,
        lastUsed: observation.at,
        dailyRequestCounts: { date: '2026-10-07', claude: 0, gemini: 0 },
      }
    },
    recordQuota: async (ref, observation) => {
      calls.push({ method: 'recordQuota', args: [ref, observation] })
    },
    selectAccount: async (target, row) => {
      calls.push({ method: 'selectAccount', args: [target, row] })
    },
    reorder: notUsed('reorder'),
    remove: async (ref) => {
      calls.push({ method: 'remove', args: [ref] })
    },
    clear: notUsed('clear'),
    replacePool: notUsed('replacePool'),
    flush: async () => {
      calls.push({ method: 'flush', args: [] })
      return flushReport
    },
    dispose: async () => {
      calls.push({ method: 'dispose', args: [] })
      return flushReport
    },
  }
  return {
    repository,
    metadataWrites,
    fingerprintWrites,
    calls: (method?: string) =>
      method === undefined
        ? calls
        : calls.filter((call) => call.method === method),
    setFlushReport: (report: AccountFlushReport) => {
      flushReport = report
    },
    setRefreshOutcome: (outcome: AccountRefreshOutcome) => {
      refreshOutcome = outcome
    },
    setRows: (next: AccountRow[]) => {
      currentRows = next
    },
  }
}

const testFingerprint = {
  deviceId: 'device-1',
  sessionToken: 'session-1',
  userAgent: 'antigravity-cli/test',
  apiClient: 'antigravity-cli',
  clientMetadata: { ideType: 'IDE', platform: 'darwin', pluginType: 'GEMINI' },
  createdAt: 1,
}

/** A routable repository row (bound, usable, metadata shown) unless overridden. */
function repositoryRow(
  ref: RowRef,
  index: number,
  overrides: Partial<AccountRow> = {},
): AccountRow {
  return {
    ref,
    index,
    enabled: true,
    credential: { refreshToken: `tok-${ref.id}` },
    usable: true,
    stamp: 'bound',
    metadata: {
      status: 'present',
      metadata: {
        addedAt: 10,
        lastUsed: 20,
        projectId: `proj-${ref.id}`,
        fingerprint: testFingerprint,
      },
    },
    quota: { status: 'absent' },
    ...overrides,
  }
}

const refA: RowRef = { id: 'a', credentialEpoch: 2, identity: 'acct-a' }
const refB: RowRef = { id: 'b', credentialEpoch: 1 }
const refC: RowRef = { id: 'c', credentialEpoch: 1 }
const refD: RowRef = { id: 'd', credentialEpoch: 3 }

/**
 * One row per load path: routable (`a`), metadata not shown (`b`), torn (`c`)
 * and without metadata (`d`); the stored selection names `d` for gemini.
 */
function repositoryFixture() {
  const recording = recordingRepository(
    [
      repositoryRow(refA, 0),
      repositoryRow(refB, 1, {
        metadata: { status: 'dropped', reason: 'uncovered' },
      }),
      repositoryRow(refC, 2, { torn: true }),
      repositoryRow(refD, 3, { metadata: { status: 'absent' } }),
    ],
    {
      schemaVersion: 1,
      activeIndex: 0,
      activeRowByFamily: { gemini: refD },
    },
  )
  const diagnostics: Array<{
    message: string
    fields?: Record<string, unknown>
  }> = []
  return {
    ...recording,
    diagnostics,
    load: async () =>
      AccountManager.fromRepository(await recording.repository.read(), {
        repository: recording.repository,
        now: () => Date.UTC(2026, 9, 7, 12),
        onDiagnostic: (message, fields) =>
          diagnostics.push({ message, fields }),
      }),
  }
}

describe('repository-backed AccountManager', () => {
  it('needs exactly one of a pool-file store and a repository', () => {
    const { repository } = recordingRepository([])
    expect(() => new AccountManager(undefined, null, {})).toThrow('exactly one')
    expect(
      () =>
        new AccountManager(undefined, null, {
          repository,
          store: createStore().store,
        }),
    ).toThrow('exactly one')
  })

  it('loads routable rows with their refs and follows the stored selection refs', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    const accounts = manager.getAccounts()
    expect(accounts.map((account) => account.ref)).toEqual([refA, refD])
    expect(accounts[0]?.projectId).toBe('proj-a')
    expect(accounts[0]?.parts.refreshToken).toBe('tok-a')
    expect(manager.getCurrentAccountForFamily('gemini')?.ref).toEqual(refD)
    expect(manager.getCurrentAccountForFamily('claude')?.ref).toEqual(refA)
    expect(
      fixture.diagnostics
        .filter((d) => d.message.startsWith('Skipped'))
        .map((d) => d.fields?.rowId),
    ).toEqual(['b', 'c'])
    // A generated fingerprint (the row had none) and one brought to the
    // runtime user agent are recorded, as the pool-file loader saved them.
    const fingerprints = fixture.fingerprintWrites
    expect(fingerprints.map((write) => write.ref)).toEqual([refD, refA])
    const updated = fingerprints[1]?.observation
    expect(updated?.fingerprint.userAgent).toBe(
      accounts[0]?.fingerprint?.userAgent ?? 'missing',
    )
    expect(updated?.fingerprint.userAgent).not.toBe(testFingerprint.userAgent)
  })

  it('records every request as its own increment, never coalesced', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    manager.recordRequest(0, 'claude')
    manager.recordRequest(0, 'claude')
    manager.recordRequest(1, 'gemini')
    await manager.flushSaveToDisk()
    expect(fixture.calls('recordUsage').map((call) => call.args)).toEqual([
      [refA, { family: 'claude', at: Date.UTC(2026, 9, 7, 12) }],
      [refA, { family: 'claude', at: Date.UTC(2026, 9, 7, 12) }],
      [refD, { family: 'gemini', at: Date.UTC(2026, 9, 7, 12) }],
    ])
    await manager.dispose()
  })

  it('coalesces absolute state into one attributed write per row', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    const now = Date.UTC(2026, 9, 7, 12)
    const account = manager.getAccounts()[0]
    if (account === undefined) throw new Error('no account')
    manager.markRateLimited(account, 1_000, 'claude')
    manager.markRateLimited(account, 5_000, 'claude')
    manager.markRateLimited(account, 2_000, 'gemini', 'gemini-cli')
    manager.markAccountCoolingDown(account, 3_000, 'network-error')
    manager.markSwitched(account, 'rate-limit', 'gemini')
    await manager.flushSaveToDisk()

    const writes = fixture.metadataWrites
    expect(writes).toHaveLength(1)
    expect(writes[0]?.ref).toEqual(refA)
    const mutator = writes[0]?.mutator
    if (mutator === undefined) throw new Error('no metadata write')
    const stored: ProviderMetadata = {
      addedAt: 10,
      lastUsed: 20,
      rateLimitResetTimes: { claude: now + 9_000, other: 1 },
      label: 'kept',
    }
    const update = await mutator(stored, repositoryRow(refA, 0))
    expect(update).toEqual({
      kind: 'set',
      metadata: {
        addedAt: 10,
        lastUsed: 20,
        label: 'kept',
        // The stored later reset wins over this process's earlier one.
        rateLimitResetTimes: {
          claude: now + 9_000,
          other: 1,
          'gemini-cli': now + 2_000,
        },
        coolingDownUntil: now + 3_000,
        cooldownReason: 'network-error',
        lastSwitchReason: 'rate-limit',
      },
    })
    expect(fixture.calls('selectAccount').map((call) => call.args)).toEqual([
      ['gemini', refA],
    ])
    // Nothing went through a pool-file snapshot.
    expect(fixture.calls('flush').length).toBeGreaterThan(0)
  })

  it('removes by ref and drops writes still queued for the removed account', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    const account = manager.getAccounts()[0]
    if (account === undefined) throw new Error('no account')
    manager.markRateLimited(account, 1_000, 'claude')
    expect(manager.removeAccount(account)).toBe(true)
    await manager.saveToDiskReplace()
    expect(fixture.calls('remove').map((call) => call.args)).toEqual([[refA]])
    expect(fixture.calls('updateMetadata')).toHaveLength(0)
  })

  it('records access verdicts as one transition instead of a separate disable', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    manager.markAccountIneligible(0, 'blocked')
    manager.clearAccountAccessBlocks(0, true)
    await manager.flushSaveToDisk()
    expect(fixture.calls('setEnabled')).toHaveLength(0)
    expect(
      fixture.calls('recordAccessVerdict').map((call) => call.args),
    ).toEqual([
      [
        refA,
        {
          kind: 'ineligible',
          observedAt: Date.UTC(2026, 9, 7, 12),
          reason: 'blocked',
        },
      ],
      [
        refA,
        { kind: 'cleared', observedAt: Date.UTC(2026, 9, 7, 12), enable: true },
      ],
    ])
    expect(manager.getAccounts()[0]?.enabled).toBe(true)
    manager.setAccountEnabled(0, false)
    await manager.flushSaveToDisk()
    expect(fixture.calls('setEnabled').map((call) => call.args)).toEqual([
      [refA, { enabled: false, actor: 'user' }],
    ])
  })

  it('fails a flush on a write failure but tolerates refusals of stale credentials', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    const stale = {
      operation: 'recordUsage' as const,
      kind: 'attribution' as const,
      retryable: true,
      ambiguous: false,
      rowId: 'a',
      message: 'stale',
    }
    fixture.setFlushReport({ completed: 0, failures: [stale] })
    await manager.flushSaveToDisk()
    const broken = {
      ...stale,
      kind: 'load-error' as const,
      message: 'state file unreadable',
    }
    fixture.setFlushReport({ completed: 0, failures: [stale, broken] })
    const error = await manager.flushSaveToDisk().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(AccountManagerPersistError)
    expect(
      error instanceof AccountManagerPersistError && error.failure,
    ).toEqual(broken)
    expect(
      error instanceof AccountManagerPersistError && error.report.failures,
    ).toEqual([stale, broken])
    await expect(manager.dispose()).rejects.toBeInstanceOf(
      AccountManagerPersistError,
    )
  })

  it('takes a refreshed credential only from the repository', async () => {
    const fixture = repositoryFixture()
    const manager = await fixture.load()
    const account = manager.getAccounts()[0]
    if (account === undefined) throw new Error('no account')
    const learnt: RowRef = { ...refA }
    fixture.setRefreshOutcome({
      status: 'rotated',
      ref: learnt,
      accessToken: 'access-new',
      expiresAt: 99,
    })
    fixture.setRows([
      repositoryRow(learnt, 0, {
        credential: { refreshToken: 'tok-a-next', accessToken: 'access-new' },
      }),
    ])
    const outcome = await manager.refreshAccount(account)
    expect(outcome.status).toBe('rotated')
    expect(fixture.calls('refresh')[0]?.args[0]).toEqual(refA)
    expect(account.access).toBe('access-new')
    expect(account.expires).toBe(99)
    expect(account.parts.refreshToken).toBe('tok-a-next')

    fixture.setRefreshOutcome({
      status: 'identity-contradicted',
      ref: learnt,
      expectedIdentity: 'acct-a',
      returnedIdentity: 'acct-z',
    })
    await manager.refreshAccount(account)
    expect(account.enabled).toBe(false)
    expect(account.access).toBeUndefined()
  })
})

describe('reloading a repository-backed AccountManager', () => {
  const now = Date.UTC(2026, 9, 7, 12)
  const refA: RowRef = { id: 'a', credentialEpoch: 1, identity: 'acct-a' }
  const refB: RowRef = { id: 'b', credentialEpoch: 1, identity: 'acct-b' }
  const refC: RowRef = { id: 'c', credentialEpoch: 1 }
  const session = { id: 'session-1' }

  /** A manager over rows a, b, c, with its own trackers. */
  async function loaded() {
    const recording = recordingRepository([
      repositoryRow(refA, 0),
      repositoryRow(refB, 1),
      repositoryRow(refC, 2),
    ])
    const diagnostics: string[] = []
    const manager = AccountManager.fromRepository(
      await recording.repository.read(),
      {
        repository: recording.repository,
        now: () => now,
        onDiagnostic: (message) => diagnostics.push(message),
      },
    )
    const [a, b, c] = manager.getAccounts()
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('three accounts expected')
    }
    return { recording, manager, diagnostics, a, b, c }
  }

  function rows(
    ...entries: Array<[RowRef, Partial<AccountRow>?]>
  ): AccountRepositoryRead {
    return {
      status: 'ready',
      rows: entries.map(([ref, overrides], index) =>
        repositoryRow(ref, index, overrides),
      ),
    }
  }

  it('keeps the same accounts, their pins, selection and health across a reorder', async () => {
    const { manager, a, b, c } = await loaded()
    const bRef = b.ref
    manager.markSwitched(b, 'rotation', 'claude', session)
    manager.markTouchedForQuota(b, 'claude')
    manager.healthTracker.recordFailure(b.index)
    const bScore = manager.healthTracker.getScore(b.index)
    const untouched = manager.healthTracker.getScore(a.index)
    expect(bScore).not.toBe(untouched)

    manager.reloadFromRepository(rows([refC], [refA], [refB]))

    expect(manager.getAccounts()).toEqual([c, a, b])
    expect(manager.getAccounts()[2]).toBe(b)
    expect(b.index).toBe(2)
    expect(b.ref).toBe(bRef)
    expect(manager.getCurrentAccountForFamily('claude', session)).toBe(b)
    expect(manager.getCurrentAccountForFamily('claude')).toBe(b)
    expect(b.touchedForQuota.claude).toBe(now)
    expect(manager.healthTracker.getScore(2)).toBe(bScore)
    expect(manager.healthTracker.getScore(1)).toBe(untouched)
  })

  it('refreshes unchanged accounts from the read, keeping newer evidence held here', async () => {
    const { manager, a } = await loaded()
    // This manager holds a tier captured after the one the read will show.
    manager.applyUpdatedAccount(0, {
      capturedTierId: 'local-tier',
      capturedTierAt: 300,
    })
    manager.reloadFromRepository(
      rows(
        [
          refA,
          {
            metadata: {
              status: 'present',
              metadata: {
                addedAt: 10,
                lastUsed: 20,
                email: 'renamed@example.test',
                capturedTierId: 'stored-tier',
                capturedTierAt: 200,
                fingerprint: testFingerprint,
              },
            },
            quota: {
              status: 'present',
              quota: {
                schemaVersion: 1,
                cachedQuota: {
                  gemini: { modelCount: 1, remainingFraction: 0.25 },
                },
                cachedQuotaUpdatedAt: 500,
              },
            },
          },
        ],
        [refB],
        [refC],
      ),
    )
    expect(manager.getAccounts()[0]).toBe(a)
    expect(a.email).toBe('renamed@example.test')
    expect(a.capturedTierId).toBe('local-tier')
    expect(a.cachedQuotaUpdatedAt).toBe(500)
    expect(a.cachedQuota?.gemini?.remainingFraction).toBe(0.25)
  })

  it('drops replaced and removed accounts with their pins and queued writes', async () => {
    const { recording, manager, b, c } = await loaded()
    manager.markSwitched(b, 'rotation', 'claude', session)
    manager.markRateLimited(c, 1_000, 'claude')
    const replacedB: RowRef = { ...refB, credentialEpoch: 2 }

    manager.reloadFromRepository(rows([refA], [replacedB]))

    const accounts = manager.getAccounts()
    expect(accounts.map((account) => account.ref)).toEqual([refA, replacedB])
    expect(accounts[1]).not.toBe(b)
    // The old object keeps the ref its writes were decided for.
    expect(b.ref).toEqual(refB)
    expect(manager.getCurrentAccountForFamily('claude', session)).toBeNull()
    await manager.flushSaveToDisk()
    expect(
      recording.metadataWrites.filter((write) => write.ref.id === 'c'),
    ).toEqual([])
  })

  it('sends no write about an account that left at a reload', async () => {
    const { recording, manager, diagnostics, b } = await loaded()
    manager.reloadFromRepository(
      rows([refA], [{ ...refB, credentialEpoch: 2 }], [refC]),
    )
    // Calls made before this point include the load's own writes.
    const callsBefore = recording.calls().length
    manager.markRateLimited(b, 1_000, 'claude')
    manager.markAccountCoolingDown(b, 1_000, 'network-error')
    manager.markSwitched(b, 'rate-limit', 'gemini')
    expect(manager.removeAccount(b)).toBe(false)
    await manager.flushSaveToDisk()
    const aboutOldB = recording
      .calls()
      .slice(callsBefore)
      .filter(
        (call) =>
          call.args[0] !== null &&
          typeof call.args[0] === 'object' &&
          'credentialEpoch' in call.args[0] &&
          call.args[0].credentialEpoch === 1 &&
          'id' in call.args[0] &&
          call.args[0].id === 'b',
      )
    expect(aboutOldB).toEqual([])
    expect(
      recording.metadataWrites.filter((write) => write.ref.id === 'b'),
    ).toEqual([])
    expect(
      diagnostics.filter((message) => message.includes('ignored')),
    ).toHaveLength(3)
  })

  it('admits a new or replaced credential as a new account writing under its own ref', async () => {
    const { recording, manager } = await loaded()
    const replacedB: RowRef = { ...refB, credentialEpoch: 2 }
    const refD: RowRef = { id: 'd', credentialEpoch: 1, identity: 'acct-d' }
    manager.reloadFromRepository(rows([refA], [replacedB], [refC], [refD]))
    const newB = manager.getAccounts()[1]
    if (newB === undefined) throw new Error('no account at 1')
    manager.markRateLimited(newB, 1_000, 'claude')
    manager.recordRequest(3, 'gemini')
    await manager.flushSaveToDisk()
    expect(recording.metadataWrites.map((write) => write.ref)).toEqual([
      replacedB,
    ])
    expect(recording.calls('recordUsage').map((call) => call.args[0])).toEqual([
      refD,
    ])
    // Their fingerprints are recorded under their own refs, as at load.
    expect(
      recording.fingerprintWrites.slice(-2).map((write) => write.ref),
    ).toEqual([replacedB, refD])
  })

  it("reindexes only its own trackers, never another manager's", async () => {
    const first = await loaded()
    const now2 = () => now
    const secondHealth = new HealthScoreTracker({}, now2)
    const secondTokens = new TokenBucketTracker({}, now2)
    const otherRecording = recordingRepository([
      repositoryRow({ id: 'x', credentialEpoch: 1 }, 0),
      repositoryRow({ id: 'y', credentialEpoch: 1 }, 1),
    ])
    const second = AccountManager.fromRepository(
      await otherRecording.repository.read(),
      {
        repository: otherRecording.repository,
        now: () => now,
        healthTracker: secondHealth,
        tokenTracker: secondTokens,
      },
    )
    // Both managers hold state at the same indexes.
    first.manager.healthTracker.recordFailure(0)
    first.manager.tokenTracker.consume(0, 7)
    second.healthTracker.recordFailure(0)
    second.healthTracker.recordFailure(0)
    second.tokenTracker.consume(0, 3)
    const secondPinned = second.getAccounts()[0]
    if (secondPinned === undefined) throw new Error('no account x')
    second.markSwitched(secondPinned, 'rotation', 'gemini', session)
    const secondScore = second.healthTracker.getScore(0)
    const secondTokensLeft = second.tokenTracker.getTokens(0)
    const firstScore = first.manager.healthTracker.getScore(0)
    const firstTokensLeft = first.manager.tokenTracker.getTokens(0)

    // Reordering the first manager moves its account 0 (a) to 1.
    first.manager.reloadFromRepository(rows([refC], [refA], [refB]))

    expect(first.manager.healthTracker.getScore(1)).toBe(firstScore)
    expect(first.manager.tokenTracker.getTokens(1)).toBe(firstTokensLeft)
    expect(second.healthTracker.getScore(0)).toBe(secondScore)
    expect(second.healthTracker.getConsecutiveFailures(0)).toBe(2)
    expect(second.tokenTracker.getTokens(0)).toBe(secondTokensLeft)
    expect(second.getCurrentAccountForFamily('gemini', session)).toBe(
      secondPinned,
    )
    // The second manager selects with the trackers it was given.
    expect(second.healthTracker).toBe(secondHealth)
    expect(second.tokenTracker).toBe(secondTokens)
    expect(first.manager.healthTracker).not.toBe(secondHealth)
  })

  it('refreshes from the repository one call at a time, in call order', async () => {
    const { recording, manager } = await loaded()
    const older = rows([refA], [refB], [refC])
    const newer = rows([refC], [refB])
    // The first read is held until after the second call starts, so an
    // unordered refresh would apply the older read last.
    let releaseOlder: () => void = () => {}
    const olderReady = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const reads: Array<() => Promise<AccountRepositoryRead>> = [
      async () => {
        await olderReady
        return older
      },
      async () => newer,
    ]
    recording.repository.read = () => {
      const next = reads.shift()
      if (next === undefined) throw new Error('unexpected read')
      return next()
    }
    const first = manager.refreshFromRepository()
    const second = manager.refreshFromRepository()
    releaseOlder()
    await Promise.all([first, second])
    expect(manager.getAccounts().map((account) => account.ref)).toEqual([
      refC,
      refB,
    ])
    expect(reads).toEqual([])
  })

  it('selects with its own health tracker', async () => {
    const recording = recordingRepository([
      repositoryRow(refA, 0),
      repositoryRow(refB, 1),
    ])
    const healthTracker = new HealthScoreTracker(
      { failurePenalty: -60 },
      () => now,
    )
    const manager = AccountManager.fromRepository(
      await recording.repository.read(),
      { repository: recording.repository, now: () => now, healthTracker },
    )
    // The selected account (a, at index 0) is unhealthy only in this
    // manager's tracker, so hybrid selection moves to b.
    healthTracker.recordFailure(0)
    const selected = manager.getCurrentOrNextForFamily('claude', null, 'hybrid')
    expect(selected?.ref).toEqual(refB)
  })

  it('refuses a read that is not ready and keeps its accounts', async () => {
    const { manager, a, b, c } = await loaded()
    expect(() =>
      manager.reloadFromRepository({ status: 'pending-migration' }),
    ).toThrow('not ready')
    expect(manager.getAccounts()).toEqual([a, b, c])
  })
})
