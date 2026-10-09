/**
 * The OpenCode 2 server side of the `antigravity-auth` RPC, without a host.
 * It covers the per-activation store behind `state` and `apply`:
 * - a client holding an old generation is reset or refused;
 * - notifications are numbered per session (or sessionless) scope and are
 *   never delivered to another scope;
 * - cursors acknowledge, page and reset as the protocol describes;
 * - accounts are redacted before they leave the server;
 * - `apply` passes one shared-menu action, through common-auth's own
 *   request parser, to the menu service and returns the menu's answer;
 * - disposal answers `disposed` and ignores late callbacks.
 * It also covers the check that turns an OpenCode 1 setup call into a no-op.
 * Every collaborator is an in-memory fake.
 */

import { describe, expect, it } from 'bun:test'
import { loadCommonAuthCommands } from '@cortexkit/antigravity-auth-core'
import type {
  CommandApplyResult,
  RpcNotificationPayload,
} from '../../rpc/protocol.ts'
import type {
  SidebarAccountRedactionInput,
  SidebarRoutingEntry,
} from '../../sidebar-state.ts'
import type {
  AntigravityApplyInput,
  AntigravityMenuRequest,
  AntigravityNotificationDto,
  AntigravityRpcScope,
  AntigravityStateInput,
  AntigravityStateOutput,
  AntigravityStateSnapshot,
} from '../rpc/protocol.ts'
import {
  classifyGaSetupContext,
  createGaGeneration,
  createGaRpcActivation,
  type GaAccountsRead,
  type GaApplyRequest,
  type GaCommandService,
  type GaRpcActivationOptions,
  GaRpcContractError,
  GaRpcInputError,
  GaSetupContextError,
  type GaStateRead,
  type GaStateSource,
} from './index.ts'

const SESSION_A: AntigravityRpcScope = { kind: 'session', sessionID: 'ses_a' }
const SESSION_B: AntigravityRpcScope = { kind: 'session', sessionID: 'ses_b' }
const SESSIONLESS: AntigravityRpcScope = { kind: 'sessionless' }

/** common-auth's own request parser, as the server binding supplies it. */
const { parseApplyRequest } = await loadCommonAuthCommands()

/** An activation over the genuine request parser. */
function activate(options: Omit<GaRpcActivationOptions, 'parseApplyRequest'>) {
  return createGaRpcActivation({ ...options, parseApplyRequest })
}

const MENU_REQUEST: AntigravityMenuRequest = {
  command: 'antigravity',
  sectionId: 'limits',
  actionId: 'toggle-dump',
}

const MENU: CommandApplyResult['menu'] = {
  command: 'antigravity',
  title: 'Antigravity',
  sections: [],
}

function menuResult(text: string, command = 'antigravity'): CommandApplyResult {
  return { command, ok: true, text, menu: MENU }
}

/** A toast notification carrying `message`. */
function toast(message: string): RpcNotificationPayload {
  return { command: 'antigravity', notify: { message, kind: 'info' } }
}

function messageOf(notification: AntigravityNotificationDto): string {
  const payload = notification.payload
  return 'notify' in payload ? payload.notify.message : payload.menu.title
}

/**
 * An account row as the account service might hold it, including email,
 * tokens, project and fingerprint. The tests check none of these reach a client.
 */
type LiveRow = SidebarAccountRedactionInput & Record<string, unknown>

function liveRows(): LiveRow[] {
  return [
    {
      index: 0,
      label: 'person@example.com',
      enabled: true,
      current: true,
      healthScore: 80,
      email: 'person@example.com',
      refreshToken: 'fake-refresh-token-0',
      access: 'fake-access-token-0',
      projectId: 'fake-project-0',
      fingerprint: { deviceId: 'fake-device' },
      cachedQuota: { gemini: { remainingFraction: 0.5 } },
    },
    {
      index: 1,
      label: 'Work profile',
      enabled: false,
      email: 'second@example.com',
      refreshToken: 'fake-refresh-token-1',
    },
  ]
}

/** A well-formed selector for test row `index`. */
function selectorFor(index: number): string {
  return `sel-${String(index).padStart(32, 'S')}`
}

