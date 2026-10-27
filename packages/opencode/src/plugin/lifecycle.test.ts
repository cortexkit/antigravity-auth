import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk'

import { AccountManager } from './accounts'
import { DEFAULT_CONFIG } from './config'
import { initializeDebug } from './debug'
import { createPluginLifecycle } from './lifecycle'
import { ProactiveRefreshQueue } from './refresh-queue'

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

function heldDrain() {
  let finish: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

describe('PluginLifecycle', () => {
  it('dispose completes all teardown stages after a rejected live queue drain', async () => {
    const events: string[] = []
    const failure = new Error('row synthetic-disabled-id is disabled')
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
    lifecycle.register(
      {
        dispose: () => {
          events.push('producer:dispose')
        },
      },
      'producer',
    )
    lifecycle.register({
      dispose: () => {
        events.push('consumer:dispose')
      },
    })
    await lifecycle.replaceAccountRuntime(createAccountManager(events), {
      dispose: mock(async () => {
        events.push('queue:dispose')
        throw failure
      }),
    } as unknown as ProactiveRefreshQueue)

    const disposal = lifecycle.dispose()
    const result = await Promise.resolve(disposal).catch(
      (error: unknown) => error,
    )

    expect(events).toEqual([
      'queue:dispose',
      'manager:flush',
      'manager:dispose',
      'cache:shutdown',
      'sessions:clear',
      'fetch:clear',
      'producer:dispose',
      'sidebar:drain',
      'consumer:dispose',
    ])
    expect(result).toBe(failure)
    expect(lifecycle.getAccountManager()).toBeNull()
    expect(lifecycle.dispose()).toBe(disposal)
    expect(
      await Promise.resolve(lifecycle.dispose()).catch(
        (error: unknown) => error,
      ),
    ).toBe(failure)
    expect(events).toHaveLength(9)
  })

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

  it('awaits a producer whose async dispose enqueues a write only after an in-flight refresh settles', async () => {
    // Models the quota manager: its dispose() awaits an in-flight
    // refresh, and that refresh's completion is what enqueues the
    // fire-and-forget sidebar write. The drain must not run until the
    // producer's async dispose has fully resolved — otherwise the
    // post-refresh write races past a drain that already asserted the
    // queue was empty.
    const events: string[] = []
    let enqueued = false
    let releaseInflight: (() => void) | null = null
    const inflight = new Promise<void>((resolve) => {
      releaseInflight = resolve
    })

    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        // The producer's async dispose must have enqueued the write
        // before the drain observes the queue.
        events.push(enqueued ? 'drain:sees-write' : 'drain:missed-write')
      },
    })

    lifecycle.register(
      {
        dispose: async () => {
          events.push('producer:dispose-start')
          // Simulate an in-flight refresh still running at shutdown.
          // It resolves on the next microtask; only THEN is the sidebar
          // write enqueued — exactly the quota manager's ordering.
          queueMicrotask(() => releaseInflight?.())
          await inflight
          enqueued = true
          events.push('producer:enqueue-after-inflight')
        },
      },
      'producer',
    )

    await lifecycle.dispose()

    expect(events).toEqual([
      'producer:dispose-start',
      'producer:enqueue-after-inflight',
      'drain:sees-write',
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
    const expected = [
      'queue:dispose',
      'manager:flush',
      'manager:dispose',
      'cache:shutdown',
      'sessions:clear',
      'fetch:clear',
      'sidebar:drain',
    ]
    expect(events).toEqual(expected)
    await lifecycle.dispose()
    expect(events).toEqual(expected)
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

describe('PluginLifecycle failure isolation', () => {
  const stages = [
    'manager',
    'cache',
    'sessions',
    'fetch',
    'producer',
    'sidebar',
    'consumer',
  ]

  it.each(
    stages,
  )('continues cleanup after a synchronous %s failure', async (failedStage) => {
    const events: string[] = []
    const failure = new Error(`${failedStage} failed`)
    const run = (stage: string) => {
      events.push(stage)
      if (stage === failedStage) throw failure
    }
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => run('sessions') },
      shutdownDiskSignatureCache: () => {
        run('cache')
        return Promise.resolve()
      },
      clearFetchState: () => run('fetch'),
      drainSidebarWrites: () => {
        run('sidebar')
        return Promise.resolve()
      },
    })
    lifecycle.register({ dispose: () => run('producer') }, 'producer')
    lifecycle.register({ dispose: () => run('producer:next') }, 'producer')
    lifecycle.register({ dispose: () => run('consumer') })
    lifecycle.register({ dispose: () => run('consumer:next') })
    await lifecycle.replaceAccountRuntime(
      { dispose: () => run('manager') } as unknown as AccountManager,
      null,
    )

    const result = await Promise.resolve(lifecycle.dispose()).catch(
      (error: unknown) => error,
    )

    expect(events).toEqual([
      'manager',
      'cache',
      'sessions',
      'fetch',
      'producer',
      'producer:next',
      'sidebar',
      'consumer',
      'consumer:next',
    ])
    expect(result).toBe(failure)
  })

  it('reports all rejected cleanup stages only after the final consumer', async () => {
    const events: string[] = []
    const failures = stages.map((stage) => new Error(`${stage} failed`))
    const run = (stage: string) => {
      events.push(stage)
      throw failures[stages.indexOf(stage)]
    }
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => run('sessions') },
      shutdownDiskSignatureCache: async () => run('cache'),
      clearFetchState: () => run('fetch'),
      drainSidebarWrites: async () => run('sidebar'),
    })
    lifecycle.register({ dispose: async () => run('producer') }, 'producer')
    lifecycle.register({ dispose: async () => run('consumer') })
    lifecycle.register({
      dispose: () => {
        events.push('consumer:next')
      },
    })
    await lifecycle.replaceAccountRuntime(
      { dispose: async () => run('manager') } as unknown as AccountManager,
      null,
    )

    const result = await Promise.resolve(lifecycle.dispose()).catch(
      (error: unknown) => error,
    )

    expect(events).toEqual([...stages, 'consumer:next'])
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError))
      throw new Error('Missing cleanup failures')
    expect(result.errors).toEqual(failures)
  })

  it.each([
    'throws',
    'rejects',
  ])('starts all aborts and waits for remaining users when a live request abort %s', async (mode) => {
    const events: string[] = []
    const failure = new Error('request abort failed')
    const retirement = heldDrain()
    const queueDrain = heldDrain()
    const retiredAbort = heldDrain()
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {
        events.push('cache')
      },
      clearFetchState: () => {},
    })
    const retiredManager = createAccountManager(events, 'retired-manager')
    const liveManager = createAccountManager(events, 'live-manager')
    await lifecycle.replaceAccountRuntime(retiredManager, null, {
      retire: () => retirement.promise,
      dispose: () => {
        events.push('retired:abort')
        return retiredAbort.promise
      },
    })
    await lifecycle.replaceAccountRuntime(
      liveManager,
      {
        dispose: () => {
          events.push('queue:stop')
          return queueDrain.promise
        },
      } as unknown as ProactiveRefreshQueue,
      {
        retire: async () => {},
        dispose: () => {
          events.push('live:abort')
          if (mode === 'throws') throw failure
          return Promise.reject(failure)
        },
      },
    )

    const disposal = lifecycle.dispose()
    const result = Promise.resolve(disposal).catch((error: unknown) => error)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events).toEqual(['live:abort', 'retired:abort', 'queue:stop'])
      expect(retiredManager.dispose).not.toHaveBeenCalled()
      expect(liveManager.dispose).not.toHaveBeenCalled()
      retiredAbort.finish()
      retirement.finish()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(retiredManager.dispose).toHaveBeenCalledTimes(1)
      expect(liveManager.dispose).not.toHaveBeenCalled()
      expect(events).not.toContain('cache')
    } finally {
      retirement.finish()
      retiredAbort.finish()
      queueDrain.finish()
      await result
    }
    expect(await result).toBe(failure)
    expect(liveManager.dispose).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toBe('cache')
  })

  it.each([
    'throws',
    'rejects',
  ])('waits for request users and cleans shared state when a live queue %s', async (mode) => {
    const events: string[] = []
    const failure = new Error('queue failed')
    const requestDrain = heldDrain()
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {
        events.push('cache')
      },
      clearFetchState: () => {},
    })
    const manager = createAccountManager(events)
    const reentry: { promise?: Promise<void> | void } = {}
    await lifecycle.replaceAccountRuntime(
      manager,
      {
        dispose: () => {
          events.push('queue:stop')
          reentry.promise = lifecycle.dispose()
          if (mode === 'throws') throw failure
          return Promise.reject(failure)
        },
      } as unknown as ProactiveRefreshQueue,
      {
        retire: async () => {},
        dispose: () => requestDrain.promise,
      },
    )

    const disposal = lifecycle.dispose()
    const result = Promise.resolve(disposal).catch((error: unknown) => error)
    try {
      expect(reentry.promise).toBe(disposal)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events).toEqual(['queue:stop'])
      expect(manager.dispose).not.toHaveBeenCalled()
    } finally {
      requestDrain.finish()
      await result
    }
    expect(await result).toBe(failure)
    expect(lifecycle.dispose()).toBe(disposal)
    expect(events).toEqual([
      'queue:stop',
      'manager:flush',
      'manager:dispose',
      'cache',
    ])
    expect(manager.dispose).toHaveBeenCalledTimes(1)
  })

  it('continues aborting retired runtimes after a synchronous retired abort failure', async () => {
    const events: string[] = []
    const failure = new Error('retired abort failed')
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {
        events.push('cache')
      },
      clearFetchState: () => {},
    })
    const managers = [
      createAccountManager(events, 'first'),
      createAccountManager(events, 'second'),
    ]
    for (const [index, manager] of managers.entries()) {
      const retirement = heldDrain()
      await lifecycle.replaceAccountRuntime(manager, null, {
        retire: () => retirement.promise,
        dispose: () => {
          events.push(`retired:${index}:abort`)
          retirement.finish()
          if (index === 0) throw failure
        },
      })
    }
    const liveManager = createAccountManager(events, 'live')
    await lifecycle.replaceAccountRuntime(
      liveManager,
      createRefreshQueue(events),
    )

    const result = await Promise.resolve(lifecycle.dispose()).catch(
      (error: unknown) => error,
    )

    expect(result).toBe(failure)
    expect(events.slice(0, 3)).toEqual([
      'retired:0:abort',
      'retired:1:abort',
      'queue:dispose',
    ])
    for (const manager of [...managers, liveManager]) {
      expect(manager.dispose).toHaveBeenCalledTimes(1)
    }
    expect(events.at(-1)).toBe('cache')
  })

  it.each([
    'throws',
    'rejects',
  ])('cleans live and shared state when a retired request drain %s', async (mode) => {
    const events: string[] = []
    const failure = new Error('retirement failed')
    const queueDrain = heldDrain()
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {
        events.push('cache')
      },
      clearFetchState: () => {},
    })
    const retiredManager = createAccountManager(events, 'retired-manager')
    const liveManager = createAccountManager(events, 'live-manager')
    await lifecycle.replaceAccountRuntime(
      retiredManager,
      {
        dispose: () => queueDrain.promise,
      } as unknown as ProactiveRefreshQueue,
      {
        retire: () => {
          if (mode === 'throws') throw failure
          return Promise.reject(failure)
        },
        dispose: () => {
          events.push('retired:abort')
        },
      },
    )
    const replacement = lifecycle.replaceAccountRuntime(liveManager, null)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(retiredManager.dispose).not.toHaveBeenCalled()
    } finally {
      queueDrain.finish()
    }
    expect(await replacement).toBe(true)
    const result = await Promise.resolve(lifecycle.dispose()).catch(
      (error: unknown) => error,
    )

    expect(result).toBe(failure)
    expect(retiredManager.dispose).toHaveBeenCalledTimes(1)
    expect(liveManager.dispose).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toBe('cache')
  })
})

