import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverPortFile, writePortFile } from './port-file'
import { type RpcServerHandle, startRpcServer } from './rpc-server'

const APPLY_PATH = '/rpc/apply'

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

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'agy-rpc-server-test-')), 'rpc')
  })

  afterEach(async () => {
    await handle?.stop()
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('listens on loopback and publishes discovery only after startup', async () => {
    handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })

    const discovered = discoverPortFile(dir, process.pid)
    expect(discovered).toEqual({
      pid: process.pid,
      port: handle.port,
      token: handle.token,
    })
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
    writePortFile(dir, { pid: process.ppid, port: 49_999, token: 'other' })

    await handle.stop()
    await handle.stop()

    expect(existsSync(ownFile)).toBe(false)
    expect(existsSync(otherFile)).toBe(true)
    await expect(
      fetch(`http://127.0.0.1:${handle.port}${APPLY_PATH}`),
    ).rejects.toThrow()
    handle = undefined
  })
})