const SETTINGS: GaStateRead['settings'] = {
  routing: { cliFirst: false, quotaStyleFallback: true },
  killswitch: { enabled: false, minimumRemainingPercent: 5 },
  logLevel: 'info',
  dump: { enabled: false },
}

/**
 * An in-memory state source. Every `read` returns the next `readSeq`, the
 * live rows with selectors, the route for a session scope and fixed status
 * and settings; `overrides` replace parts of one read.
 */
function makeState(
  routes: Record<string, SidebarRoutingEntry> = {},
  overrides: (read: GaStateRead) => GaStateRead = (read) => read,
): GaStateSource & { reads: AbortSignal[] } {
  let readSeq = 0
  const reads: AbortSignal[] = []
  return {
    reads,
    read: async ({ scope, signal }) => {
      reads.push(signal)
      readSeq += 1
      const accounts: GaAccountsRead = {
        kind: 'complete',
        rows: liveRows().map((row, index) => ({
          selector: selectorFor(index),
          row,
        })),
      }
      return overrides({
        readSeq,
        accounts,
        route:
          scope.kind === 'session' ? (routes[scope.sessionID] ?? null) : null,
        status: {
          checkedAt: 1_700_000_000_000,
          quotaBackoffUntil: null,
          routingAuthoritative: true,
        },
        settings: SETTINGS,
      })
    },
  }
}

function makeCommands(
  respond: (request: GaApplyRequest) => Promise<CommandApplyResult> = async (
    request,
  ) => menuResult(`ran ${request.request.actionId}`),
): GaCommandService & { calls: GaApplyRequest[] } {
  const calls: GaApplyRequest[] = []
  return {
    calls,
    apply: (request) => {
      calls.push(request)
      return respond(request)
    },
  }
}

function stateInput(
  generation: string | null,
  scope: AntigravityRpcScope,
  cursor: number,
): AntigravityStateInput {
  return { version: 1, generation, scope, cursor }
}

function applyInput(
  generation: string,
  scope: AntigravityRpcScope = SESSION_A,
  request: AntigravityMenuRequest = MENU_REQUEST,
): AntigravityApplyInput {
  return { version: 1, generation, scope, request }
}

function snapshot(output: AntigravityStateOutput): AntigravityStateSnapshot {
  if (output.kind !== 'snapshot') throw new Error(`got ${output.kind}`)
  return output
}

describe('generation', () => {
  it('creates a distinct contract-valid token per activation', () => {
    const first = createGaGeneration()
    const second = createGaGeneration()
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('answers first contact with reset initial and the current generation', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen-one',
    })
    const output = snapshot(
      await activation.handlers.state(stateInput(null, SESSION_A, 0)),
    )
    expect(output.generation).toBe('gen-one')
    expect(output.reset).toBe('initial')
  })

  it('resets a client holding another generation and redelivers from cursor 0', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen-new',
    })
    activation.notify(SESSION_A, toast('first'))
    const output = snapshot(
      await activation.handlers.state(stateInput('gen-old', SESSION_A, 1)),
    )
    expect(output.reset).toBe('generation-changed')
    expect(output.notifications.map(messageOf)).toEqual(['first'])
    expect(output.cursor).toBe(1)
  })

  it('refuses apply from a stale generation before calling the service', async () => {
    const commands = makeCommands()
    const activation = activate({
      state: makeState(),
      commands,
      generation: 'gen-new',
    })
    const output = await activation.handlers.apply(applyInput('gen-old'))
    expect(output).toEqual({
      version: 1,
      kind: 'stale-generation',
      generation: 'gen-new',
    })
    expect(commands.calls).toHaveLength(0)
  })
})

