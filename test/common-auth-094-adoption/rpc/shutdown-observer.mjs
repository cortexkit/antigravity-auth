import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'

// This observer never sends bytes, resolves a case promise, or adds a timer.
// Wrapped calls synchronously record their inputs and delegate the originals.
const root = process.argv[2]
const config = JSON.parse(
  readFileSync(join(root, 'observer-config.receipt'), 'utf8'),
)
assert.equal(process.versions.bun, '1.3.14')
const started = performance.now()
const events = []
const sockets = []
const socketStates = new WeakMap()
const requestStates = new WeakMap()
const sources = []
const capturedSources = new WeakSet()
const labels = [
  'partial-headers',
  'partial-body',
  'entered-apply',
  'entered-async-drain',
]
let clients = 0
let requests = 0
let serverConnections = 0
let cleanupStarted
let row
const time = () => Number((performance.now() - started).toFixed(3))
const get = (object, key) => {
  try {
    return object[key]
  } catch {
    return undefined
  }
}
const event = (kind, data = {}) =>
  events.push({ sequence: events.length + 1, ms: time(), kind, ...data })
const stack = () =>
  String(new Error().stack ?? '')
    .split('\n')
    .slice(2, 12)
    .join('\n')
const endpoints = (socket) => ({
  localAddress: get(socket, 'localAddress'),
  localPort: get(socket, 'localPort'),
  remoteAddress: get(socket, 'remoteAddress'),
  remotePort: get(socket, 'remotePort'),
})
const labelFor = (state) =>
  state.role === 'client'
    ? state.label
    : sockets.find(
        (client) =>
          client.role === 'client' &&
          client.endpoints.localPort === state.endpoints.remotePort,
      )?.label
const snapshot = () =>
  sockets.map((state) => ({
    id: state.id,
    role: state.role,
    label: labelFor(state),
    endpoints: state.endpoints,
    destroyed: get(state.socket, 'destroyed'),
    readableEnded: get(state.socket, 'readableEnded'),
    writableEnded: get(state.socket, 'writableEnded'),
    endAt: state.endAt,
    closeAt: state.closeAt,
    fixtureDestroyAt: state.fixtureDestroyAt,
    destroyCalls: state.destroyCalls,
  }))

function sourceOf(name, fn) {
  if (typeof fn !== 'function' || capturedSources.has(fn)) return
  capturedSources.add(fn)
  const text = Function.prototype.toString.call(fn)
  sources.push({
    name,
    authority:
      'Function.prototype.toString observation of the pinned executable',
    opaqueNativePlaceholder: text.includes('[native code]'),
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
  })
}

function sourcePrototype(name, prototype) {
  for (const key of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    sourceOf(`${name}.${key}`, descriptor.value)
    sourceOf(`${name}.get ${key}`, descriptor.get)
    sourceOf(`${name}.set ${key}`, descriptor.set)
  }
}

sourceOf('http.Server constructor', http.Server)
sourcePrototype('http.Server.prototype', http.Server.prototype)
sourcePrototype(
  'http.IncomingMessage.prototype',
  http.IncomingMessage.prototype,
)
sourcePrototype('http.ServerResponse.prototype', http.ServerResponse.prototype)
sourcePrototype('net.Socket.prototype', net.Socket.prototype)

const originalNetEmit = net.Socket.prototype.emit
sourceOf('original net.Socket.emit', originalNetEmit)
let observedNetEmit

function socketEvent(state, name, args, layer) {
  if (
    !['connect', 'data', 'end', 'close', 'error', 'finish', 'timeout'].includes(
      name,
    )
  )
    return
  if (name === 'end') state.endAt ??= time()
  if (name === 'close') state.closeAt ??= time()
  event(`socket.${name}`, {
    id: state.id,
    role: state.role,
    label: labelFor(state),
    layer,
    afterFixtureCleanup: cleanupStarted !== undefined,
    bytes: name === 'data' ? args[0]?.byteLength : undefined,
    code: name === 'error' ? args[0]?.code : undefined,
    hadError: name === 'close' ? args[0] : undefined,
  })
}

function observeSocket(socket, role) {
  if (
    socket === null ||
    (typeof socket !== 'object' && typeof socket !== 'function')
  ) {
    event('socket.unavailable', { role })
    return { id: null, role }
  }
  if (socketStates.has(socket)) return socketStates.get(socket)
  const state = {
    id: sockets.length + 1,
    role,
    socket,
    endpoints: endpoints(socket),
    destroyCalls: 0,
    label: role === 'client' ? labels[clients++] : undefined,
  }
  socketStates.set(socket, state)
  sockets.push(state)
  sourcePrototype(
    `${role} socket ${socket.constructor?.name}`,
    Object.getPrototypeOf(socket),
  )
  event('socket.observed', {
    id: state.id,
    role,
    label: labelFor(state),
    endpoints: state.endpoints,
  })
  const originalDestroy = socket.destroy
  sourceOf(`${role} socket.destroy`, originalDestroy)
  if (typeof originalDestroy === 'function')
    socket.destroy = function (...args) {
      const origin = stack()
      const fixtureCleanup = origin.includes(
        `shutdown-case.mjs:${config.cleanupLine}:`,
      )
      if (fixtureCleanup) {
        cleanupStarted ??= time()
        state.fixtureDestroyAt ??= time()
      }
      state.destroyCalls++
      event('socket.destroy.call', {
        id: state.id,
        role,
        label: labelFor(state),
        fixtureCleanup,
        origin,
        before: { destroyed: get(socket, 'destroyed'), closeAt: state.closeAt },
      })
      return Reflect.apply(originalDestroy, this, args)
    }
  const originalEmit = socket.emit
  if (originalEmit !== observedNetEmit)
    socket.emit = function (name, ...args) {
      socketEvent(state, name, args, 'socket-instance')
      return Reflect.apply(originalEmit, this, [name, ...args])
    }
  if (role === 'client') {
    const originalWrite = socket.write
    socket.write = function (...args) {
      const bytes =
        typeof args[0] === 'string'
          ? Buffer.from(args[0], typeof args[1] === 'string' ? args[1] : 'utf8')
          : Buffer.from(args[0])
      event('client.wire.write', {
        id: state.id,
        label: state.label,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        wire: bytes
          .toString('utf8')
          .replace(
            /Authorization: Bearer [^\r\n]+/gi,
            'Authorization: Bearer <owned token redacted>',
          ),
      })
      return Reflect.apply(originalWrite, this, args)
    }
  }
  return state
}

