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
      drainSidebarWrites: mock(async () => {
        events.push('sidebar:drain')
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
      'sidebar:drain',
      'registered:dispose',
    ])
    expect(lifecycle.getAccountManager()).toBeNull()
  })

  it('disposes producers BEFORE the sidebar drain and consumers AFTER', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        events.push('sidebar:drain')
      },
    })
    lifecycle.register(
      {
        dispose: () => {
          events.push('producer:fetch-interceptor-dispose')
        },
      },
      'producer',
    )
    lifecycle.register(
      {
        dispose: () => {
          events.push('consumer:rpc-stop')
        },
      },
      'consumer',
    )
    lifecycle.register(
      {
        dispose: () => {
          events.push('consumer:logger-close')
        },
      },
      'consumer',
    )

    await lifecycle.dispose()

    expect(events).toEqual([
      'producer:fetch-interceptor-dispose',
      'sidebar:drain',
      'consumer:rpc-stop',
      'consumer:logger-close',
    ])
  })

  it('a producer that enqueues a sidebar write during dispose lands before drain', async () => {
    const events: string[] = []
    let producerEnqueue: (() => void) | null = null
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        // The drain observes the producer's last enqueue — by the time
        // the drain runs, producerEnqueue should already have fired.
        if (producerEnqueue) {
          events.push('drain:producer-enqueued')
        }
        events.push('sidebar:drain')
      },
    })
    lifecycle.register(
      {
        dispose: () => {
          events.push('producer:start')
          // Simulate an in-flight fetch that enqueues a sidebar write
          // before disposing itself.
          producerEnqueue = () => {
            events.push('producer:enqueue-sidebar-write')
          }
          producerEnqueue()
          events.push('producer:end')
        },
      },
      'producer',
    )
    lifecycle.register(
      {
        dispose: () => {
          events.push('consumer:close')
        },
      },
      'consumer',
    )

    await lifecycle.dispose()

    expect(events).toEqual([
      'producer:start',
      'producer:enqueue-sidebar-write',
      'producer:end',
      'drain:producer-enqueued',
      'sidebar:drain',
      'consumer:close',
    ])
  })

  it('performs disposal only once', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => events.push('sessions:clear') },
      shutdownDiskSignatureCache: async () => {
        events.push('cache:shutdown')
      },
      clearFetchState: () => events.push('fetch:clear'),
      drainSidebarWrites: async () => {
        events.push('sidebar:drain')
      },
    })
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events),
      createRefreshQueue(events),
    )

    await lifecycle.dispose()
    await lifecycle.dispose()

    expect(events).toHaveLength(7)
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

    await lifecycle.dispose()
  })

  it('drains sidebar writes before tearing down the RPC server (file logger / RPC)', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        // Simulate a real drain: await a microtask flush, like the real
        // implementation does for in-flight writes.
        await Promise.resolve()
        events.push('sidebar:drain')
      },
    })
    lifecycle.register({
      dispose: () => {
        events.push('rpc:stop')
      },
    })
    lifecycle.register({
      dispose: () => {
        events.push('logger:close')
      },
    })

    await lifecycle.dispose()

    expect(events).toEqual(['sidebar:drain', 'rpc:stop', 'logger:close'])
  })

  it('treats drainSidebarWrites as a no-op when omitted (back-compat)', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => events.push('sessions:clear') },
      shutdownDiskSignatureCache: async () => {
        events.push('cache:shutdown')
      },
      clearFetchState: () => events.push('fetch:clear'),
    })
    lifecycle.register({
      dispose: () => {
        events.push('registered:dispose')
      },
    })

    await lifecycle.dispose()

    expect(events).toEqual([
      'cache:shutdown',
      'sessions:clear',
      'fetch:clear',
      'registered:dispose',
    ])
  })
})

describe('PluginLifecycle RPC ownership', () => {
  it('stops a registered RPC server during disposal', async () => {
    const stop = mock(async () => {})
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
    })
    lifecycle.register({ dispose: stop })

    await lifecycle.dispose()
    await lifecycle.dispose()

    expect(stop).toHaveBeenCalledTimes(1)
  })
})
