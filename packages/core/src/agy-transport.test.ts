import { readFileSync } from "node:fs"
import * as net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import {
  buildAgyCliHeaderPairs,
  ContentLengthStream,
  DEFAULT_AGY_IDLE_TIMEOUT_MS,
  DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS,
  fetchWithAgyCliTransport,
} from "./agy-transport.ts"

type AgyWireFixture = {
  capture: {
    version: string
    endpoint: string
    httpVersion: string
  }
  headers: Array<[string, string]>
  envelopeKeys: string[]
  requestKeys: string[]
}

const AGY_1_1_3_WIRE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../../test-fixtures/agy-cli-1.1.3-stream-request.json", import.meta.url), "utf8"),
) as AgyWireFixture

const savedProxyEnv = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
}

function restoreProxyEnv(): void {
  for (const [key, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function collect(stream: ContentLengthStream, inputs: Buffer[]): Promise<Buffer> {
  const chunks: Buffer[] = []
  stream.on("data", (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve) => stream.on("end", resolve))
  for (const input of inputs) stream.write(input)
  stream.end()
  await done
  return Buffer.concat(chunks)
}

describe("agy transport", () => {
  afterEach(() => {
    restoreProxyEnv()
  })

  it("has bounded default header and idle timeouts", () => {
    expect(DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS).toBe(180_000)
    expect(DEFAULT_AGY_IDLE_TIMEOUT_MS).toBe(180_000)
  })

  it("serializes the captured agy CLI 1.1.3 stream header contract", () => {
    const pairs = buildAgyCliHeaderPairs(AGY_1_1_3_WIRE_FIXTURE.capture.endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
        "User-Agent": "antigravity/cli/1.1.3 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify({ request: { contents: [] } }),
    }).map(([name, value]) => [
      name,
      name === "Authorization" ? "<redacted>" : value,
    ])

    expect(AGY_1_1_3_WIRE_FIXTURE.capture).toMatchObject({
      version: "1.1.3",
      httpVersion: "HTTP/1.1",
    })
    expect(pairs).toEqual(AGY_1_1_3_WIRE_FIXTURE.headers)
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchWithAgyCliTransport("https://example.com/x", { method: "POST" }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
  })

  it("times out while waiting for response headers", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Accept the connection but never respond.
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")

    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`
    delete process.env.https_proxy
    delete process.env.ALL_PROXY
    delete process.env.all_proxy
    delete process.env.NO_PROXY
    delete process.env.no_proxy

    const debugLines: string[] = []
    try {
      await expect(fetchWithAgyCliTransport("https://example.com/v1internal:streamGenerateContent", {
        method: "POST",
        headers: {
          "User-Agent": "antigravity/cli/1.1.3 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
        },
        body: JSON.stringify({ x: 1 }),
      }, {
        timeoutMs: 20,
        onDebug: (line) => debugLines.push(line),
      })).rejects.toThrow("Antigravity request timed out waiting for response headers after 20ms")

      expect(debugLines.some((l) => l.includes("proxy CONNECT response timeout after 20ms"))).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  describe("ContentLengthStream", () => {
    it("emits exactly contentLength bytes and ends", async () => {
      const out = await collect(new ContentLengthStream(5), [Buffer.from("hello")])
      expect(out.toString()).toBe("hello")
    })

    it("discards trailing bytes belonging to the next keep-alive response", async () => {
      const out = await collect(new ContentLengthStream(5), [Buffer.from("helloEXTRA_NEXT_RESPONSE")])
      expect(out.toString()).toBe("hello")
    })

    it("reassembles a body split across chunks", async () => {
      const out = await collect(new ContentLengthStream(6), [Buffer.from("foo"), Buffer.from("bar"), Buffer.from("baz")])
      expect(out.toString()).toBe("foobar")
    })
  })
})