observedNetEmit = function (name, ...args) {
  let state = socketStates.get(this)
  if (!state && name === 'connect') state = observeSocket(this, 'client')
  if (state) socketEvent(state, name, args, 'net-prototype')
  return Reflect.apply(originalNetEmit, this, [name, ...args])
}
net.Socket.prototype.emit = observedNetEmit

function observeRequest(request) {
  if (requestStates.has(request)) return requestStates.get(request)
  const state = {
    id: ++requests,
    method: request.method,
    url: request.url,
    declaredLength: request.headers?.['content-length'],
  }
  requestStates.set(request, state)
  event('http.request.observed', state)
  const originalEmit = request.emit
  request.emit = function (name, ...args) {
    if (
      ['data', 'end', 'close', 'aborted', 'error', 'timeout'].includes(name)
    ) {
      event(`http.request.${name}`, {
        ...state,
        bytes: name === 'data' ? args[0]?.byteLength : undefined,
        code: name === 'error' ? args[0]?.code : undefined,
      })
    }
    return Reflect.apply(originalEmit, this, [name, ...args])
  }
  return state
}

const originalServerEmit = http.Server.prototype.emit
sourceOf('original http.Server.emit', originalServerEmit)
http.Server.prototype.emit = function (name, ...args) {
  if (name === 'connection') {
    const state = observeSocket(args[0], 'server')
    serverConnections++
    event('http.server.connection', {
      id: state.id,
      label: labelFor(state),
      count: serverConnections,
    })
  }
  if (name === 'request') observeRequest(args[0])
  if (['request', 'close', 'listening', 'error'].includes(name))
    event(`http.server.${name}`)
  return Reflect.apply(originalServerEmit, this, [name, ...args])
}

// Delegate a socket getter only when original runtime code itself accesses it.
// An observer-side request.socket read could create Bun's lazy facade too early.
const socketDescriptor = Object.getOwnPropertyDescriptor(
  http.IncomingMessage.prototype,
  'socket',
)
if (socketDescriptor?.get && socketDescriptor.configurable) {
  Object.defineProperty(http.IncomingMessage.prototype, 'socket', {
    ...socketDescriptor,
    get() {
      const socket = Reflect.apply(socketDescriptor.get, this, [])
      const state = observeSocket(socket, 'server')
      event('http.request.socket.get', {
        request: requestStates.get(this)?.id,
        socket: state.id,
        label: labelFor(state),
      })
      return socket
    },
  })
}

for (const name of ['close', 'closeAllConnections']) {
  const original = http.Server.prototype[name]
  if (typeof original !== 'function') continue
  http.Server.prototype[name] = function (...args) {
    event(`http.server.${name}.call`, { sockets: snapshot() })
    if (name === 'close' && typeof args[0] === 'function') {
      const callback = args[0]
      args[0] = function (...values) {
        event('http.server.close.callback', { sockets: snapshot() })
        return Reflect.apply(callback, this, values)
      }
    }
    const result = Reflect.apply(original, this, args)
    event(`http.server.${name}.returned`)
    return result
  }
}

const originalSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (callback, ms, ...args) {
  if (![500, 1000, 15000].includes(ms))
    return Reflect.apply(originalSetTimeout, this, [callback, ms, ...args])
  const scheduled = time()
  event('original.guard.scheduled', { budgetMs: ms, scheduled })
  return Reflect.apply(originalSetTimeout, this, [
    function (...values) {
      event('original.guard.fired', {
        budgetMs: ms,
        scheduled,
        sockets: snapshot(),
        serverConnections,
        requests,
        cleanupStarted,
      })
      return Reflect.apply(callback, this, values)
    },
    ms,
    ...args,
  ])
}

export function observedDeferred(original, index) {
  const deferred = original()
  const resolve = deferred.resolve
  deferred.resolve = function (...args) {
    event('application.callback.entered', {
      callback: index === 0 ? 'apply' : 'async-drain',
    })
    return Reflect.apply(resolve, this, args)
  }
  return deferred
}

export function recordResult(value) {
  row = value
  event('selected.case.completed', {
    ok: value?.ok,
    error: value?.error,
    sockets: snapshot(),
  })
}

process.once('exit', (exitCode) => {
  event('process.exit', { exitCode, sockets: snapshot() })
  writeFileSync(
    join(root, 'shutdown-trace.receipt'),
    JSON.stringify(
      {
        diagnosticOnly: true,
        acceptance: false,
        runtime: process.versions.bun,
        row,
        cleanupStarted,
        clients,
        requests,
        serverConnections,
        events,
        finalSockets: snapshot(),
        sourceCoverage:
          'Builtin function text is an observation of the pinned executable; native placeholders are opaque and supplied native source coverage remains limited.',
        sources,
      },
      null,
      2,
    ),
  )
})
