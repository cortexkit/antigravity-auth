import * as net from "node:net"
import * as tls from "node:tls"
import { Buffer } from "node:buffer"
import { PassThrough, Readable, Transform } from "node:stream"
import { createGunzip } from "node:zlib"

import { buildAntigravityHarnessUserAgent } from "./fingerprint.ts"

const DEFAULT_HTTPS_PORT = 443
const DEFAULT_PROXY_PORT = 8080

export const DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS = 180_000
// Max time the response body may stall (no bytes received) before the socket is
// destroyed. Streaming responses emit data far more frequently than this; a
// truly hung body would otherwise hold the socket open indefinitely.
export const DEFAULT_AGY_IDLE_TIMEOUT_MS = 180_000

export type AgyTransportOptions = {
  /**
   * Maximum time to wait for the request to connect and receive HTTP response headers.
   * The response body/stream is not bounded by this timeout.
   */
  timeoutMs?: number
  /**
   * Maximum time the response body may stall (no bytes) before the socket is
   * destroyed. Resets on every received chunk. Defaults to
   * DEFAULT_AGY_IDLE_TIMEOUT_MS.
   */
  idleTimeoutMs?: number
  signal?: AbortSignal | null
  onDebug?: (message: string) => void
}

type HeaderPair = readonly [string, string]

type ParsedResponseHead = {
  status: number
  statusText: string
  headers: Headers
  chunked: boolean
  gzip: boolean
  contentLength?: number
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  const normalized = new Headers(headers)
  normalized.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  return headers[name.toLowerCase()]
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer {
  if (body == null) return Buffer.alloc(0)
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new Error("agy transport only supports string/byte request bodies")
}

function shouldUseChunkedBody(url: URL): boolean {
  return url.pathname.includes(":streamGenerateContent")
}

export function buildAgyCliHeaderPairs(url: string, init: RequestInit = {}): HeaderPair[] {
  const parsedUrl = new URL(url)
  const headers = headersToRecord(init.headers)
  const body = bodyToBuffer(init.body)
  const host = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname
  const userAgent = getHeader(headers, "User-Agent") ?? buildAntigravityHarnessUserAgent()
  const authorization = getHeader(headers, "Authorization")
  const contentType = getHeader(headers, "Content-Type") ?? "application/json"
  const acceptEncoding = getHeader(headers, "Accept-Encoding") ?? "gzip"
  const chunked = shouldUseChunkedBody(parsedUrl)

  const pairs: HeaderPair[] = [
    ["Host", host],
    ["User-Agent", userAgent],
  ]

  if (chunked) {
    pairs.push(["Transfer-Encoding", "chunked"])
  } else {
    pairs.push(["Content-Length", String(body.byteLength)])
  }

  if (authorization) {
    pairs.push(["Authorization", authorization])
  }
  pairs.push(["Content-Type", contentType])
  pairs.push(["Accept-Encoding", acceptEncoding])

  return pairs
}

function noProxyIncludes(hostname: string): boolean {
  const raw = process.env.NO_PROXY || process.env.no_proxy || ""
  if (!raw) return false
  const host = hostname.toLowerCase()
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).some((entry) => {
    if (!entry) return false
    if (entry === "*") return true
    if (entry.startsWith(".")) return host.endsWith(entry)
    return host === entry || host.endsWith(`.${entry}`)
  })
}

function getHttpsProxy(url: URL): URL | undefined {
  if (url.protocol !== "https:" || noProxyIncludes(url.hostname)) return undefined
  const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
  if (!rawProxy) return undefined
  try {
    return new URL(rawProxy)
  } catch {
    return undefined
  }
}

