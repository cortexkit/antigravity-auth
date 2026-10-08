import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseApplyRequest } from '../common-auth-embedded/commands/index.js'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotification,
} from './protocol'
import { createRpcClient } from './rpc-client'
import {
  type RpcServerHandle,
  type StartRpcServerOptions,
  startRpcServer,
} from './rpc-server'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MENU = { command: 'antigravity', title: 'Antigravity', sections: [] }

function result(text: string): CommandApplyResult {
  return { command: 'antigravity', ok: true, text, menu: MENU }
}

const APPLY: CommandApplyRequest = {
  command: 'antigravity',
  sectionId: 'routing',
  actionId: 'set-routing',
  values: { cliFirst: false },
}

describe('RPC client', () => {
  let dir: string
  let handle: RpcServerHandle | undefined

  const start = async (
    overrides: Partial<StartRpcServerOptions> = {},
  ): Promise<RpcServerHandle> => {
    handle = await startRpcServer({
      dir,
      parseApplyRequest,
      apply: async () => result('ok'),
      drain: () => [],
      ...overrides,
    })
    return handle
  }

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agy-rpc-client-test-'))
    dir = join(parent, 'rpc')
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('discovers the server and performs authenticated apply requests', async () => {
    await start({
      apply: async (request) =>
        result(`${request.sectionId}/${request.actionId}:${request.sessionId}`),
    })
    const client = createRpcClient(dir, process.pid)

    await expect(
      client.apply({ ...APPLY, sessionId: 'session-a' }),
    ).resolves.toEqual(result('routing/set-routing:session-a'))
  })

  it('polls ordered pending notifications for the active session', async () => {
    const notifications: RpcNotification[] = [
      {
        id: 4,
        payload: { command: 'antigravity', menu: MENU },
        sessionId: 'session-a',
      },
      {
        id: 5,
        payload: {
          command: 'antigravity',
          notify: { message: 'quota changed', kind: 'info' },
        },
      },
    ]
    await start({
      drain: (lastReceivedId, sessionId) => {
        expect(lastReceivedId).toBe(3)
        expect(sessionId).toBe('session-a')
        return notifications
      },
    })
    const client = createRpcClient(dir, process.pid)

    await expect(client.pendingNotifications(3, 'session-a')).resolves.toEqual(
      notifications,
    )
  })

  it('refuses a whole batch when any notification envelope is malformed', async () => {
    const valid = {
      id: 1,
      payload: { command: 'antigravity', menu: MENU },
      sessionId: 'session-a',
    }
    let messages: unknown[] = [valid]
    await start({ drain: () => messages as RpcNotification[] })
    const client = createRpcClient(dir, process.pid)
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual([
      valid,
    ])

    for (const invalid of [
      null,
      [],
      { ...valid, id: '1' },
      { ...valid, id: 0 },
      { ...valid, id: -1 },
      { ...valid, id: 1.5 },
      { ...valid, id: 9007199254740992 },
      { ...valid, sessionId: 1 },
      { ...valid, payload: null },
      { ...valid, payload: [] },
      { ...valid, payload: 'menu' },
      // Notifications of the older per-command dialogs had a `type` field; the menu envelope has none, so the client refuses one.
      { ...valid, type: 'open-dialog' },
    ]) {
      messages = [valid, invalid]
      expect({
        invalid,
        received: await client.pendingNotifications(0, 'session-a'),
      }).toEqual({ invalid, received: [] })
    }
  })

  it('resolves undefined when the server is missing', async () => {
    const client = createRpcClient(dir, process.pid)
    await expect(client.apply(APPLY)).resolves.toBeUndefined()
  })

  it('falls back to [] when the server is missing for pending notifications', async () => {
    const client = createRpcClient(dir, process.pid)
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual(
      [],
    )
  })

  it('resolves undefined on a delayed apply with the default two-second timeout', async () => {
    await start({
      apply: async () => {
        await sleep(2_200)
        return result('late')
      },
    })
    const client = createRpcClient(dir, process.pid)

    await expect(client.apply(APPLY)).resolves.toBeUndefined()
  }, 5_000)

  it('resolves undefined on a non-2xx response', async () => {
    let applied = 0
    await start({
      apply: async () => {
        applied += 1
        return result('ok')
      },
    })
    const client = createRpcClient(dir, process.pid)

    // The server refuses the retired request shape with 400.
    await expect(
      client.apply({
        command: 'antigravity-quota',
        arguments: '',
      } as unknown as CommandApplyRequest),
    ).resolves.toBeUndefined()
    expect(applied).toBe(0)
  })

  it('resolves undefined when the answer is not a JSON object', async () => {
    await start({
      apply: async () => 'not a result' as unknown as CommandApplyResult,
    })
    const client = createRpcClient(dir, process.pid)

    await expect(client.apply(APPLY)).resolves.toBeUndefined()
  })

  it('allows a delayed apply when the caller raises the timeout', async () => {
    await start({
      apply: async () => {
        await sleep(2_200)
        return result('complete')
      },
    })
    const client = createRpcClient(dir, process.pid)

    await expect(client.apply(APPLY, { timeoutMs: 5_000 })).resolves.toEqual(
      result('complete'),
    )
  }, 6_000)
})
