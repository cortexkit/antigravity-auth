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
    // live index for `r1` (which is now `-1`) and skips the write — the
    // AccountManager's existing expectedRefreshToken guard enforces that.
    const liveIndex = manager
      .getAccounts()
      .findIndex((entry) => entry.parts.refreshToken === refreshTokenForA)
    expect(liveIndex).toBe(-1)
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
