import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RpcNotification } from './protocol'
import { createRpcClient } from './rpc-client'
import { type RpcServerHandle, startRpcServer } from './rpc-server'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('RPC client', () => {
  let dir: string
  let handle: RpcServerHandle | undefined

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agy-rpc-client-test-'))
    dir = join(parent, 'rpc')
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('discovers the server and performs authenticated apply requests', async () => {
    handle = await startRpcServer({
      dir,
      apply: async (request) => ({
        text: `${request.command}:${request.arguments}`,
        knobs: { sessionId: request.sessionId },
      }),
      drain: () => [],
    })
    const client = createRpcClient(dir, process.pid)

    await expect(
      client.apply({
        command: 'antigravity-routing',
        arguments: 'primary',
        sessionId: 'session-a',
      }),
    ).resolves.toEqual({
      text: 'antigravity-routing:primary',
      knobs: { sessionId: 'session-a' },
    })
  })

  it('polls ordered pending notifications for the active session', async () => {
    const notifications: RpcNotification[] = [
      {
        id: 4,
        type: 'open-dialog',
        payload: {
          command: 'antigravity-quota',
          text: 'quota changed',
          knobs: {},
        },
        sessionId: 'session-a',
      },
    ]
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
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

  it('falls back to { text: apply failed } when the server is missing', async () => {
    // No startRpcServer — discoverPortFile returns null.
    const client = createRpcClient(dir, process.pid)
    await expect(
      client.apply({ command: 'antigravity-quota', arguments: '' }),
    ).resolves.toEqual({ text: 'apply failed', knobs: {} })
  })

  it('falls back to [] when the server is missing for pending notifications', async () => {
    const client = createRpcClient(dir, process.pid)
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual(
      [],
    )
  })

  it('falls back to { text: apply failed } on a delayed apply with the default two-second timeout', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => {
        await sleep(2_200)
        return { text: 'late', knobs: {} }
      },
      drain: () => [],
    })
    const client = createRpcClient(dir, process.pid)

    await expect(
      client.apply({ command: 'antigravity-quota', arguments: '' }),
    ).resolves.toEqual({ text: 'apply failed', knobs: {} })
  }, 5_000)

  it('falls back to { text: apply failed } on a non-2xx response', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => {
        throw new Error('handler failed')
      },
      drain: () => [],
    })
    // Drain via raw fetch with a wrong token so the server replies 401.
    const probe = await fetch(`http://127.0.0.1:${handle.port}/rpc/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify({ command: 'antigravity-quota', arguments: '' }),
    })
    expect(probe.status).toBe(401)

    const client = createRpcClient(dir, process.pid)
    await expect(
      client.apply({ command: 'antigravity-quota', arguments: '' }),
    ).resolves.toEqual({ text: 'apply failed', knobs: {} })
  })

  it('allows a delayed apply when the caller raises the timeout', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => {
        await sleep(2_200)
        return { text: 'complete', knobs: {} }
      },
      drain: () => [],
    })
    const client = createRpcClient(dir, process.pid)

    await expect(
      client.apply(
        { command: 'antigravity-quota', arguments: '' },
        { timeoutMs: 5_000 },
      ),
    ).resolves.toEqual({ text: 'complete', knobs: {} })
  }, 6_000)
})
