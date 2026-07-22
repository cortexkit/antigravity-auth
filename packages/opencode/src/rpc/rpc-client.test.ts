import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'agy-rpc-client-test-')), 'rpc')
  })

  afterEach(async () => {
    await handle?.stop()
    rmSync(join(dir, '..'), { recursive: true, force: true })
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
        command: 'antigravity-quota',
        text: 'quota changed',
        knobs: {},
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

  it('aborts delayed apply with the default two-second timeout', async () => {
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
    ).rejects.toThrow()
  }, 5_000)

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
