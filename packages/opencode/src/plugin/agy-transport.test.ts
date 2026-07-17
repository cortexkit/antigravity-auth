import * as net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS,
  fetchWithAgyCliTransport,
} from "./agy-transport.ts"

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

describe("agy transport", () => {
  afterEach(() => {
    restoreProxyEnv()
  })

  it("has a bounded default response-header timeout", () => {
    expect(DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS).toBe(180_000)
  })

  it("times out while waiting for response headers", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Keep the connection open but never send the proxy CONNECT response.
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("test proxy did not bind to a TCP port")
    }

    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`
    delete process.env.https_proxy
    delete process.env.ALL_PROXY
    delete process.env.all_proxy
    delete process.env.NO_PROXY
    delete process.env.no_proxy

    const debugLines: string[] = []
    try {
      await expect(fetchWithAgyCliTransport("https://example.com/v1internal:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
          "User-Agent": "antigravity/cli/1.1.3 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
        },
        body: JSON.stringify({ request: { contents: [] } }),
      }, {
        timeoutMs: 20,
        onDebug: (line) => debugLines.push(line),
      })).rejects.toThrow("Antigravity request timed out waiting for response headers after 20ms")

      expect(debugLines.some((line) => line.includes("proxy CONNECT response timeout after 20ms"))).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})
