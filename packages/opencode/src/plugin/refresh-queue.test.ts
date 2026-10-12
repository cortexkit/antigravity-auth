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
import type { Logger } from './logger'
import {
  createLocationProactiveRefreshQueue,
  ProactiveRefreshQueue,
} from './refresh-queue'
import type { AccountStorageV4 } from './storage'
import type { OAuthAuthDetails, PluginClient } from './types'

const nextRealTurn = setImmediate

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
      expect(needsRefresh[0]?.index).toBe(0)
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

describe('location refresh queue', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('refreshes and logs only through the location’s own collaborators', async () => {
    jest.useFakeTimers()
    const now = Date.now()
    const manager = new AccountManager(undefined, {
      version: 4,
      accounts: [
        {
          refreshToken: 'fake-refresh',
          projectId: 'fake-project',
          addedAt: now,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    })
    manager.getAccounts()[0]!.expires = now + 60_000
    manager.saveToDisk = mock(async () => {})
    const refreshed: string[] = []
    const messages: string[] = []
    const logger: Logger = {
      debug: (message) => void messages.push(message),
      info: (message) => void messages.push(message),
      warn: (message) => void messages.push(message),
      error: (message) => void messages.push(message),
    }
    const queue = createLocationProactiveRefreshQueue(
      {
        logger,
        refreshToken: async (auth) => {
          refreshed.push(auth.refresh)
          return {
            type: 'oauth',
            refresh: auth.refresh,
            access: 'fake-access',
            expires: now + 3_600_000,
          }
        },
      },
      { enabled: true, bufferSeconds: 1800, checkIntervalSeconds: 300 },
    )
    queue.setAccountManager(manager)
    queue.start()
    jest.advanceTimersByTime(5000)
    await queue.dispose()

    expect(refreshed).toEqual(['fake-refresh|fake-project'])
    expect(messages).toContain('Proactively refreshing token')
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    expect(queue.getStats().refreshCount).toBe(1)
  })

  it('refuses to build without a logger and token refresher', () => {
    expect(() =>
      createLocationProactiveRefreshQueue({
        logger: undefined as unknown as Logger,
        refreshToken: async () => undefined,
      }),
    ).toThrow('requires a logger and refreshToken')
    expect(
      () => new ProactiveRefreshQueue(null, 'test-provider', { enabled: true }),
    ).toThrow('host client or explicit dependencies')
  })
})

it('finishes an admitted refresh and saves its successor but admits no second account after enrollment', async () => {
  jest.useFakeTimers()
  const now = Date.now()
  const manager = new AccountManager(undefined, {
    version: 4,
    accounts: [0, 1].map((index) => ({
      refreshToken: `synthetic-refresh-${index}`,
      projectId: `synthetic-project-${index}`,
      addedAt: now,
      lastUsed: 0,
      enabled: true,
    })),
    activeIndex: 0,
  })
  const accounts = manager.getAccounts()
  accounts.forEach((account) => {
    account.expires = now + 10000
  })
  let mayRun = true
  let signalStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  let finishRefresh: (auth: OAuthAuthDetails) => void = () => {}
  const answer = new Promise<OAuthAuthDetails>((resolve) => {
    finishRefresh = resolve
  })
  const calls: number[] = []
  const updates: OAuthAuthDetails[] = []
  let saves = 0
  const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }
  const successor: OAuthAuthDetails = {
    type: 'oauth',
    refresh: 'synthetic-successor|synthetic-project-0',
    access: 'synthetic-access',
    expires: now + 3600000,
  }
  const queue = createLocationProactiveRefreshQueue(
    {
      logger: quiet,
      refreshToken: async (_auth, account) => {
        calls.push(account.index)
        signalStarted()
        return answer
      },
    },
    {
      enabled: true,
      bufferSeconds: 30,
      checkIntervalSeconds: 300,
      mayRun: async () => mayRun,
    },
  )
  queue.setAccountManager({
    getAccounts: () => accounts,
    toAuthDetails: (account) => manager.toAuthDetails(account),
    updateFromAuth: (_account, auth) => {
      updates.push(auth)
    },
    saveToDisk: async () => {
      saves += 1
    },
  })
  try {
    queue.start()
    jest.advanceTimersByTime(5000)
    await started
    mayRun = false
    finishRefresh(successor)
    await new Promise<void>((resolve) => nextRealTurn(resolve))
    expect(queue.getStats().isRefreshing).toBe(false)
    expect(calls).toEqual([0])
    expect(updates).toEqual([successor])
    expect(saves).toBe(1)
  } finally {
    finishRefresh(successor)
    await queue.dispose()
    jest.useRealTimers()
  }
})

it('does not restart a disposed queue', async () => {
  jest.useFakeTimers()
  let admissions = 0
  const queue = new ProactiveRefreshQueue(mockClient, 'google', {
    enabled: true,
    mayRun: async () => {
      admissions += 1
      return true
    },
  })
  try {
    await queue.dispose()
    queue.start()
    jest.advanceTimersByTime(600000)
    await Promise.resolve()
    expect(queue.getStats().isRunning).toBe(false)
    expect(admissions).toBe(0)
  } finally {
    await queue.dispose()
    jest.useRealTimers()
  }
})