function waitForHead(socket: net.Socket, timeoutMs: number, onTimeout: () => void): Promise<{ head: string; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => {
      onTimeout()
      cleanup(() => reject(new Error(`Antigravity request timed out waiting for response headers after ${timeoutMs}ms`)))
    }, timeoutMs)

    const cleanup = (finish: () => void) => {
      socket.off("data", onData)
      socket.off("error", onError)
      clearTimeout(timeout)
      finish()
    }

    const onError = (error: Error) => cleanup(() => reject(error))
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const marker = buffer.indexOf("\r\n\r\n")
      if (marker === -1) return
      const head = buffer.subarray(0, marker).toString("latin1")
      const leftover = buffer.subarray(marker + 4)
      cleanup(() => resolve({ head, leftover }))
    }

    socket.on("data", onData)
    socket.once("error", onError)
  })
}

async function connectViaProxy(proxyUrl: URL, targetUrl: URL, timeoutMs: number, onDebug?: (message: string) => void): Promise<tls.TLSSocket> {
  const proxySocket = net.connect({
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port || DEFAULT_PROXY_PORT),
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport proxy connect timeout after ${timeoutMs}ms`)
      proxySocket.destroy()
      reject(new Error(`Antigravity request timed out connecting to HTTPS proxy after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => clearTimeout(timeout)
    proxySocket.once("connect", () => {
      cleanup()
      resolve()
    })
    proxySocket.once("error", (error) => {
      cleanup()
      reject(error)
    })
  })

  const targetHost = targetUrl.hostname
  const targetPort = Number(targetUrl.port || DEFAULT_HTTPS_PORT)
  const auth = proxyUrl.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r\n`
    : ""

  proxySocket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      auth +
      "\r\n",
  )

  const { head, leftover } = await waitForHead(proxySocket, timeoutMs, () => {
    onDebug?.(`agy transport proxy CONNECT response timeout after ${timeoutMs}ms`)
    proxySocket.destroy()
  })
  if (!/^HTTP\/1\.[01] 2\d\d\b/.test(head)) {
    proxySocket.destroy()
    throw new Error(`Proxy CONNECT failed: ${head.split("\r\n")[0] ?? "unknown"}`)
  }
  if (leftover.length > 0) {
    proxySocket.unshift(leftover)
  }

  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const tlsSocket = tls.connect({ socket: proxySocket, servername: targetHost })
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport proxy TLS handshake timeout after ${timeoutMs}ms`)
      tlsSocket.destroy()
      reject(new Error(`Antigravity request timed out during proxy TLS handshake after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => clearTimeout(timeout)
    tlsSocket.once("secureConnect", () => {
      cleanup()
      resolve(tlsSocket)
    })
    tlsSocket.once("error", (error) => {
      cleanup()
      reject(error)
    })
  })
}

async function connectDirect(targetUrl: URL, timeoutMs: number, onDebug?: (message: string) => void): Promise<tls.TLSSocket> {
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || DEFAULT_HTTPS_PORT),
      servername: targetUrl.hostname,
    })
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport TLS connect timeout after ${timeoutMs}ms`)
      socket.destroy()
      reject(new Error(`Antigravity request timed out connecting after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => clearTimeout(timeout)
    socket.once("secureConnect", () => {
      cleanup()
      resolve(socket)
    })
    socket.once("error", (error) => {
      cleanup()
      reject(error)
    })
  })
}

async function connectTls(targetUrl: URL, timeoutMs: number, onDebug?: (message: string) => void): Promise<tls.TLSSocket> {
  const proxyUrl = getHttpsProxy(targetUrl)
  return proxyUrl ? await connectViaProxy(proxyUrl, targetUrl, timeoutMs, onDebug) : await connectDirect(targetUrl, timeoutMs, onDebug)
}

function serializeRequest(url: URL, init: RequestInit, body: Buffer): Buffer {
  const method = init.method ?? "POST"
  const path = `${url.pathname}${url.search}`
  const headerLines = buildAgyCliHeaderPairs(url.toString(), init)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n")
  const head = Buffer.from(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`)

  if (body.byteLength === 0) {
    return head
  }

  if (!shouldUseChunkedBody(url)) {
    return Buffer.concat([head, body])
  }

  return Buffer.concat([
    head,
    Buffer.from(`${body.byteLength.toString(16)}\r\n`),
    body,
    Buffer.from("\r\n0\r\n\r\n"),
  ])
}

function parseResponseHead(head: string): ParsedResponseHead {
  const lines = head.split("\r\n")
  const statusLine = lines.shift() ?? ""
  const match = /^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/.exec(statusLine)
  if (!match) {
    throw new Error(`Invalid HTTP response: ${statusLine}`)
  }

  const headers = new Headers()
  let chunked = false
  let gzip = false
  let contentLength: number | undefined
  for (const line of lines) {
    const index = line.indexOf(":")
    if (index <= 0) continue
    const key = line.slice(0, index)
    const value = line.slice(index + 1).trim()
    const lowerKey = key.toLowerCase()
    const lowerValue = value.toLowerCase()
    if (lowerKey === "transfer-encoding" && lowerValue.includes("chunked")) {
      chunked = true
      continue
    }
    if (lowerKey === "content-encoding" && lowerValue.includes("gzip")) {
      gzip = true
      continue
    }
    if (lowerKey === "content-length") {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed >= 0) {
        contentLength = parsed
      }
      // Drop content-length from the surfaced headers when gzip is set, since
      // the decoded body length differs from the wire length.
      if (gzip) continue
    }
    headers.append(key, value)
  }

  return {
    status: Number(match[1]),
    statusText: match[2] ?? "",
    headers,
    chunked,
    gzip,
    contentLength,
  }
}

