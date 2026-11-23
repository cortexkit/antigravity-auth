import { mock, spyOn } from 'bun:test'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import {
  bodyOf,
  credential,
  epoch,
  type Reply,
  success,
  type Wire,
} from './fixtures.ts'

export function decodeWrite(host: string, bytes: Buffer): Wire {
  const boundary = bytes.indexOf('\r\n\r\n')
  if (boundary < 0)
    throw new Error('The raw sender did not write an HTTP header block')
  const [requestLine, ...lines] = bytes
    .subarray(0, boundary)
    .toString('ascii')
    .split('\r\n')
  const match = /^POST (\/\S+) HTTP\/1\.1$/.exec(requestLine ?? '')
  if (!match) throw new Error(`Unexpected AGY request line: ${requestLine}`)
  const headers = lines.map((line): [string, string] => {
    const colon = line.indexOf(': ')
    if (colon < 0) throw new Error(`Invalid raw header: ${line}`)
    return [line.slice(0, colon), line.slice(colon + 2)]
  })
  return {
    target: `https://${host}${match[1]}`,
    headers,
    bodyBase64: bytes.subarray(boundary + 4).toString('base64'),
  }
}

type Timer = ReturnType<typeof setTimeout>
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realFetch = globalThis.fetch
const originalNodeUuid = crypto.randomUUID
const originalWebUuid = globalThis.crypto.randomUUID.bind(globalThis.crypto)
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as const
let active: Environment | undefined

const originalConnect = tls.connect
mock.module('node:tls', () => ({
  ...tls,
  connect: (options: tls.ConnectionOptions & { signal?: AbortSignal }) =>
    active ? active.connect(options) : originalConnect(options),
}))

// Both crypto APIs are used by the public adapters. Keep their sequences
// separate so an OpenCode bridge job does not consume an ingress fallback ID.
mock.module('node:crypto', () => ({
  ...crypto,
  randomUUID: (...args: Parameters<typeof crypto.randomUUID>) =>
    active ? active.nextNodeId() : originalNodeUuid(...args),
}))

export class Environment {
  readonly wires: Wire[] = []
  readonly physicalSends: {
    endpoint: string
    model: unknown
    route: string
  }[] = []
  readonly delays: number[] = []
  readonly aborts: number[] = []
  readonly cancellations: number[] = []
  readonly notices: unknown[] = []
  readonly reports: unknown[] = []
  readonly hooks: unknown[] = []
  private readonly sockets = new Set<Duplex>()
  private readonly timers = new Map<Timer, { at: number; call(): void }>()
  private instant = epoch
  private randomIndex = 0
  private nodeId = 0
  private scopeId = 0
  private webId = 0
  private latestSend = epoch
  private readonly restore: (() => void)[] = []