describe('scoped notifications', () => {
  it('delivers a session’s notifications only to that session', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    activation.notify(SESSION_A, toast('for a'))
    activation.notify(SESSION_B, toast('for b'))
    const a = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    )
    const b = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_B, 0)),
    )
    expect(a.notifications.map(messageOf)).toEqual(['for a'])
    expect(b.notifications.map(messageOf)).toEqual(['for b'])
    // Each scope numbers its own cursors from 1.
    expect(a.notifications[0]?.cursor).toBe(1)
    expect(b.notifications[0]?.cursor).toBe(1)
  })

  it('keeps sessionless and session notifications disjoint in both directions', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    activation.notify(SESSIONLESS, toast('no session'))
    activation.notify(SESSION_A, toast('session a'))
    const sessionless = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    const a = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    )
    expect(sessionless.notifications.map(messageOf)).toEqual(['no session'])
    expect(a.notifications.map(messageOf)).toEqual(['session a'])
  })

  it('acknowledges through the cursor and never redelivers', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    activation.notify(SESSION_A, toast('one'))
    activation.notify(SESSION_A, toast('two'))
    const first = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    )
    expect(first.reset).toBeNull()
    expect(first.cursor).toBe(2)
    activation.notify(SESSION_A, toast('three'))
    const second = snapshot(
      await activation.handlers.state(
        stateInput('gen', SESSION_A, first.cursor),
      ),
    )
    expect(second.notifications.map(messageOf)).toEqual(['three'])
    const third = snapshot(
      await activation.handlers.state(
        stateInput('gen', SESSION_A, second.cursor),
      ),
    )
    expect(third.notifications).toEqual([])
    expect(third.cursor).toBe(3)
  })

  it('resets a cursor ahead of the scope instead of silently skipping', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    activation.notify(SESSION_A, toast('one'))
    const output = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 5)),
    )
    expect(output.reset).toBe('cursor-ahead')
    expect(output.notifications.map(messageOf)).toEqual(['one'])
  })

  it('a cursor issued in one session is ahead in another, never an acknowledgement there', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    activation.notify(SESSION_A, toast('a1'))
    activation.notify(SESSION_A, toast('a2'))
    activation.notify(SESSION_B, toast('b1'))
    const b = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_B, 2)),
    )
    expect(b.reset).toBe('cursor-ahead')
    expect(b.notifications.map(messageOf)).toEqual(['b1'])
  })

  it('pages long queues and counts evicted notifications as dropped', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
      notificationsPerScope: 40,
    })
    for (let index = 1; index <= 45; index += 1) {
      activation.notify(SESSION_A, toast(`n${index}`))
    }
    const page = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    )
    expect(page.dropped).toBe(5)
    expect(page.notifications).toHaveLength(32)
    expect(page.notifications.map(messageOf)[0]).toBe('n6')
    expect(page.more).toBe(true)
    const rest = snapshot(
      await activation.handlers.state(
        stateInput('gen', SESSION_A, page.cursor),
      ),
    )
    expect(rest.dropped).toBe(0)
    expect(rest.notifications.map(messageOf)).toEqual(
      Array.from({ length: 8 }, (_, index) => `n${index + 38}`),
    )
    expect(rest.more).toBe(false)
  })

  it('reports a scope connected only while it is being pulled', async () => {
    let now = 1_000_000
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
      now: () => now,
    })
    expect(activation.isConnected(SESSION_A)).toBe(false)
    await activation.handlers.state(stateInput('gen', SESSION_A, 0))
    expect(activation.isConnected(SESSION_A)).toBe(true)
    expect(activation.isConnected(SESSION_B)).toBe(false)
    expect(activation.isConnected(SESSIONLESS)).toBe(false)
    now += 3_000
    expect(activation.isConnected(SESSION_A)).toBe(false)
  })

  it('emits the changed hint carrying only the version and generation', () => {
    const events: unknown[] = []
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
      onChanged: (event) => events.push(event),
    })
    activation.notify(SESSION_A, toast('private text'))
    expect(events).toEqual([{ version: 1, generation: 'gen' }])
  })
})

