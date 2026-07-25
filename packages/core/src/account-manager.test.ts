import { describe, expect, it } from 'bun:test'
import { AccountManager } from './account-manager.ts'
import type { AccountStorageStore } from './account-storage.ts'
import type { AccountStorageV4 } from './account-types.ts'

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