export class ContentLengthStream extends Transform {
  private remaining: number

  constructor(contentLength: number) {
    super()
    this.remaining = contentLength
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.remaining <= 0) {
      callback()
      return
    }
    if (chunk.length <= this.remaining) {
      this.remaining -= chunk.length
      this.push(chunk)
    } else {
      // Emit only up to the declared length; discard any trailing bytes that
      // belong to the next keep-alive response.
      this.push(chunk.subarray(0, this.remaining))
      this.remaining = 0
    }
    if (this.remaining <= 0) {
      this.push(null)
    }
    callback()
  }
}

class ChunkedDecodeStream extends Transform {
  private buffer = Buffer.alloc(0)

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      this.flushAvailableChunks()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.flushAvailableChunks()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private flushAvailableChunks(): void {
    while (true) {
      const lineEnd = this.buffer.indexOf("\r\n")
      if (lineEnd === -1) return
      const sizeLine = this.buffer.subarray(0, lineEnd).toString("latin1")
      const sizeText = sizeLine.split(";", 1)[0]?.trim() ?? ""
      const size = Number.parseInt(sizeText, 16)
      if (!Number.isFinite(size)) {
        throw new Error(`Invalid chunk size: ${sizeLine}`)
      }
      const chunkStart = lineEnd + 2
      const chunkEnd = chunkStart + size
      const nextOffset = chunkEnd + 2
      if (this.buffer.length < nextOffset) return
      if (size === 0) {
        this.buffer = Buffer.alloc(0)
        this.push(null)
        return
      }
      this.push(this.buffer.subarray(chunkStart, chunkEnd))
      this.buffer = this.buffer.subarray(nextOffset)
    }
  }
}

