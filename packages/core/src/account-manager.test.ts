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