  constructor(
    private readonly reply: (wire: Wire, attempt: number) => Reply = () =>
      success,
  ) {
    if (active) throw new Error('Host parity environments must run serially')
    active = this
    const replace = <T extends object, K extends keyof T>(
      object: T,
      key: K,
      implementation: T[K],
    ) => {
      const spy = spyOn(object, key).mockImplementation(implementation as never)
      this.restore.push(() => spy.mockRestore())
    }
    replace(Date, 'now', () => this.instant)
    replace(
      globalThis,
      'fetch',
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input)
          if (
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            !url.pathname.startsWith('/agy/')
          ) {
            throw new Error(`Parity forbids fetch to ${url.origin}`)
          }
          return realFetch(input, init)
        },
        {
          preconnect: () => {
            throw new Error('Parity forbids fetch.preconnect')
          },
        },
      ),
    )
    replace(Math, 'random', () => [0.5, 0.25, 0.75][this.randomIndex++ % 3]!)
    replace(globalThis.crypto, 'randomUUID', () =>
      active ? uuid(++this.webId) : originalWebUuid(),
    )

    for (const [key, value] of [
      ['platform', 'linux'],
      ['arch', 'x64'],
    ] as const) {
      const previous = Object.getOwnPropertyDescriptor(process, key)
      Object.defineProperty(process, key, { configurable: true, value })
      this.restore.push(() => {
        if (previous) Object.defineProperty(process, key, previous)
      })
    }

    // Ignore the runner's proxy environment without altering the target or
    // replacing any part of the sender that prepares or writes request bytes.
    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      const previous = process.env[key]
      process.env[key] = '*'
      this.restore.push(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      })
    }
  }

  nextNodeId() {
    // Account, bridge and reporting IDs must not advance the request-scope
    // sequence. Keep the production scope lookup; only supply its next IDs.
    if (new Error().stack?.includes('createAgyRequestSessionContext'))
      return uuid(++this.scopeId)
    return uuid(10_000 + ++this.nodeId)
  }

  connect(
    options: tls.ConnectionOptions & { signal?: AbortSignal },
  ): tls.TLSSocket {
    const host = options.host
    if (
      typeof host !== 'string' ||
      !/^(?:daily-|autopush-)?cloudcode-pa\.googleapis\.com$/.test(host)
    )
      throw new Error(`Parity forbids an unexpected TLS connection to ${host}`)
    let stalled = false
    const socket = new Duplex({
      read() {},
      write: (bytes: Buffer, _encoding, done) => {
        try {
          const wire = decodeWrite(host, bytes)
          const envelope = bodyOf(wire)
          this.wires.push(wire)
          this.physicalSends.push({
            endpoint: new URL(wire.target).origin,
            model: envelope.model,
            route: credential.projectId,
          })
          if (this.instant > this.latestSend)
            this.delays.push(this.instant - this.latestSend)
          this.latestSend = this.instant
          const reply = this.reply(wire, this.wires.length - 1)
          stalled = reply.stall !== undefined
          done()
          queueMicrotask(() => {
            if (socket.destroyed || reply.stall === 'before-headers') return
            if (reply.transportError) {
              socket.destroy(new Error(reply.transportError))
              return
            }
            const body = Buffer.from(reply.body ?? '')
            const headers = new Headers(reply.headers)
            if (!headers.has('content-type'))
              headers.set('content-type', 'text/event-stream')
            if (!stalled) headers.set('content-length', String(body.length))
            const serialized = Array.from(
              headers,
              ([k, v]) => `${k}: ${v}`,
            ).join('\r\n')
            socket.push(
              Buffer.concat([
                Buffer.from(
                  `HTTP/1.1 ${reply.status ?? 200} Fixture\r\n${serialized}\r\n\r\n`,
                ),
                body,
              ]),
            )
            if (!stalled) socket.push(null)
          })
        } catch (error) {
          done(error as Error)
        }
      },
    })
    const abort = () => this.aborts.push(this.instant - epoch)
    options.signal?.addEventListener('abort', abort, { once: true })
    // The sender owns all socket teardown. Keep its errors observable without
    // producing an unhandled EventEmitter error if close races a test failure.
    socket.on('error', () => {})
    this.sockets.add(socket)
    socket.on('close', () => {
      options.signal?.removeEventListener('abort', abort)
      this.sockets.delete(socket)
      if (stalled) this.cancellations.push(this.instant - epoch)
    })
    queueMicrotask(() => socket.emit('secureConnect'))
    return socket as tls.TLSSocket
  }

  async timed<T>(operation: () => Promise<T>): Promise<T> {
    const makeTimer = (
      call: (...args: unknown[]) => void,
      ms = 0,
      ...args: unknown[]
    ): Timer => {
      // Advance request timers, not bridge job retention or background
      // account persistence, which may be pending during an ordinary send.
      const caller =
        new Error().stack
          ?.split('\n')
          .slice(1)
          .find(
            (line) =>
              !line.includes('host-parity/environment.') &&
              !line.includes('bun:'),
          ) ?? ''
      if (
        ms <= 1 ||
        !/agy-transport\.|request-services\.|pre-response-deadline\.|(?:at nextWithTimeout )/.test(
          caller,
        )
      )
        return realSetTimeout(call, ms, ...args)
      const handle = realSetTimeout(() => {}, 2_147_483_647)
      handle.unref()
      this.timers.set(handle, {
        at: this.instant + ms,
        call: () => call(...args),
      })
      return handle
    }
    const set = spyOn(globalThis, 'setTimeout').mockImplementation(
      makeTimer as typeof setTimeout,
    )
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(
      (handle) => {
        if (typeof handle === 'object') this.timers.delete(handle as Timer)
        realClearTimeout(handle as Timer | number | undefined)
      },
    )
    let finished = false
    const result = operation().finally(() => {
      finished = true
    })
    void result.catch(() => {})
    try {
      // Give the loopback bridge and stream readers a real turn before moving
      // the fixture clock to the next requested deadline.
      for (let turns = 0; !finished && turns < 160; turns++) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 3))
        if (finished) break
        if (this.wires.length === 0) continue
        const next = Array.from(this.timers).sort(
          (a, b) => a[1].at - b[1].at,
        )[0]
        if (next) {
          const [handle, timer] = next
          this.timers.delete(handle)
          realClearTimeout(handle)
          this.instant = timer.at
          timer.call()
        }
      }
      if (!finished)
        throw new Error('The fixture did not settle on its controlled clock')
      return await result
    } finally {
      for (const handle of this.timers.keys()) realClearTimeout(handle)
      this.timers.clear()
      clear.mockRestore()
      set.mockRestore()
    }
  }

  dispose() {
    for (const socket of this.sockets) socket.destroy()
    for (const restore of this.restore.reverse()) restore()
    active = undefined
  }
}