/** A request runtime whose retirement the test finishes explicitly. */
function createRequests(events: string[], name: string) {
  let finishRetirement: () => void = () => {}
  const retired = new Promise<void>((resolve) => {
    finishRetirement = resolve
  })
  const requests = {
    retire: mock(async () => {
      events.push(`${name}:retire`)
      await retired
      events.push(`${name}:retired`)
    }),
    // Aborting admitted requests ends a retirement that is still waiting.
    dispose: mock(async () => {
      events.push(`${name}:abort`)
      finishRetirement()
    }),
  }
  return { requests, finishRetirement }
}

describe('PluginLifecycle request runtime retirement', () => {
  const options = (events: string[]) => ({
    sessionRegistry: { clear: () => {} },
    shutdownDiskSignatureCache: async () => {},
    clearFetchState: () => {},
    drainSidebarWrites: async () => {
      events.push('sidebar:drain')
    },
  })

  it('publishes closing before synchronous disposal-hook admissions', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    const manager = new AccountManager()
    manager.dispose = mock(async () => {
      events.push('live-manager:dispose')
    })
    const offeredManager = new AccountManager()
    offeredManager.dispose = mock(async () => {
      events.push('offered-manager:dispose')
    })
    const client = createOpencodeClient()
    const offeredQueue = new ProactiveRefreshQueue(client, 'google')
    offeredQueue.dispose = mock(async () => {
      events.push('offered-queue:dispose')
    })
    const offeredRequests = {
      retire: mock(async () => {}),
      dispose: mock(async () => {
        events.push('offered-requests:abort')
      }),
    }
    let closingInHook = false
    let offered = Promise.resolve(true)
    const registeredDispose = mock(() => {
      events.push('reentrant-registration:dispose')
    })
    await lifecycle.replaceAccountRuntime(manager, null, {
      retire: async () => {},
      dispose() {
        events.push('live-requests:abort')
        closingInHook = lifecycle.isClosing()
        offered = lifecycle.replaceAccountRuntime(
          offeredManager,
          offeredQueue,
          offeredRequests,
        )
        lifecycle.register({ dispose: registeredDispose }, 'producer')
      },
    })

    expect(lifecycle.isClosing()).toBe(false)
    const disposal = lifecycle.dispose()
    // Both admissions run inside the first dispose call, before its async
    // body returns a promise. A promise assigned afterward cannot fence them.
    expect(closingInHook).toBe(true)
    expect(registeredDispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'live-requests:abort',
      'offered-requests:abort',
      'reentrant-registration:dispose',
    ])
    expect(await offered).toBe(false)
    await disposal
    expect(lifecycle.isClosing()).toBe(true)
    expect(lifecycle.getAccountManager()).toBeNull()
    expect(offeredRequests.retire).not.toHaveBeenCalled()
    expect(offeredRequests.dispose).toHaveBeenCalledTimes(1)
    expect(offeredQueue.dispose).toHaveBeenCalledTimes(1)
    expect(offeredManager.dispose).toHaveBeenCalledTimes(1)
    expect(manager.dispose).toHaveBeenCalledTimes(1)
  })

  it('joins synchronous reentrant final disposal before any owned drain finishes', async () => {
    let finishRequests: () => void = () => {}
    const heldDrain = new Promise<void>((resolve) => {
      finishRequests = resolve
    })
    const events: string[] = []
    const cacheShutdown = mock(async () => {
      events.push('cache:shutdown')
    })
    const sidebarDrain = mock(async () => {
      events.push('sidebar:drain')
    })
    const producerDispose = mock(async () => {
      events.push('producer:dispose')
    })
    const consumerDispose = mock(async () => {
      events.push('consumer:dispose')
    })
    const lifecycle = createPluginLifecycle({
      ...options(events),
      shutdownDiskSignatureCache: cacheShutdown,
      drainSidebarWrites: sidebarDrain,
    })
    lifecycle.register({ dispose: producerDispose }, 'producer')
    lifecycle.register({ dispose: consumerDispose }, 'consumer')
    const manager = new AccountManager()
    manager.dispose = mock(async () => {
      events.push('manager:dispose')
    })
    const queue = new ProactiveRefreshQueue(createOpencodeClient(), 'google')
    queue.dispose = mock(async () => {
      events.push('queue:stop')
    })
    const reentry: { promise?: Promise<void> | void } = {}
    const requestDispose = mock(() => {
      events.push('requests:abort')
      reentry.promise = lifecycle.dispose()
      return heldDrain
    })
    await lifecycle.replaceAccountRuntime(manager, queue, {
      retire: async () => {},
      dispose: requestDispose,
    })

    const first = lifecycle.dispose()
    try {
      expect(events).toEqual(['requests:abort', 'queue:stop'])
      const reentered = reentry.promise
      expect(reentered).toBe(first)
      if (!first || !reentered) throw new Error('No shutdown promise returned')
      let firstFinished = false
      let reentryFinished = false
      void first.then(() => {
        firstFinished = true
      })
      void reentered.then(() => {
        reentryFinished = true
      })
      // Give a mistakenly independent shutdown body time to reach consumers
      // while the original request still owns the held drain.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(firstFinished).toBe(false)
      expect(reentryFinished).toBe(false)
      expect(lifecycle.isClosing()).toBe(true)
      expect(events).toEqual(['requests:abort', 'queue:stop'])
      expect(requestDispose).toHaveBeenCalledTimes(1)
      expect(queue.dispose).toHaveBeenCalledTimes(1)
      expect(manager.dispose).not.toHaveBeenCalled()
      expect(cacheShutdown).not.toHaveBeenCalled()
      expect(sidebarDrain).not.toHaveBeenCalled()
      expect(producerDispose).not.toHaveBeenCalled()
      expect(consumerDispose).not.toHaveBeenCalled()
    } finally {
      finishRequests()
      await Promise.all([first, reentry.promise])
    }
    expect(manager.dispose).toHaveBeenCalledTimes(1)
    expect(cacheShutdown).toHaveBeenCalledTimes(1)
    expect(sidebarDrain).toHaveBeenCalledTimes(1)
    expect(producerDispose).toHaveBeenCalledTimes(1)
    expect(consumerDispose).toHaveBeenCalledTimes(1)
    expect(events.indexOf('consumer:dispose')).toBeGreaterThan(
      events.indexOf('manager:dispose'),
    )
  })

  it('retires a replaced request runtime and disposes its manager only after the retirement finishes', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    let markOldManagerDisposed: () => void = () => {}
    const oldManagerDisposed = new Promise<void>((resolve) => {
      markOldManagerDisposed = resolve
    })
    const oldManager = {
      dispose: mock(async () => {
        events.push('old-manager:flush')
        events.push('old-manager:dispose')
        markOldManagerDisposed()
      }),
    } as unknown as AccountManager
    const newManager = createAccountManager(events, 'new-manager')
    const old = createRequests(events, 'old-requests')
    const fresh = createRequests(events, 'new-requests')
    try {
      await lifecycle.replaceAccountRuntime(
        oldManager,
        createRefreshQueue(events, 'old-queue'),
        old.requests,
      )
      expect(
        await lifecycle.replaceAccountRuntime(
          newManager,
          createRefreshQueue(events, 'new-queue'),
          fresh.requests,
        ),
      ).toBe(true)
      expect(lifecycle.getAccountManager()).toBe(newManager)
      // The old queue's timers stop at once; the old manager stays open.
      expect(events).toEqual(['old-queue:dispose', 'old-requests:retire'])

      old.finishRetirement()
      await oldManagerDisposed
      expect(events).toEqual([
        'old-queue:dispose',
        'old-requests:retire',
        'old-requests:retired',
        'old-manager:flush',
        'old-manager:dispose',
      ])
      expect(old.requests.dispose).not.toHaveBeenCalled()
      expect(newManager.dispose).not.toHaveBeenCalled()
    } finally {
      await lifecycle.dispose()
    }
  })

  it('keeps a replaced manager open until its queue finishes a refresh under way, and final disposal still owns it meanwhile', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    let finishRefresh: () => void = () => {}
    const refreshing = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const oldQueue = {
      dispose: mock(async () => {
        events.push('old-queue:stop')
        await refreshing
        events.push('old-queue:drained')
      }),
    } as unknown as ProactiveRefreshQueue
    // The request runtime has no admitted request: its retirement ends at
    // once, so only the queue keeps the old manager open.
    const oldRequests = {
      retire: mock(async () => {
        events.push('old-requests:retired')
      }),
      dispose: mock(async () => {
        events.push('old-requests:abort')
      }),
    }
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events, 'old-manager'),
      oldQueue,
      oldRequests,
    )
    const replaced = lifecycle.replaceAccountRuntime(
      createAccountManager(events, 'new-manager'),
      null,
      createRequests(events, 'new-requests').requests,
    )
    await oldRequests.retire.mock.results[0]?.value
    // Final disposal begins while the old queue is still refreshing.
    const disposal = lifecycle.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([
      'old-queue:stop',
      'old-requests:retired',
      'old-requests:abort',
    ])

    finishRefresh()
    expect(await replaced).toBe(false)
    await disposal
    // The replaced manager is disposed only after its queue drained, and
    // before the sidebar drain; the refused replacement is disposed too.
    const at = (event: string) => events.indexOf(event)
    expect(at('old-queue:drained')).toBeGreaterThan(-1)
    expect(at('old-manager:dispose')).toBeGreaterThan(at('old-queue:drained'))
    expect(at('sidebar:drain')).toBeGreaterThan(at('old-manager:dispose'))
    expect(events).toContain('new-requests:abort')
    expect(events).toContain('new-manager:dispose')
    expect(events.at(-1)).toBe('sidebar:drain')
  })

  it('aborts live and retired request runtimes before any manager is disposed, and before producers and the sidebar drain', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    lifecycle.register(
      {
        dispose: () => {
          events.push('producer:dispose')
        },
      },
      'producer',
    )
    const old = createRequests(events, 'old-requests')
    const live = createRequests(events, 'live-requests')
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events, 'old-manager'),
      null,
      old.requests,
    )
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events, 'live-manager'),
      createRefreshQueue(events, 'live-queue'),
      live.requests,
    )

    await lifecycle.dispose()

    // The live queue stops together with the aborts, before any manager is
    // disposed.
    expect(events).toEqual([
      'old-requests:retire',
      'live-requests:abort',
      'old-requests:abort',
      'live-queue:dispose',
      'old-requests:retired',
      'old-manager:flush',
      'old-manager:dispose',
      'live-manager:flush',
      'live-manager:dispose',
      'producer:dispose',
      'sidebar:drain',
    ])
    expect(live.requests.retire).not.toHaveBeenCalled()
    expect(lifecycle.getAccountManager()).toBeNull()
  })

  it('stops the live refresh queue as shutdown begins, while its request runtime is still draining, and disposes the manager after both', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    let finishAbort: () => void = () => {}
    const abortHeld = new Promise<void>((resolve) => {
      finishAbort = resolve
    })
    let finishRefresh: () => void = () => {}
    const refreshHeld = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    await lifecycle.replaceAccountRuntime(
      createAccountManager(events, 'live-manager'),
      {
        dispose: mock(async () => {
          events.push('live-queue:stop')
          await refreshHeld
          events.push('live-queue:drained')
        }),
      } as unknown as ProactiveRefreshQueue,
      {
        retire: mock(async () => {}),
        // An admitted stream still draining after its abort.
        dispose: mock(async () => {
          events.push('live-requests:abort')
          await abortHeld
          events.push('live-requests:drained')
        }),
      },
    )

    const disposal = lifecycle.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const whileDraining = [...events]
    finishAbort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const whileRefreshing = [...events]
    finishRefresh()
    await disposal

    expect({ whileDraining, whileRefreshing }).toEqual({
      whileDraining: ['live-requests:abort', 'live-queue:stop'],
      whileRefreshing: [
        'live-requests:abort',
        'live-queue:stop',
        'live-requests:drained',
      ],
    })
    expect(events.slice(3)).toEqual([
      'live-queue:drained',
      'live-manager:flush',
      'live-manager:dispose',
      'sidebar:drain',
    ])
  })

  it('disposes an offered request runtime, queue and manager once disposal has begun', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle(options(events))
    const disposal = lifecycle.dispose()
    const late = createRequests(events, 'late-requests')

    expect(
      await lifecycle.replaceAccountRuntime(
        createAccountManager(events, 'late-manager'),
        createRefreshQueue(events, 'late-queue'),
        late.requests,
      ),
    ).toBe(false)
    await disposal

    expect(events).toContain('late-requests:abort')
    expect(events).toContain('late-queue:dispose')
    expect(events).toContain('late-manager:dispose')
    expect(late.requests.retire).not.toHaveBeenCalled()
    expect(lifecycle.getAccountManager()).toBeNull()
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

describe('PluginLifecycle debug log disposal', () => {
  let logDir: string

  beforeEach(() => {
    logDir = join(
      tmpdir(),
      `agy-lifecycle-debug-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(logDir, { recursive: true })
  })

  afterEach(() => {
    // Reset module-global debug state before removing the temp dir so any
    // stream targeting logDir is closed and the global points nowhere live.
    // Without this, a stale WriteStream in debugState outlives the directory;
    // under --isolate this is benign today (each file gets a fresh registry)
    // but correct teardown guards against future tests added to this suite.
    initializeDebug({ ...DEFAULT_CONFIG, debug: false })
    rmSync(logDir, { recursive: true, force: true })
  })

  it('calls closeDebugLog as a consumer-phase disposable during lifecycle disposal', async () => {
    const events: string[] = []
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        events.push('sidebar:drain')
      },
    })
    // Simulate the plugin registration: closeDebugLog is registered as a
    // consumer so it runs AFTER the sidebar drain.
    lifecycle.register(
      {
        dispose: async () => {
          events.push('debug-log:close')
        },
      },
      'consumer',
    )

    await lifecycle.dispose()

    // The debug log close must happen after the sidebar drain — consumers
    // are disposed in phase 3, after the drain in phase 2.
    expect(events.indexOf('sidebar:drain')).toBeLessThan(
      events.indexOf('debug-log:close'),
    )
  })

  it('flushes buffered debug lines to disk when closeDebugLog runs during dispose', async () => {
    // Initialize debug with a known log dir so closeDebugLog targets a
    // predictable file path.
    const {
      initializeDebug,
      getLogFilePath,
      closeDebugLog,
      startAntigravityDebugRequest,
    } = await import('./debug')

    initializeDebug({
      ...DEFAULT_CONFIG,
      debug: true,
      debug_tui: false,
      log_dir: logDir,
    })

    // Write a log line that would be buffered in the WriteStream.
    startAntigravityDebugRequest({
      originalUrl: 'https://example.com/v1',
      resolvedUrl: 'https://example.com/v1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"dispose-test-body"',
      streaming: false,
    })

    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
    })
    lifecycle.register({
      dispose: () => closeDebugLog().catch(() => {}),
    })

    await lifecycle.dispose()

    // After dispose, the debug log file must exist and contain the
    // test marker written before shutdown.
    const logPath = getLogFilePath()
    expect(logPath).toBeTruthy()
    const files = readdirSync(logDir)
    const logFile = files
      .filter((f) => f.startsWith('antigravity-debug-') && f.endsWith('.log'))
      .sort()
      .pop()
    expect(logFile).toBeTruthy()
    const contents = readFileSync(join(logDir, logFile!), 'utf8')
    expect(contents).toContain('dispose-test-body')
  })
})
