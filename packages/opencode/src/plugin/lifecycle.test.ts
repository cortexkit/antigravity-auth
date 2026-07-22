import { describe, expect, it, mock } from 'bun:test'

import type { AccountManager } from './accounts'
import { createPluginLifecycle } from './lifecycle'
import type { ProactiveRefreshQueue } from './refresh-queue'

function createAccountManager(
  events: string[],
  name = 'manager',
): AccountManager {
  return {
    dispose: mock(async () => {
      events.push(`${name}:flush`)
      events.push(`${name}:dispose`)
    }),
  } as unknown as AccountManager
}

function createRefreshQueue(
  events: string[],
  name = 'queue',
): ProactiveRefreshQueue {
  return {
    dispose: mock(() => {
      events.push(`${name}:dispose`)
    }),
  } as unknown as ProactiveRefreshQueue
}

describe('PluginLifecycle', () => {
  it('disposes runtime and shared state in dependency order', async () => {
    const events: string[] = []
    const sessionRegistry = {
      clear: mock(() => {
        events.push('sessions:clear')
      }),
    }
    const lifecycle = createPluginLifecycle({
      sessionRegistry,
      shutdownDiskSignatureCache: mock(async () => {
        events.push('cache:shutdown')
      }),
      clearFetchState: mock(() => {
        events.push('fetch:clear')
      }),
    })
    lifecycle.register({
      dispose: () => {
        events.push('registered:dispose')
      },
    })
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events),
      createRefreshQueue(events),
    )

    await lifecycle.dispose()

    expect(events).toEqual([
      'queue:dispose',
      'manager:flush',
      'manager:dispose',
      'cache:shutdown',
      'sessions:clear',
      'fetch:clear',
      'registered:dispose',
    ])
    expect(lifecycle.getAccountManager()).toBeNull()
  })

  it('performs disposal only once', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => events.push('sessions:clear') },
      shutdownDiskSignatureCache: async () => {
        events.push('cache:shutdown')
      },
      clearFetchState: () => events.push('fetch:clear'),
    })
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events),
      createRefreshQueue(events),
    )

    await lifecycle.dispose()
    await lifecycle.dispose()

    expect(events).toHaveLength(6)
  })

  it('disposes the previous runtime before publishing its replacement', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
    })
    const oldManager = createAccountManager(events, 'old-manager')
    const newManager = createAccountManager(events, 'new-manager')

    await lifecycle.replaceAccountRuntime(
      oldManager,
      createRefreshQueue(events, 'old-queue'),
    )
    expect(lifecycle.getAccountManager()).toBe(oldManager)

    await lifecycle.replaceAccountRuntime(
      newManager,
      createRefreshQueue(events, 'new-queue'),
    )

    expect(events).toEqual([
      'old-queue:dispose',
      'old-manager:flush',
      'old-manager:dispose',
    ])
    expect(lifecycle.getAccountManager()).toBe(newManager)
  })
})