describe('state redaction', () => {
  it('projects live rows through the sidebar redactor', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    const output = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    expect(output.accounts.map((a) => [a.id, a.label, a.enabled])).toEqual([
      ['acct-0', 'Account 1', true],
      ['acct-1', 'Account 2', false],
    ])
    const text = JSON.stringify(output)
    for (const secret of [
      'person@example.com',
      'second@example.com',
      'Work profile',
      'fake-refresh-token',
      'fake-access-token',
      'fake-project',
      'fake-device',
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('returns only the requesting session’s route', async () => {
    const route: SidebarRoutingEntry = {
      accountId: 'acct-0',
      modelFamily: 'claude',
      headerStyle: 'antigravity',
      updatedAt: 1_700_000_000_000,
    }
    const activation = activate({
      state: makeState({ ses_a: route }),
      commands: makeCommands(),
      generation: 'gen',
    })
    const a = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    )
    const b = snapshot(
      await activation.handlers.state(stateInput('gen', SESSION_B, 0)),
    )
    const sessionless = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    expect(a.route).toEqual({ ...route, strategy: null })
    expect(b.route).toBeNull()
    expect(sessionless.route).toBeNull()
  })

  it('refuses to answer when the state source breaks the contract', async () => {
    const activation = activate({
      state: makeState({}, (read) => {
        // Extra fields beyond the status DTO, including error text that names
        // an account, as a careless state source might return them.
        const status = {
          checkedAt: null,
          quotaBackoffUntil: null,
          routingAuthoritative: false,
          lastError: 'refresh token revoked for person@example.com',
        }
        return { ...read, status }
      }),
      commands: makeCommands(),
      generation: 'gen',
    })
    await expect(
      activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    ).rejects.toBeInstanceOf(GaRpcContractError)
  })
})

describe('raw input', () => {
  it('rejects malformed input before any effect', async () => {
    const commands = makeCommands()
    const activation = activate({
      state: makeState(),
      commands,
      generation: 'gen',
    })
    const malformed: unknown[] = [
      { ...applyInput('gen'), version: '1' },
      {
        ...applyInput('gen'),
        request: { ...MENU_REQUEST, command: 'antigravity-quota' },
      },
      {
        ...applyInput('gen'),
        request: { ...MENU_REQUEST, values: { level: [] } },
      },
      {
        ...applyInput('gen'),
        request: { ...MENU_REQUEST, sessionId: 'ses_b' },
      },
      { ...applyInput('gen'), scope: { kind: 'session' } },
      { ...applyInput('gen'), knobs: {} },
      // The retired per-command dialog form.
      {
        version: 1,
        generation: 'gen',
        scope: SESSION_A,
        command: 'antigravity-dump',
        arguments: 'on',
      },
    ]
    for (const input of malformed) {
      await expect(activation.handlers.apply(input)).rejects.toBeInstanceOf(
        GaRpcInputError,
      )
    }
    for (const cursor of [true, '0', 0.5, -1, Number.NaN]) {
      await expect(
        activation.handlers.state({
          ...stateInput('gen', SESSION_A, 0),
          cursor,
        }),
      ).rejects.toBeInstanceOf(GaRpcInputError)
    }
    expect(commands.calls).toHaveLength(0)
  })

  it('does not echo a rejected menu value in the error', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    const error = await activation.handlers
      .apply({
        ...applyInput('gen'),
        request: {
          ...MENU_REQUEST,
          values: { code: 'fake-oauth-code\u0000' },
        },
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GaRpcInputError)
    expect(String((error as Error).message)).not.toContain('fake-oauth-code')
  })
})

describe('apply', () => {
  it('passes the menu action and scope to the service and returns the menu answer', async () => {
    const commands = makeCommands()
    const activation = activate({
      state: makeState(),
      commands,
      generation: 'gen',
    })
    const output = await activation.handlers.apply(applyInput('gen'))
    expect(output).toEqual({
      version: 1,
      kind: 'applied',
      generation: 'gen',
      scope: SESSION_A,
      result: menuResult('ran toggle-dump'),
    })
    expect(commands.calls[0]?.scope).toEqual(SESSION_A)
  })

  it('gives the menu the scope’s session, and no session for the sessionless scope', async () => {
    const commands = makeCommands()
    const activation = activate({
      state: makeState(),
      commands,
      generation: 'gen',
    })
    const named = { ...MENU_REQUEST, sectionId: 'accounts', itemId: 'item-7' }
    await activation.handlers.apply(applyInput('gen', SESSION_A, named))
    await activation.handlers.apply(applyInput('gen', SESSIONLESS, named))
    expect(commands.calls.map((call) => call.request)).toEqual([
      { ...named, sessionId: 'ses_a' },
      named,
    ])
  })

  it('refuses a request the menu’s parser does not accept before the service runs', async () => {
    const commands = makeCommands()
    const activation = createGaRpcActivation({
      state: makeState(),
      commands,
      generation: 'gen',
      parseApplyRequest: () => undefined,
    })
    await expect(
      activation.handlers.apply(applyInput('gen')),
    ).rejects.toBeInstanceOf(GaRpcInputError)
    expect(commands.calls).toHaveLength(0)
  })

  it('refuses a result for a different command', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(async () => menuResult('done', 'other-command')),
      generation: 'gen',
    })
    await expect(
      activation.handlers.apply(applyInput('gen')),
    ).rejects.toBeInstanceOf(GaRpcContractError)
  })

  it('forwards the host call signal to the service', async () => {
    let seen: AbortSignal | undefined
    const activation = activate({
      state: makeState(),
      commands: makeCommands(async (request) => {
        seen = request.signal
        return menuResult('')
      }),
      generation: 'gen',
    })
    const host = new AbortController()
    host.abort(new Error('client left'))
    await activation.handlers.apply(applyInput('gen'), host.signal)
    expect(seen?.aborted).toBe(true)
  })
})

