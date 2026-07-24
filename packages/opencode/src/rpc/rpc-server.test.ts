import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverPortFile, writePortFile } from './port-file'
import { type RpcServerHandle, startRpcServer } from './rpc-server'

const APPLY_PATH = '/rpc/apply'
const NOTIFICATIONS_PATH = '/rpc/pending-notifications'

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
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })

    const discovered = await discoverPortFile(dir, process.pid)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(process.pid)
    expect(discovered?.port).toBe(handle.port)
    expect(discovered?.token).toBe(handle.token)
    expect(handle.port).not.toBe(process.pid)
  })

  it('requires the bearer token for both exposed routes', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })
    const body = JSON.stringify({
      command: 'antigravity-quota',
      arguments: '',
    })

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
    const notification = {
      id: 4,
      type: 'open-dialog' as const,
      payload: {
        command: 'antigravity-quota' as const,
        text: 'quota changed',
        knobs: {},
      },
      sessionId: 'session-a',
    }
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
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

  it('returns 404 for non-POST requests and unknown paths', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })

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
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })

    const response = await request(handle, '/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('returns 404 for unknown GET paths', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })

    const unknown = await request(handle, '/not-a-real-route')
    expect(unknown.status).toBe(404)
  })

  it('rejects invalid JSON and bodies larger than one MiB', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })
    const headers = { authorization: `Bearer ${handle.token}` }

    const invalid = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers,
      body: '{nope',
    })
    const oversized = await request(handle, APPLY_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
    })

    expect(invalid.status).toBe(400)
    expect(oversized.status).toBe(413)
  })

  it('stops idempotently and removes only its own PID file', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })
    const ownFile = join(dir, `port-${process.pid}.json`)
    const otherFile = join(dir, `port-${process.ppid}.json`)
    await writePortFile(dir, {
      pid: process.ppid,
      port: 49_999,
      token: 'other',
    })

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
