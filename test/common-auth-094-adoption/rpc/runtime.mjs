import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createServer as httpServer, request } from 'node:http'
import { connect, createServer as netServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const mode = process.argv[3]
const load = (path) => import(pathToFileURL(join(root, path)).href)
const { startRpcServer } = await load('rpc/rpc-server.js')
const { createRpcClient } = await load('rpc/rpc-client.js')
const { discoverPortFile } = await load('rpc/port-file.js')
const publicRpc = await load('common-auth-embedded/rpc/index.js')
const publicClient = await load('common-auth-embedded/rpc/client.js')
const applyRequest = { command: 'antigravity-quota', arguments: '' }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const dirFor = async (name) => {
  const dir = join(root, 'state', name)
  await mkdir(dir, { recursive: true })
  return dir
}
const wire = (handle, path, body, token = handle.token) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: handle.port,
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
const applyWire = (handle, body = JSON.stringify(applyRequest)) =>
  wire(handle, '/rpc/apply', body)

// Child liveness is observed by the parent, not by a timer in this process.
if (mode?.startsWith('lifetime:')) {
  const kind = mode.slice('lifetime:'.length)
  const entered = deferred()
  const dir = await dirFor(`lifetime-${kind}`)
  const handle = await startRpcServer({
    dir,
    apply: () => {
      entered.resolve()
      return kind === 'completed'
        ? { text: 'ok', knobs: {} }
        : new Promise(() => {})
    },
    drain: () => {
      entered.resolve()
      return new Promise(() => {})
    },
  })
  const socket = connect(handle.port, '127.0.0.1')
  const body =
    kind === 'drain' ? '{"lastReceivedId":0}' : JSON.stringify(applyRequest)
  const path = kind === 'drain' ? 'pending-notifications' : 'apply'
  socket.on('error', () => {})
  socket.on('data', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(
    `POST /rpc/${path} HTTP/1.0\r\nAuthorization: Bearer ${handle.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
  await entered.promise
  socket.destroy()
  await handle.stop()
  await assert.rejects(stat(join(dir, `port-${process.pid}.json`)))
  console.log(
    JSON.stringify({
      reached: kind,
      closed: true,
      stopped: true,
      portRemoved: true,
    }),
  )
} else {
  const rows = []
  const run = async (name, fn) => {
    let timer
    try {
      const observation = await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name}: case did not terminate`)),
            15000,
          )
        }),
      ])
      rows.push({ name, ok: true, observation: observation ?? 'reached' })
    } catch (error) {
      rows.push({ name, ok: false, error: String(error.stack ?? error) })
      process.exitCode = 1
    } finally {
      clearTimeout(timer)
    }
  }
  await run('rpc.auth_validation', async () => {
    let effects = 0
    const seen = []
    const handle = await startRpcServer({
      dir: await dirFor('validation'),
      apply: (value) => {
        effects++
        seen.push(value)
        return { text: 'ok', knobs: {} }
      },
      drain: (cursor, sessionId) => {
        effects++
        seen.push({ cursor, sessionId })
        return []
      },
    })
    try {
      for (const path of ['/rpc/apply', '/rpc/pending-notifications']) {
        for (const token of ['', 'wrong']) {
          const out = await wire(handle, path, '{broken', token)
          assert.equal(out.status, 401)
        }
        const bodies = [
          '',
          '{}',
          '[]',
          'null',
          '"secret-token"',
          '{bad',
          ...(path.endsWith('apply')
            ? [
                '{"command":"unknown","arguments":""}',
                '{"command":"antigravity-quota"}',
                '{"command":"antigravity-quota","arguments":7}',
                '{"command":"antigravity-quota","arguments":"","sessionId":null}',
              ]
            : [
                '{"lastReceivedId":-1}',
                '{"lastReceivedId":0.1}',
                '{"lastReceivedId":9007199254740992}',
                '{"lastReceivedId":"0"}',
                '{"lastReceivedId":0,"sessionId":null}',
              ]),
        ]
        for (const body of bodies) {
          const out = await wire(handle, path, body)
          assert.equal(out.status, 400, `${path}: ${body}`)
          assert(!JSON.stringify(out).includes('secret-token'))
        }
      }
      assert.equal(effects, 0)
      for (const sessionId of [undefined, '', 'session-a']) {
        assert.equal(
          (
            await applyWire(
              handle,
              JSON.stringify({ ...applyRequest, sessionId }),
            )
          ).status,
          200,
        )
        assert.equal(
          (
            await wire(
              handle,
              '/rpc/pending-notifications',
              JSON.stringify({ lastReceivedId: 0, sessionId }),
            )
          ).status,
          200,
        )
      }
      assert.equal(effects, 6)
      assert.deepEqual(
        seen.filter((_, i) => i % 2 === 1).map((v) => v.sessionId),
        [undefined, '', 'session-a'],
      )
      for (const command of [
        'antigravity-quota',
        'antigravity-account',
        'antigravity-routing',
        'antigravity-killswitch',
        'antigravity-dump',
        'antigravity-logging',
      ]) {
        assert.equal(
          (await applyWire(handle, JSON.stringify({ command, arguments: '' })))
            .status,
          200,
        )
      }
      assert.equal(effects, 12)
      assert.equal(
        (await wire(handle, '/rpc/unknown', '{bad', 'wrong')).status,
        401,
      )
      assert.equal((await wire(handle, '/rpc/unknown', '{bad')).status, 400)
      assert.equal((await wire(handle, '/rpc/unknown', '{}')).status, 404)
      return { invalidEffects: 0, validEffects: effects }
    } finally {
      await handle.stop()
    }
  })
  await run('identity.rpc_error', async () => {
    const handle = await startRpcServer({
      dir: await dirFor('identity'),
      drain: () => [],
      apply: () => {
        throw new publicRpc.RpcRequestError(409, 'refused')
      },
    })
    try {
      assert.deepEqual(await applyWire(handle), {
        status: 409,
        body: { error: 'refused' },
      })
    } finally {
      await handle.stop()
    }
  })
  await run('identity.client_public_objects', async () => {
    assert.equal(publicRpc.createRpcClient, publicClient.createRpcClient)
    assert.equal(publicRpc.discoverPortFile, publicClient.discoverPortFile)
    assert.equal(
      publicRpc.DEFAULT_RPC_TIMEOUT_MS,
      publicClient.DEFAULT_RPC_TIMEOUT_MS,
    )
    // Both public entry points must expose the same cached client factory and
    // discovery function, rather than cloned or query-qualified instances.
    const source = await readFile(join(root, 'rpc/rpc-client.js'), 'utf8')
    assert.match(
      source,
      /from ['"]\.\.\/common-auth-embedded\/rpc\/client\.js['"]/,
    )
    assert(!/from ['"][^'"]+\?/.test(source))
  })
  await run('rpc.strict_pid', async () => {
    let effects = 0
    const dir = await dirFor('pid')
    const handle = await startRpcServer({
      dir,
      drain: () => [],
      apply: () => {
        effects++
        return { text: 'ok', knobs: {} }
      },
    })
    try {
      for (const pid of [undefined, process.ppid, 99999999]) {
        assert.deepEqual(await createRpcClient(dir, pid).apply(applyRequest), {
          text: 'apply failed',
          knobs: {},
        })
        assert.deepEqual(
          await createRpcClient(dir, pid).pendingNotifications(0),
          [],
        )
      }
      assert.equal(effects, 0)
      assert.equal(
        (await createRpcClient(dir, process.pid).apply(applyRequest)).text,
        'ok',
      )
      assert.equal(effects, 1)
    } finally {
      await handle.stop()
    }
  })
  await run('rpc.port_wrapper', async () => {
    const dir = await dirFor('port-wrapper')
    await chmod(dir, 0o755)
    const handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => [],
    })
    try {
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      assert.equal(await discoverPortFile(dir), null)
      assert.equal(await discoverPortFile(dir, process.ppid), null)
      assert.equal((await discoverPortFile(dir, process.pid)).port, handle.port)
      await chmod(dir, 0o755)
      await discoverPortFile(dir, process.pid)
      assert.equal((await stat(dir)).mode & 0o777, 0o755)
      const portModule = await load('rpc/port-file.js')
      assert(!('writePortFile' in portModule))
      assert(
        !(await readFile(join(root, 'rpc/port-file.js'), 'utf8')).includes(
          'secureDir',
        ),
      )
    } finally {
      await handle.stop()
    }
  })
  await run('rpc.stage_security', async () => {
    const dir = await dirFor('stage')
    const target = join(dir, `port-${process.pid}.json`)
    const stage = `${target}.collision.tmp`
    await writeFile(stage, 'owned by another writer')
    await assert.rejects(
      publicRpc.writePortFile(
        dir,
        { pid: process.pid, port: 12345, token: 'fake' },
        { secureDir: true, stageName: () => 'collision' },
      ),
      { code: 'EEXIST' },
    )
    assert.equal(await readFile(stage, 'utf8'), 'owned by another writer')
    await unlink(stage)
    await publicRpc.writePortFile(
      dir,
      { pid: process.pid, port: 12345, token: 'fake' },
      { secureDir: true },
    )
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    await unlink(target)
    await mkdir(target)
    await assert.rejects(
      publicRpc.writePortFile(
        dir,
        { pid: process.pid, port: 12345, token: 'fake' },
        { secureDir: true, stageName: () => 'owned' },
      ),
    )
    assert.deepEqual(await readdir(dir), [`port-${process.pid}.json`])
  })
  await run('rpc.async_drain', async () => {
    const handle = await startRpcServer({
      dir: await dirFor('async'),
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: async (cursor, sessionId) => {
        await delay(40)
        return [
          {
            id: cursor + 1,
            type: 'open-dialog',
            sessionId,
            payload: {
              command: 'antigravity-account',
              text: 'ready',
              knobs: { diagnostic: 4 },
            },
          },
        ]
      },
    })
    try {
      const out = await wire(
        handle,
        '/rpc/pending-notifications',
        '{"lastReceivedId":5,"sessionId":""}',
      )
      assert.equal(out.status, 200)
      assert.deepEqual(out.body.messages, [
        {
          id: 6,
          type: 'open-dialog',
          sessionId: '',
          payload: {
            command: 'antigravity-account',
            text: 'ready',
            knobs: { diagnostic: 4 },
          },
        },
      ])
    } finally {
      await handle.stop()
    }
    let entered = false
    const failing = await startRpcServer({
      dir: await dirFor('async-failure'),
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: async () => {
        entered = true
        await delay(20)
        throw new Error('fake-secret-must-not-reach-wire')
      },
    })
    try {
      const out = await wire(
        failing,
        '/rpc/pending-notifications',
        '{"lastReceivedId":0}',
      )
      assert.equal(entered, true)
      assert.deepEqual(out, { status: 500, body: { error: 'drain failed' } })
      return { awaited: true, failureEntered: entered, sanitizedFailure: out }
    } finally {
      await failing.stop()
    }
  })
  await run('rpc.shutdown_ownership', async () => {
    const entered = deferred()
    const drainEntered = deferred()
    const dir = await dirFor('shutdown')
    const handle = await startRpcServer({
      dir,
      apply: () => {
        entered.resolve()
        return new Promise(() => {})
      },
      drain: () => {
        drainEntered.resolve()
        return new Promise(() => {})
      },
    })
    const sockets = []
    const closes = []
    for (const kind of ['partial', 'body', 'apply', 'pending-notifications']) {
      const socket = connect(handle.port, '127.0.0.1')
      socket.on('error', () => {})
      socket.on('data', () => {})
      sockets.push(socket)
      closes.push(new Promise((resolve) => socket.once('close', resolve)))
      await new Promise((resolve) => socket.once('connect', resolve))
      const body =
        kind === 'pending-notifications'
          ? '{"lastReceivedId":0}'
          : JSON.stringify(applyRequest)
      socket.write(
        kind === 'partial'
          ? 'POST /rpc/apply HTTP/1.1\r\nHost: '
          : `POST /rpc/${kind === 'body' ? 'apply' : kind} HTTP/1.0\r\nAuthorization: Bearer ${handle.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${kind === 'body' ? '{' : body}`,
      )
    }
    try {
      await Promise.all([entered.promise, drainEntered.promise])
      const file = join(dir, `port-${process.pid}.json`)
      await writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          port: handle.port,
          token: 'other-token',
        }),
      )
      const stopping = handle.stop()
      assert.equal(handle.stop(), stopping)
      await Promise.race([
        stopping,
        delay(1000).then(() => {
          throw new Error('reached stop did not resolve')
        }),
      ])
      await Promise.race([
        Promise.all(closes),
        delay(500).then(() => {
          throw new Error('tracked peers still open')
        }),
      ])
      assert.equal(
        JSON.parse(await readFile(file, 'utf8')).token,
        'other-token',
      )
      await handle.stop()
      return {
        entered: ['apply', 'drain'],
        closed: sockets.length,
        coalesced: true,
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      await handle.stop()
    }
  })
  await run('rpc.notification_narrowing', async () => {
    const commands = [
      'antigravity-quota',
      'antigravity-account',
      'antigravity-routing',
      'antigravity-killswitch',
      'antigravity-dump',
      'antigravity-logging',
    ]
    let messages = commands.map((command, i) => ({
      id: i + 1,
      type: 'open-dialog',
      ...(i === 5 ? {} : { sessionId: i === 0 ? '' : `session-${i}` }),
      payload: { command, text: 'text', knobs: { count: i } },
    }))
    const handle = await startRpcServer({
      dir: await dirFor('narrowing'),
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: () => messages,
    })
    const client = createRpcClient(join(root, 'state/narrowing'), process.pid)
    try {
      assert.deepEqual(await client.pendingNotifications(0), messages)
      const valid = messages[0]
      for (const invalid of [
        null,
        [],
        { ...valid, id: '1' },
        { ...valid, id: -1 },
        { ...valid, id: 9007199254740992 },
        { ...valid, type: 'unknown' },
        { ...valid, sessionId: 1 },
        { ...valid, payload: null },
        { ...valid, payload: { ...valid.payload, command: 'unknown' } },
        { ...valid, payload: { ...valid.payload, text: 7 } },
        { ...valid, payload: { ...valid.payload, knobs: [] } },
      ]) {
        messages = [valid, invalid]
        assert.deepEqual(await client.pendingNotifications(0), [])
      }
    } finally {
      await handle.stop()
    }
  })
  await run('rpc.timeout_zero', async () => {
    const nonzero = (await load('rpc/server-nonzero.js')).startRpcServer
    const observations = []
    for (const [label, factory] of [
      ['zero', startRpcServer],
      ['nonzero', nonzero],
    ]) {
      const handles = []
      try {
        const tasks = ['apply', 'drain'].map(async (kind) => {
          let reached = false
          const dir = await dirFor(`idle-${label}-${kind}`)
          const handle = await factory({
            dir,
            apply: async () => {
              reached = true
              await delay(6500)
              return { text: 'finished', knobs: {} }
            },
            drain: async () => {
              reached = true
              await delay(6500)
              return []
            },
          })
          handles.push(handle)
          const before = performance.now()
          const client = createRpcClient(dir, process.pid)
          const out =
            kind === 'apply'
              ? await client.apply(applyRequest, { timeoutMs: 10000 })
              : await wire(
                  handle,
                  '/rpc/pending-notifications',
                  '{"lastReceivedId":0}',
                ).catch(() => null)
          const elapsedMs = Math.round(performance.now() - before)
          assert(reached)
          if (label === 'zero') {
            assert(elapsedMs >= 6400 && elapsedMs < 10000)
            assert.deepEqual(
              kind === 'apply' ? out : out.body,
              kind === 'apply'
                ? { text: 'finished', knobs: {} }
                : { messages: [] },
            )
          } else {
            assert(
              elapsedMs >= 1000 && elapsedMs < 6200,
              `${kind} idle cutoff: ${elapsedMs}ms`,
            )
            assert.deepEqual(
              out,
              kind === 'apply' ? { text: 'apply failed', knobs: {} } : null,
            )
          }
          observations.push({ label, kind, reached, elapsedMs })
        })
        await Promise.all(tasks)
      } finally {
        await Promise.all(handles.map((h) => h.stop()))
      }
    }
    return observations
  })
  const shortServer = (await load('rpc/server-short.js')).startRpcServer
  await run('rpc.live_504', async () => {
    let reached = 0
    const dir = await dirFor('live504')
    const handle = await shortServer({
      dir,
      drain: () => [],
      apply: () => {
        reached++
        return new Promise(() => {})
      },
    })
    try {
      const before = performance.now()
      const response = await Promise.race([
        applyWire(handle),
        delay(800).then(() => {
          throw new Error(`live 504 missing after reached apply: ${reached}`)
        }),
      ])
      assert.deepEqual(response, {
        status: 504,
        body: { error: 'handler deadline exceeded' },
      })
      assert.deepEqual(
        await createRpcClient(dir, process.pid).apply(applyRequest, {
          timeoutMs: 2000,
        }),
        { text: 'apply failed', knobs: {} },
      )
      const elapsedMs = Math.round(performance.now() - before)
      assert(elapsedMs >= 250 && elapsedMs < 1800)
      assert.equal(reached, 2)
      return { reached, elapsedMs }
    } finally {
      await handle.stop()
    }
  })
  await run('rpc.callback_noncancel', async () => {
    const observations = []
    for (const kind of ['504', 'client-close', 'stop']) {
      const entered = deferred()
      const effect = deferred()
      let effects = 0
      const dir = await dirFor(`effect-${kind}`)
      const handle = await shortServer({
        dir,
        drain: () => [],
        apply: async () => {
          entered.resolve()
          await delay(350)
          effects++
          effect.resolve()
          return { text: 'late', knobs: {} }
        },
      })
      const response =
        kind === 'client-close'
          ? createRpcClient(dir, process.pid).apply(applyRequest, {
              timeoutMs: 30,
            })
          : applyWire(handle).catch(() => null)
      try {
        await entered.promise
        if (kind === '504') assert.equal((await response).status, 504)
        else if (kind === 'stop') await handle.stop()
        else {
          assert.deepEqual(await response, { text: 'apply failed', knobs: {} })
        }
        await Promise.race([
          effect.promise,
          delay(1000).then(() => {
            throw new Error('entered callback effect was cancelled')
          }),
        ])
        assert(effects >= 1)
        observations.push({ kind, effects })
      } finally {
        await handle.stop()
        await response
      }
    }
    const entered = deferred(),
      effect = deferred()
    let effects = 0
    const dir = await dirFor('effect-drain')
    const handle = await startRpcServer({
      dir,
      apply: async () => ({ text: 'ok', knobs: {} }),
      drain: async () => {
        entered.resolve()
        await delay(350)
        effects++
        effect.resolve()
        return []
      },
    })
    try {
      const pending = createRpcClient(dir, process.pid).pendingNotifications(
        0,
        '',
        { timeoutMs: 30 },
      )
      await entered.promise
      assert.deepEqual(await pending, [])
      await handle.stop()
      await Promise.race([
        effect.promise,
        delay(1000).then(() => {
          throw new Error('entered drain effect was cancelled')
        }),
      ])
      assert.equal(effects, 1)
      observations.push({ kind: 'drain-client-close-stop', effects })
    } finally {
      await handle.stop()
    }
    return observations
  })
  await run('rpc.lifetime_after_stop', async () => {
    const observations = []
    for (const kind of ['apply', 'completed', 'drain']) {
      const before = performance.now()
      const child = spawn(
        process.execPath,
        [process.argv[1], root, `lifetime:${kind}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (v) => {
        stdout += v
      })
      child.stderr.on('data', (v) => {
        stderr += v
      })
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 2500)
      const exit = await new Promise((resolve) => child.once('exit', resolve))
      clearTimeout(timeout)
      assert.equal(
        timedOut,
        false,
        `referenced work retained ${kind}: ${stdout} ${stderr}`,
      )
      assert.equal(exit, 0, stderr)
      assert.deepEqual(JSON.parse(stdout), {
        reached: kind,
        closed: true,
        stopped: true,
        portRemoved: true,
      })
      observations.push({
        kind,
        elapsedMs: Math.round(performance.now() - before),
        naturalExit: true,
      })
    }
    return observations
  })

  let recorderCount = 0
  const recorder = httpServer((req, res) => {
    recorderCount++
    req.resume()
    res.end('recorded')
  })
  await new Promise((resolve) => recorder.listen(0, '127.0.0.1', resolve))
  const proxy = `http://127.0.0.1:${recorder.address().port}`
  await run('rpc.recorder_witness', async () => {
    // Deliberately address the recorder with proxy-shaped HTTP traffic.
    await new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: recorder.address().port,
          path: 'http://example.invalid/control',
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(recorderCount, 1)
  })
  await run('rpc.no_proxy', async () => {
    const beforeCount = recorderCount
    const keys = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ]
    const saved = keys.map((key) => process.env[key])
    let entered = 0
    const dir = await dirFor('proxy')
    const handle = await startRpcServer({
      dir,
      apply: async () => {
        entered++
        return { text: 'direct', knobs: {} }
      },
      drain: () => [],
    })
    try {
      for (const key of keys)
        process.env[key] = key.toLowerCase() === 'no_proxy' ? '' : proxy
      assert.equal(
        (await createRpcClient(dir, process.pid).apply(applyRequest)).text,
        'direct',
      )
      assert.deepEqual(
        await createRpcClient(dir, process.pid).pendingNotifications(0),
        [],
      )
      assert.equal(entered, 1)
      assert.equal(recorderCount, beforeCount)
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]
        else process.env[key] = saved[i]
      })
      await handle.stop()
    }
  })
  await new Promise((resolve) => recorder.close(resolve))
  await run('rpc.client_deadline_socket_close', async () => {
    const observations = []
    for (const kind of [
      'delayed',
      'stalled',
      'drip',
      'malformed',
      'oversized-header',
      'oversized-body',
      'oversized-body-stream',
      'malformed-json',
      'truncated',
      'non2xx',
    ]) {
      const entered = deferred(),
        closed = deferred()
      let peer, drip
      const server = netServer((socket) => {
        peer = socket
        socket.on('error', () => {})
        socket.on('close', () => {
          clearInterval(drip)
          closed.resolve()
        })
        socket.once('data', () => {
          entered.resolve()
          if (kind === 'delayed') return
          if (kind === 'stalled')
            socket.write('HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\n{')
          if (kind === 'drip') {
            socket.write('HTTP/1.0 200 OK\r\nContent-Length: 1000\r\n\r\n')
            drip = setInterval(() => socket.write(' '), 20)
          }
          if (kind === 'malformed') socket.write('BOGUS\r\n\r\n{}')
          if (kind === 'oversized-header')
            socket.write(`HTTP/1.0 200 OK\r\nX-Huge: ${'x'.repeat(17000)}`)
          if (kind === 'oversized-body')
            socket.write('HTTP/1.0 200 OK\r\nContent-Length: 8388609\r\n\r\n')
          if (kind === 'oversized-body-stream')
            socket.write(`HTTP/1.0 200 OK\r\n\r\n${' '.repeat(8388609)}`)
          if (kind === 'malformed-json')
            socket.write('HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{x')
          if (kind === 'truncated')
            socket.end('HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\n{}')
          if (kind === 'non2xx')
            socket.write(
              'HTTP/1.0 500 Internal Error\r\nContent-Length: 2\r\n\r\n{}',
            )
        })
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const dir = await dirFor(`deadline-${kind}`)
      await publicRpc.writePortFile(
        dir,
        { pid: process.pid, port: server.address().port, token: 'fake' },
        { secureDir: true },
      )
      try {
        const before = performance.now()
        const response = createRpcClient(dir, process.pid).apply(applyRequest, {
          timeoutMs: 180,
        })
        await entered.promise
        assert.deepEqual(await response, { text: 'apply failed', knobs: {} })
        await Promise.race([
          closed.promise,
          delay(500).then(() => {
            throw new Error(`${kind}: socket still open`)
          }),
        ])
        const elapsedMs = Math.round(performance.now() - before)
        assert(elapsedMs < 650)
        if (kind.startsWith('oversized') || kind.startsWith('malformed'))
          assert(
            elapsedMs < 160,
            `${kind}: rejection fell back to the deadline`,
          )
        observations.push({ kind, reached: true, closed: true, elapsedMs })
      } finally {
        clearInterval(drip)
        peer?.destroy()
        await new Promise((resolve) => server.close(resolve))
      }
    }
    return observations
  })
  await run('rpc.deadlines', async () => {
    // Check the adapter's configured budgets here. The separate timeout_zero
    // case measures idle behavior, live_504 measures the apply deadline, and
    // client_deadline_socket_close measures the full client-response deadline.
    const source = await readFile(join(root, 'rpc/rpc-server.js'), 'utf8')
    assert.match(source, /receiptTimeoutMs: 2_?000/)
    assert.match(source, /applyDeadlineMs: 120_?000/)
    assert.match(source, /timeoutMs: 0/)
  })
  console.log(
    JSON.stringify({
      runtime: process.version,
      bun: process.versions.bun ?? null,
      rows,
    }),
  )
}
