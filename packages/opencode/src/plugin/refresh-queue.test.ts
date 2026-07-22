import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { AccountManager } from './accounts'
import { ProactiveRefreshQueue } from './refresh-queue'
import type { AccountStorageV4 } from './storage'
import type { OAuthAuthDetails, PluginClient } from './types'

// Mock PluginClient
const mockClient: PluginClient = {
  toast: mock(),
  auth: {
    get: mock(),
    set: mock(),
    remove: mock(),
  },
} as unknown as PluginClient

describe('ProactiveRefreshQueue', () => {
  beforeEach(() => {
    jest.useRealTimers()
  })

  describe('getAccountsNeedingRefresh', () => {
    it('skips disabled accounts', () => {
      const now = Date.now()
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: 'r1',
            projectId: 'p1',
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
          {
            refreshToken: 'r2',
            projectId: 'p2',
            addedAt: now,
            lastUsed: 0,
            enabled: false, // disabled account
          },
          {
            refreshToken: 'r3',
            projectId: 'p3',
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      }

      const manager = new AccountManager(undefined, stored)
      const queue = new ProactiveRefreshQueue(mockClient, 'test-provider', {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      })
      queue.setAccountManager(manager)

      // Set all accounts to expire soon (within buffer)
      const accounts = manager.getAccounts()
      const expiringSoon = now + 1000 * 60 * 10 // 10 minutes from now
      accounts.forEach((acc) => {
        acc.expires = expiringSoon
      })

      const needsRefresh = queue.getAccountsNeedingRefresh()

      // Should only include enabled accounts (indices 0 and 2)
      expect(needsRefresh.length).toBe(2)
      expect(needsRefresh.map((a) => a.index)).toEqual([0, 2])
      expect(needsRefresh.every((a) => a.enabled !== false)).toBe(true)
    })

    it('includes accounts with undefined enabled (default to enabled)', () => {
      const now = Date.now()
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: 'r1',
            projectId: 'p1',
            addedAt: now,
            lastUsed: 0,
            // enabled is undefined - should be treated as enabled
          },
        ],
        activeIndex: 0,
      }

      const manager = new AccountManager(undefined, stored)
      const queue = new ProactiveRefreshQueue(mockClient, 'test-provider', {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      })
      queue.setAccountManager(manager)

      // Set account to expire soon
      const accounts = manager.getAccounts()
      accounts[0]!.expires = now + 1000 * 60 * 10 // 10 minutes from now

      const needsRefresh = queue.getAccountsNeedingRefresh()

      expect(needsRefresh.length).toBe(1)
      expect(needsRefresh[0]!.index).toBe(0)
    })

    it('skips expired accounts', () => {
      const now = Date.now()
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: 'r1',
            projectId: 'p1',
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      }

      const manager = new AccountManager(undefined, stored)
      const queue = new ProactiveRefreshQueue(mockClient, 'test-provider', {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      })
      queue.setAccountManager(manager)

      // Set account to already expired
      const accounts = manager.getAccounts()
      accounts[0]!.expires = now - 1000 // 1 second ago

      const needsRefresh = queue.getAccountsNeedingRefresh()

      expect(needsRefresh.length).toBe(0)
    })

    it("skips accounts that don't need refresh yet", () => {
      const now = Date.now()
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: 'r1',
            projectId: 'p1',
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      }

      const manager = new AccountManager(undefined, stored)
      const queue = new ProactiveRefreshQueue(mockClient, 'test-provider', {
        enabled: true,
        bufferSeconds: 1800, // 30 minutes
        checkIntervalSeconds: 300,
      })
      queue.setAccountManager(manager)

      // Set account to expire in 1 hour (outside 30 min buffer)
      const accounts = manager.getAccounts()
      accounts[0]!.expires = now + 1000 * 60 * 60 // 1 hour from now

      const needsRefresh = queue.getAccountsNeedingRefresh()

      expect(needsRefresh.length).toBe(0)
    })
  })
})

describe('ProactiveRefreshQueue disposal', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('waits for an in-flight refresh before resolving', async () => {
    jest.useFakeTimers()
    const now = Date.now()
    const manager = new AccountManager(undefined, {
      version: 4,
      accounts: [
        {
          refreshToken: 'refresh-token',
          projectId: 'project-id',
          addedAt: now,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    })
    manager.getAccounts()[0]!.expires = now + 60_000
    const events: string[] = []
    let resolveRefresh!: (auth: {
      type: 'oauth'
      refresh: string
      access: string
      expires: number
    }) => void
    const refreshResult = new Promise<{
      type: 'oauth'
      refresh: string
      access: string
      expires: number
    }>((resolve) => {
      resolveRefresh = resolve
    })
    const queue = new ProactiveRefreshQueue(mockClient, 'test-provider', {
      enabled: true,
      bufferSeconds: 1800,
      checkIntervalSeconds: 300,
    })
    queue.setAccountManager(manager)
    ;(
      queue as unknown as {
        refreshToken: () => Promise<OAuthAuthDetails | undefined>
      }
    ).refreshToken = mock(async () => {
      events.push('refresh:started')
      return refreshResult
    })
    manager.updateFromAuth = mock(() => {
      events.push('manager:update')
    })
    manager.saveToDisk = mock(async () => {
      events.push('manager:save')
    })

    queue.start()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()
    const disposal = Promise.resolve(queue.dispose()).then(() => {
      events.push('queue:disposed-returned')
    })
    await Promise.resolve()

    expect(events).toEqual(['refresh:started'])

    events.push('refresh:resolved')
    resolveRefresh({
      type: 'oauth',
      refresh: 'refresh-token|project-id',
      access: 'new-access-token',
      expires: now + 3_600_000,
    })
    await disposal

    expect(events).toEqual([
      'refresh:started',
      'refresh:resolved',
      'manager:update',
      'manager:save',
      'queue:disposed-returned',
    ])
    expect(jest.getTimerCount()).toBe(0)
  })
})
