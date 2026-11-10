import { describe, expect, it } from 'bun:test'
import {
  type GaLocationRef,
  type GaRoute,
  type GaRpcCallInput,
  type GaScope,
  type GaTuiContext,
  setupGaTui,
} from './host-ga'

const A = { directory: '/work/a' }
const B = { directory: '/work/b' }
const MENU = {
  command: 'antigravity',
  menu: { command: 'antigravity', title: 'Antigravity', sections: [] },
}

function answer(input: GaRpcCallInput, notified: boolean) {
  return {
    output: {
      version: 1,
      kind: 'snapshot',
      generation: input.location?.directory === B.directory ? 'gen-b' : 'gen-a',
      scope: (input.input as { scope: GaScope }).scope,
      reset: null,
      cursor: notified ? 1 : 0,
      dropped: 0,
      more: false,
      notifications: notified ? [{ cursor: 1, payload: MENU }] : [],
      readSeq: 1,
      accountsStatus: { kind: 'complete' },
      accounts: [],
      route: null,
      status: {
        checkedAt: 1,
        quotaBackoffUntil: null,
        routingAuthoritative: true,
      },
      settings: {
        selectionStrategy: 'hybrid',
        killswitch: { enabled: false, minimumRemainingPercent: 10 },
        logLevel: 'info',
        dump: { enabled: false },
      },
    },
  }
}

async function settle() {
  // All fake host operations resolve in microtasks, without wall-clock timers.
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

function host() {
  let route: GaRoute = { type: 'session', sessionID: 'ses_b' }
  let tick = () => {}
  let lookup: (id: string) => Promise<{ location: GaLocationRef }> = async (
    id,
  ) => ({
    location: id === 'ses_b' ? B : A,
  })
  const calls: GaRpcCallInput[] = []
  const menus: string[] = []
  const warnings: string[] = []
  const queues = new Set([B.directory])
  const context: GaTuiContext = {
    location: A,
    client: {
      session: { get: ({ sessionID }) => lookup(sessionID) },
      rpc: {
        call: async (input) => {
          calls.push(input)
          const directory = input.location?.directory ?? ''
          const notified = queues.delete(directory)
          return answer(input, notified)
        },
      },
    },
    ui: {
      router: { current: () => route },
      slot: () => () => {},
      toast: { show: () => {} },
      dialog: {
        set: () => {},
        clear: () => {},
        alert: async () => {},
        confirm: async () => false,
        prompt: async () => undefined,
        select: async (options) => {
          menus.push(options.title)
          return undefined
        },
      },
    },
  }
  const cleanup = setupGaTui(context, {
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
    schedule: (next) => {
      tick = next
      return () => {}
    },
  })
  return {
    calls,
    menus,
    warnings,
    queues,
    cleanup,
    tick: () => tick(),
    route: (next: GaRoute) => {
      route = next
    },
    lookup: (next: typeof lookup) => {
      lookup = next
    },
  }
}

describe('GA session location polling', () => {
  it('opens the B queue menu when the TUI started in A', async () => {
    const fake = host()
    try {
      await settle()
      expect(fake.menus).toEqual(['Antigravity'])
      expect(fake.calls.map((call) => call.location)).toEqual([B])
      expect(fake.calls[0]?.input).toMatchObject({
        scope: { kind: 'session', sessionID: 'ses_b' },
      })
      expect(fake.queues.has(B.directory)).toBe(false)
    } finally {
      await fake.cleanup()
    }
  })

  it('switches back to an A session and retains the home client for sessionless polling', async () => {
    const fake = host()
    try {
      await settle()
      fake.queues.add(A.directory)
      fake.route({ type: 'session', sessionID: 'ses_a' })
      fake.tick()
      await settle()
      expect(fake.menus).toEqual(['Antigravity', 'Antigravity'])
      expect(fake.calls[1]?.location).toEqual(A)
      expect(fake.calls[1]?.input).toMatchObject({
        generation: null,
        cursor: 0,
        scope: { kind: 'session', sessionID: 'ses_a' },
      })
      fake.route({ type: 'home' })
      fake.tick()
      await settle()
      expect(fake.calls[2]?.location).toEqual(A)
      expect(fake.calls[2]?.input).toMatchObject({
        generation: 'gen-a',
        cursor: 0,
        scope: { kind: 'sessionless' },
      })
    } finally {
      await fake.cleanup()
    }
  })

  it('does not poll A when session lookup fails or finishes after cleanup', async () => {
    const fake = host()
    await settle()
    fake.lookup(async () => {
      throw new Error('session unavailable')
    })
    fake.route({ type: 'session', sessionID: 'ses_missing' })
    fake.tick()
    await settle()
    expect(fake.calls).toHaveLength(1)
    expect(fake.warnings).toEqual(['ga-session-location-failed'])
    const pending = Promise.withResolvers<{ location: GaLocationRef }>()
    fake.lookup(() => pending.promise)
    fake.tick()
    await settle()
    await fake.cleanup()
    pending.resolve({ location: B })
    await settle()
    expect(fake.calls).toHaveLength(1)
  })

  it('disposes clients for locations no longer shown and drops their pending answers', async () => {
    const { createGaLocationClients } = await import('./host-ga')
    const pending = Promise.withResolvers<unknown>()
    const clients = createGaLocationClients({
      location: A,
      call: () => pending.promise,
    })
    const home = clients.current()
    const foreign = clients.select(B)
    const scope = { kind: 'session', sessionID: 'ses_b' } as const
    const pull = foreign.pull(scope)
    await settle()
    expect(clients.select(B)).toBe(foreign)
    expect(clients.select(A)).toBe(home)
    expect(foreign.disposed()).toBe(true)
    pending.resolve(
      answer(
        {
          rpcID: 'antigravity-auth',
          method: 'state',
          location: B,
          input: { scope },
        },
        true,
      ),
    )
    expect(await pull).toEqual({ kind: 'dropped' })
    const another = clients.select(B)
    expect(another).not.toBe(foreign)
    expect(another.generation()).toBeNull()
    clients.dispose()
    expect(another.disposed()).toBe(true)
    expect(home.disposed()).toBe(true)
  })
})
