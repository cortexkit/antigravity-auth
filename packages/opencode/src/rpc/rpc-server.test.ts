import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseApplyRequest } from '../common-auth-embedded/commands/index.js'
import { writePortFile as writePublicPortFile } from '../common-auth-embedded/rpc/index.js'
import { discoverPortFile } from './port-file'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotification,
} from './protocol'
import {
  type RpcServerHandle,
  type StartRpcServerOptions,
  startRpcServer,
} from './rpc-server'

const APPLY_PATH = '/rpc/apply'
const NOTIFICATIONS_PATH = '/rpc/pending-notifications'

const MENU = { command: 'antigravity', title: 'Antigravity', sections: [] }

function result(text: string): CommandApplyResult {
  return { command: 'antigravity', ok: true, text, menu: MENU }
}

function start(
  dir: string,
  overrides: Partial<StartRpcServerOptions> = {},
): Promise<RpcServerHandle> {
  return startRpcServer({
    dir,
    parseApplyRequest,
    apply: async () => result('ok'),
    drain: () => [],
    ...overrides,
  })
}

const APPLY_BODY: CommandApplyRequest = {
  command: 'antigravity',
  sectionId: 'routing',
  actionId: 'set-routing',
  values: { cliFirst: true },
}

function request(
  handle: RpcServerHandle,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}${path}`, init)
}

describe('RPC server HTTP boundary', () => {
  let dir: string
  let handle: RpcServerHandle | undefined

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agy-rpc-server-test-'))
    dir = join(parent, 'rpc')
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('listens on loopback and publishes discovery only after startup', async () => {
    handle = await start(dir)

    const discovered = await discoverPortFile(dir, process.pid)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(process.pid)
    expect(discovered?.port).toBe(handle.port)
    expect(discovered?.token).toBe(handle.token)
    expect(handle.port).not.toBe(process.pid)
  })

  it('requires the bearer token for both exposed routes', async () => {
    handle = await start(dir)
    const body = JSON.stringify(APPLY_BODY)

    const missing = await request(handle, APPLY_PATH, { method: 'POST', body })
    const wrong = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body,
    })
    const pending = await request(handle, '/rpc/pending-notifications', {
      method: 'POST',
      body: JSON.stringify({ lastReceivedId: 0 }),
    })

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(pending.status).toBe(401)
  })

  it('wraps pending notifications in a messages response', async () => {
    const notification: RpcNotification = {
      id: 4,
      payload: { command: 'antigravity', menu: MENU },
      sessionId: 'session-a',
    }
    handle = await start(dir, {
      drain: (lastReceivedId, sessionId) => {
        expect(lastReceivedId).toBe(3)
        expect(sessionId).toBe('session-a')
        return [notification]
      },
    })

    const response = await request(handle, NOTIFICATIONS_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ lastReceivedId: 3, sessionId: 'session-a' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ messages: [notification] })
  })

  it('hands apply only the parsed menu request and answers its result', async () => {
    const received: CommandApplyRequest[] = []
    handle = await start(dir, {
      apply: async (request) => {
        received.push(request)
        return result('applied')
      },
    })

    const response = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({
        ...APPLY_BODY,
        itemId: 'item-1',
        confirmed: true,
        sessionId: 'session-a',
        unexpected: 'dropped by the parser',
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(result('applied'))
    expect(received).toEqual([
      {
        ...APPLY_BODY,
        itemId: 'item-1',
        confirmed: true,
        sessionId: 'session-a',
      },
    ])
  })

  it('refuses malformed and retired apply bodies before apply runs', async () => {
    let applied = 0
    handle = await start(dir, {
      apply: async () => {
        applied += 1
        return result('ok')
      },
    })
    const bodies = [
      '{}',
      '[]',
      'null',
      '"antigravity"',
      // The older per-command dialog request `{command, arguments}`, which the
      // menu request replaced; the server must refuse it.
      '{"command":"antigravity-quota","arguments":""}',
      '{"command":"antigravity","sectionId":"routing"}',
      '{"command":"antigravity","sectionId":"routing","actionId":7}',
      '{"command":"antigravity","sectionId":"routing","actionId":"a","itemId":3}',
      '{"command":"antigravity","sectionId":"routing","actionId":"a","sessionId":null}',
      '{"command":"antigravity","sectionId":"routing","actionId":"a","confirmed":"yes"}',
      '{"command":"antigravity","sectionId":"routing","actionId":"a","values":[]}',
      '{"command":"antigravity","sectionId":"routing","actionId":"a","values":{"k":{}}}',
    ]

    for (const body of bodies) {
      const response = await request(handle, APPLY_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.token}` },
        body,
      })
      expect({ body, status: response.status }).toEqual({ body, status: 400 })
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid apply request',
      })
    }
    expect(applied).toBe(0)
  })

  it('validates apply bodies only with the injected parser', async () => {
    const parsed: unknown[] = []
    let applied = 0
    handle = await start(dir, {
      parseApplyRequest: (value) => {
        parsed.push(value)
        return undefined
      },
      apply: async () => {
        applied += 1
        return result('ok')
      },
    })

    const response = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
      body: JSON.stringify(APPLY_BODY),
    })

    expect(response.status).toBe(400)
    expect(parsed).toEqual([APPLY_BODY])
    expect(applied).toBe(0)
  })

  it('refuses malformed pending-notification cursors before drain runs', async () => {
    let drained = 0
    handle = await start(dir, {
      drain: () => {
        drained += 1
        return []
      },
    })
    for (const body of [
      '{}',
      '{"lastReceivedId":-1}',
      '{"lastReceivedId":0.5}',
      '{"lastReceivedId":"0"}',
      '{"lastReceivedId":9007199254740992}',
      '{"lastReceivedId":0,"sessionId":null}',
    ]) {
      const response = await request(handle, NOTIFICATIONS_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.token}` },
        body,
      })
      expect({ body, status: response.status }).toEqual({ body, status: 400 })
    }
    expect(drained).toBe(0)
  })

  it('refuses to start without a parser function before creating anything', async () => {
    const { stat } = await import('node:fs/promises')
    for (const parseApplyRequest of [
      undefined,
      null,
      {},
      'parseApplyRequest',
    ]) {
      // A JavaScript caller can omit the option the type requires.
      const options = {
        dir,
        apply: async () => result('ok'),
        drain: () => [],
        ...(parseApplyRequest === undefined ? {} : { parseApplyRequest }),
      } as unknown as StartRpcServerOptions

      await expect(startRpcServer(options)).rejects.toThrow(
        new TypeError(
          'startRpcServer needs parseApplyRequest from the common-auth commands module',
        ),
      )
      // Nothing was published: the RPC directory was never created.
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('returns 404 for non-POST requests and unknown paths', async () => {
    handle = await start(dir)

    const get = await request(handle, APPLY_PATH)
    const unknown = await request(handle, '/rpc/unknown', {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
      body: '{}',
    })

    expect(get.status).toBe(404)
    expect(unknown.status).toBe(404)
  })

  it('serves GET /health without authentication', async () => {
    handle = await start(dir)

    const response = await request(handle, '/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('returns 404 for unknown GET paths', async () => {
    handle = await start(dir)

    const unknown = await request(handle, '/not-a-real-route')
    expect(unknown.status).toBe(404)
  })

  it('rejects invalid JSON and bodies larger than the decimal million-byte cap', async () => {
    handle = await start(dir)
    const headers = { authorization: `Bearer ${handle.token}` }

    const invalid = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers,
      body: '{nope',
    })
    const oversized = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: 'x'.repeat(1_000_000) }),
    })

    expect(invalid.status).toBe(400)
    expect(oversized.status).toBe(413)
  })

  it('stops idempotently and removes only its own PID file', async () => {
    handle = await start(dir)
    const ownFile = join(dir, `port-${process.pid}.json`)
    const otherFile = join(dir, `port-${process.ppid}.json`)
    await writePublicPortFile(
      dir,
      {
        pid: process.ppid,
        port: 49_999,
        token: 'other',
      },
      { secureDir: true },
    )

    await handle.stop()
    await handle.stop()

    const { stat } = await import('node:fs/promises')
    await expect(stat(ownFile)).rejects.toThrow()
    await expect(stat(otherFile)).resolves.toBeDefined()
    await expect(
      fetch(`http://127.0.0.1:${handle.port}${APPLY_PATH}`),
    ).rejects.toThrow()
    handle = undefined
  })
})