describe('disposal and stale activations', () => {
  it('answers disposed and ignores late notifications', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    await activation.dispose()
    await activation.dispose()
    expect(activation.disposed).toBe(true)
    expect(
      await activation.handlers.state(stateInput('gen', SESSION_A, 0)),
    ).toEqual({ version: 1, kind: 'disposed', generation: 'gen' })
    expect(await activation.handlers.apply(applyInput('gen'))).toEqual({
      version: 1,
      kind: 'disposed',
      generation: 'gen',
    })
    expect(activation.notify(SESSION_A, toast('late'))).toBeNull()
  })

  it('aborts and awaits a running apply; its late result is reported as disposed', async () => {
    let release: (() => void) | undefined
    let serviceSignal: AbortSignal | undefined
    const activation = activate({
      state: makeState(),
      commands: makeCommands(
        (request) =>
          new Promise((resolve) => {
            serviceSignal = request.signal
            release = () => resolve(menuResult('late'))
          }),
      ),
      generation: 'old',
    })
    const pending = activation.handlers.apply(applyInput('old'))
    let disposed = false
    const disposal = activation.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(serviceSignal?.aborted).toBe(true)
    // Disposal does not finish while this activation's apply call is still
    // running.
    expect(disposed).toBe(false)
    release?.()
    await disposal
    expect(await pending).toEqual({
      version: 1,
      kind: 'disposed',
      generation: 'old',
    })
  })

  it('a disposed activation’s late callbacks cannot reach its replacement', async () => {
    const old = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'old',
    })
    const replacement = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'new',
    })
    old.notify(SESSION_A, toast('before'))
    await old.dispose()
    old.notify(SESSION_A, toast('late'))
    const output = snapshot(
      await replacement.handlers.state(stateInput('old', SESSION_A, 1)),
    )
    expect(output.reset).toBe('generation-changed')
    expect(output.notifications).toEqual([])
    expect(output.generation).toBe('new')
  })

  it('disposing one location’s activation leaves another serving', async () => {
    const first = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'loc-a',
    })
    const second = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'loc-b',
    })
    second.notify(SESSION_A, toast('b'))
    await first.dispose()
    const output = snapshot(
      await second.handlers.state(stateInput('loc-b', SESSION_A, 0)),
    )
    expect(output.notifications.map(messageOf)).toEqual(['b'])
    expect(second.notify(SESSION_A, toast('b2'))).toBe(2)
  })
})

describe('setup context predicate', () => {
  function recording(target: Record<string, unknown>) {
    const reads: string[] = []
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        reads.push(String(key))
        return Reflect.get(object, key, receiver)
      },
      has(object, key) {
        reads.push(`has:${String(key)}`)
        return Reflect.has(object, key)
      },
    })
    return { proxy, reads }
  }

  it('treats a context without session and location as the legacy no-op, reading nothing else', () => {
    const { proxy, reads } = recording({
      options: {},
      command: {},
      integration: {},
    })
    expect(classifyGaSetupContext(proxy)).toBe('legacy')
    expect(reads).toEqual(['session', 'location'])
  })

  it('throws, never no-ops, when only one of session and location is present', () => {
    expect(() =>
      classifyGaSetupContext({ session: { hook: () => undefined } }),
    ).toThrow(GaSetupContextError)
    expect(() =>
      classifyGaSetupContext({ location: { directory: '/tmp/x' } }),
    ).toThrow(GaSetupContextError)
  })

  it('names a missing capability when both are present', () => {
    const error = (() => {
      try {
        classifyGaSetupContext({
          session: { hook: () => undefined },
          location: { directory: '/tmp/x' },
        })
      } catch (caught) {
        return caught
      }
      return null
    })()
    expect(error).toBeInstanceOf(GaSetupContextError)
    expect((error as GaSetupContextError).missing).toEqual([
      'rpc.register',
      'provider.transform',
      'command.transform',
    ])
  })

  it('accepts a complete GA context', () => {
    expect(
      classifyGaSetupContext({
        session: { hook: () => undefined },
        location: { directory: '/tmp/x' },
        rpc: { register: () => undefined },
        provider: { transform: () => undefined },
        command: { transform: () => undefined },
      }),
    ).toBe('ga')
  })
})