function buildResponseStream(
  socket: tls.TLSSocket,
  leftover: Buffer,
  head: ParsedResponseHead,
  signal?: AbortSignal | null,
  idleTimeoutMs?: number,
  onDebug?: (message: string) => void,
): ReadableStream<Uint8Array> {
  const source = new PassThrough()
  if (leftover.length > 0) {
    source.write(leftover)
  }
  socket.pipe(source)

  let responseBody: Readable = source
  if (head.chunked) {
    responseBody = responseBody.pipe(new ChunkedDecodeStream())
  } else if (typeof head.contentLength === "number") {
    // Non-chunked with a known length: emit exactly contentLength bytes then
    // end, rather than reading until socket EOF (which over-reads on keep-alive
    // connections and never ends if the server keeps the socket open).
    responseBody = responseBody.pipe(new ContentLengthStream(head.contentLength))
  }
  if (head.gzip) {
    responseBody = responseBody.pipe(createGunzip())
  }

  // Idle-read watchdog: if no body bytes arrive within idleTimeoutMs, destroy
  // the socket so a hung/stalled response can't hold the connection forever.
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }
  const armIdle = () => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return
    clearIdle()
    idleTimer = setTimeout(() => {
      onDebug?.(`agy transport idle timeout after ${idleTimeoutMs}ms with no body data`)
      socket.destroy(new Error(`Antigravity response stalled: no data for ${idleTimeoutMs}ms`))
    }, idleTimeoutMs)
  }
  socket.on("data", armIdle)
  armIdle()

  const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"))
  const cleanup = () => {
    clearIdle()
    socket.off("data", armIdle)
    signal?.removeEventListener("abort", abort)
  }
  if (signal?.aborted) {
    abort()
  } else {
    signal?.addEventListener("abort", abort, { once: true })
  }

  responseBody.once("end", () => {
    cleanup()
    socket.destroy()
  })
  responseBody.once("error", () => {
    cleanup()
    socket.destroy()
  })
  responseBody.once("close", cleanup)
  return Readable.toWeb(responseBody) as ReadableStream<Uint8Array>
}

export async function fetchWithAgyCliTransport(
  url: string,
  init: RequestInit = {},
  options: AgyTransportOptions = {},
): Promise<Response> {
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`agy transport only supports https URLs: ${url}`)
  }

  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError")
  }

  const body = bodyToBuffer(init.body)
  const requestBytes = serializeRequest(parsedUrl, init, body)
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_AGY_IDLE_TIMEOUT_MS
  options.onDebug?.(`agy transport connecting to ${parsedUrl.hostname} with header timeout ${timeoutMs}ms`)
  // Race the connect against abort so a cancel during TLS/proxy connect is
  // honored immediately instead of waiting out the connect timeout.
  const socket = await connectTlsWithAbort(parsedUrl, timeoutMs, options.signal, options.onDebug)

  const abort = () => {
    socket.destroy(new DOMException("The operation was aborted", "AbortError"))
  }

  try {
    options.signal?.addEventListener("abort", abort, { once: true })
    socket.write(requestBytes)
    options.onDebug?.(`agy transport request dispatched (${requestBytes.byteLength} bytes)`)

    const { head, leftover } = await waitForHead(socket, timeoutMs, () => {
      options.onDebug?.(`agy transport response header timeout after ${timeoutMs}ms`)
      socket.destroy()
    })
    const parsedHead = parseResponseHead(head)
    options.onDebug?.(`agy transport response headers received: ${parsedHead.status} ${parsedHead.statusText}`)
    const bodyStream = buildResponseStream(socket, leftover, parsedHead, options.signal, idleTimeoutMs, options.onDebug)
    return new Response(bodyStream, {
      status: parsedHead.status,
      statusText: parsedHead.statusText,
      headers: parsedHead.headers,
    })
  } catch (error) {
    socket.destroy()
    throw error
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
}

async function connectTlsWithAbort(
  targetUrl: URL,
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
  onDebug?: (message: string) => void,
): Promise<tls.TLSSocket> {
  if (!signal) {
    return connectTls(targetUrl, timeoutMs, onDebug)
  }
  const connectPromise = connectTls(targetUrl, timeoutMs, onDebug)
  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([connectPromise, abortPromise])
  } catch (error) {
    // If abort won the race, make sure the in-flight socket is torn down once it resolves.
    void connectPromise.then((socket) => socket.destroy()).catch(() => {})
    throw error
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