describe('selectors, account limit, settings and stale applies', () => {
  it('sends each row with its selector and the read’s settings and readSeq', async () => {
    const activation = activate({
      state: makeState(),
      commands: makeCommands(),
      generation: 'gen',
    })
    const first = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    const second = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    expect(first.accounts.map((account) => account.selector)).toEqual([
      selectorFor(0),
      selectorFor(1),
    ])
    expect(first.accountsStatus).toEqual({ kind: 'complete' })
    expect(first.settings).toEqual(SETTINGS)
    expect([first.readSeq, second.readSeq]).toEqual([1, 2])
  })

  it('answers an over-limit roster with no accounts and its count', async () => {
    const activation = activate({
      state: makeState({}, (read) => ({
        ...read,
        accounts: { kind: 'over-limit', count: 65 },
      })),
      commands: makeCommands(),
      generation: 'gen',
    })
    const output = snapshot(
      await activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    )
    expect(output.accounts).toEqual([])
    expect(output.accountsStatus).toEqual({
      kind: 'over-limit',
      count: 65,
      limit: 64,
    })
  })

  it('refuses a complete read longer than the limit instead of shortening it', async () => {
    const activation = activate({
      state: makeState({}, (read) => ({
        ...read,
        accounts: {
          kind: 'complete',
          rows: Array.from({ length: 65 }, (_, index) => ({
            selector: selectorFor(index),
            row: { index, enabled: true },
          })),
        },
      })),
      commands: makeCommands(),
      generation: 'gen',
    })
    // The specific refusal, not only the later output-schema check.
    await expect(
      activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    ).rejects.toThrow('State source returned more accounts than the limit')
  })

  it('refuses a readSeq that does not increase', async () => {
    const activation = activate({
      state: makeState({}, (read) => ({ ...read, readSeq: 1 })),
      commands: makeCommands(),
      generation: 'gen',
    })
    await activation.handlers.state(stateInput('gen', SESSIONLESS, 0))
    await expect(
      activation.handlers.state(stateInput('gen', SESSIONLESS, 0)),
    ).rejects.toBeInstanceOf(GaRpcContractError)
  })

  it('aborts a running read on disposal and reports disposed', async () => {
    let release: (() => void) | undefined
    let readSignal: AbortSignal | undefined
    const base = makeState()
    const activation = activate({
      state: {
        read: async (input) => {
          readSignal = input.signal
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return base.read(input)
        },
      },
      commands: makeCommands(),
      generation: 'gen',
    })
    const pending = activation.handlers.state(stateInput('gen', SESSIONLESS, 0))
    const disposal = activation.dispose()
    await Promise.resolve()
    expect(readSignal?.aborted).toBe(true)
    release?.()
    await disposal
    expect(await pending).toEqual({
      version: 1,
      kind: 'disposed',
      generation: 'gen',
    })
  })

  it('refuses a menu action from a stale generation before the service runs', async () => {
    const commands = makeCommands()
    const activation = activate({
      state: makeState(),
      commands,
      generation: 'gen',
    })
    const output = await activation.handlers.apply(
      applyInput('old', SESSIONLESS, {
        ...MENU_REQUEST,
        sectionId: 'accounts',
        itemId: 'item-1',
        actionId: 'enable',
      }),
    )
    expect(output.kind).toBe('stale-generation')
    expect(commands.calls).toHaveLength(0)
  })
})
